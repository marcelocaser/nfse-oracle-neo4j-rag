import { z } from "zod";

/**
 * Schema dos campos extraídos de uma NFS-e.
 *
 * Com `withStructuredOutput(method: "functionCalling")` este schema é enviado
 * como definição de função na chamada à API. O formato passa a ser imposto no
 * nível do protocolo, em vez de pedido no texto do prompt — foi o que resolveu
 * as cercas ```json que o modelo insistia em adicionar.
 *
 * Todos os campos são nullable: a regra é devolver null quando o documento
 * traz apenas "-" ou não traz o campo.
 */
export const nfseSchema = z.object({
    valor_total: z.string().nullable()
        .describe("Valor total da nota, total do serviço ou valor bruto, como aparece no documento"),
    valor_liquido: z.string().nullable()
        .describe("Valor líquido da NFS-e, se existir"),
    numero_nota: z.string().nullable()
        .describe("Número da NFS-e. Não confundir com código de autenticidade, código de verificação ou número de RPS"),
    irrf: z.string().nullable()
        .describe("Valor do IRRF lido APENAS do campo isolado de IRRF ou IRPJ. Nunca usar campos agregados como 'IRRF, CP, CSLL - Retidos'"),
    aliquota: z.string().nullable()
        .describe("Alíquota aplicada, em percentual, como consta no documento"),
    total_issqn: z.string().nullable()
        .describe("Valor total do ISSQN apurado"),
    data_emissao: z.string().nullable()
        .describe("Data de emissão da nota. Se houver emissão e competência, priorizar a emissão"),
    tomador_cnpj: z.string().nullable()
        .describe("CNPJ ou CPF do tomador do serviço"),
    tomador_razao_social: z.string().nullable()
        .describe("Razão social ou nome fantasia do tomador, completo"),
    prestador_municipio: z.string().nullable()
        .describe("Município do prestador do serviço"),
    prestador_uf: z.string().nullable()
        .describe("UF do prestador, com duas letras"),
    prestador_cnpj: z.string().nullable()
        .describe("CNPJ ou CPF do prestador do serviço"),
    prestador_razao_social: z.string().nullable()
        .describe("Razão social ou nome fantasia do prestador, completo"),
    prestador_email: z.string().nullable()
        .describe("E-mail do prestador do serviço"),
    local_prestacao: z.string().nullable()
        .describe("Local de prestação do serviço, no formato 'Município - UF' quando ambos estiverem disponíveis"),
    tipo_nota_fiscal: z.enum(["COMISSÃO", "PROMOÇÃO DE VENDA", "PREMIAÇÃO"]).nullable()
        .describe(
            "Classificação feita SOMENTE pela Descrição do Serviço. " +
            "IGNORAR o rótulo do Código de Tributação Nacional/Municipal " +
            "(ex.: '17.06.01 - Propaganda e publicidade, inclusive promoção de vendas'), " +
            "que é nomenclatura padrão da classificação fiscal e não descreve a natureza da nota. " +
            "Se a descrição do serviço não indicar comissão, promoção de venda ou prêmio, retornar null"
        ),
}).describe("Campos estruturados extraídos de uma Nota Fiscal de Serviço eletrônica (NFS-e)");

export type NfseFields = z.infer<typeof nfseSchema>;
