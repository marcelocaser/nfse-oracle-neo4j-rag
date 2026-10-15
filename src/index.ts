import { OllamaEmbeddings } from "@langchain/ollama";
import { CONFIG } from "./config.ts";
import { DocumentProcessor } from "./documentProcessor.ts";
import { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { ChatOpenAI } from "@langchain/openai";
import { AI } from "./ai.ts";
import { clearGraph, consolidarEmpresas, corrigirPapeisPeloConjunto, saveNota, setupGraph } from "./graph.ts";
import { NfseExtractor } from "./nfseExtractor.ts";
import { OraclePdfRepository } from "./oracle.ts";
import { formatAnswerForDisk, stripCodeFences } from "./util.ts";
import { writeFile, mkdir } from 'node:fs/promises'

let _neo4jVectorStore: any = null;
const oracleRepository = new OraclePdfRepository(CONFIG.oracle);

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
    let notaCount = 0;

    let documentCount = 0;
    let chunkCount = 0;

    for await (const record of oracleRepository.streamPdfs()) {
        console.log(`\n📥 ${record.sourceLabel} (${record.name}, ${(record.data.length / 1024).toFixed(0)} KB)`);

        const documentProcessor = new DocumentProcessor(record, CONFIG.textSplitter);
        const chunks = await documentProcessor.loadAndSplit();

        if (!chunks.length) {
            console.warn(
                `⚠️  Nenhum texto extraído de ${record.sourceLabel} — PDF sem camada de texto ` +
                (CONFIG.ocr.enabled ? `e o OCR não reconheceu nada.` : `(OCR desligado em OCR_ENABLED).`)
            );
            continue;
        }

        await vectorStore.addDocuments(chunks);
        documentCount++;
        chunkCount += chunks.length;
        console.log(`✅ ${chunks.length} chunks indexados no Neo4j.`);

        if (extractor) {
            try {
                const started = Date.now();
                const { nota, descartes } = await extractor.extract(documentProcessor.fullText);
                for (const motivo of descartes) console.log(`   ↳ ${motivo}`);
                if (nota) {
                    await saveNota(vectorStore, record, nota);
                    notaCount++;
                    console.log(
                        `🕸️  Nota ${nota.numero ?? "?"} no grafo (${((Date.now() - started) / 1000).toFixed(0)} s): ` +
                        `prestador ${nota.prestador.nome ?? "?"}, valor ${nota.valorTotal ?? "?"}, ` +
                        `ISS retido ${nota.issRetido ?? "-"}, IRRF retido ${nota.irrfRetido ?? "-"}`
                    );
                }
            } catch (error) {
                // A extração enriquece o grafo; os chunks já estão salvos e a
                // busca nos trechos continua funcionando para este documento.
                console.warn(`⚠️  Extração falhou em ${record.sourceLabel}: ${(error as Error).message}`);
            }
        }
    }

    if (documentCount === 0) {
        throw new Error(
            `Nenhum PDF indexado. Verifique a tabela "${CONFIG.oracle.table}" e as colunas configuradas no .env, ` +
            `ou rode "npm run oracle:check" para inspecionar o que a query retorna.`
        );
    }

    console.log(`\n📚 Total: ${chunkCount} chunks de ${documentCount} documento(s) do Oracle.`);
    if (extractor) {
        const corrigidas = await corrigirPapeisPeloConjunto(vectorStore);
        const { nomesRemovidos, unidas } = await consolidarEmpresas(vectorStore);
        console.log(
            `🕸️  ${notaCount} NFS-e no grafo. Correções pelo conjunto: ${corrigidas} nota(s) com prestador/tomador ` +
            `trocados, ${nomesRemovidos} nome(s) de empresa removidos de outro CNPJ, ${unidas} empresa(s) sem CNPJ unida(s).`
        );
    }
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

    const embeddings = new OllamaEmbeddings({
        model: CONFIG.embedding.modelName,
        baseUrl: CONFIG.embedding.baseUrl,
    });

    const nlpModel = new ChatOpenAI({
        temperature: CONFIG.llm.temperature,
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

    // Temperatura 0 para extração e roteamento: com 0.3 os mesmos campos
    // variavam entre execuções.
    const structuredModel = new ChatOpenAI({
        temperature: 0,
        maxRetries: CONFIG.llm.maxRetries,
        maxTokens: CONFIG.llm.maxTokens,
        modelName: CONFIG.llm.nlpModel,
        openAIApiKey: CONFIG.llm.apiKey,
        modelKwargs: CONFIG.llm.reasoningEffort
            ? { reasoning_effort: CONFIG.llm.reasoningEffort }
            : undefined,
        configuration: {
            baseURL: CONFIG.llm.url,
        }
    });

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
    const questions = [
        "Quais prestadores de serviço aparecem nas notas e quais são os CNPJs de cada um?",
        "Em quais municípios e UFs os serviços foram prestados?",
        "Que tipos de serviço aparecem nas notas, como comissão, premiação ou propaganda?",
        // Troque "ACME REPRESENTACOES" pelo nome de um prestador que exista na
        // sua base: identificar a nota na própria pergunta é o que faz a busca
        // vetorial trazer os chunks daquele documento específico.
        "Na nota do prestador ACME REPRESENTACOES, qual é o valor do serviço e a data de emissão?",
        "Alguma das notas apresenta retenção de ISSQN ou de tributos federais? Em quais valores?"
    ];

    const ai = new AI({
        nlpModel,
        debugLog: console.log,
        vectorStore: _neo4jVectorStore,
        promptConfig: CONFIG.promptConfig,
        templateText: CONFIG.templateText,
        topK: CONFIG.similarity.topK,
        graph: extractor
            ? { router: structuredModel, maxRows: CONFIG.extraction.maxRows }
            : undefined,
    });

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
