/**
 * Período de emissão citado na pergunta ("de 01/10 até hoje", "em outubro",
 * "neste mês"), por regra: o LLM de 2B não é confiável para extrair e
 * converter datas, e "hoje" depende do relógio desta máquina.
 *
 * As datas saem no formato de n.dataEmissaoIso (aaaa-mm-dd), que se compara
 * como texto. Sem ano, vale o ano corrente — ou o anterior, se a data ainda
 * não chegou ("em dezembro" perguntado em outubro).
 */
export interface Periodo {
    /** aaaa-mm-dd, inclusive; null = sem limite inferior. */
    inicio: string | null;
    /** aaaa-mm-dd, inclusive; null = sem limite superior. */
    fim: string | null;
    /** "01/10/2026 a 15/10/2026", para o log e o contexto do LLM. */
    descricao: string;
}

const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
    "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** dd/mm, dd/mm/aa ou dd/mm/aaaa, sem colar em outros dígitos. */
const DATA = /(?<!\d)(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g;

const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const br = (s: string) => s.split("-").reverse().join("/");
const somarDias = (d: Date, dias: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + dias);
const fimDoMes = (ano: number, mes: number) => new Date(ano, mes + 1, 0);

/** Remove as datas da pergunta, para o ano de "01/10/2026" não virar número de nota. */
export function semDatas(pergunta: string): string {
    return pergunta.replace(DATA, " ");
}

function periodo(inicio: string | null, fim: string | null): Periodo {
    if (inicio && fim && inicio > fim) [inicio, fim] = [fim, inicio];
    const descricao = inicio && fim
        ? inicio === fim ? `em ${br(inicio)}` : `de ${br(inicio)} a ${br(fim)}`
        : inicio ? `a partir de ${br(inicio)}` : `até ${br(fim!)}`;
    return { inicio, fim, descricao };
}

export function periodoNaPergunta(pergunta: string, agora: Date = new Date()): Periodo | null {
    const texto = pergunta.toLowerCase().normalize("NFC");
    const hoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate());
    const temHoje = /(?<!\p{L})(?:hoje|atualmente|agora)(?!\p{L})/u.test(texto);

    // Datas explícitas, com a palavra que vem antes de cada uma.
    const datas: { valor: string, antes: string }[] = [];
    for (const m of texto.matchAll(DATA)) {
        const dia = Number(m[1]), mes = Number(m[2]);
        if (dia < 1 || dia > 31 || mes < 1 || mes > 12) continue;
        let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : hoje.getFullYear();
        let data = new Date(ano, mes - 1, dia);
        if (data.getMonth() !== mes - 1) continue; // 31/02
        if (!m[3] && data > hoje) data = new Date(--ano, mes - 1, dia);
        datas.push({ valor: iso(data), antes: texto.slice(Math.max(0, m.index! - 25), m.index) });
    }
    if (datas.length >= 2) return periodo(datas[0]!.valor, datas[1]!.valor);
    if (datas.length === 1) {
        const { valor, antes } = datas[0]!;
        if (/(?:até|ate)(?:\s+o)?(?:\s+dia)?\s*$/.test(antes)) return periodo(null, valor);
        if (/(?:desde|a partir d[eo]|após|apos|depois d[eo])(?:\s+o)?(?:\s+dia)?\s*$/.test(antes) || temHoje
            || /em diante|pra cá|para cá/.test(texto)) {
            return periodo(valor, temHoje ? iso(hoje) : null);
        }
        return periodo(valor, valor);
    }

    // Expressões relativas.
    if (/(?<!\p{L})ontem(?!\p{L})/u.test(texto)) {
        const ontem = iso(somarDias(hoje, -1));
        return periodo(ontem, ontem);
    }
    const ultimosDias = texto.match(/últimos\s+(\d{1,3})\s+dias/);
    if (ultimosDias) return periodo(iso(somarDias(hoje, 1 - Number(ultimosDias[1]))), iso(hoje));
    if (/(?:mês|mes)\s+(?:passado|anterior)|(?:último|ultimo)\s+(?:mês|mes)/.test(texto)) {
        return periodo(iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)),
            iso(fimDoMes(hoje.getFullYear(), hoje.getMonth() - 1)));
    }
    if (/(?:n?este|n?esse|deste|desse)\s+(?:mês|mes)|(?:mês|mes)\s+atual/.test(texto)) {
        return periodo(iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), iso(hoje));
    }
    if (/ano\s+(?:passado|anterior)/.test(texto)) {
        const ano = hoje.getFullYear() - 1;
        return periodo(`${ano}-01-01`, `${ano}-12-31`);
    }
    if (/(?:n?este|n?esse|deste|desse)\s+ano|ano\s+atual/.test(texto)) {
        return periodo(`${hoje.getFullYear()}-01-01`, iso(hoje));
    }

    // Mês por nome: "em outubro", "outubro de 2025", "outubro/2025".
    const nomeMes = texto.match(new RegExp(
        `(?<!\\p{L})(${MESES.join("|")}|marco)(?!\\p{L})(?:\\s*(?:de|/)\\s*(\\d{4}))?`, "u"));
    if (nomeMes) {
        const mes = nomeMes[1] === "marco" ? 2 : MESES.indexOf(nomeMes[1]!);
        let ano = nomeMes[2] ? Number(nomeMes[2]) : hoje.getFullYear();
        if (!nomeMes[2] && new Date(ano, mes, 1) > hoje) ano--;
        return periodo(iso(new Date(ano, mes, 1)), iso(fimDoMes(ano, mes)));
    }
    if (temHoje && !/até\s+hoje|ate\s+hoje/.test(texto)) return periodo(iso(hoje), iso(hoje));

    // Ano sozinho: "em 2025", "no ano de 2025", "de 2025".
    const ano = texto.match(/(?:em|ano(?:\s+de)?|de)\s+(20\d{2})(?!\d)/);
    if (ano) return periodo(`${ano[1]}-01-01`, `${ano[1]}-12-31`);
    return null;
}
