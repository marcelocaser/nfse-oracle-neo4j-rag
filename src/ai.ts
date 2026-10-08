import { type Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector"
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { ChatOpenAI } from "@langchain/openai"
import type { z } from "zod";

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
}

interface ChainState {
    question: string;
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

        return {
            ...input,
            answer: rawResponse as string
        }
    }

    async anwerQuestion(question: string) {
        const chain = RunnableSequence.from([
            this.retrieveVectorSearchResults.bind(this),
            this.generatedNLPResponse.bind(this),
        ]);
        const result = await chain.invoke({ question })

        // A apresentação da resposta fica com quem chamou (src/index.ts).
        // Imprimir aqui também fazia cada resposta sair duplicada no console.
        return result
    }
}