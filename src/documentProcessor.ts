import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { CONFIG, type TextSplitterConfig } from "./config.ts";
import { type PdfRecord } from "./oracle.ts";

/**
 * Corrige os artefatos que o `parsedItemSeparator: " "` introduz.
 *
 * O pdf.js quebra o texto em items que às vezes partem um token no meio; ao
 * uni-los com espaço, `12.345.678/0001-99` virava `12.345.678/0001- 99` e
 * `NFS-e` virava `NFS- e`. Para extração estruturada isso muda o valor do
 * campo, então colamos de volta o que foi partido.
 *
 * Importante: só remove o espaço quando NÃO há espaço antes do hífen. Assim
 * separadores legítimos como `Itumbiara - GO` e `17.06.01 - Propaganda`
 * permanecem intactos.
 */
export function normalizeExtractedText(text: string): string {
    return text
        // dígito-hífen-dígito: CNPJ, CPF, CEP, datas  →  0001- 69  ⇒  0001-69
        .replace(/(\d)-[ \t]+(?=\d)/g, '$1-')
        // letra-hífen-letra minúscula solta: NFS- e  ⇒  NFS-e
        .replace(/([A-Za-zÀ-ÿ])-[ \t]+(?=[a-zà-ÿ]\b)/g, '$1-')
        // espaços horizontais repetidos
        .replace(/[ \t]{2,}/g, ' ')
        // espaço antes de quebra de linha
        .replace(/[ \t]+\n/g, '\n');
}

export class DocumentProcessor {
    private record: PdfRecord;
    private textSplitterConfig: TextSplitterConfig;

    constructor(record: PdfRecord, textSplitterConfig: TextSplitterConfig) {
        this.record = record;
        this.textSplitterConfig = textSplitterConfig;
    }

    async loadAndSplit() {
        // O PDFLoader aceita `string | Blob`. Passamos um Blob, e não o Buffer
        // cru, porque PDFLoader.parse faz `new Uint8Array(raw.buffer)` —
        // ignorando byteOffset/byteLength. Buffers do oracledb podem ser views
        // sobre um ArrayBuffer maior, e nesse caso o parser recebe bytes extras
        // em volta do PDF. Na prática o pdf.js tolera esse lixo (testado), mas
        // depender disso é frágil: o arrayBuffer() do Blob devolve um
        // ArrayBuffer exato no offset 0, que é o contrato que o loader espera.
        const blob = new Blob([new Uint8Array(this.record.data)], { type: "application/pdf" });
        const loader = new PDFLoader(blob, {
            parsedItemSeparator: CONFIG.pdf.parsedItemSeparator,
        });
        const rawDocuments = (await loader.load()).map(doc => {
            doc.pageContent = normalizeExtractedText(doc.pageContent);
            return doc;
        });
        console.log(`Raw documents loaded: ${rawDocuments.length} pages from ${this.record.name}`);

        const splitter = new RecursiveCharacterTextSplitter(
            this.textSplitterConfig
        );
        const documents = await splitter.splitDocuments(rawDocuments);
        console.log(`Documents split into ${documents.length} chunks`);

        // O metadata precisa ser achatado: o Neo4jVectorStore faz `SET c += row.metadata`
        // e o Neo4j não aceita propriedades aninhadas.
        // `source` é sobrescrito porque, no caminho Blob, o BufferLoader grava
        // o literal "blob" — perderíamos a rastreabilidade até a linha do Oracle.
        return documents.map(doc => ({
            ...doc,
            metadata: {
                source: this.record.sourceLabel,
                documentName: this.record.name,
                oracleId: this.record.id,
                pageNumber: doc.metadata.loc?.pageNumber
            },
        }));
    }

}
