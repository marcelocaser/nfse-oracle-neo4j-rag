import type { DataType, PretrainedModelOptions } from "@huggingface/transformers";
import { readFileSync } from 'node:fs'

const promptsFolder = './prompts';
const promptsFiles = {
    answerPrompt: `${promptsFolder}/answerPrompt.json`,
    template: `${promptsFolder}/template.txt`,
};

export interface TextSplitterConfig {
    chunkSize: number;
    chunkOverlap: number;
}

export interface OracleConfig {
    user: string;
    password: string;
    connectString: string;
    /** Só usado em Windows/macOS. No Linux as libs precisam estar no ldconfig. */
    clientLibDir?: string;
    /** Pasta com tnsnames.ora / sqlnet.ora, se houver. */
    configDir?: string;
    table: string;
    idColumn: string;
    nameColumn: string;
    blobColumn: string;
    /** Sobrescreve a query montada. Deve retornar ID, NAME, DATA e usar o bind :maxDocs. */
    query?: string;
    maxDocs: number;
    poolMin: number;
    poolMax: number;
}

/**
 * Nomes de tabela/coluna não podem ser bind variables em SQL — eles são
 * interpolados na query. Validar o formato evita que um valor de .env
 * mal formado (ou malicioso) vire injeção de SQL.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$#]*(\.[A-Za-z_][A-Za-z0-9_$#]*)?$/;

function identifier(value: string | undefined, envName: string, fallback: string): string {
    const resolved = value?.trim() || fallback;
    if (!SAFE_IDENTIFIER.test(resolved)) {
        throw new Error(
            `${envName}="${resolved}" não é um identificador Oracle válido. ` +
            `Use apenas letras, números, _ $ # (opcionalmente SCHEMA.OBJETO).`
        );
    }
    return resolved;
}

function positiveInt(value: string | undefined, envName: string, fallback: number): number {
    if (!value?.trim()) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${envName}="${value}" deve ser um inteiro positivo.`);
    }
    return parsed;
}

export const CONFIG = Object.freeze({
    promptConfig: JSON.parse(readFileSync(promptsFiles.answerPrompt, 'utf-8')),
    templateText: readFileSync(promptsFiles.template, 'utf-8'),
    output: {
        answersFolder: './respostas',
        fileName: 'resposta',
    },
    neo4j: {
        url: process.env.NEO4J_URI!,
        username: process.env.NEO4J_USER!,
        password: process.env.NEO4J_PASSWORD!,
        indexName: "tensors_index",
        searchType: "vector" as const,
        textNodeProperties: ["text"],
        nodeLabel: "Chunk",
    },
    openRouter: {
        nlpModel: process.env.NLP_MODEL,
        url: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
        // 0.3 para respostas conversacionais. Para extração estruturada, use 0:
        // com 0.3 os mesmos campos variavam entre execuções
        // (ex.: "635,62" vs "R$ 635,62", razão social truncada).
        temperature: 0.3,
        maxRetries: 2,
        // Sem isto o ChatOpenAI pede o contexto inteiro do modelo como
        // max_tokens (~116k), o que estoura o limite de gasto da chave no
        // OpenRouter com HTTP 402. Também dá efeito ao max_length declarado
        // em prompts/answerPrompt.json, que antes era só documental.
        maxTokens: 1024,
        // "functionCalling" é o único método suportado pelos três modelos
        // testados via OpenRouter (gemma-3-27b-it, nemotron-3.5-lightning,
        // claude-haiku-4.5). "jsonMode" falha em todos; "jsonSchema" falha no
        // nemotron.
        structuredOutputMethod: "functionCalling" as const,
        defaultHeaders: {
            "HTTP-Referer": process.env.OPENROUTER_SITE_URL,
            "X-Title": process.env.OPENROUTER_SITE_NAME,
        }
    },
    oracle: {
        user: process.env.ORACLE_USER!,
        password: process.env.ORACLE_PASSWORD!,
        connectString: process.env.ORACLE_CONNECT_STRING!,
        clientLibDir: process.env.ORACLE_CLIENT_LIB_DIR?.trim() || undefined,
        configDir: process.env.ORACLE_TNS_ADMIN?.trim() || undefined,
        table: identifier(process.env.ORACLE_PDF_TABLE, 'ORACLE_PDF_TABLE', 'DOCUMENTOS'),
        idColumn: identifier(process.env.ORACLE_PDF_ID_COLUMN, 'ORACLE_PDF_ID_COLUMN', 'ID'),
        nameColumn: identifier(process.env.ORACLE_PDF_NAME_COLUMN, 'ORACLE_PDF_NAME_COLUMN', 'NOME'),
        blobColumn: identifier(process.env.ORACLE_PDF_BLOB_COLUMN, 'ORACLE_PDF_BLOB_COLUMN', 'ARQUIVO'),
        query: process.env.ORACLE_PDF_QUERY?.trim() || undefined,
        maxDocs: positiveInt(process.env.ORACLE_PDF_MAX_DOCS, 'ORACLE_PDF_MAX_DOCS', 10),
        poolMin: positiveInt(process.env.ORACLE_POOL_MIN, 'ORACLE_POOL_MIN', 1),
        poolMax: positiveInt(process.env.ORACLE_POOL_MAX, 'ORACLE_POOL_MAX', 4),
    } satisfies OracleConfig,
    pdf: {
        // O default do PDFLoader é "", que cola os text items do pdf.js e produz
        // "ValordoServiço" / "R$635,62". Com " " o texto sai com fronteiras de
        // palavra ("Valor do Serviço", "R$ 635,62"), o que melhora os embeddings.
        // Em troca aparecem artefatos como "NFS- e" e "CNPJ / CPF / NIF".
        parsedItemSeparator: " ",
    },
    textSplitter: {
        chunkSize: 1000,
        chunkOverlap: 200,
    },
    embedding: {
        modelName: process.env.EMBEDDING_MODEL!,
        pretrainedOptions: {
            dtype: "fp32" as DataType, // Options: 'fp32' (best quality), 'fp16' (faster), 'q8', 'q4', 'q4f16' (quantized)
        } satisfies PretrainedModelOptions,
    },
    similarity: {
        // 8 e não 3: a base tem ~28 chunks de 9 notas, e as perguntas agregadas
        // ("quais prestadores aparecem?") precisam alcançar vários documentos.
        // Com topK: 3 a resposta cobria no máximo 2 ou 3 notas.
        topK: 8,
    },
});
