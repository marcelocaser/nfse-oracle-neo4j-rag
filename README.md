# exemplo-12 — Embeddings + Neo4j, lendo PDFs de BLOB no Oracle 11g

Pipeline RAG didático:

```
Oracle 11g (BLOB)  →  PDF (texto ou OCR) → chunks  →  embeddings locais (Ollama)  →  Neo4j (índice vetorial)  →  perguntas via LLM (Ollama)
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
| Embeddings | `embeddinggemma` via Ollama (local), 768 dimensões |
| LLM | `gemma4:cloud` via Ollama (API compatível com OpenAI) |

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

### 3. Ollama

Embeddings e LLM passam pelo [Ollama](https://docs.ollama.com). No Linux o
instalador já registra o serviço na porta `11434`:

```bash
curl -fsSL https://ollama.com/install.sh | sh

ollama pull embeddinggemma   # embeddings, roda local (~620 MB, cabe em GPU de 4 GB)
ollama signin                # libera modelos :cloud no servidor local
ollama run gemma4:cloud      # teste rápido do LLM — /bye para sair
```

- **Embeddings locais** (`embeddinggemma`, multilíngue): os PDFs não saem da
  máquina na indexação.
- **LLM na nuvem** (`gemma4:cloud`, incluído no plano gratuito): a pergunta e os
  trechos recuperados do Neo4j são enviados à nuvem do Ollama. Se os dados não
  puderem sair da máquina, use o LLM local abaixo.

O código chama o servidor local (`http://localhost:11434/v1`) com o `ChatOpenAI`
do LangChain; não há chave no código. Para chamar a nuvem direto, sem servidor
local, use `LLM_BASE_URL=https://ollama.com/v1` e uma chave de
https://ollama.com/settings/keys em `OLLAMA_API_KEY`.

#### LLM local (dados sensíveis)

Com tudo local, nenhum dado das notas sai da máquina:

```bash
ollama pull gemma4:e2b-it-qat
ollama create gemma4-e2b-8k -f ollama/Modelfile.gemma4-e2b-8k
```

```ini
NLP_MODEL=gemma4-e2b-8k
LLM_REASONING_EFFORT=none
```

Os dois ajustes são obrigatórios:

- **`LLM_REASONING_EFFORT=none`** — o gemma4 tem *thinking* ligado por padrão e
  gasta os 1024 tokens de `maxTokens` raciocinando: a resposta volta **vazia**.
- **`num_ctx 8192`** (no Modelfile) — com o contexto padrão de 4096, o prompt
  com 8 chunks (~3000 tokens) mais a resposta estoura e o Ollama trunca.

Comparação nas 5 perguntas do exemplo (9 NFS-e, GTX 1650 4 GB):

| `NLP_MODEL` | Tempo total | Observação |
| ----------- | ----------- | ---------- |
| `gemma4:cloud` | ~15 s | melhor qualidade; dados vão para a nuvem do Ollama |
| `gemma4-e2b-8k` + `LLM_REASONING_EFFORT=none` | ~107 s | 100% GPU; recusa nota inexistente, mas deixa passar detalhes (ex.: IR retido) e às vezes repete itens |
| `granite4.1:3b` | ~161 s | **não use**: inventou valor e data para uma nota que não existe |

Em GPUs com mais VRAM, modelos maiores (`gemma4:e4b`, `gemma4:12b`) devem
responder melhor; com 4 GB eles transbordam para a CPU e ficam lentos.

#### OCR de PDFs escaneados ou fotografados

PDFs sem camada de texto (foto de celular, digitalização) passam por OCR local
com o modelo de visão `glm-ocr` — os dados não saem da máquina:

```bash
ollama pull glm-ocr                       # 2,2 GB, cabe numa GPU de 4 GB
sudo apt-get install -y poppler-utils     # pdftoppm, renderiza as páginas
```

O OCR entra sozinho quando o PDF não rende texto: cada página vira PNG
(`pdftoppm`), é transcrita pelo `glm-ocr` e segue o fluxo normal (chunks,
embeddings, Neo4j). Os chunks ficam marcados com `ocr: true`:

```cypher
MATCH (c:Chunk {ocr: true}) RETURN c.documentName, c.pageNumber, c.text LIMIT 5;
```

| Variável | Default | Observação |
| -------- | ------- | ---------- |
| `OCR_ENABLED` | `true` | `false` volta a pular PDFs sem texto |
| `OCR_MODEL` | `glm-ocr` | outro modelo de visão do Ollama |
| `OCR_DPI` | `100` | 100 dpi ≈ 30 s/página; 150 dpi ≈ 70 s/página (GTX 1650) |

Medido numa foto de NFS-e com 6 notas em 6 páginas: números, datas, CNPJs,
valores e códigos de verificação saem corretos; nomes longos podem ganhar erros
pontuais (`Clientica` por `Cientifica`). Só a ingestão fica mais lenta — as
perguntas não mudam. O OCR é só da ingestão: as imagens são criadas num
diretório temporário e apagadas em seguida.

#### GPU com pouca VRAM (ex.: 4 GB)

