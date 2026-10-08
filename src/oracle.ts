import oracledb from "oracledb";
import type { OracleConfig } from "./config.ts";

/** Um PDF lido de uma linha da tabela: o BLOB já materializado em memória. */
export interface PdfRecord {
    id: string;
    name: string;
    data: Buffer;
    /** Rótulo de origem propagado até o metadata do nó no Neo4j. */
    sourceLabel: string;
}

/** Shape de cada linha devolvida pela query (colunas com alias fixo). */
interface PdfRow {
    ID: unknown;
    NAME: unknown;
    DATA: Buffer | null;
}

let clientInitialized = false;

/**
 * Habilita o Thick mode do node-oracledb.
 *
 * Obrigatório para Oracle 11g: o Thin mode (default) só conecta em
 * Oracle Database 12.1+. Em Thick mode é preciso o Oracle Instant Client
 * **19.x** — pela matriz de interoperabilidade da Oracle, o client 19 é o
 * último que conecta em 11.2 (client 21 exige DB 12.1+, client 23 exige 19+).
 *
 * Precisa ser chamado uma única vez, antes de qualquer conexão/pool, e é
 * irreversível no processo.
 *
 * No Linux, `libDir` não altera o carregamento das libs — o diretório tem de
 * estar no search path do linker antes do Node iniciar (ldconfig).
 */
export function initOracleThickMode(config: Pick<OracleConfig, 'clientLibDir' | 'configDir'>): void {
    if (clientInitialized) return;

    const options: oracledb.InitialiseOptions = {};
    if (config.clientLibDir && process.platform !== 'linux') {
        options.libDir = config.clientLibDir;
    }
    if (config.configDir) {
        options.configDir = config.configDir;
    }

    try {
        oracledb.initOracleClient(options);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Falha ao carregar o Oracle Instant Client (Thick mode), obrigatório para Oracle 11g.\n` +
            `  ${detail}\n` +
            `  Instale o Instant Client 19.x e registre-o:\n` +
            `    sudo sh -c "echo /opt/oracle/instantclient_19_26 > /etc/ld.so.conf.d/oracle-instantclient.conf"\n` +
            `    sudo ldconfig\n` +
            `  Confira com: ldconfig -p | grep libclntsh`
        );
    }

    clientInitialized = true;
    console.log(`🔌 Oracle Client (Thick mode): ${oracledb.oracleClientVersionString}`);
}

/**
 * Lê PDFs armazenados em coluna BLOB de um Oracle 11g.
 *
 * Os registros são entregues um a um (async generator) para que cada PDF seja
 * processado e liberado antes do próximo ser buscado — evita carregar todos os
 * BLOBs do lote na memória de uma vez.
 */
export class OraclePdfRepository {
    private config: OracleConfig;
    private pool: oracledb.Pool | null = null;

    constructor(config: OracleConfig) {
        this.config = config;
    }

    /**
     * Query montada a partir da tabela/colunas do .env, ou a sobrescrita
     * de `ORACLE_PDF_QUERY`.
     *
     * Oracle 11g não tem `OFFSET ... FETCH NEXT` (só a partir do 12c), por isso
     * o limite usa `ROWNUM`. O filtro por `DBMS_LOB.GETLENGTH` descarta linhas
     * com BLOB nulo ou vazio, que fariam o parser de PDF estourar.
     */
    /** A query efetivamente usada — exposta para diagnóstico. */
    buildQuery(): string {
        if (this.config.query) return this.config.query;

        const { idColumn, nameColumn, blobColumn, table } = this.config;
        return [
            `SELECT ${idColumn} AS ID, ${nameColumn} AS NAME, ${blobColumn} AS DATA`,
            `  FROM ${table}`,
            ` WHERE ${blobColumn} IS NOT NULL`,
            `   AND DBMS_LOB.GETLENGTH(${blobColumn}) > 0`,
            `   AND ROWNUM <= :maxDocs`,
        ].join('\n');
    }

    async connect(): Promise<void> {
        if (this.pool) return;

        for (const [key, value] of Object.entries({
            ORACLE_USER: this.config.user,
            ORACLE_PASSWORD: this.config.password,
            ORACLE_CONNECT_STRING: this.config.connectString,
        })) {
            if (!value) throw new Error(`${key} não está definido no .env`);
        }

        initOracleThickMode(this.config);

        this.pool = await oracledb.createPool({
            user: this.config.user,
            password: this.config.password,
            connectString: this.config.connectString,
            poolMin: this.config.poolMin,
            poolMax: this.config.poolMax,
        });

        const connection = await this.pool.getConnection();
        try {
            console.log(`🗄️  Oracle Server: ${connection.oracleServerVersionString}`);
        } finally {
            await connection.close();
        }
    }

    /** Emite um PdfRecord por linha encontrada, sob demanda. */
    async *streamPdfs(): AsyncGenerator<PdfRecord> {
        if (!this.pool) throw new Error("connect() precisa ser chamado antes de streamPdfs()");

        const connection = await this.pool.getConnection();
        try {
            const sql = this.buildQuery();
            // Só manda o bind se a query o referencia: uma sobrescrita via
            // ORACLE_PDF_QUERY sem :maxDocs falharia com ORA-01036.
            const binds = /:maxDocs\b/.test(sql) ? { maxDocs: this.config.maxDocs } : {};

            const result = await connection.execute<PdfRow>(
                sql,
                binds,
                {
                    resultSet: true,
                    outFormat: oracledb.OUT_FORMAT_OBJECT,
                    // Traz BLOB como Buffer (e CLOB como string) em vez de
                    // instâncias Lob, que exigiriam consumo em ordem e
                    // fechamento manual. Escopado nesta query para não mutar
                    // o oracledb.fetchAsBuffer global.
                    fetchTypeHandler: (metadata) => {
                        if (metadata.dbType === oracledb.DB_TYPE_BLOB) {
                            return { type: oracledb.BUFFER };
                        }
                        // Cobre o caso do nome do documento estar num CLOB.
                        if (metadata.dbType === oracledb.DB_TYPE_CLOB) {
                            return { type: oracledb.STRING };
                        }
                        return undefined;
                    },
                }
            );

            const resultSet = result.resultSet!;
            try {
                while (true) {
                    const row: PdfRow | undefined = await resultSet.getRow();
                    if (!row) break;

                    if (!row.DATA || row.DATA.length === 0) {
                        console.warn(`⚠️  Registro ${String(row.ID)} tem BLOB vazio — ignorado.`);
                        continue;
                    }

                    const id = String(row.ID);
                    yield {
                        id,
                        name: row.NAME == null ? `documento-${id}` : String(row.NAME),
                        data: row.DATA,
                        sourceLabel: `oracle://${this.config.table}/${id}`,
                    };
                }
            } finally {
                await resultSet.close();
            }
        } finally {
            await connection.close();
        }
    }

    async close(): Promise<void> {
        if (!this.pool) return;
        await this.pool.close(10);
        this.pool = null;
    }
}
