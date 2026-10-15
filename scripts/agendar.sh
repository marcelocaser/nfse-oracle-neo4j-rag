#!/usr/bin/env bash
#
# Agenda a indexação incremental (scripts/indexar.sh) no crontab do usuário.
#
#   npm run index:schedule                     instala às 02:00, todo dia
#   npm run index:schedule -- "30 1 * * *"     instala/atualiza com outro horário
#   npm run index:schedule -- --status         mostra o agendamento atual
#   npm run index:schedule -- --remover        remove o agendamento
#
# O horário segue o formato do cron: minuto hora dia-do-mês mês dia-da-semana.
# Ex.: "0 2 * * 1-5" = 02:00 de segunda a sexta.
#
# Só a linha marcada com "# nfse-oracle-neo4j-rag:indexacao" é tocada; o resto
# do crontab fica como está. Não precisa de sudo.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
PROJECT_DIR="$(pwd)"
MARKER="# nfse-oracle-neo4j-rag:indexacao"

current="$(crontab -l 2>/dev/null || true)"
others="$(printf '%s\n' "$current" | grep -vF "$MARKER" || true)"

case "${1:-}" in
    --status)
        line="$(printf '%s\n' "$current" | grep -F "$MARKER" || true)"
        if [[ -n "$line" ]]; then echo "Agendado: $line"; else echo "Indexação não agendada."; fi
        exit 0
        ;;
    --remover)
        printf '%s\n' "$others" | sed '/^$/d' | crontab -
        echo "✓ Agendamento removido."
        exit 0
        ;;
esac

schedule="${1:-0 2 * * *}"
read -r -a fields <<< "$schedule"
if [[ ${#fields[@]} -ne 5 ]]; then
    echo "✗ \"$schedule\" não é um horário do cron (5 campos: minuto hora dia mês dia-da-semana)." >&2
    exit 1
fi

line="$schedule bash \"$PROJECT_DIR/scripts/indexar.sh\" $MARKER"
{ printf '%s\n' "$others" | sed '/^$/d'; echo "$line"; } | crontab -
echo "✓ Agendado: $schedule"
echo "  Logs em $PROJECT_DIR/logs/indexacao-AAAA-MM-DD.log"
