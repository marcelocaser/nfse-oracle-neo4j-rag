import { z } from "zod";

/**
 * Campos extraídos de cada documento na ingestão, para virar um nó `Nota` no
 * grafo (ver src/graph.ts).
 *
 * Com `withStructuredOutput(method: "jsonSchema")` o schema vai como
 * `response_format` e o Ollama restringe a geração a ele. Com o gemma4 local,
 * "functionCalling" voltava `undefined` em textos longos; "jsonSchema" acertou
 * o formato em todos os testes.
 *
 * Todos os campos são nullable: a regra é devolver null quando o documento
 * traz apenas "-" ou não traz o campo. O modelo pequeno erra campos de formato
 * fixo (CNPJ, valores), então tudo passa depois por src/nfseExtractor.ts, que
 * confere cada valor contra o texto e descarta o que não confirmar.
 */
export const nfseSchema = z.object({
    e_nfse: z.boolean()
        .describe("true se o texto é uma Nota Fiscal de Serviço (NFS-e/NFS); false para qualquer outro documento"),
    numero_nota: z.string().nullable()
        .describe("Número da NFS-e. Não confundir com código de autenticidade, código de verificação ou número de RPS"),
    data_emissao: z.string().nullable()
        .describe("Data de emissão da nota (dd/mm/aaaa). Se houver emissão e competência, priorizar a emissão"),
    valor_total: z.string().nullable()
        .describe("Valor total da nota ou do serviço, como aparece no documento"),
    prestador_razao_social: z.string().nullable()
        .describe("Razão social ou nome do PRESTADOR do serviço (quem emite a nota), completo"),
    prestador_cnpj: z.string().nullable()
        .describe("CNPJ ou CPF do PRESTADOR, no formato do documento. Não é inscrição municipal nem estadual"),
    tomador_razao_social: z.string().nullable()
        .describe("Razão social ou nome do TOMADOR do serviço (quem contrata), completo"),
    tomador_cnpj: z.string().nullable()
        .describe("CNPJ ou CPF do TOMADOR, no formato do documento. Não é inscrição municipal nem estadual"),
    municipio_prestacao: z.string().nullable()
        .describe("Município onde o serviço foi prestado (ou município de incidência)"),
    uf_prestacao: z.string().nullable()
        .describe("UF do município de prestação, com duas letras"),
    tipo_servico: z.enum(["COMISSÃO", "PROMOÇÃO DE VENDA", "PREMIAÇÃO"]).nullable()
        .describe(
            "Classificação feita SOMENTE pela Descrição/Discriminação do Serviço. " +
            "IGNORAR o rótulo do Código de Tributação Nacional/Municipal " +
            "(ex.: '17.06 - Propaganda e publicidade, inclusive promoção de vendas'), " +
            "que é nomenclatura padrão da classificação fiscal e não descreve a natureza da nota. " +
            "Se a descrição do serviço não indicar comissão, promoção de venda ou prêmio, retornar null"
        ),
    iss_retido: z.string().nullable()
        .describe("Valor do ISS/ISSQN RETIDO na fonte. null se não houver o campo"),
    irrf_retido: z.string().nullable()
        .describe("Valor do IR/IRRF RETIDO na fonte. null se o documento não tiver campo de IR/IRRF"),
}).describe("Campos estruturados extraídos de uma Nota Fiscal de Serviço eletrônica (NFS-e)");

export type NfseFields = z.infer<typeof nfseSchema>;