Por padrão o Ollama mantém até 3 modelos carregados ao mesmo tempo. Numa GPU
de 4 GB, se o `embeddinggemma` carregar antes do OCR, o `glm-ocr` não cabe
inteiro e roda parte na CPU. Com `OLLAMA_MAX_LOADED_MODELS=1` o Ollama troca
os modelos em vez de dividi-los, e cada um usa a GPU inteira:

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_MAX_LOADED_MODELS=1"
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart ollama
systemctl show ollama -p Environment | tr ' ' '\n' | grep MAX_LOADED   # confere
```

Medido numa GTX 1650 (4 GB):

| Cenário | Padrão (3 modelos) | `OLLAMA_MAX_LOADED_MODELS=1` |
| ------- | ------------------ | ---------------------------- |
| OCR por página | ~50 s (`glm-ocr` 39% na CPU) | **~30 s** (100% GPU) |
| Pipeline completo com OCR, `gemma4:cloud` | ~326 s | **~210 s** |
| Pipeline sem OCR, LLM local `gemma4-e2b-8k` | ~107 s | ~123 s |

Com LLM local, cada pergunta alterna `embeddinggemma` (busca) e `gemma4`
(resposta) na memória — cerca de 3 s a mais por pergunta. Para desfazer:
`sudo rm /etc/systemd/system/ollama.service.d/override.conf` e repita o
`daemon-reload` e o `restart`.

### 4. Tabela com os PDFs

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
| `EMBEDDING_MODEL` / `NLP_MODEL` | defaults `embeddinggemma` e `gemma4:cloud` |
| `LLM_REASONING_EFFORT`   | `none` para LLM local com thinking (gemma4); vazio na nuvem |

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

### Limpeza

```bash
npm run clean       # remove respostas/, neo4j/ e import/
npm run clean:all   # o anterior + node_modules/ (rode npm ci depois)
```

Os dois derrubam a infra antes de apagar. O container do Neo4j escreve em
`neo4j/` e `import/` como **root**, então um `rm -rf` do seu usuário falha com
"Permission denied" — por isso `scripts/clean.sh` recorre a um container
rodando como root para apagar esses dois, o que dispensa `sudo` no host. A
imagem usada é a mesma do `docker-compose.yml`, já em cache local.

`respostas/` guarda os dados extraídos das notas, então é artefato descartável e
não versionado — vale limpar antes de compartilhar o diretório do projeto.

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
| `401 Unauthorized` no LLM | servidor local não logado: rode `ollama signin` (ou, chamando `https://ollama.com/v1` direto, `OLLAMA_API_KEY` ausente/inválida) |
| Resposta vazia com LLM local | modelo com *thinking* gastou o `maxTokens`: defina `LLM_REASONING_EFFORT=none` |
| `model "embeddinggemma" not found` | rode `ollama pull embeddinggemma` |
| `Unsupported authentication token, missing key credentials` (Neo4j) | `NEO4J_USER` ou `NEO4J_PASSWORD` vazio no `.env`. Cuidado com `NEO4J_USER= ` (só espaço): o `--env-file` do Node engole a linha seguinte e a senha some |
| `ECONNREFUSED 127.0.0.1:11434` | serviço do Ollama parado: `sudo systemctl start ollama` |
| `The provided embedding function and vector index dimensions do not match` | o índice `tensors_index` foi criado com outro modelo de embeddings (ex.: MiniLM, 384 dim). Rode `npm run clean` ou, no Neo4j Browser, `DROP INDEX tensors_index` |
| "Nenhum texto extraído" | PDF sem camada de texto e OCR desligado (`OCR_ENABLED=false`) ou sem resultado |
| `spawn pdftoppm ENOENT` | falta o poppler-utils: `sudo apt-get install -y poppler-utils` |
| `model "glm-ocr" not found` | rode `ollama pull glm-ocr` |
| OCR lento (>40 s/página) | confira `ollama ps`: se o `glm-ocr` não estiver "100% GPU", a VRAM está disputada — use `OLLAMA_MAX_LOADED_MODELS=1` (seção "GPU com pouca VRAM") ou reduza `OCR_DPI` |
| Nenhuma linha retornada | a query filtra `DBMS_LOB.GETLENGTH(blob) > 0`; confira se os BLOBs estão realmente populados |

## Estrutura

| Arquivo | Papel |
| ------- | ----- |
| `src/config.ts` | configuração centralizada, lida do `.env`, com validação dos identificadores SQL |
| `src/oracle.ts` | Thick mode + pool + leitura dos BLOBs como `AsyncGenerator<PdfRecord>` |
| `src/documentProcessor.ts` | BLOB → páginas de PDF → chunks, com metadata rastreável |
| `src/ocr.ts` | OCR de PDFs sem texto: `pdftoppm` → PNG → `glm-ocr` no Ollama |
| `src/index.ts` | orquestra ingestão em lote e o loop de perguntas |
| `src/oracleCheck.ts` | smoke test isolado do Oracle |
| `src/ai.ts` | retrieval no Neo4j + geração da resposta |
| `scripts/clean.sh` | remove os artefatos gerados, inclusive os root-owned do container |
| `ollama/` | Modelfile do LLM local com contexto de 8192 tokens |
| `prompts/` | `answerPrompt.json` (role/task/instruções) e `template.txt` |

Os BLOBs são entregues **um por vez** (async generator): cada PDF é processado e
liberado antes de o próximo ser buscado, em vez de carregar o lote inteiro na
memória.
