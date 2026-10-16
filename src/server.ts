/**
 * Servidor de perguntas no formato da API da OpenAI, para o Open WebUI (ou
 * qualquer cliente OpenAI) conversar com a base de NFS-e.
 *
 *   GET  /health                → sem autenticação; confere o Neo4j
 *   GET  /v1/models             → um único "modelo" (API_MODEL_NAME)
 *   POST /v1/chat/completions   → responde a última mensagem do usuário
 *
 * Por dentro roda a mesma cadeia do npm start: roteador → grafo ou trechos →
 * resposta. Antes dela, as últimas API_HISTORY_TURNS trocas da conversa servem
 * para reescrever uma pergunta de continuação ("e o valor dela?") como
 * pergunta completa.
 *
 * As perguntas são atendidas uma por vez: o LLM local divide a GPU de 4 GB e,
 * em paralelo, as duas ficariam lentas. Acima de API_MAX_QUEUE na fila, 503.
 */
import { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CONFIG } from "./config.ts";
import { type Turno } from "./ai.ts";
import { createAI, createEmbeddings } from "./models.ts";
import { stripCodeFences } from "./util.ts";

const { host, port, key, modelName, maxQueue, historyTurns } = CONFIG.api;
const MAX_BODY_BYTES = 1024 * 1024;

if (!key) {
    console.error("❌ RAG_API_KEY não está definida no .env. Gere uma com: openssl rand -hex 32");
    process.exit(1);
}

class HttpError extends Error {
    // Sem "parameter properties": o Node só remove tipos, não gera código.
    readonly status: number;
    readonly type: string;
    constructor(status: number, message: string, type = "invalid_request_error") {
        super(message);
        this.status = status;
        this.type = type;
    }
}

/** Fila de uma posição: cada pergunta espera a anterior terminar. */
let fila: Promise<unknown> = Promise.resolve();
let naFila = 0;

function enfileirar<T>(tarefa: () => Promise<T>): Promise<T> {
    if (naFila >= maxQueue) {
        throw new HttpError(503, `Muitas perguntas na fila (${naFila}). Tente de novo em alguns minutos.`, "server_busy");
    }
    naFila++;
    const resultado = fila.then(tarefa);
    fila = resultado.catch(() => undefined).finally(() => { naFila--; });
    return resultado;
}

function autorizado(req: IncomingMessage): boolean {
    const recebido = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
    const esperado = Buffer.from(key);
    return recebido.length === esperado.length && timingSafeEqual(recebido, esperado);
}

async function lerJson(req: IncomingMessage): Promise<any> {
    const partes: Buffer[] = [];
    let total = 0;
    for await (const parte of req) {
        total += parte.length;
        if (total > MAX_BODY_BYTES) throw new HttpError(413, "Corpo da requisição grande demais.");
        partes.push(parte);
    }
    try {
        return JSON.parse(Buffer.concat(partes).toString("utf8"));
    } catch {
        throw new HttpError(400, "JSON inválido.");
    }
}

/** Texto de uma mensagem (string ou partes {type: "text"}). */
function textoDe(mensagem: any): string {
    const conteudo = mensagem?.content;
    const texto = typeof conteudo === "string"
        ? conteudo
        : Array.isArray(conteudo)
            ? conteudo.filter(p => p?.type === "text").map(p => p.text).join("\n")
            : "";
    return texto.trim();
}

/**
 * A última mensagem do usuário e, antes dela, até `historyTurns` trocas
 * completas (pergunta seguida de resposta). Mensagens de sistema e perguntas
 * que ficaram sem resposta não entram no histórico.
 */
function lerConversa(messages: unknown): { pergunta: string, historico: Turno[] } {
    if (!Array.isArray(messages)) throw new HttpError(400, "\"messages\" deve ser uma lista.");
    let indiceUltima = messages.length - 1;
    while (indiceUltima >= 0 && messages[indiceUltima]?.role !== "user") indiceUltima--;
    const pergunta = textoDe(messages[indiceUltima]);
    if (!pergunta) throw new HttpError(400, "Nenhuma mensagem de usuário com texto.");

    const historico: Turno[] = [];
    for (let i = 0; i < indiceUltima; i++) {
        const atual = messages[i], seguinte = messages[i + 1];
        if (atual?.role === "user" && seguinte?.role === "assistant" && textoDe(atual) && textoDe(seguinte)) {
            historico.push({ pergunta: textoDe(atual), resposta: textoDe(seguinte) });
        }
    }
    return { pergunta, historico: historyTurns ? historico.slice(-historyTurns) : [] };
}

function enviarJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

function enviarEvento(res: ServerResponse, body: unknown): void {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
}

/**
 * Conecta ao Neo4j com novas tentativas: no boot da máquina (ou logo após
 * recriar o container) o Neo4j aceita a conexão antes de terminar de subir.
 */
async function conectarNeo4j(tentativas = 20, intervaloMs = 3000): Promise<Neo4jVectorStore> {
    for (let i = 1; ; i++) {
        try {
            return await Neo4jVectorStore.fromExistingGraph(createEmbeddings(), CONFIG.neo4j);
        } catch (error) {
            if (i >= tentativas) throw error;
            console.warn(`⏳ Neo4j indisponível (${(error as Error).message}) — tentativa ${i}/${tentativas}.`);
            await new Promise(resolve => setTimeout(resolve, intervaloMs));
        }
    }
}

const store = await conectarNeo4j();
const ai = createAI(store);

function responder(pergunta: string, historico: Turno[], aindaConectado: () => boolean): Promise<string | null> {
    return enfileirar(async () => {
        // Quem desistiu enquanto esperava na fila não ocupa a GPU.
        if (!aindaConectado()) return null;
        const inicio = Date.now();
        const resultado = await ai.anwerQuestion(pergunta, historico);
        console.log(`⏱️  Pergunta respondida em ${((Date.now() - inicio) / 1000).toFixed(0)} s (rota: ${resultado.route ?? "-"}).`);
        return stripCodeFences(resultado.answer ?? resultado.error ?? "Não consegui gerar uma resposta.");
    });
}

async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await lerJson(req);
    const { pergunta, historico } = lerConversa(body.messages);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof body.model === "string" ? body.model : modelName;
    let desconectou = false;
    res.on("close", () => { if (!res.writableEnded) desconectou = true; });

    if (!body.stream) {
        const resposta = await responder(pergunta, historico, () => !desconectou);
        if (resposta === null) return;
        return enviarJson(res, 200, {
            id, object: "chat.completion", created, model,
            choices: [{ index: 0, message: { role: "assistant", content: resposta }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
    }

    // Erros de fila (503) saem antes de abrir o stream, como HTTP comum.
    const promessa = responder(pergunta, historico, () => !desconectou);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const chunk = (delta: object, finish_reason: string | null = null) =>
        ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] });
    enviarEvento(res, chunk({ role: "assistant", content: "" }));
    // A resposta leva de 5 s a minutos (fila): comentários SSE mantêm a
    // conexão viva sem aparecer no chat.
    const keepAlive = setInterval(() => res.write(": aguardando\n\n"), 10_000);
    try {
        const resposta = await promessa;
        if (resposta === null || desconectou) return;
        enviarEvento(res, chunk({ content: resposta }));
        enviarEvento(res, chunk({}, "stop"));
    } catch (error) {
        console.error("❌ Falha ao responder:", error);
        enviarEvento(res, chunk({ content: "\n\n⚠️ Erro ao gerar a resposta. Tente novamente." }, "stop"));
    } finally {
        clearInterval(keepAlive);
        if (!res.writableEnded) {
            res.write("data: [DONE]\n\n");
            res.end();
        }
    }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
        if (req.method === "GET" && url.pathname === "/health") {
            await store.query("RETURN 1");
            return enviarJson(res, 200, { status: "ok", naFila });
        }
        if (!autorizado(req)) throw new HttpError(401, "Chave de API inválida.", "authentication_error");

        if (req.method === "GET" && url.pathname === "/v1/models") {
            return enviarJson(res, 200, {
                object: "list",
                data: [{ id: modelName, object: "model", created: 0, owned_by: "nfse-oracle-neo4j-rag" }],
            });
        }
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            return await chatCompletions(req, res);
        }
        throw new HttpError(404, `Rota ${req.method} ${url.pathname} não existe.`);
    } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error("❌ Erro inesperado:", error);
        if (res.headersSent) return void res.end();
        enviarJson(res, status, {
            error: {
                message: error instanceof HttpError ? error.message : "Erro interno.",
                type: error instanceof HttpError ? error.type : "server_error",
            },
        });
    }
});

server.listen(port, host, () => {
    console.log(`🚀 API de perguntas em http://${host}:${port}/v1 — modelo "${modelName}", LLM ${CONFIG.llm.nlpModel}`);
});

async function encerrar(): Promise<void> {
    console.log("\n👋 Encerrando...");
    server.close();
    await store.close();
    process.exit(0);
}
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);
