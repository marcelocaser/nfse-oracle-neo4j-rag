# exemplo-12 — Embeddings + Neo4j, lendo PDFs de BLOB no Oracle 11g

Pipeline RAG didático:

```
Oracle 11g (BLOB)  →  PDF → chunks  →  embeddings locais (MiniLM)  →  Neo4j (índice vetorial)  →  perguntas via LLM
```

Os PDFs **não** são lidos do disco: cada execução varre registros de uma tabela
do Oracle, lê a coluna `BLOB`, extrai o texto, gera embeddings localmente e
indexa no Neo4j. Depois responde um conjunto de perguntas usando só o contexto
recuperado.

## Testado com

Validado ponta a ponta nesta configuração:

| Componente | Versão / valor |
| ---------- | -------------- |
| Oracle Database | **11.2.0.3.0** |
| Oracle Instant Client | **19.26.0.0.0** (Thick mode) |
| Connect string | Easy Connect (`host:1521/SERVICE_NAME`) — funcionou sem precisar do descritor TNS |
| Node.js | 22.23.3 |
| Neo4j | 5.14.0-community + APOC |
| Embeddings | `Xenova/all-MiniLM-L6-v2`, 384 dimensões |

Resultado do run: 1 PDF (71 KB) lido do BLOB → 1 página → 3 chunks indexados no
Neo4j com `source = oracle://<TABELA>/<ID>`, e as 5 perguntas respondidas a
partir desse conteúdo, com scores de similaridade entre **0.670 e 0.723**.

## Pré-requisitos

### 1. Node 22

O projeto usa `--experimental-strip-types` (Node 22.6+) e `--env-file`:

```bash
nvm use 22
node -v   # v22.x
```

### 2. Oracle Instant Client 19.x — obrigatório

O `node-oracledb` tem dois modos. O **Thin mode** (default, sem bibliotecas
nativas) só conecta em **Oracle Database 12.1 ou superior**. Para 11g é
preciso o **Thick mode**, que carrega as bibliotecas do Oracle Client.

Pela matriz de interoperabilidade cliente-servidor da Oracle:

| Oracle Client | conecta em             |
| ------------- | ---------------------- |
| 23            | Database 19+           |
| 21            | Database 12.1+         |
| **19**        | **Database 11.2+** ← a única opção para 11g |

Ou seja: **Instant Client 19.x**. Nem 21, nem 23.

