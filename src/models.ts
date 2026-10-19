import { OllamaEmbeddings } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai";
import { CONFIG } from "./config.ts";

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
export function createChatModel(temperature: number = CONFIG.llm.temperature): ChatOpenAI {
    return new ChatOpenAI({
        temperature,
        maxRetries: CONFIG.llm.maxRetries,
        maxTokens: CONFIG.llm.maxTokens,
        modelName: CONFIG.llm.nlpModel,
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
