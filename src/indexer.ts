/**
 * Indexação incremental: processa só os PDFs do Oracle que ainda não estão no
 * Neo4j, sem apagar nada. Feita para rodar agendada (scripts/indexar.sh).
 *
 * Pendentes = IDs do Oracle − IDs já processados no Neo4j. Por ser diferença
 * de conjuntos, e não "maior ID visto", pega também o acervo antigo ainda não
 * indexado e linhas gravadas fora de ordem.
 *
 * Ordem: do mais novo para o mais antigo, então os documentos do dia entram
 * primeiro e o acervo vai sendo consumido nas rodadas seguintes. Cada rodada
 * para em INGEST_MAX_MINUTES / INGEST_MAX_DOCS; o restante fica para a próxima.
 */
import { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { CONFIG } from "./config.ts";
import { setupGraph } from "./graph.ts";
import { corrigirPeloConjunto, processedIds, processRecord, setupDocumentos, type DocumentoStatus } from "./ingest.ts";
import { createChatModel, createEmbeddings } from "./models.ts";
import { NfseExtractor } from "./nfseExtractor.ts";
import { OraclePdfRepository } from "./oracle.ts";

const oracleRepository = new OraclePdfRepository(CONFIG.oracle);
let store: Neo4jVectorStore | null = null;
const started = Date.now();
const minutos = () => (Date.now() - started) / 60_000;

try {
    const { maxMinutes, maxDocs, since, reprocess } = CONFIG.ingest;
    console.log(
        `🗓️  Indexação incremental — ${new Date().toLocaleString("pt-BR")} — LLM ${CONFIG.llm.nlpModel}, ` +
        `limite ${maxMinutes} min` + (Number.isFinite(maxDocs) ? ` / ${maxDocs} documento(s)` : "") +
        (reprocess.length ? `, reprocessando ${reprocess.length} ID(s) informado(s)` : since ? `, incluídos desde ${since}` : "")
    );

    await oracleRepository.connect();
    store = await Neo4jVectorStore.fromExistingGraph(createEmbeddings(), CONFIG.neo4j);
    await setupGraph(store);
    await setupDocumentos(store);

    const feitos = await processedIds(store);
    // Com INGEST_REPROCESS, só os IDs pedidos — já indexados ou não. O
    // processRecord apaga os chunks e a nota antigos antes de gravar.
    const pendentes = reprocess.length
        ? reprocess
        : (await oracleRepository.listIds({ since })).filter(id => !feitos.has(id));
    console.log(`📋 ${pendentes.length} documento(s) pendente(s); ${feitos.size} já processado(s).`);

    const extractor = CONFIG.extraction.enabled
        ? new NfseExtractor(createChatModel(0), CONFIG.extraction.maxChars, CONFIG.llm.schemaMethod)
        : null;
    const contagem: Record<DocumentoStatus, number> = { indexado: 0, sem_texto: 0, nao_nfse: 0, falha_extracao: 0 };
    let processados = 0;
    let motivoParada: string | null = null;

    for await (const record of oracleRepository.streamPdfsByIds(pendentes)) {
        const { status } = await processRecord(store, extractor, record);
        contagem[status]++;
        processados++;
        if (processados >= maxDocs) { motivoParada = `limite de ${maxDocs} documento(s)`; break; }
        if (minutos() >= maxMinutes) { motivoParada = `limite de ${maxMinutes} min`; break; }
    }

    if (processados && extractor) await corrigirPeloConjunto(store);
    console.log(
        `\n✅ ${processados} documento(s) em ${minutos().toFixed(0)} min — ` +
        Object.entries(contagem).map(([s, n]) => `${s}: ${n}`).join(", ") + ". " +
        (motivoParada
            ? `Parou por ${motivoParada}; ${pendentes.length - processados} ficam para a próxima rodada.`
            : "Nada pendente.")
    );
} catch (error) {
    console.error("❌ Indexação falhou:", error);
    process.exitCode = 1;
} finally {
    await oracleRepository.close();
    await store?.close();
}
