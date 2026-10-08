/**
 * Smoke test do acesso ao Oracle — não toca no Neo4j nem no LLM.
 *
 * Serve para separar "problema de Oracle/Instant Client" de "problema do
 * pipeline RAG". Rode isto primeiro:  npm run oracle:check
 */
import { CONFIG } from "./config.ts";
import { OraclePdfRepository } from "./oracle.ts";

const PDF_MAGIC = "%PDF-";

const repository = new OraclePdfRepository(CONFIG.oracle);

try {
    console.log(`Tabela:     ${CONFIG.oracle.table}`);
    console.log(`Colunas:    id=${CONFIG.oracle.idColumn} nome=${CONFIG.oracle.nameColumn} blob=${CONFIG.oracle.blobColumn}`);
    console.log(`Query:      ${CONFIG.oracle.query ? 'sobrescrita via ORACLE_PDF_QUERY' : 'montada a partir das colunas'}`);
    console.log(`Max docs:   ${CONFIG.oracle.maxDocs}`);
    console.log(`\nSQL:\n${repository.buildQuery()}\n`);

    await repository.connect();

    let count = 0;
    for await (const record of repository.streamPdfs()) {
        count++;
        // Todo PDF válido começa com "%PDF-". Se não começar, o BLOB não é um
        // PDF (ou está truncado/encodado) e o parser vai falhar adiante.
        const header = record.data.subarray(0, 5).toString("latin1");
        const looksLikePdf = header === PDF_MAGIC;

        console.log(
            `${looksLikePdf ? '✅' : '❌'} ${record.sourceLabel}  ` +
            `nome="${record.name}"  ` +
            `${(record.data.length / 1024).toFixed(0)} KB  ` +
            `header=${JSON.stringify(header)}`
        );
    }

    console.log(`\n${count} registro(s) com BLOB utilizável.`);
    if (count === 0) {
        console.log("Nenhuma linha retornada — confira nome da tabela, colunas e permissões do usuário.");
    }
} catch (error) {
    console.error("\n❌ Falhou:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    await repository.close();
}
