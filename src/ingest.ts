import { type Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { CONFIG } from "./config.ts";
import { DocumentProcessor } from "./documentProcessor.ts";
import { consolidarEmpresas, corrigirPapeisPeloConjunto, saveNota } from "./graph.ts";
import { type NfseExtractor } from "./nfseExtractor.ts";
import { type PdfRecord } from "./oracle.ts";

/**
 * Resultado de um documento, gravado em (:Documento {oracleId, status}).
 * Todo documento processado é registrado, inclusive os que não viraram nota:
 * sem isso a indexação incremental os tentaria de novo a cada rodada.
 */
export type DocumentoStatus =
    /** Chunks gravados e, com a extração ligada, a nota no grafo. */
    | "indexado"
    /** Sem camada de texto e o OCR não reconheceu nada (ou está desligado). */
    | "sem_texto"
    /** Chunks gravados; o LLM classificou o documento como não sendo NFS-e. */
    | "nao_nfse"
    /** Chunks gravados; a extração falhou (ex.: "token repeat limit"). */
    | "falha_extracao";

export interface ProcessResult {
    status: DocumentoStatus;
    chunks: number;
}

export async function setupDocumentos(store: Neo4jVectorStore): Promise<void> {
    await store.query("CREATE CONSTRAINT documento_oracle_id IF NOT EXISTS FOR (d:Documento) REQUIRE d.oracleId IS UNIQUE");
}

/**
 * IDs já processados. Inclui os IDs dos chunks porque indexações anteriores
 * ao (:Documento) só deixaram os chunks.
 */
export async function processedIds(store: Neo4jVectorStore): Promise<Set<string>> {
    const rows = await store.query(
        `MATCH (d:Documento) RETURN d.oracleId AS id
         UNION
         MATCH (c:${CONFIG.neo4j.nodeLabel}) WHERE c.oracleId IS NOT NULL RETURN DISTINCT c.oracleId AS id`
    );
    return new Set(rows.map(row => String(row.id)));
}

/**
 * Indexa um PDF: chunks com embeddings e, com o extrator, a nota no grafo.
 * Apaga antes o que houver do mesmo oracleId, então pode ser repetido sem
 * duplicar chunks (ex.: rodada interrompida no meio do documento).
 */
export async function processRecord(
    store: Neo4jVectorStore,
    extractor: NfseExtractor | null,
    record: PdfRecord,
): Promise<ProcessResult> {
    console.log(`\n📥 ${record.sourceLabel} (${record.name}, ${(record.data.length / 1024).toFixed(0)} KB)`);
    await store.query(
        `OPTIONAL MATCH (c:${CONFIG.neo4j.nodeLabel} {oracleId: $id})
         OPTIONAL MATCH (n:Nota {oracleId: $id})
         DETACH DELETE c, n`,
        { id: record.id }
    );

    const documentProcessor = new DocumentProcessor(record, CONFIG.textSplitter);
    const chunks = await documentProcessor.loadAndSplit();

    if (!chunks.length) {
        console.warn(
            `⚠️  Nenhum texto extraído de ${record.sourceLabel} — PDF sem camada de texto ` +
            (CONFIG.ocr.enabled ? `e o OCR não reconheceu nada.` : `(OCR desligado em OCR_ENABLED).`)
        );
        return marcar(store, record, { status: "sem_texto", chunks: 0 });
    }

    await store.addDocuments(chunks);
    console.log(`✅ ${chunks.length} chunks indexados no Neo4j.`);
    if (!extractor) return marcar(store, record, { status: "indexado", chunks: chunks.length });

    try {
        const started = Date.now();
        const { nota, descartes } = await extractor.extract(documentProcessor.fullText);
        for (const motivo of descartes) console.log(`   ↳ ${motivo}`);
        if (!nota) return marcar(store, record, { status: "nao_nfse", chunks: chunks.length });

        await saveNota(store, record, nota);
        console.log(
            `🕸️  Nota ${nota.numero ?? "?"} no grafo (${((Date.now() - started) / 1000).toFixed(0)} s): ` +
            `prestador ${nota.prestador.nome ?? "?"}, valor ${nota.valorTotal ?? "?"}, ` +
            `ISS retido ${nota.issRetido ?? "-"}, IRRF retido ${nota.irrfRetido ?? "-"}`
        );
        return marcar(store, record, { status: "indexado", chunks: chunks.length });
    } catch (error) {
        // A extração enriquece o grafo; os chunks já estão salvos e a
        // busca nos trechos continua funcionando para este documento.
        console.warn(`⚠️  Extração falhou em ${record.sourceLabel}: ${(error as Error).message}`);
        return marcar(store, record, { status: "falha_extracao", chunks: chunks.length });
    }
}

async function marcar(store: Neo4jVectorStore, record: PdfRecord, result: ProcessResult): Promise<ProcessResult> {
    await store.query(
        `MERGE (d:Documento {oracleId: $id})
         SET d.nome = $nome, d.status = $status, d.chunks = $chunks, d.processadoEm = datetime()`,
        { id: record.id, nome: record.name, status: result.status, chunks: result.chunks }
    );
    return result;
}

/**
 * Correções que dependem do conjunto de notas (papéis trocados, nomes de
 * empresa em CNPJ errado). Só mexem no que está errado, então podem rodar
 * após cada lote sem desfazer correções anteriores.
 */
export async function corrigirPeloConjunto(store: Neo4jVectorStore): Promise<void> {
    const corrigidas = await corrigirPapeisPeloConjunto(store);
    const { nomesRemovidos, unidas } = await consolidarEmpresas(store);
    const [row] = await store.query("MATCH (n:Nota) RETURN count(n) AS notas");
    console.log(
        `🕸️  ${row?.notas ?? 0} NFS-e no grafo. Correções pelo conjunto: ${corrigidas} nota(s) com prestador/tomador ` +
        `trocados, ${nomesRemovidos} nome(s) de empresa removidos de outro CNPJ, ${unidas} empresa(s) sem CNPJ unida(s).`
    );
}
