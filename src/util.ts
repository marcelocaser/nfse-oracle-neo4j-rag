import type { Document } from "@langchain/core/documents";

function displayResults(results: Array<Document<Record<string, any>>>): void {
    console.log(`\n📄 Encontrados ${results.length} trechos relevantes:\n`);

    results.forEach((doc, index) => {
        console.log(`   ${index + 1}.`);
        console.log(`      ${formatContent(doc.pageContent)}`);
        if (doc.metadata?.pageNumber) {
            console.log(`      📄 (Página: ${doc.metadata.pageNumber})`);
        }
        console.log();
    });
}

function formatContent(content: string, maxLength: number = 200): string {
    const cleaned = content.replace(/\s+/g, ' ').trim();
    return cleaned.length > maxLength
        ? `${cleaned.substring(0, maxLength)}...`
        : cleaned;
}


/**
 * Remove as cercas de código markdown que o LLM insiste em adicionar ao redor
 * da resposta, mesmo quando o prompt pede JSON puro.
 *
 * Instrução de prompt não é garantia — o modelo reincide. Normalizar aqui é
 * determinístico e não atrapalha respostas em prosa, que não têm cercas.
 */
function stripCodeFences(answer: string): string {
    const match = answer
        .trim()
        .match(/^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/);
    return match ? match[1]!.trim() : answer.trim();
}

/**
 * Se a resposta for JSON válido, devolve a versão reformatada e a extensão
 * ".json"; senão devolve o texto como veio e ".md".
 */
function formatAnswerForDisk(answer: string): { content: string; extension: string } {
    const cleaned = stripCodeFences(answer);
    try {
        return { content: JSON.stringify(JSON.parse(cleaned), null, 2), extension: 'json' };
    } catch {
        return { content: cleaned, extension: 'md' };
    }
}

export {
    displayResults,
    stripCodeFences,
    formatAnswerForDisk
}