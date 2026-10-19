import { readFileSync } from 'node:fs'
import type { OcrConfig } from "./ocr.ts";

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
    /** Data de inclusão da linha (ex.: INCLUIDO_EM). Opcional; usada por INGEST_SINCE. */
    dateColumn?: string;
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

function idList(value: string | undefined, envName: string): string[] {
    const ids = (value ?? "").split(",").map(id => id.trim()).filter(Boolean);
    const invalid = ids.find(id => !/^\d+$/.test(id));
    if (invalid) throw new Error(`${envName}: "${invalid}" não é um ID numérico.`);
    return ids;
}

function isoDate(value: string | undefined, envName: string): string | undefined {
    if (!value?.trim()) return undefined;
    const resolved = value.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(resolved) || Number.isNaN(Date.parse(resolved))) {
        throw new Error(`${envName}="${value}" deve ser uma data no formato aaaa-mm-dd.`);
    }
    return resolved;
}

export const CONFIG = Object.freeze({
    promptConfig: JSON.parse(readFileSync(promptsFiles.answerPrompt, 'utf-8')),
    templateText: readFileSync(promptsFiles.template, 'utf-8'),
    output: {
        answersFolder: './respostas',
        fileName: 'resposta',
        // Perguntas a responder, uma por linha (# comenta). Fica fora do git
        // porque costuma citar prestadores reais. Sem o arquivo, valem as
        // perguntas padrão de src/index.ts.
        questionsFile: process.env.QUESTIONS_FILE?.trim() || './perguntas.txt',
    },
    neo4j: {
        url: process.env.NEO4J_URI!,
        username: process.env.NEO4J_USER!,
        password: process.env.NEO4J_PASSWORD!,
        indexName: "tensors_index",
        // "hybrid" soma a busca por palavra-chave (índice FULLTEXT) à vetorial:
        // ajuda perguntas com termos exatos (CNPJ, "Retido", nome de empresa).
        // Os scores dos dois lados são normalizados pelo maior de cada um.
        searchType: (process.env.SEARCH_TYPE?.trim() === "vector" ? "vector" : "hybrid") as "vector" | "hybrid",
        keywordIndexName: "chunk_keyword_index",
        textNodeProperties: ["text"],
        nodeLabel: "Chunk",
    },
    llm: {
        // Ollama expõe uma API compatível com a da OpenAI, então o ChatOpenAI
        // segue o mesmo. Com o servidor local logado (`ollama signin`), modelos
        // `:cloud` como gemma4:cloud rodam na nuvem do Ollama sem chave no código.
        nlpModel: process.env.NLP_MODEL,
        url: process.env.LLM_BASE_URL?.trim() || "http://localhost:11434/v1",
        // O servidor local ignora a chave, mas o cliente da OpenAI exige um valor.
        // Para chamar https://ollama.com/v1 direto, use a chave de OLLAMA_API_KEY.
        apiKey: process.env.OLLAMA_API_KEY?.trim() || "ollama",
        // 0.3 para respostas conversacionais. Para extração estruturada, use 0:
        // com 0.3 os mesmos campos variavam entre execuções
        // (ex.: "635,62" vs "R$ 635,62", razão social truncada).
        temperature: 0.3,
        maxRetries: 2,
        // Limita o tamanho da resposta. Também dá efeito ao max_length
        // declarado em prompts/answerPrompt.json, que antes era só documental.
        maxTokens: 1024,
        // Modelos com "thinking" (ex.: gemma4 local) gastam o maxTokens no
        // raciocínio e devolvem resposta vazia. "none" desliga o thinking na
        // API compatível com OpenAI do Ollama. Vazio = padrão do modelo.
        reasoningEffort: process.env.LLM_REASONING_EFFORT?.trim() || undefined,
        // "functionCalling" envia o schema como tool, que a API compatível
        // com OpenAI do Ollama suporta.
        structuredOutputMethod: "functionCalling" as const,
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
        dateColumn: process.env.ORACLE_PDF_DATE_COLUMN?.trim()
            ? identifier(process.env.ORACLE_PDF_DATE_COLUMN, 'ORACLE_PDF_DATE_COLUMN', '')
            : undefined,
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
        // Gerado localmente pelo Ollama (`ollama pull embeddinggemma`).
        // Trocar de modelo muda a dimensão dos vetores: apague o índice
        // vetorial do Neo4j antes (npm run clean) e reindexe.
        modelName: process.env.EMBEDDING_MODEL?.trim() || "embeddinggemma",
        baseUrl: process.env.OLLAMA_HOST?.trim() || "http://localhost:11434",
    },
    ocr: {
        // PDFs sem camada de texto (escaneados/fotografados) passam por OCR
        // local: `ollama pull glm-ocr` e `pdftoppm` (poppler-utils).
        enabled: process.env.OCR_ENABLED?.trim().toLowerCase() !== "false",
        model: process.env.OCR_MODEL?.trim() || "glm-ocr",
        baseUrl: process.env.OLLAMA_HOST?.trim() || "http://localhost:11434",
        // O tempo é dominado pela leitura da imagem, não pela geração. Numa
        // foto de NFS-e A4 (GTX 1650): 150 dpi ≈ 70 s/página, 100 dpi ≈ 30 s,
        // com os mesmos números, datas, CNPJs e valores; só nomes longos
        // ganham erros pontuais. Suba se o OCR errar campos importantes.
        // É o dpi de uma A4: páginas maiores são reduzidas a esse tamanho
        // em pixels (ver renderPages em src/ocr.ts).
        dpi: positiveInt(process.env.OCR_DPI, 'OCR_DPI', 100),
        // Uma página densa de NFS-e rende ~1000 tokens; o resto seria o loop
        // de repetição do fim da página (ver src/ocr.ts).
        maxTokensPerPage: 2000,
        // 8192 mantém o glm-ocr 100% na GPU de 4 GB. Com 16384 metade do
        // modelo ia para a CPU e cada página demorava ~100 s.
        numCtx: 8192,
    } satisfies OcrConfig,
    extraction: {
        // Extrai os campos de cada NFS-e na ingestão e monta o grafo
        // (Empresa)-[:PRESTOU]->(Nota). ~8–12 s por documento com o LLM local.
        enabled: process.env.EXTRACTION_ENABLED?.trim().toLowerCase() !== "false",
        // ~4K tokens: cabe no contexto de 8K do gemma4-e2b-8k com o schema e a
        // resposta. Os campos de uma NFS-e ficam no início do documento.
        maxChars: 12000,
        // Linhas do grafo levadas ao contexto da resposta.
        maxRows: 60,
    },
    ingest: {
        // "true" pula Oracle, OCR e extração e só responde às perguntas sobre o
        // que já está no Neo4j: segundos em vez dos ~45 min de reindexar 100
        // PDFs. Útil para testar prompts, rotas e perguntas.
        skip: process.env.SKIP_INGEST?.trim().toLowerCase() === "true",
        // Indexação incremental (npm run index): para de pegar documentos novos
        // depois deste tempo, para a rodada da madrugada não invadir o
        // expediente. O documento em andamento termina.
        maxMinutes: positiveInt(process.env.INGEST_MAX_MINUTES, 'INGEST_MAX_MINUTES', 300),
        // Teto de documentos por rodada; vazio = sem teto (só o de tempo).
        maxDocs: process.env.INGEST_MAX_DOCS?.trim()
            ? positiveInt(process.env.INGEST_MAX_DOCS, 'INGEST_MAX_DOCS', 1)
            : Number.POSITIVE_INFINITY,
        // Só documentos incluídos a partir desta data (aaaa-mm-dd), pela coluna
        // ORACLE_PDF_DATE_COLUMN. Vazio = o acervo inteiro, dos mais novos aos
        // mais antigos.
        since: isoDate(process.env.INGEST_SINCE, 'INGEST_SINCE'),
        // IDs a reprocessar mesmo já indexados (ex.: "15027,15032"), depois de
        // uma correção no extrator. Com a lista, a rodada processa só eles.
        reprocess: idList(process.env.INGEST_REPROCESS, 'INGEST_REPROCESS'),
    },
    api: {
        // Servidor de perguntas (npm run serve), no formato da API da OpenAI
        // para o Open WebUI. Só escuta na própria máquina: quem fica exposto na
        // rede é o Open WebUI, com login.
        host: process.env.API_HOST?.trim() || "127.0.0.1",
        port: positiveInt(process.env.API_PORT, 'API_PORT', 8000),
        // Chave que o Open WebUI manda em "Authorization: Bearer ...".
        key: process.env.RAG_API_KEY?.trim() || "",
        // Nome do "modelo" que aparece no Open WebUI.
        modelName: process.env.API_MODEL_NAME?.trim() || "nfse",
        // A GPU atende uma pergunta por vez; acima disso a API responde 503
        // em vez de deixar a pessoa esperando minutos.
        maxQueue: positiveInt(process.env.API_MAX_QUEUE, 'API_MAX_QUEUE', 10),
        // Trocas anteriores (pergunta + resposta) usadas para entender uma
        // pergunta de continuação ("e o valor dela?"). 0 desliga o histórico:
        // cada mensagem vira uma pergunta independente.
        historyTurns: process.env.API_HISTORY_TURNS?.trim() === "0"
            ? 0
            : positiveInt(process.env.API_HISTORY_TURNS, 'API_HISTORY_TURNS', 3),
    },
    similarity: {
        // 8 e não 3: a base tem ~28 chunks de 9 notas, e as perguntas agregadas
        // ("quais prestadores aparecem?") precisam alcançar vários documentos.
        // Com topK: 3 a resposta cobria no máximo 2 ou 3 notas.
        topK: 8,
    },
});
