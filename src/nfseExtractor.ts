import type { ChatOpenAI } from "@langchain/openai";
import { nfseSchema, type NfseFields } from "./nfseSchema.ts";

export interface Pessoa {
    nome: string | null;
    /** CNPJ ou CPF formatado, com dígitos verificadores válidos. */
    documento: string | null;
}

/** Uma NFS-e já validada, pronta para virar nó no grafo. */
export interface Nota {
    numero: string | null;
    /** dd/mm/aaaa, como no documento. */
    dataEmissao: string | null;
    /** aaaa-mm-dd, para ordenar e filtrar no Cypher. */
    dataEmissaoIso: string | null;
    valorTotal: number | null;
    /** 0 = o documento diz que não houve retenção; null = não informado. */
    issRetido: number | null;
    irrfRetido: number | null;
    prestador: Pessoa;
    tomador: Pessoa;
    municipio: string | null;
    uf: string | null;
    tipoServico: string | null;
}

export interface ExtractionResult {
    nota: Nota | null;
    /** Campos que o LLM propôs e a validação descartou, com o motivo. */
    descartes: string[];
}

const UFS = new Set([
    "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
    "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

/**
 * CNPJ ou CPF isolado — sem dígito, ponto, barra ou hífen colado dos lados.
 * Procurado no texto com espaços: no texto compactado "Fone: (00) 0000-0000"
 * seguido do número da nota "202200000000152" virava o CNPJ 00.002.022/0000-00.
 */
const DOC_PATTERN = /(?<![\d.\/-])(?:\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{3}\.?\d{3}\.?\d{3}-?\d{2})(?![\d])/g;

/**
 * Rótulos que precisam aparecer pouco antes de um valor retido maior que zero.
 * Em NFS-e com layout de tabela o rótulo fica no cabeçalho e o valor na linha
 * de baixo, por isso a janela é generosa.
 */
const RETENTION_LABELS = {
    iss: /ISS(QN)?Retid|RetidopeloTomador|ISSRetid|ISSQNRetid/i,
    irrf: /IRRF|IR\(R\$\)|IRRetid|ImpostodeRenda|\bIR[:\-]/i,
};
const RETENTION_WINDOW = 160;

/**
 * Tetos legais, para descartar valores lidos da coluna errada em layouts de
 * tabela: ISS no máximo 5% do serviço (LC 116/2003, art. 8º, II) e IR no
 * máximo 27,5% (maior alíquota da tabela progressiva).
 */
const MAX_ALIQUOTA = { iss: 0.05, irrf: 0.275 };

/**
 * Textos que o LLM às vezes devolve como "empresa" mas são cabeçalho do
 * município, endereço ou descrição do serviço. Nos 100 PDFs, isso fazia o
 * tomador virar "PREFEITURA DE SANTARÉM" e empurrava o tomador real para o
 * lugar do prestador. Comparado com o nome sem acento e em maiúsculas.
 */
const NOME_INVALIDO =
    /^(PREFEITURA|SECRETARIA|MUNICIPIO|GOVERNO|ESTADO D[OE]|NOTA FISCAL|NFS-?E|RUA |R\.? |AV(ENIDA)?\.? |ROD(OVIA)?\.? |ALAMEDA|TRAVESSA|PRACA|PROMOCAO|PROPAGANDA|COMISSAO|PREMIACAO|SERVICO)/;

/**
 * Distância máxima (caracteres) entre o nome e o CNPJ da mesma parte. Acima
 * disso o nome é de outro bloco do documento — nos testes, o LLM punha o nome
 * do tomador junto do CNPJ do prestador.
 */
const MAX_DISTANCIA_NOME_DOC = 600;

/** Rótulos de bloco que indicam o papel da parte que vem logo depois. */
const ROTULO_PAPEL = /(PRESTADOR|TOMADOR)/g;

function semAcento(text: string): string {
    return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Remove espaços e acentos: compara texto de PDF/OCR sem depender de layout. */
function compact(text: string): string {
    return semAcento(text).replace(/\s+/g, "");
}

/**
 * "Montes Claros/MG", "ITUMBIARA - Goiás" → "Montes Claros", "ITUMBIARA".
 * Hífen só conta com espaços dos lados, para não cortar "Embu-Guaçu".
 */
function limparMunicipio(municipio: string): string {
    return municipio.replace(/(\s+-\s+|\s*\/\s*)([A-Z]{2}|[A-ZÀ-Ú][a-zà-ú]+)\s*$/, "").trim();
}

function digits(text: string): string {
    return text.replace(/\D/g, "");
}

function cnpjValido(d: string): boolean {
    // Filial 0000 não existe: a matriz é 0001.
    if (d.length !== 14 || /^(\d)\1+$/.test(d) || d.slice(8, 12) === "0000") return false;
    const calc = (len: number) => {
        const pesos = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        const soma = pesos.reduce((acc, p, i) => acc + p * Number(d[i]), 0);
        const resto = soma % 11;
        return resto < 2 ? 0 : 11 - resto;
    };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

function cpfValido(d: string): boolean {
    if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
    const calc = (len: number) => {
        const soma = Array.from({ length: len }, (_, i) => Number(d[i]) * (len + 1 - i)).reduce((a, b) => a + b, 0);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function formatarDocumento(d: string): string | null {
    if (cnpjValido(d)) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
    if (cpfValido(d)) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
    return null;
}

/** Converte "R$ 1.234,56" em 1234.56. Devolve null se não for um valor monetário. */
export function parseValor(value: string | null): number | null {
    if (!value) return null;
    const clean = value.replace(/R\$|\s/g, "");
    if (/^\d{1,3}(\.\d{3})*,\d{2}$|^\d+,\d{2}$/.test(clean)) return Number(clean.replace(/\./g, "").replace(",", "."));
    if (/^\d+(\.\d{2})?$/.test(clean)) return Number(clean);
    return null;
}

/** Forma do valor como aparece no texto ("1.234,56"), para conferir presença. */
function formatarValor(n: number): string {
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Valida o CNPJ/CPF proposto pelo LLM. Se for inválido ou não estiver no
 * texto, procura o primeiro documento válido logo depois do nome da parte —
 * nos testes o gemma4 local trocava o CNPJ pela inscrição municipal, mas
 * acertava o nome.
 */
function resolverDocumento(
    proposto: string | null, nome: string | null, texto: string, textoDigitos: string, descartes: string[], papel: string,
): string | null {
    if (proposto) {
        const d = digits(proposto);
        const formatado = formatarDocumento(d);
        if (formatado && textoDigitos.includes(d)) return formatado;
        descartes.push(`${papel}_cnpj "${proposto}": ${formatado ? "não aparece no texto" : "formato ou dígito verificador inválido"}`);
    }
    if (!nome) return null;
    const alvo = semAcento(nome).replace(/\s+/g, " ").trim().slice(0, 12).toUpperCase();
    const textoNormal = semAcento(texto).replace(/\s+/g, " ").toUpperCase();
    const pos = textoNormal.indexOf(alvo);
    if (pos < 0) return null;
    // Documento válido mais próximo do nome, antes ou depois (layouts variam).
    const janela = textoNormal.slice(Math.max(0, pos - 200), pos + 400);
    for (const m of janela.matchAll(DOC_PATTERN)) {
        const formatado = formatarDocumento(digits(m[0]));
        if (formatado) {
            descartes.push(`${papel}_cnpj recuperado do texto perto do nome: ${formatado}`);
            return formatado;
        }
    }
    return null;
}

/** Confere se um valor retido maior que zero vem logo depois do rótulo certo. */
function valorPertoDoRotulo(textoCompacto: string, valor: number, rotulo: RegExp): boolean {
    const alvo = formatarValor(valor);
    let from = 0;
    for (let i = textoCompacto.indexOf(alvo, from); i >= 0; i = textoCompacto.indexOf(alvo, from)) {
        if (rotulo.test(textoCompacto.slice(Math.max(0, i - RETENTION_WINDOW), i))) return true;
        from = i + 1;
    }
    return false;
}

function resolverRetencao(
    proposto: string | null, textoCompacto: string, rotulo: RegExp, descartes: string[], campo: string,
): number | null {
    const valor = parseValor(proposto);
    if (valor === null) return null;
    const temRotulo = rotulo.test(textoCompacto);
    if (valor === 0) return temRotulo ? 0 : null;
    if (valorPertoDoRotulo(textoCompacto, valor, rotulo)) return valor;
    descartes.push(`${campo} "${proposto}": ${temRotulo ? "valor não está junto do rótulo" : "o documento não tem esse campo"}`);
    return null;
}

/** Texto sem acento, com espaços simples e maiúsculo — para achar posições. */
function normalizarParaBusca(text: string): string {
    return semAcento(text).replace(/\s+/g, " ").toUpperCase();
}

function posicaoNome(textoNormal: string, nome: string | null): number {
    if (!nome) return -1;
    return textoNormal.indexOf(normalizarParaBusca(nome).trim().slice(0, 12));
}

function posicaoDocumento(textoNormal: string, documento: string | null): number {
    if (!documento) return -1;
    const alvo = digits(documento);
    for (const m of textoNormal.matchAll(DOC_PATTERN)) if (digits(m[0]) === alvo) return m.index!;
    return -1;
}

function distancia(a: number, b: number): number {
    return a < 0 || b < 0 ? Number.POSITIVE_INFINITY : Math.abs(a - b);
}

/** Rótulo PRESTADOR/TOMADOR mais próximo antes da posição, se estiver perto. */
function papelAntes(textoNormal: string, pos: number): string | null {
    if (pos < 0) return null;
    let papel: string | null = null;
    for (const m of textoNormal.slice(Math.max(0, pos - 300), pos).matchAll(ROTULO_PAPEL)) papel = m[1]!;
    return papel;
}

/**
 * Confere a coerência entre nomes, documentos e papéis — onde o modelo
 * pequeno mais erra. Não inventa nada: só remove ou troca o que o próprio
 * texto contradiz.
 */
function coerenciaDasPartes(prestador: Pessoa, tomador: Pessoa, textoNormal: string, descartes: string[]): [Pessoa, Pessoa] {
    const pn = posicaoNome(textoNormal, prestador.nome), tn = posicaoNome(textoNormal, tomador.nome);
    const pd = posicaoDocumento(textoNormal, prestador.documento), td = posicaoDocumento(textoNormal, tomador.documento);

    // Mesmo nome dos dois lados: fica com quem tem o documento junto dele.
    if (prestador.nome && tomador.nome && normalizarParaBusca(prestador.nome) === normalizarParaBusca(tomador.nome)) {
        const ficaNoPrestador = distancia(pn, pd) < distancia(tn, td);
        descartes.push(`nome "${prestador.nome}" nos dois papéis: mantido só no ${ficaNoPrestador ? "prestador" : "tomador"}`);
        return ficaNoPrestador ? [prestador, { ...tomador, nome: null }] : [{ ...prestador, nome: null }, tomador];
    }

    // O documento de cada parte está junto do nome da outra: nomes trocados.
    const direto = distancia(pn, pd) + distancia(tn, td);
    const cruzado = distancia(pn, td) + distancia(tn, pd);
    if (Number.isFinite(cruzado) && cruzado + 50 < direto) {
        descartes.push("nomes de prestador e tomador trocados (o CNPJ de cada um está junto do nome do outro): corrigido");
        return [{ ...prestador, nome: tomador.nome }, { ...tomador, nome: prestador.nome }];
    }

    // Nome longe do próprio CNPJ: o nome é de outra parte do documento.
    const semNomeLonge = (p: Pessoa, nomePos: number, docPos: number, papel: string): Pessoa => {
        if (!p.nome || !p.documento || distancia(nomePos, docPos) <= MAX_DISTANCIA_NOME_DOC) return p;
        descartes.push(`${papel} "${p.nome}": longe do CNPJ ${p.documento} no texto, não é o nome dessa parte`);
        return { ...p, nome: null };
    };
    prestador = semNomeLonge(prestador, pn, pd, "prestador");
    tomador = semNomeLonge(tomador, tn, td, "tomador");

    // Os rótulos do PDF dizem o contrário dos papéis extraídos: troca as partes.
    // Só quando os dois rótulos discordam — layouts que embaralham os blocos
    // ("TOMADOR DE SERVIÇOS PRESTADOR DE SERVIÇOS CIFARMA…") ficam como estão.
    if (papelAntes(textoNormal, pn) === "TOMADOR" && papelAntes(textoNormal, tn) === "PRESTADOR") {
        descartes.push("prestador e tomador trocados (pelos rótulos do documento): corrigido");
        return [tomador, prestador];
    }
    return [prestador, tomador];
}

function resolverNome(proposto: string | null, aparece: (v: string | null) => boolean, descartes: string[], papel: string): string | null {
    if (!proposto || !aparece(proposto)) return null;
    const nome = proposto.trim();
    if (NOME_INVALIDO.test(normalizarParaBusca(nome))) {
        descartes.push(`${papel} "${nome}": é cabeçalho, endereço ou descrição, não uma empresa`);
        return null;
    }
    return nome;
}

function limitarAliquota(valor: number | null, total: number | null, maximo: number, campo: string, descartes: string[]): number | null {
    if (valor === null || total === null || valor <= total * maximo + 0.01) return valor;
    descartes.push(`${campo} ${formatarValor(valor)}: acima de ${maximo * 100}% do valor da nota (${formatarValor(total)})`);
    return null;
}

/** Validação pura (sem LLM) — exportada para teste. */
export function validarCampos(campos: NfseFields, texto: string): ExtractionResult {
    const descartes: string[] = [];
    if (!campos.e_nfse) return { nota: null, descartes: ["documento não é uma NFS-e"] };

    const textoCompacto = compact(texto);
    const textoDigitos = digits(texto);
    const aparece = (v: string | null) => !!v && textoCompacto.toUpperCase().includes(compact(v).toUpperCase());

    const valorTotal = parseValor(campos.valor_total);
    const valorTotalOk = valorTotal !== null && textoCompacto.includes(formatarValor(valorTotal));
    if (campos.valor_total && !valorTotalOk) descartes.push(`valor_total "${campos.valor_total}": não aparece no texto`);

    const data = campos.data_emissao?.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] ?? null;
    const dataOk = data && textoCompacto.includes(data) ? data : null;
    if (campos.data_emissao && !dataOk) descartes.push(`data_emissao "${campos.data_emissao}": não aparece no texto`);

    const numero = campos.numero_nota?.trim() || null;
    const numeroOk = numero && aparece(numero) ? numero : null;
    if (numero && !numeroOk) descartes.push(`numero_nota "${numero}": não aparece no texto`);

    const prestadorNome = resolverNome(campos.prestador_razao_social, aparece, descartes, "prestador");
    const tomadorNome = resolverNome(campos.tomador_razao_social, aparece, descartes, "tomador");
    const prestadorDoc = resolverDocumento(campos.prestador_cnpj, prestadorNome, texto, textoDigitos, descartes, "prestador");
    let tomadorDoc = resolverDocumento(campos.tomador_cnpj, tomadorNome, texto, textoDigitos, descartes, "tomador");
    if (tomadorDoc && tomadorDoc === prestadorDoc) {
        descartes.push(`tomador_cnpj igual ao do prestador (${tomadorDoc}): descartado`);
        tomadorDoc = null;
    }
    const [prestador, tomador] = coerenciaDasPartes(
        { nome: prestadorNome, documento: prestadorDoc },
        { nome: tomadorNome, documento: tomadorDoc },
        normalizarParaBusca(texto),
        descartes,
    );
    const total = valorTotalOk ? valorTotal : null;

    const uf = campos.uf_prestacao?.trim().toUpperCase() ?? null;
    const municipio = aparece(campos.municipio_prestacao) ? limparMunicipio(campos.municipio_prestacao!.trim()) : null;

    return {
        nota: {
            numero: numeroOk,
            dataEmissao: dataOk,
            dataEmissaoIso: dataOk ? dataOk.split("/").reverse().join("-") : null,
            valorTotal: total,
            issRetido: limitarAliquota(
                resolverRetencao(campos.iss_retido, textoCompacto, RETENTION_LABELS.iss, descartes, "iss_retido"),
                total, MAX_ALIQUOTA.iss, "iss_retido", descartes),
            irrfRetido: limitarAliquota(
                resolverRetencao(campos.irrf_retido, textoCompacto, RETENTION_LABELS.irrf, descartes, "irrf_retido"),
                total, MAX_ALIQUOTA.irrf, "irrf_retido", descartes),
            prestador,
            tomador,
            municipio,
            uf: uf && UFS.has(uf) ? uf : null,
            tipoServico: campos.tipo_servico,
        },
        descartes,
    };
}

/**
 * Extrai os campos de uma NFS-e com o LLM e valida cada um contra o texto.
 *
 * Roda uma nota por vez: cabe com folga no contexto de 8K do LLM local, e
 * perguntas sobre "todas as notas" passam a ser respondidas pelo grafo, não
 * pelo contexto do modelo.
 */
export class NfseExtractor {
    private llm;
    private maxChars: number;

    constructor(llm: ChatOpenAI, maxChars: number) {
        this.llm = llm.withStructuredOutput(nfseSchema, { method: "jsonSchema" });
        this.maxChars = maxChars;
    }

    async extract(texto: string): Promise<ExtractionResult> {
        // NFS-e trazem os campos no início; cortar mantém o prompt dentro do
        // contexto do LLM local mesmo em PDFs de várias páginas.
        const recorte = texto.slice(0, this.maxChars);
        const campos = await this.llm.invoke(
            "Extraia os campos desta Nota Fiscal de Serviço. Use apenas o que está escrito no texto; " +
            "se um campo não existir, use null. Se o texto não for uma nota fiscal de serviço, e_nfse = false.\n" +
            // Exemplo com marcadores, não números reais: com "202200000000152" o
            // modelo copiava o número do exemplo em notas de outro layout.
            "Atenção: o texto vem de um PDF e, em alguns layouts, o valor aparece ANTES do rótulo " +
            "(ex.: \"<NUMERO> Número da NFS-e <DATA> Data <CODIGO> Código Verificador\": " +
            "o número da nota é <NUMERO>, não <CODIGO>).\n\n" +
            recorte
        );
        return validarCampos(campos, recorte);
    }
}
