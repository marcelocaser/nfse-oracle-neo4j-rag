import type { Neo4jVectorStore } from "@langchain/community/vectorstores/neo4j_vector";
import type { Nota, Pessoa } from "./nfseExtractor.ts";
import type { PdfRecord } from "./oracle.ts";

/**
 * Grafo das NFS-e, ao lado dos chunks do RAG:
 *
 *   (:Empresa)-[:PRESTOU]->(:Nota)-[:TOMADA_POR]->(:Empresa)
 *                            └-[:TEM_TRECHO]->(:Chunk)
 *
 * Perguntas sobre o conjunto ("quais notas têm ISS retido?") são respondidas
 * com Cypher sobre TODAS as notas. A busca vetorial só vê os topK trechos mais
 * parecidos: com 100 documentos, as notas com retenção ficavam nas posições
 * 31–39 e a resposta dizia que não havia nenhuma.
 */

export async function setupGraph(store: Neo4jVectorStore): Promise<void> {
    await store.query("CREATE CONSTRAINT nota_oracle_id IF NOT EXISTS FOR (n:Nota) REQUIRE n.oracleId IS UNIQUE");
    await store.query("CREATE CONSTRAINT empresa_chave IF NOT EXISTS FOR (e:Empresa) REQUIRE e.chave IS UNIQUE");
}

export async function clearGraph(store: Neo4jVectorStore): Promise<void> {
    await store.query("MATCH (n) WHERE n:Nota OR n:Empresa OR n:Documento DETACH DELETE n");
}

/**
 * Corrige notas com prestador e tomador trocados por inteiro — nome e CNPJ
 * coerentes entre si, mas do lado errado. O texto de um documento sozinho não
 * resolve isso; o conjunto resolve: uma empresa que é tomadora na grande
 * maioria das notas (a que recebe as notas dos representantes) quase
 * certamente é tomadora também nas poucas em que saiu como prestadora.
 *
 * Roda depois da ingestão. Não usa nome de empresa fixo.
 */
export async function corrigirPapeisPeloConjunto(store: Neo4jVectorStore): Promise<number> {
    const [row] = await store.query(
        `MATCH (c:Empresa)
         WITH c, COUNT { (c)<-[:TOMADA_POR]-(:Nota) } AS comoTomador, COUNT { (c)-[:PRESTOU]->(:Nota) } AS comoPrestador
         WHERE comoTomador >= $minTomador AND comoTomador > $razao * comoPrestador
         MATCH (c)-[errado:PRESTOU]->(n:Nota)
         WHERE NOT (n)-[:TOMADA_POR]->(c)
         OPTIONAL MATCH (n)-[outro:TOMADA_POR]->(o:Empresa)
         DELETE errado
         WITH c, n, outro, o
         CALL {
             WITH n, outro, o
             WITH n, outro, o WHERE o IS NOT NULL
             DELETE outro
             MERGE (o)-[:PRESTOU]->(n)
         }
         MERGE (n)-[:TOMADA_POR]->(c)
         RETURN count(DISTINCT n) AS corrigidas`,
        { minTomador: 5, razao: 2 }
    );
    return Number(row?.corrigidas ?? 0);
}

/**
 * Limpa nomes trocados que sobram depois de corrigir os papéis: o LLM às vezes
 * põe o nome da tomadora frequente junto do CNPJ de um representante, e o nó
 * desse CNPJ fica com o nome errado. Também junta ao nó principal a empresa
 * sem CNPJ que tem o mesmo nome (ex.: "CIFARMA CIENTÍFICA F ARMACÊUTICA").
 *
 * Nomes são comparados pelas 8 primeiras letras, sem espaços nem acentos —
 * o texto de PDF/OCR quebra palavras ("F ARMACEUTICA") e erra letras.
 */
