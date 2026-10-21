import { type Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector"
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai"
import { z } from "zod";
import { formatRows, GRAPH_ROUTES, type GraphRoute } from "./graph.ts";
import { periodoNaPergunta, semDatas, type Periodo } from "./periodo.ts";

type DebugLog = (...args: unknown[]) => void;
type params = {
    debugLog: DebugLog,
    vectorStore: Neo4jVectorStore,
    nlpModel: ChatOpenAI,
    promptConfig: any,
    templateText: string,
    topK: number,
    /**
     * LLM com temperatura 0 que reescreve uma pergunta de continuação ("e o
     * valor dela?") como pergunta completa, usando o histórico. Sem ele, o
     * histórico é ignorado.
     */
    rewriter?: ChatOpenAI,
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

/**
 * Texto para o índice FULLTEXT (Lucene) da busca híbrida. O LangChain tira
 * os caracteres especiais mas não a "/", que no Lucene abre uma expressão
 * regular: "notas de 01/10 até hoje" estourava com TokenMgrError. AND/OR/NOT
 * em maiúsculas também são operadores; em minúsculas viram termos comuns.
 */
function textoParaBuscaPorPalavra(pergunta: string): string {
    return pergunta
        .replace(/\//g, " ")
        .replace(/\b(AND|OR|NOT)\b/g, termo => termo.toLowerCase());
}

/** Teto de "notas mais recentes" quando a pergunta não cita período. */
const NOTAS_MAIS_RECENTES = 20;

/** Número de nota citado na pergunta ("nota 206", "NFS-e nº 202200000000152"). */
function numeroNaPergunta(pergunta: string): string | null {
    return pergunta.match(/\b\d{3,}\b/)?.[0] ?? null;
}

/** Uma troca anterior da conversa. */
export interface Turno {
    pergunta: string;
    resposta: string;
}

/** Teto de caracteres de cada resposta anterior levada ao reescritor. */
const MAX_CHARS_RESPOSTA_HISTORICO = 1000;

/** Marca a tabela do grafo que generatedNLPResponse anexa à resposta. */
const MARCA_TABELA_GRAFO = "\n\n**Dados completos (consulta ao grafo):**";

/**
 * Sinais de que a pergunta depende da conversa: pronome ou demonstrativo
 * ("dela", "dessa nota"), ordinal ("o segundo"), "a outra", ou começar com
 * "E ...". Sem eles a pergunta nem vai ao reescritor: o LLM de 2B tendia a
 * prender perguntas gerais ("em quais municípios...?") à nota anterior.
 */
const REFERENCIA_A_CONVERSA =
    /^\s*e(?!\p{L})|(?<!\p{L})(?:(?:d|n)?(?:el|ess|est|aquel)[ae]s?|(?:outr|primeir|segund|terceir|últim|mesm)[ao]s?|anterior(?:es)?)(?!\p{L})/iu;

/** Pergunta curta ("Qual o valor?") quase sempre depende do contexto. */
const MAX_PALAVRAS_PERGUNTA_CURTA = 5;

function dependeDaConversa(pergunta: string): boolean {
    return REFERENCIA_A_CONVERSA.test(pergunta)
        || pergunta.split(/\s+/).filter(Boolean).length <= MAX_PALAVRAS_PERGUNTA_CURTA;
}

/** Posição na lista por ordinal; -1 = o último. */
const ORDINAIS: [RegExp, number][] = [
    [/(?<!\p{L})primeir[ao]s?(?!\p{L})/iu, 1], [/(?<!\p{L})segund[ao]s?(?!\p{L})/iu, 2],
    [/(?<!\p{L})terceir[ao]s?(?!\p{L})/iu, 3], [/(?<!\p{L})quart[ao]s?(?!\p{L})/iu, 4],
    [/(?<!\p{L})quint[ao]s?(?!\p{L})/iu, 5],
    // "o último" da lista, mas não "o último mês" (período, ver src/periodo.ts).
    [/(?<!\p{L})últim[ao]s?(?!\p{L})(?!\s+(?:m[eê]s|ano|semana|dias?)(?!\p{L}))/iu, -1],
];

/**
 * "o segundo da lista" → o 2º item em negrito da lista mais recente da
 * conversa ("*   **NOME** ..." ou "1. **NOME** ..."). Contar itens é onde o
 * LLM de 2B mais erra: com 10 prestadores na lista, devolvia a pergunta igual.
 */
function itemPorOrdinal(pergunta: string, historico: Turno[]): string | null {
    const itens = historico
        // "**Valor:** R$ ..." e "**Valor**: R$ ..." são rótulos de campo, não
        // itens de lista: os dois-pontos dentro ou logo depois do negrito.
        .map(({ resposta }) => [...resposta.matchAll(/^\s*(?:[*-]|\d+[.)])\s+\*\*([^*:]+?)\*\*(?!\s*:)/gm)]
            .map(m => m[1]!.trim()))
        .reverse().find(lista => lista.length >= 2) ?? [];
    if (!itens.length) return null;
    const numero = pergunta.match(/(?<!\d)(\d{1,2})\s*[ºª°]/)?.[1];
    const posicao = numero ? Number(numero) : ORDINAIS.find(([re]) => re.test(pergunta))?.[1];
    if (!posicao) return null;
    return (posicao === -1 ? itens.at(-1) : itens[posicao - 1]) ?? null;
}

/**
 * Exemplos com dados fictícios: o LLM de 2B segue melhor um modelo do que
 * uma regra. O último mostra que pergunta já completa volta igual.
 */
const PROMPT_REESCRITA = `Você reescreve a última pergunta de uma conversa sobre notas fiscais de serviço (NFS-e) para que ela possa ser entendida sozinha, sem a conversa.

Regras:
- Troque pronomes e referências ("dela", "essa nota", "a outra", "e o valor?") pelo nome da empresa, número da nota ou assunto citado na conversa.
- Mantenha o sentido da pergunta. Não responda a pergunta.
- Só reescreva se a pergunta tiver uma referência à conversa: pronome ("dela", "dessa", "desse"), "a outra", "o segundo", ou começar com "E ...". Sem referência, devolva-a sem mudanças, mesmo que o assunto seja parecido.
- Devolva só a pergunta reescrita, em uma linha, sem explicações.

Exemplo 1
Conversa:
Usuário: Quais os dados da nota da EMPRESA EXEMPLO LTDA?
Assistente: A nota nº 120 da EMPRESA EXEMPLO LTDA foi emitida em 05/03/2025, no valor de R$ 1.500,00.
Última pergunta: E qual o ISS retido dela?
Pergunta reescrita: Qual o ISS retido na nota nº 120 da EMPRESA EXEMPLO LTDA?

Exemplo 2
Conversa:
Usuário: Quais prestadores aparecem nas notas?
Assistente: Aparecem a ALFA SERVIÇOS LTDA (3 notas) e a BETA COMÉRCIO ME (1 nota).
Última pergunta: Quais os dados da nota da segunda?
Pergunta reescrita: Quais os dados da nota da BETA COMÉRCIO ME?

Exemplo 3
Conversa:
Usuário: Quais os dados da nota nº 15?
Assistente: A nota nº 15 da GAMA REPRESENTAÇÕES LTDA vale R$ 800,00 e tem ISS retido.
Última pergunta: Quais tipos de serviço aparecem nas notas?
Pergunta reescrita: Quais tipos de serviço aparecem nas notas?

Agora a sua vez.
Conversa:
{conversa}
Última pergunta: {pergunta}
Pergunta reescrita:`;

interface ChainState {
    question: string;
    /** Tabela do grafo, anexada à resposta sem passar pelo LLM. */
    graphTable?: string;
    route?: GraphRoute | "texto_livre";
    /** Período de emissão citado na pergunta; filtra todas as rotas do grafo. */
    periodo?: Periodo | null;
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

    /**
     * Transforma uma pergunta de continuação em pergunta completa. O resto da
     * cadeia (roteador, Cypher por nome/número, busca nos trechos) só enxerga
     * a pergunta, então é ela que precisa carregar o nome ou o número.
     */
    async reformularPergunta(pergunta: string, historico: Turno[]): Promise<string> {
        if (!this.params.rewriter || !historico.length || !dependeDaConversa(pergunta)) return pergunta;
        const item = itemPorOrdinal(pergunta, historico);
        if (item) {
            this.params.debugLog(`🔢 Item da lista anterior: ${item}`);
            pergunta = `${pergunta.replace(/[?\s]+$/, "")} (${item})?`;
        }
        const conversa = historico.map(({ pergunta: p, resposta }) => {
            // A tabela do grafo pode ter dezenas de linhas e confunde o LLM de
            // 2B; o resumo antes dela já cita os nomes e números.
            const r = resposta.split(MARCA_TABELA_GRAFO)[0]!.trim();
            const resumo = r.length > MAX_CHARS_RESPOSTA_HISTORICO
                ? `${r.slice(0, MAX_CHARS_RESPOSTA_HISTORICO)}…`
                : r;
            return `Usuário: ${p}\nAssistente: ${resumo}`;
        }).join("\n");
        const bruta = await ChatPromptTemplate.fromTemplate(PROMPT_REESCRITA)
            .pipe(this.params.rewriter)
            .pipe(new StringOutputParser())
            .invoke({ conversa, pergunta });
        // O modelo às vezes repete o rótulo, põe aspas ou acrescenta linhas.
        const reescrita = (bruta.trim().split("\n")[0] ?? "")
            .replace(/^(pergunta reescrita|pergunta)\s*:\s*/i, "")
            .replace(/^["'“”]+|["'“”]+$/g, "")
            .trim();
        // Saída vazia ou desproporcional (respondeu em vez de reescrever):
        // melhor a pergunta original do que uma pergunta errada.
        if (!reescrita || reescrita.length > Math.max(300, pergunta.length * 4)) {
            this.params.debugLog("⚠️  Reescrita descartada; usando a pergunta como veio.");
            return pergunta;
        }
        if (reescrita !== pergunta) this.params.debugLog(`💬 Pergunta reescrita: ${reescrita}`);
        return reescrita;
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
        const periodo = periodoNaPergunta(input.question);
        // Pergunta com data que o roteador não soube encaixar é pergunta por
        // período: a busca nos trechos não filtra datas.
        const route = periodo && rota === "texto_livre" ? "notas_por_periodo" : rota as ChainState["route"];
        this.params.debugLog(`🧭 Rota: ${route}${route !== rota ? ` (roteador: ${rota})` : ""}`);
        if (periodo) this.params.debugLog(`📅 Período: ${periodo.descricao}`);
        return { ...input, route, periodo };
    }

    async retrieveContext(input: ChainState): Promise<ChainState> {
        if (!input.route || input.route === "texto_livre") return this.retrieveVectorSearchResults(input);

        const { periodo } = input;
        const consultar = (rota: GraphRoute) => this.params.vectorStore.query(GRAPH_ROUTES[rota].cypher, {
            pergunta: input.question,
            // Sem as datas: o ano de "01/10/2026" não é número de nota.
            numero: numeroNaPergunta(semDatas(input.question)),
            inicio: periodo?.inicio ?? null,
            fim: periodo?.fim ?? null,
        });
        let route = input.route;
        let rows = await consultar(route);
        // "Havia nota emitida de 01/10 até hoje?" ia para nota_especifica, que
        // sem nome nem número não acha nada.
        if (!rows.length && periodo && route === "nota_especifica") {
            this.params.debugLog(`⚠️  Consulta "${route}" sem resultado no período — tentando "notas_por_periodo".`);
            route = "notas_por_periodo";
            rows = await consultar(route);
        }
        if (!rows.length && periodo) {
            // Os trechos não filtram datas: buscar neles traria notas de
            // qualquer época. A resposta é a ausência, sem passar pelo LLM.
            this.params.debugLog(`⚠️  Consulta "${route}" sem resultado no período.`);
            return {
                ...input,
                route,
                answer: `Não encontrei, entre as notas indexadas, nenhuma emitida ${periodo.descricao} que atenda à pergunta.`,
            };
        }
        // Sem período, "as notas mais recentes": não despeja a base inteira.
        let recorte = "";
        if (route === "notas_por_periodo" && !periodo && rows.length > NOTAS_MAIS_RECENTES) {
            rows = rows.slice(0, NOTAS_MAIS_RECENTES);
            recorte = ` — as ${NOTAS_MAIS_RECENTES} emitidas mais recentemente`;
        }
        if (!rows.length) {
            // Ex.: prestador que não está no grafo, ou campo que o extrator
            // descartou — os trechos ainda podem ter a resposta.
            this.params.debugLog(`⚠️  Consulta "${route}" sem resultado no grafo — usando a busca nos trechos.`);
            return this.retrieveVectorSearchResults(input);
        }
        this.params.debugLog(`🕸️  ${rows.length} linha(s) do grafo (${route}).`);
        // O teto de linhas vale só para o contexto do LLM (8K no local); a
        // tabela anexada à resposta vai inteira.
        const graphTable = formatRows(rows, Number.POSITIVE_INFINITY);
        const context =
            `Resultado de uma consulta ao banco com TODAS as notas fiscais indexadas ` +
            `(${rows.length} linha(s)${recorte})` +
            (periodo ? `, filtrado pelas notas emitidas ${periodo.descricao}` : "") +
            `. Valores em R$. A tabela completa será mostrada ao usuário ` +
            `logo após a sua resposta: escreva um resumo curto, sem repetir a tabela linha a linha.\n\n` +
            formatRows(rows, this.params.graph!.maxRows);
        return { ...input, route, context, graphTable };
    }

    async retrieveVectorSearchResults(input: ChainState): Promise<ChainState> {
        this.params.debugLog("🔍 Buscando no vector store do Neo4j...");
        // O embedding sai da pergunta como veio; só a busca por palavra-chave
        // recebe o texto ajustado.
        const embedding = await this.params.vectorStore.embeddings.embedQuery(input.question);
        const vectorResults = await this.params.vectorStore.similaritySearchVectorWithScore(
            embedding, this.params.topK, textoParaBuscaPorPalavra(input.question),
        );
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
            ? `${(rawResponse as string).trim()}${MARCA_TABELA_GRAFO}\n\n${input.graphTable}`
            : rawResponse as string;
        return {
            ...input,
            answer
        }
    }

    /**
     * @param historico trocas anteriores da conversa, da mais antiga para a
     * mais recente. Com histórico, a pergunta é reescrita antes da cadeia.
     */
    async anwerQuestion(pergunta: string, historico: Turno[] = []) {
        const question = await this.reformularPergunta(pergunta, historico);
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