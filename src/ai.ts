import { type Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector"
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod";
import { formatRows, GRAPH_ROUTES, type GraphRoute } from "./graph.ts";

type DebugLog = (...args: unknown[]) => void;
type params = {
    debugLog: DebugLog,
    vectorStore: Neo4jVectorStore,
    nlpModel: ChatOpenAI,
    promptConfig: any,
    templateText: string,
    topK: number,
    /**
     * Quando informado, a resposta é obtida via withStructuredOutput: o schema
     * vai como definição de função na chamada à API e o formato é imposto no
     * protocolo, não pedido no texto. Sem schema, cai no caminho de texto livre.
     */
    outputSchema?: z.ZodType<Record<string, unknown>>,
    structuredOutputMethod?: "functionCalling" | "jsonMode" | "jsonSchema"
    /**
     * Com grafo, cada pergunta passa antes por um roteador: as agregadas
     * ("quais notas têm retenção?") viram Cypher sobre todas as notas; o resto
     * segue para a busca nos trechos. Sem grafo, só a busca nos trechos.
     */
    graph?: {
        /** LLM com temperatura 0 para classificar a pergunta. */
        router: ChatOpenAI,
        /** Teto de linhas no contexto — mantém o prompt dentro do LLM local. */
        maxRows: number,
    }
}

const ROUTE_NAMES: [GraphRoute | "texto_livre", ...(GraphRoute | "texto_livre")[]] =
    ["texto_livre", ...(Object.keys(GRAPH_ROUTES) as GraphRoute[])];

/**
 * O LLM só escolhe a rota. Termos da pergunta (nome da empresa, número da
 * nota) são achados por regra/Cypher: o gemma4 local, pedido a extrair o nome,
 * copiava a descrição da rota no lugar.
 */
const routeSchema = z.object({
    rota: z.enum(ROUTE_NAMES)
        .describe("A consulta que responde a pergunta; texto_livre se nenhuma das outras servir"),
});

/** Número de nota citado na pergunta ("nota 206", "NFS-e nº 202200000000152"). */
function numeroNaPergunta(pergunta: string): string | null {
    return pergunta.match(/\b\d{3,}\b/)?.[0] ?? null;
}

interface ChainState {
    question: string;
    /** Tabela do grafo, anexada à resposta sem passar pelo LLM. */
    graphTable?: string;
    route?: GraphRoute | "texto_livre";
    context?: string;
    topScore?: number;
    error?: string;
    answer?: string;
    /** Objeto validado contra o schema, quando outputSchema é usado. */
    structured?: Record<string, unknown>;
}

export class AI {
    private params: params;

    constructor(params: params) {
        this.params = params;
    }

    async routeQuestion(input: ChainState): Promise<ChainState> {
        if (!this.params.graph) return { ...input, route: "texto_livre" };
        const rotas = Object.entries(GRAPH_ROUTES).map(([nome, r]) => `- ${nome}: ${r.descricao}`).join("\n");
        const { rota } = await this.params.graph.router
            .withStructuredOutput(routeSchema, { method: "jsonSchema" })
            .invoke(
                `Classifique a pergunta sobre notas fiscais de serviço na rota que a responde.\n` +
                `Rotas:\n${rotas}\n- texto_livre: qualquer outra pergunta\n\nPergunta: ${input.question}`
            );
        this.params.debugLog(`🧭 Rota: ${rota}`);
        return { ...input, route: rota as ChainState["route"] };
    }

    async retrieveContext(input: ChainState): Promise<ChainState> {
        if (!input.route || input.route === "texto_livre") return this.retrieveVectorSearchResults(input);

        const { cypher } = GRAPH_ROUTES[input.route];
        const rows = await this.params.vectorStore.query(cypher, {
            pergunta: input.question,
            numero: numeroNaPergunta(input.question),
        });
        if (!rows.length) {
            // Ex.: prestador que não está no grafo, ou campo que o extrator
            // descartou — os trechos ainda podem ter a resposta.
            this.params.debugLog(`⚠️  Consulta "${input.route}" sem resultado no grafo — usando a busca nos trechos.`);
            return this.retrieveVectorSearchResults(input);
        }
        this.params.debugLog(`🕸️  ${rows.length} linha(s) do grafo (${input.route}).`);
        // O teto de linhas vale só para o contexto do LLM (8K no local); a
        // tabela anexada à resposta vai inteira.
        const graphTable = formatRows(rows, Number.POSITIVE_INFINITY);
        const context =
            `Resultado de uma consulta ao banco com TODAS as notas fiscais indexadas ` +
            `(${rows.length} linha(s)). Valores em R$. A tabela completa será mostrada ao usuário ` +
            `logo após a sua resposta: escreva um resumo curto, sem repetir a tabela linha a linha.\n\n` +
            formatRows(rows, this.params.graph!.maxRows);
        return { ...input, context, graphTable };
    }

    async retrieveVectorSearchResults(input: ChainState): Promise<ChainState> {
        this.params.debugLog("🔍 Buscando no vector store do Neo4j...");
        const vectorResults = await this.params.vectorStore.similaritySearchWithScore(input.question, this.params.topK);
        if (!vectorResults.length) {
            this.params.debugLog("⚠️  Nenhum resultado encontrado no vector store.");
            return {
                ...input,
                error: "Desculpe, não encontrei informações relevantes sobre essa pergunta na base de conhecimento."
            };
        }
        // console.log(vectorResults);
        const topScore = vectorResults[0]![1];
        this.params.debugLog(`✅ Encontrados ${vectorResults.length} resultados relevantes (melhor score: ${topScore.toFixed(3)})`);

        const contexts = vectorResults
            .filter(([, score]) => score > 0.5)
            .map(([doc]) => doc.pageContent)
            .join("\n\n---\n\n");

        // Sem este guard, quando todos os resultados ficam abaixo do threshold
        // o context vira "" e o estágio seguinte devolve answer e error ambos
        // undefined — o chamador então grava `undefined` em disco e estoura.
        if (!contexts) {
            this.params.debugLog(`⚠️  Resultados abaixo do threshold (melhor score: ${topScore.toFixed(3)}).`);
            return {
                ...input,
                topScore,
                error: "Desculpe, não encontrei informações relevantes sobre essa pergunta na base de conhecimento."
            };
        }

        return {
            ...input,
            context: contexts,
            topScore
        }
    }

    async generatedNLPResponse(input: ChainState): Promise<ChainState> {
        if (!input.context) {
            return input;
        }
        this.params.debugLog("🤖 Gerando resposta com IA...");
        const responsePrompt = ChatPromptTemplate.fromTemplate(
            this.params.templateText
        )
        const { outputSchema, structuredOutputMethod } = this.params;
        const responseChain = outputSchema
            ? responsePrompt.pipe(
                this.params.nlpModel.withStructuredOutput(outputSchema, {
                    method: structuredOutputMethod ?? "functionCalling",
                })
            )
            : responsePrompt
                .pipe(this.params.nlpModel)
                .pipe(new StringOutputParser())

        const rawResponse = await responseChain.invoke({
            role: this.params.promptConfig.role,
            task: this.params.promptConfig.task,
            tone: this.params.promptConfig.constraints.tone,
            language: this.params.promptConfig.constraints.language,
            format: this.params.promptConfig.constraints.format,
            instructions: this.params.promptConfig.instructions.map((instruction: string, idx: number) =>
                `${idx + 1}. ${instruction}`
            ).join('\n'),
            question: input.question,
            context: input.context
        })

        // Com schema vem um objeto; serializamos para `answer` de modo que o
        // restante do fluxo (impressão e gravação em disco) siga igual.
        if (outputSchema) {
            const structured = rawResponse as Record<string, unknown>;
            return {
                ...input,
                structured,
                answer: JSON.stringify(structured, null, 2)
            }
        }

        // Um LLM de 2B esquece linhas ao resumir uma tabela (citou 5 de 8 notas
        // com retenção): os dados do grafo vão inteiros, direto do banco.
        const answer = input.graphTable
            ? `${(rawResponse as string).trim()}\n\n**Dados completos (consulta ao grafo):**\n\n${input.graphTable}`
            : rawResponse as string;
        return {
            ...input,
            answer
        }
    }

    async anwerQuestion(question: string) {
        const chain = RunnableSequence.from([
            this.routeQuestion.bind(this),
            this.retrieveContext.bind(this),
            this.generatedNLPResponse.bind(this),
        ]);
        const result = await chain.invoke({ question })

        // A apresentação da resposta fica com quem chamou (src/index.ts).
        // Imprimir aqui também fazia cada resposta sair duplicada no console.
        return result
    }
}