export async function consolidarEmpresas(store: Neo4jVectorStore): Promise<{ nomesRemovidos: number; unidas: number }> {
    const prefixo = (v: string) =>
        `left(apoc.text.regreplace(toUpper(apoc.text.clean(${v})), '[^A-Z]', ''), 8)`;
    const [r1] = await store.query(
        `MATCH (dom:Empresa) WHERE dom.documento IS NOT NULL AND dom.nome IS NOT NULL
           AND COUNT { (:Nota)-[:TOMADA_POR]->(dom) } >= $minTomador
         MATCH (e:Empresa) WHERE e <> dom AND e.documento IS NOT NULL AND e.nome IS NOT NULL
           AND ${prefixo("e.nome")} = ${prefixo("dom.nome")}
         SET e.nome = null
         RETURN count(DISTINCT e) AS n`,
        { minTomador: 5 }
    );
    const [r2] = await store.query(
        `MATCH (dom:Empresa) WHERE dom.documento IS NOT NULL AND dom.nome IS NOT NULL
           AND COUNT { (:Nota)-[:TOMADA_POR]->(dom) } >= $minTomador
         MATCH (e:Empresa) WHERE e.documento IS NULL AND e.nome IS NOT NULL
           AND ${prefixo("e.nome")} = ${prefixo("dom.nome")}
         CALL {
             WITH e, dom
             MATCH (n:Nota)-[r:TOMADA_POR]->(e)
             DELETE r
             MERGE (n)-[:TOMADA_POR]->(dom)
         }
         CALL {
             WITH e, dom
             MATCH (e)-[r:PRESTOU]->(n:Nota)
             DELETE r
             MERGE (dom)-[:PRESTOU]->(n)
         }
         DETACH DELETE e
         RETURN count(*) AS n`,
        { minTomador: 5 }
    );
    return { nomesRemovidos: Number(r1?.n ?? 0), unidas: Number(r2?.n ?? 0) };
}

/** Empresa sem CNPJ válido ainda entra no grafo, identificada pelo nome. */
function chaveEmpresa(p: Pessoa): string | null {
    if (p.documento) return p.documento;
    if (p.nome) return `NOME:${p.nome.toUpperCase()}`;
    return null;
}

export async function saveNota(store: Neo4jVectorStore, record: PdfRecord, nota: Nota): Promise<void> {
    await store.query(
        `MERGE (n:Nota {oracleId: $oracleId})
         SET n.numero = $numero, n.dataEmissao = $dataEmissao, n.dataEmissaoIso = $dataEmissaoIso,
             n.valorTotal = $valorTotal, n.issRetido = $issRetido, n.irrfRetido = $irrfRetido,
             n.municipio = $municipio, n.uf = $uf, n.tipoServico = $tipoServico,
             n.documentName = $documentName, n.source = $source
         WITH n
         CALL {
             WITH n
             WITH n WHERE $prestadorChave IS NOT NULL
             MERGE (p:Empresa {chave: $prestadorChave})
             SET p.nome = coalesce(p.nome, $prestadorNome), p.documento = $prestadorDoc
             MERGE (p)-[:PRESTOU]->(n)
         }
         CALL {
             WITH n
             WITH n WHERE $tomadorChave IS NOT NULL
             MERGE (t:Empresa {chave: $tomadorChave})
             SET t.nome = coalesce(t.nome, $tomadorNome), t.documento = $tomadorDoc
             MERGE (n)-[:TOMADA_POR]->(t)
         }
         WITH n
         MATCH (c:Chunk {oracleId: $oracleId})
         MERGE (n)-[:TEM_TRECHO]->(c)`,
        {
            oracleId: record.id,
            numero: nota.numero,
            dataEmissao: nota.dataEmissao,
            dataEmissaoIso: nota.dataEmissaoIso,
            valorTotal: nota.valorTotal,
            issRetido: nota.issRetido,
            irrfRetido: nota.irrfRetido,
            municipio: nota.municipio,
            uf: nota.uf,
            tipoServico: nota.tipoServico,
            documentName: record.name,
            source: record.sourceLabel,
            prestadorChave: chaveEmpresa(nota.prestador),
            prestadorNome: nota.prestador.nome,
            prestadorDoc: nota.prestador.documento,
            tomadorChave: chaveEmpresa(nota.tomador),
            tomadorNome: nota.tomador.nome,
            tomadorDoc: nota.tomador.documento,
        }
    );
}

/**
 * Consultas que respondem as perguntas sobre o conjunto. O LLM só escolhe a
 * rota (ver src/ai.ts) — não escreve Cypher: um modelo de 2B gerando consultas
 * livres erraria nomes de propriedades e relações.
 */
