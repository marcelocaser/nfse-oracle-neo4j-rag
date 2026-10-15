#!/usr/bin/env bash
#
# Indexação incremental agendada: roda `npm run index` com o ambiente que o
# cron não carrega (Node 22 do nvm, Oracle Instant Client) e grava o log em
# logs/indexacao-AAAA-MM-DD.log. Agende com: npm run index:schedule
#
#   bash scripts/indexar.sh            roda agora (mesmo log do agendamento)
#
# Variáveis opcionais (no crontab ou no ambiente):
#   ORACLE_INSTANT_CLIENT  pasta do Instant Client; padrão: a mais nova em
#                          /opt/oracle/instantclient_19_*
#   LOG_RETENTION_DAYS     dias de log mantidos (padrão 30)
#
# O resto (LLM, limites da rodada) vem do .env: NLP_MODEL, INGEST_MAX_MINUTES…
set -euo pipefail

# Opera sempre na raiz do projeto, qualquer que seja o cwd de quem chamou.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p logs
LOG="logs/indexacao-$(date +%F).log"
# Os logs citam prestadores e valores das notas: só o dono lê.
umask 077

# Uma rodada por vez: se a anterior ainda estiver no acervo, esta desiste.
exec 9>logs/.indexar.lock
if ! flock -n 9; then
    echo "$(date '+%F %T') ⏭️  indexação anterior ainda em andamento — rodada ignorada." >> "$LOG"
    exit 0
fi

(
    echo "==================== $(date '+%F %T') ===================="

    # O nvm.sh não é compatível com `set -u`.
    set +u
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use --silent 22
    set -u

    # No Linux o Instant Client tem de estar no search path antes do Node subir.
    if ! ldconfig -p 2>/dev/null | grep -q libclntsh; then
        client="${ORACLE_INSTANT_CLIENT:-$(ls -d /opt/oracle/instantclient_19_* 2>/dev/null | sort -V | tail -1)}"
        if [[ -z "$client" ]]; then
            echo "❌ Oracle Instant Client não encontrado. Defina ORACLE_INSTANT_CLIENT."
            exit 1
        fi
        export LD_LIBRARY_PATH="$client${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    fi

    status=0
    node --no-warnings --env-file .env --experimental-strip-types src/indexer.ts || status=$?
    echo "==================== fim: código $status ===================="
    exit "$status"
) >> "$LOG" 2>&1 || status=$?

find logs -name 'indexacao-*.log' -mtime +"${LOG_RETENTION_DAYS:-30}" -delete
exit "${status:-0}"