Baixe o pacote *Basic* (ou *Basic Light*) de
[Instant Client para Linux x86-64](https://www.oracle.com/database/technologies/instant-client/linux-x86-64-downloads.html),
seção **Version 19.x**.

**Opção A — sem sudo (foi a usada nos testes).** As libs ficam no seu `$HOME` e
o `LD_LIBRARY_PATH` é exportado por sessão:

```bash
mkdir -p ~/oracle
unzip instantclient-basic-linux.x64-19.26.0.0.0dbru.zip -d ~/oracle

export LD_LIBRARY_PATH="$HOME/oracle/instantclient_19_26:$LD_LIBRARY_PATH"
```

Como é uma variável de ambiente, **ela se perde ao fechar o terminal** — precisa
ser exportada antes de cada `npm start` / `npm run oracle:check` (ou colocada no
seu `~/.bashrc` / `~/.zshrc`).

**Opção B — permanente, com sudo.** Registra as libs no linker, sem depender de
variável de ambiente:

```bash
sudo apt-get install -y libaio1 unzip

sudo mkdir -p /opt/oracle
cd /opt/oracle
sudo unzip ~/Downloads/instantclient-basic-linux.x64-19.26.0.0.0dbru.zip

sudo sh -c "echo /opt/oracle/instantclient_19_26 > /etc/ld.so.conf.d/oracle-instantclient.conf"
sudo ldconfig

ldconfig -p | grep libclntsh   # precisa listar a lib
```

> No **Linux**, `ORACLE_CLIENT_LIB_DIR` não resolve: o diretório tem de estar no
> search path do linker **antes** do Node iniciar. Em Windows/macOS essa variável
> é usada (`initOracleClient({ libDir })`).

### 3. Tabela com os PDFs

Qualquer tabela com um identificador, um nome e uma coluna `BLOB`. O exemplo
assume este formato, mas tabela e colunas são configuráveis no `.env`:

```sql
CREATE TABLE DOCUMENTOS (
  ID      NUMBER        PRIMARY KEY,
  NOME    VARCHAR2(255),
  ARQUIVO BLOB
);
```

## Configuração

```bash
cp .env.example .env
```

Preencha no `.env`:

| Variável                 | Observação |
| ------------------------ | ---------- |
| `ORACLE_USER` / `ORACLE_PASSWORD` | credenciais do schema |
| `ORACLE_CONNECT_STRING`  | ver abaixo |
| `ORACLE_PDF_TABLE` e as 3 colunas | nomes reais no seu schema |
| `ORACLE_PDF_MAX_DOCS`    | quantos PDFs ingerir por execução |
| `OPENROUTER_API_KEY`     | crie em https://openrouter.ai/keys |

**Connect string.** Com *service name* dá para usar Easy Connect:

```ini
ORACLE_CONNECT_STRING=meu-host:1521/orclpdb
```

Muitas instalações 11g expõem apenas **SID**. Nesse caso use o descritor completo:

```ini
ORACLE_CONNECT_STRING=(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=meu-host)(PORT=1521))(CONNECT_DATA=(SID=orcl)))
```

**Query customizada.** Se precisar de join ou filtro próprio, sobrescreva a query
inteira com `ORACLE_PDF_QUERY`. O contrato é devolver as colunas `ID`, `NAME` e
`DATA`; o bind `:maxDocs` é opcional:

```ini
ORACLE_PDF_QUERY=SELECT d.ID AS ID, d.NOME AS NAME, d.ARQUIVO AS DATA FROM DOCUMENTOS d WHERE d.CATEGORIA = 'TENSORES' AND ROWNUM <= :maxDocs
```

> Oracle 11g não tem `OFFSET ... FETCH NEXT` (só a partir do 12c) — use `ROWNUM`.

## Execução

```bash
nvm use 22
npm ci

# se instalou pela Opção A (sem sudo), exporte antes de cada sessão:
export LD_LIBRARY_PATH="$HOME/oracle/instantclient_19_26:$LD_LIBRARY_PATH"

npm run typecheck      # 1. checagem de tipos (o Node só faz type-stripping em runtime)
npm run oracle:check   # 2. smoke test do Oracle, sem tocar no Neo4j nem no LLM
npm run infra:up       # 3. sobe o Neo4j 5.14 + APOC
npm start              # 4. pipeline completo
npm run infra:down
```

`npm run oracle:check` é o primeiro comando a rodar quando algo falha: ele
imprime a versão do client e do servidor, o SQL gerado e, para cada linha, o
tamanho do BLOB e se ele começa com a assinatura `%PDF-`. Isso separa
"problema de Oracle/Instant Client" de "problema do pipeline RAG".

### Conferir o resultado no Neo4j

Neo4j Browser em http://localhost:7474 (`neo4j` / `password`):

```cypher
MATCH (c:Chunk) RETURN c.source AS origem, count(*) AS chunks ORDER BY chunks DESC;
```

Cada chunk guarda a origem como `oracle://<TABELA>/<ID>`, mais `documentName`,
`oracleId` e `pageNumber`.

As respostas geradas são salvas em `./respostas/`.

> As 5 perguntas em `src/index.ts` e o `prompts/answerPrompt.json` estão no
> domínio de **NFS-e**, acompanhando os documentos que estão na tabela. Ao
> apontar o exemplo para outra base de PDFs, ajuste ambos: perguntas fora do
> domínio do documento produzem scores de similaridade perto do threshold
> (0.5, em `src/ai.ts`) e respostas sem utilidade.

### Qualidade da extração de texto

`CONFIG.pdf.parsedItemSeparator` controla como os *text items* do pdf.js são
unidos. O default do `PDFLoader` é `""`, que cola as palavras:

| separador | texto extraído |
| --------- | -------------- |
| `""` (default do loader) | `ValordoServiço` … `R$635,62` |
| `" "` (usado aqui) | `Valor do Serviço` … `R$ 635,62` |

Com `" "` os embeddings ficam melhores — nos testes os scores subiram de
0.597–0.673 para 0.670–0.723. O custo são artefatos de layout como `NFS- e` e
`CNPJ / CPF / NIF`, que o LLM interpreta sem problema.

## Troubleshooting

| Erro | Causa |
| ---- | ----- |
| `DPI-1047: Cannot locate a 64-bit Oracle Client library` | Instant Client ausente; ou instalado sem `ldconfig` (Opção B); ou o `LD_LIBRARY_PATH` não foi exportado nesta sessão do terminal (Opção A) |
| `NJS-138: connections to this database server version are not supported in Thin mode` | Thick mode não foi ativado — é o que `initOracleThickMode()` resolve; confira o Instant Client |
| `ORA-12514` / `ORA-12505` | connect string com service name num 11g que só tem SID → use o descritor TNS completo |
| `ORA-28040: No matching authentication protocol` | protocolo de senha antigo; pode exigir `SQLNET.ALLOWED_LOGON_VERSION_SERVER` no servidor |
| `ORA-00942: table or view does not exist` | nome de tabela errado, ou o usuário não tem `SELECT` nela (confira também o schema: `ORACLE_PDF_TABLE=SCHEMA.TABELA`) |
| `ORA-01036: illegal variable name/number` | `ORACLE_PDF_QUERY` com bind diferente de `:maxDocs` |
| `401 Missing Authentication header` (OpenRouter) | `OPENROUTER_API_KEY` vazia ou com placeholder — a chave real começa com `sk-or-v1-` |
| `402 This request requires more credits, or fewer max_tokens` | limite de gasto da chave. `CONFIG.openRouter.maxTokens` (1024) evita que o `ChatOpenAI` peça o contexto inteiro do modelo; reduza se a sua chave for mais restrita |
| "Nenhum texto extraído" | PDF escaneado, sem camada de texto — precisaria de OCR |
| Nenhuma linha retornada | a query filtra `DBMS_LOB.GETLENGTH(blob) > 0`; confira se os BLOBs estão realmente populados |

## Estrutura

| Arquivo | Papel |
| ------- | ----- |
| `src/config.ts` | configuração centralizada, lida do `.env`, com validação dos identificadores SQL |
| `src/oracle.ts` | Thick mode + pool + leitura dos BLOBs como `AsyncGenerator<PdfRecord>` |
| `src/documentProcessor.ts` | BLOB → páginas de PDF → chunks, com metadata rastreável |
| `src/index.ts` | orquestra ingestão em lote e o loop de perguntas |
| `src/oracleCheck.ts` | smoke test isolado do Oracle |
| `src/ai.ts` | retrieval no Neo4j + geração da resposta |
| `prompts/` | `answerPrompt.json` (role/task/instruções) e `template.txt` |

Os BLOBs são entregues **um por vez** (async generator): cada PDF é processado e
liberado antes de o próximo ser buscado, em vez de carregar o lote inteiro na
memória.