export const GRAPH_ROUTES = {
    prestadores: {
        descricao: "quais prestadores/emissores aparecem, com CNPJ e quantidade de notas",
        cypher: `MATCH (p:Empresa)-[:PRESTOU]->(n:Nota)
                 RETURN p.nome AS prestador, coalesce(p.documento, '-') AS cnpj_cpf, count(n) AS notas,
                        round(sum(coalesce(n.valorTotal, 0)), 2) AS valor_total
                 ORDER BY notas DESC, prestador`,
    },
    municipios: {
        descricao: "em quais municípios/UFs os serviços foram prestados",
        cypher: `MATCH (n:Nota) WHERE n.municipio IS NOT NULL OR n.uf IS NOT NULL
                 RETURN coalesce(n.municipio, '-') AS municipio, coalesce(n.uf, '-') AS uf, count(n) AS notas
                 ORDER BY notas DESC, municipio`,
    },
    tipos_servico: {
        descricao: "tipos de serviço (comissão, premiação, promoção de venda) e quantas notas de cada",
        cypher: `MATCH (n:Nota)
                 RETURN coalesce(n.tipoServico, 'NÃO IDENTIFICADO') AS tipo_servico, count(n) AS notas,
                        round(sum(coalesce(n.valorTotal, 0)), 2) AS valor_total
                 ORDER BY notas DESC`,
    },
    retencoes: {
        descricao: "notas com retenção de ISS/ISSQN ou IR/IRRF e os valores retidos",
        cypher: `MATCH (n:Nota) WHERE n.issRetido > 0 OR n.irrfRetido > 0
                 OPTIONAL MATCH (p:Empresa)-[:PRESTOU]->(n)
                 RETURN coalesce(n.numero, '-') AS nota, coalesce(p.nome, '-') AS prestador,
                        coalesce(n.dataEmissao, '-') AS emissao, n.valorTotal AS valor_total,
                        coalesce(n.issRetido, 0.0) AS iss_retido, coalesce(n.irrfRetido, 0.0) AS irrf_retido
                 ORDER BY n.dataEmissaoIso`,
    },
    nota_especifica: {
        descricao: "dados de uma nota identificada pelo nome do prestador ou pelo número",
        // A empresa é achada pelo próprio Cypher: nome cujas duas primeiras
        // palavras aparecem na pergunta. O LLM de 2B não extraía o nome — ele
        // copiava a descrição da rota no lugar do termo.
        cypher: `MATCH (n:Nota)
                 OPTIONAL MATCH (p:Empresa)-[:PRESTOU]->(n)
                 OPTIONAL MATCH (n)-[:TOMADA_POR]->(t:Empresa)
                 WITH n, p, t
                 WHERE (p.nome IS NOT NULL
                        AND toUpper($pergunta) CONTAINS toUpper(apoc.text.join(split(trim(p.nome), ' ')[0..2], ' ')))
                    OR ($numero IS NOT NULL AND n.numero = $numero)
                 RETURN coalesce(n.numero, '-') AS nota, coalesce(p.nome, '-') AS prestador,
                        coalesce(p.documento, '-') AS cnpj_prestador, coalesce(t.nome, '-') AS tomador,
                        coalesce(n.dataEmissao, '-') AS emissao, n.valorTotal AS valor_total,
                        coalesce(n.municipio, '-') AS municipio, coalesce(n.tipoServico, '-') AS tipo_servico
                 ORDER BY n.dataEmissaoIso`,
    },
} as const;

export type GraphRoute = keyof typeof GRAPH_ROUTES;

/**
 * Formata o resultado como tabela compacta para o contexto do LLM. O limite de
 * linhas mantém o prompt dentro dos 8K de contexto do LLM local.
 */
export function formatRows(rows: Record<string, unknown>[], maxRows: number): string {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]!);
    const fmt = (v: unknown) =>
        typeof v === "number" ? v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : v === null || v === undefined ? "-" : String(v);
    const shown = rows.slice(0, maxRows);
    const lines = [
        `| ${cols.join(" | ")} |`,
        `| ${cols.map(() => "---").join(" | ")} |`,
        ...shown.map(r => `| ${cols.map(c => fmt(r[c])).join(" | ")} |`),
    ];
    if (rows.length > maxRows) lines.push(`(+ ${rows.length - maxRows} linhas omitidas)`);
    return lines.join("\n");
}
