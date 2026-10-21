import { CONFIG } from "./config.ts";
import { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { clearGraph, setupGraph } from "./graph.ts";
import { corrigirPeloConjunto, processRecord, setupDocumentos } from "./ingest.ts";
import { createAI, createChatModel, createEmbeddings } from "./models.ts";
import { NfseExtractor } from "./nfseExtractor.ts";
import { OraclePdfRepository } from "./oracle.ts";
import { formatAnswerForDisk, stripCodeFences } from "./util.ts";
import { writeFile, mkdir, readFile } from 'node:fs/promises'

let _neo4jVectorStore: any = null;
const oracleRepository = new OraclePdfRepository(CONFIG.oracle);

/**
 * Lê as perguntas de CONFIG.output.questionsFile: uma por linha, ignorando
 * linhas vazias e comentários (#). Sem o arquivo, usa as perguntas padrão.
 */
async function loadQuestions(defaults: string[]): Promise<string[]> {
    const file = CONFIG.output.questionsFile;
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        console.log(`❓ ${file} não existe — usando as ${defaults.length} perguntas padrão.`);
        return defaults;
    }
    const questions = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (!questions.length) throw new Error(`${file} não tem perguntas (linhas vazias e com # são ignoradas).`);
    console.log(`❓ ${questions.length} pergunta(s) lida(s) de ${file}.`);
    return questions;
}

async function clearAll(vectorStore: Neo4jVectorStore, modelLabel: string) {
    console.log(`Clearing all nodes with label: ${modelLabel}`);
    await vectorStore.query(`MATCH (n:${modelLabel}) DETACH DELETE n`);
    console.log(`All nodes with label ${modelLabel} have been deleted.`);
}

/**
 * Reindexa do zero: apaga chunks e grafo, lê os PDFs do Oracle (com OCR
 * quando preciso), grava os chunks e, com a extração ligada, as notas no grafo.
 */
async function ingest(vectorStore: Neo4jVectorStore, extractor: NfseExtractor | null) {
    await oracleRepository.connect();

    // Precisa de await: sem ele o DETACH DELETE corre em paralelo com o
    // addDocuments abaixo e pode apagar os chunks recém-inseridos.
    await clearAll(vectorStore, CONFIG.neo4j.nodeLabel);
    await clearGraph(vectorStore);
    await setupGraph(vectorStore);
    await setupDocumentos(vectorStore);

    let documentCount = 0;
    let chunkCount = 0;

    for await (const record of oracleRepository.streamPdfs()) {
        const { chunks } = await processRecord(vectorStore, extractor, record);
        if (!chunks) continue;
        documentCount++;
        chunkCount += chunks;
    }

    if (documentCount === 0) {
        throw new Error(
            `Nenhum PDF indexado. Verifique a tabela "${CONFIG.oracle.table}" e as colunas configuradas no .env, ` +
            `ou rode "npm run oracle:check" para inspecionar o que a query retorna.`
        );
    }

    console.log(`\n📚 Total: ${chunkCount} chunks de ${documentCount} documento(s) do Oracle.`);
    if (extractor) await corrigirPeloConjunto(vectorStore);
}

/** Com SKIP_INGEST, confere que há uma indexação anterior para responder. */
async function checkExistingIndex(vectorStore: Neo4jVectorStore) {
    const [row] = await vectorStore.query(
        `MATCH (c:${CONFIG.neo4j.nodeLabel}) WITH count(c) AS chunks
         OPTIONAL MATCH (n:Nota) RETURN chunks, count(n) AS notas`
    );
    const chunks = Number(row?.chunks ?? 0);
    const notas = Number(row?.notas ?? 0);
    if (chunks === 0) {
        throw new Error(`SKIP_INGEST=true, mas o Neo4j está vazio. Rode uma vez sem SKIP_INGEST para indexar.`);
    }
    console.log(`⏭️  SKIP_INGEST: usando a indexação existente (${chunks} chunks, ${notas} NFS-e no grafo).`);
    if (CONFIG.extraction.enabled && notas === 0) {
        console.warn(`⚠️  Nenhuma Nota no grafo: as perguntas agregadas vão cair na busca nos trechos.`);
    }
}

try {
    console.log("Starting document processing...");

    const embeddings = createEmbeddings();
    const structuredModel = createChatModel(0);

    _neo4jVectorStore = await Neo4jVectorStore.fromExistingGraph(embeddings, CONFIG.neo4j);

    const extractor = CONFIG.extraction.enabled
        ? new NfseExtractor(structuredModel, CONFIG.extraction.maxChars)
        : null;

    if (CONFIG.ingest.skip) {
        await checkExistingIndex(_neo4jVectorStore);
    } else {
        await ingest(_neo4jVectorStore, extractor);
    }

    // A base indexa VÁRIAS notas ao mesmo tempo, então perguntas no singular
    // ("qual o valor desta nota?") não têm referente: a busca vetorial traz
    // chunks de notas diferentes e a resposta mistura documentos.
    //
    // Dois padrões funcionam aqui:
    //   1. agregadas — sobre o conjunto ("quais prestadores aparecem?")
    //   2. direcionadas — a pergunta identifica a nota ("na nota do prestador X")
    //
    // Com o grafo (EXTRACTION_ENABLED), as agregadas são respondidas por Cypher
    // sobre todas as notas. Sem ele, ficam limitadas por topK: só os chunks
    // recuperados são vistos, e a resposta cobre parte do acervo.
    const defaultQuestions = [
        "Quais prestadores de serviço aparecem nas notas e quais são os CNPJs de cada um?",
        "Em quais municípios e UFs os serviços foram prestados?",
        "Que tipos de serviço aparecem nas notas, como comissão, premiação ou propaganda?",
        // Nome de exemplo: em perguntas.txt, troque pelo de um prestador da sua
        // base. Identificar a nota na própria pergunta é o que leva a consulta
        // ao grafo (ou a busca nos trechos) àquele documento específico.
        "Na nota do prestador ACME REPRESENTACOES, qual é o valor do serviço e a data de emissão?",
        "Alguma das notas apresenta retenção de ISSQN ou de tributos federais? Em quais valores?"
    ];
    const questions = await loadQuestions(defaultQuestions);

    const ai = createAI(_neo4jVectorStore);

    for (const index in questions) {
        const question = questions[index];
        console.log(`\n${'='.repeat(80)}\n`);
        console.log(`Processing question: ${question}`);
        console.log(`\n${'='.repeat(80)}\n`);

        const results = await ai.anwerQuestion(question!);
        if (results.error) {
            console.log(`\n❌ ${results.error}\n`);
            continue
        }
        console.log(`💬 Resposta:\n`);
        console.log(`${stripCodeFences(results.answer!)}\n`);
        await mkdir(CONFIG.output.answersFolder, { recursive: true })

        const { content, extension } = formatAnswerForDisk(results.answer!);
        const fileName = `${CONFIG.output.answersFolder}/${CONFIG.output.fileName}-${index}-${Date.now()}.${extension}`

        await writeFile(fileName, content)
        console.log(`💾 ${fileName}`);
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log("✅ Processamento concluído com sucesso!\n");

} catch (error) {
    console.error("Error occurred:", error);
    process.exitCode = 1;
} finally {
    await oracleRepository.close();
    await _neo4jVectorStore?.close();
}
