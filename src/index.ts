import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { CONFIG } from "./config.ts";
import { DocumentProcessor } from "./documentProcessor.ts";
import { type PretrainedModelOptions } from "@huggingface/transformers";
import { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import { ChatOpenAI } from "@langchain/openai";
import { AI } from "./ai.ts";
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

try {
    console.log("Starting document processing...");

    await oracleRepository.connect();

    const embeddings = new HuggingFaceTransformersEmbeddings({
        model: CONFIG.embedding.modelName,
        pretrainedOptions: CONFIG.embedding.pretrainedOptions as PretrainedModelOptions
    });

    const nlpModel = new ChatOpenAI({
        temperature: CONFIG.openRouter.temperature,
        maxRetries: CONFIG.openRouter.maxRetries,
        maxTokens: CONFIG.openRouter.maxTokens,
        modelName: CONFIG.openRouter.nlpModel,
        openAIApiKey: CONFIG.openRouter.apiKey,
        configuration: {
            baseURL: CONFIG.openRouter.url,
            defaultHeaders: CONFIG.openRouter.defaultHeaders
        }
    });

    _neo4jVectorStore = await Neo4jVectorStore.fromExistingGraph(embeddings, CONFIG.neo4j);

    // Precisa de await: sem ele o DETACH DELETE corre em paralelo com o
    // addDocuments abaixo e pode apagar os chunks recém-inseridos.
    await clearAll(_neo4jVectorStore, CONFIG.neo4j.nodeLabel);

    let documentCount = 0;
    let chunkCount = 0;

    for await (const record of oracleRepository.streamPdfs()) {
        console.log(`\n📥 ${record.sourceLabel} (${record.name}, ${(record.data.length / 1024).toFixed(0)} KB)`);

        const documentProcessor = new DocumentProcessor(record, CONFIG.textSplitter);
        const chunks = await documentProcessor.loadAndSplit();

        if (!chunks.length) {
            console.warn(`⚠️  Nenhum texto extraído de ${record.sourceLabel} — pode ser um PDF escaneado (sem camada de texto).`);
            continue;
        }

        await _neo4jVectorStore.addDocuments(chunks);
        documentCount++;
        chunkCount += chunks.length;
        console.log(`✅ ${chunks.length} chunks indexados no Neo4j.`);
    }

    if (documentCount === 0) {
        throw new Error(
            `Nenhum PDF indexado. Verifique a tabela "${CONFIG.oracle.table}" e as colunas configuradas no .env, ` +
            `ou rode "npm run oracle:check" para inspecionar o que a query retorna.`
        );
    }

    console.log(`\n📚 Total: ${chunkCount} chunks de ${documentCount} documento(s) do Oracle.`);

    // A base indexa VÁRIAS notas ao mesmo tempo, então perguntas no singular
    // ("qual o valor desta nota?") não têm referente: a busca vetorial traz
    // chunks de notas diferentes e a resposta mistura documentos.
    //
    // Dois padrões funcionam aqui:
    //   1. agregadas — sobre o conjunto ("quais prestadores aparecem?")
    //   2. direcionadas — a pergunta identifica a nota ("na nota do prestador X")
    //
    // As agregadas são limitadas por topK: só os chunks recuperados são vistos,
    // então a resposta cobre parte do acervo, não o total.
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
        topK: CONFIG.similarity.topK
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
