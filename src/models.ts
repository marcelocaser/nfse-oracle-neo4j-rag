import { type Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { OllamaEmbeddings } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { AI } from "./ai.ts";
import { CONFIG, type LlmModelConfig } from "./config.ts";

export function createEmbeddings(): OllamaEmbeddings {
    return new OllamaEmbeddings({
        model: CONFIG.embedding.modelName,
        baseUrl: CONFIG.embedding.baseUrl,
    });
}

/**
 * LLM do Ollama pela API compatível com a OpenAI. Use temperatura 0 para
 * extração e roteamento: com 0.3 os mesmos campos variavam entre execuções.
 */
export function createChatModel(temperature: number = CONFIG.llm.temperature, llm: LlmModelConfig = CONFIG.llm): ChatOpenAI {
    return new ChatOpenAI({
        temperature,
        maxRetries: CONFIG.llm.maxRetries,
        maxTokens: llm.maxTokens,
        modelName: llm.nlpModel,
        openAIApiKey: CONFIG.llm.apiKey,
        // Enviado cru: o reasoningEffort do ChatOpenAI não aceita "none".
        modelKwargs: CONFIG.llm.reasoningEffort
            ? { reasoning_effort: CONFIG.llm.reasoningEffort }
            : undefined,
        configuration: {
            baseURL: CONFIG.llm.url,
        }
    });
}

/**
 * Cadeia de perguntas (roteador → grafo ou trechos → resposta). Com a
 * extração ligada, as perguntas sobre o conjunto vão ao grafo. `llm` troca o
 * LLM de toda a cadeia (padrão: NLP_MODEL).
 */
export function createAI(vectorStore: Neo4jVectorStore, debugLog: (...args: unknown[]) => void = console.log,
    llm: LlmModelConfig = CONFIG.llm): AI {
    return new AI({
        nlpModel: createChatModel(CONFIG.llm.temperature, llm),
        debugLog,
        vectorStore,
        promptConfig: CONFIG.promptConfig,
        templateText: CONFIG.templateText,
        topK: CONFIG.similarity.topK,
        rewriter: createChatModel(0, llm),
        graph: CONFIG.extraction.enabled
            ? { router: createChatModel(0, llm), schemaMethod: llm.schemaMethod, maxRows: CONFIG.extraction.maxRows }
            : undefined,
    });
}
