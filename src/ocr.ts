import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Lado maior de uma A4 (297 mm). */
const A4_LONG_SIDE_INCHES = 11.69;

export interface OcrConfig {
    enabled: boolean;
    /** Modelo de visão do Ollama. glm-ocr: 2,2 GB, cabe numa GPU de 4 GB. */
    model: string;
    baseUrl: string;
    /**
     * Resolução equivalente numa página A4 — ver o trade-off em config.ts.
     * Vira um teto de pixels: páginas maiores que A4 são reduzidas.
     */
    dpi: number;
    /** Teto de tokens por página — ver `ocrImage`. */
    maxTokensPerPage: number;
    numCtx: number;
}

export interface OcrPage {
    pageNumber: number;
    text: string;
}

/**
 * Renderiza cada página do PDF como PNG com o `pdftoppm` (poppler-utils).
 *
 * PDFs escaneados ou fotografados não têm camada de texto: cada página é só
 * uma imagem, e o pdf.js devolve "". O OCR precisa da página como imagem.
 *
 * O tamanho é limitado em pixels (`-scale-to`), não em dpi: fotos de celular
 * entram no PDF com páginas de até 2× uma A4 (ex.: 1270×1797 pt), e a 100 dpi
 * viravam 1764×2496 px — ~4000 tokens de imagem, que estouram a VRAM de 4 GB
 * no encoder de visão (CUDA out of memory). Com o teto, toda página fica no
 * máximo do tamanho de uma A4 no dpi configurado.
 */
async function renderPages(pdf: Buffer, dpi: number): Promise<Buffer[]> {
    const dir = await mkdtemp(join(tmpdir(), "nfse-ocr-"));
    try {
        const pdfPath = join(dir, "doc.pdf");
        await writeFile(pdfPath, pdf);
        const maxSide = Math.round(A4_LONG_SIDE_INCHES * dpi);
        await execFileAsync("pdftoppm", ["-scale-to", String(maxSide), "-png", pdfPath, join(dir, "p")]);

        // O pdftoppm preenche o número com zeros conforme o total de páginas
        // (p-1.png ou p-01.png), então ordenamos pelo número, não pelo nome.
        const files = (await readdir(dir))
            .filter(name => /^p-\d+\.png$/.test(name))
            .sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));

        return Promise.all(files.map(name => readFile(join(dir, name))));
    } finally {
        // As imagens contêm os dados da nota: não deixamos nada no /tmp.
        await rm(dir, { recursive: true, force: true });
    }
}

/**
 * Remove a cauda repetida que o modelo gera ao terminar a página.
 *
 * Testado com o glm-ocr numa foto de NFS-e: depois de transcrever a página
 * inteira ele entra em loop até o Ollama abortar com "token repeat limit".
 * O texto útil vem antes; aqui colapsamos só a sequência repetida do FINAL.
 *
 * Linhas iguais seguidas no meio do texto são dados legítimos — numa NFS-e,
 * "Deduções" e "Desconto" costumam vir como "0,00" e "0,00" — e ficam.
 */
const MIN_REPEATED_TAIL = 3;

function trimRepetition(text: string): string {
    const lines = text.trimEnd().split("\n");
    const last = lines.at(-1)?.trim();
    let run = 0;
    while (run < lines.length && lines[lines.length - 1 - run]!.trim() === last) run++;
    if (run >= MIN_REPEATED_TAIL) lines.splice(lines.length - run + 1);
    return stripCodeFence(lines.join("\n").trim());
}

/**
 * Remove a cerca markdown que o glm-ocr às vezes põe em volta da saída.
 *
 * Numa imagem sem texto (ex.: uma foto 3×4 guardada na mesma tabela das
 * notas) ele devolve só "```markdown\n\n```" — sem isto, essa cerca vazia
 * virava um chunk no Neo4j.
 */
function stripCodeFence(text: string): string {
    const match = text.match(/^```[\w-]*\s*\n?([\s\S]*?)\n?\s*```$/);
    return (match ? match[1]! : text).trim();
}

/**
 * Transcreve uma imagem com um modelo de visão do Ollama (API nativa /api/chat).
 *
 * Usa streaming para preservar o que já foi transcrito quando o Ollama aborta
 * a geração por repetição — sem streaming, esse erro descartaria a página toda.
 * `maxTokensPerPage` limita quanto tempo se gasta no loop final.
 */
async function ocrImage(image: Buffer, config: OcrConfig): Promise<string> {
    const response = await fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: config.model,
            stream: true,
            options: {
                temperature: 0,
                num_ctx: config.numCtx,
                num_predict: config.maxTokensPerPage,
            },
            messages: [{
                role: "user",
                // Prefixo de tarefa do glm-ocr (ver ollama.com/library/glm-ocr).
                content: "Text Recognition:",
                images: [image.toString("base64")],
            }],
        }),
    });
    if (!response.ok || !response.body) {
        throw new Error(`OCR (${config.model}) falhou: HTTP ${response.status} ${await response.text()}`);
    }

    let text = "";
    let pending = "";
    // Erro no meio do stream chega como {"error": ...} com HTTP 200
    // (docs.ollama.com/api/errors). Devolve true quando a geração acabou.
    const handleLine = (line: string): boolean => {
        if (!line.trim()) return false;
        const message = JSON.parse(line);
        if (message.error) {
            // Repetição no fim da página é esperada; qualquer outro erro
            // (modelo ausente, servidor fora) precisa aparecer.
            if (!String(message.error).includes("repeat")) {
                throw new Error(`OCR (${config.model}) falhou: ${message.error}`);
            }
            return true;
        }
        text += message.message?.content ?? "";
        return false;
    };

    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk as Uint8Array, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
            if (handleLine(line)) return trimRepetition(text);
        }
    }
    // A última linha pode chegar sem "\n" — inclusive um erro.
    handleLine(pending + decoder.decode());
    return trimRepetition(text);
}

/** OCR de todas as páginas de um PDF sem camada de texto, uma por vez. */
export async function ocrPdf(pdf: Buffer, config: OcrConfig, log: (msg: string) => void): Promise<OcrPage[]> {
    const images = await renderPages(pdf, config.dpi);
    const pages: OcrPage[] = [];
    for (const [index, image] of images.entries()) {
        const started = Date.now();
        const text = await ocrImage(image, config);
        log(`   🔎 OCR página ${index + 1}/${images.length}: ${text.length} caracteres em ${((Date.now() - started) / 1000).toFixed(0)} s`);
        pages.push({ pageNumber: index + 1, text });
    }
    return pages;
}
