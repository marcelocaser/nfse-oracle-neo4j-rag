#!/usr/bin/env bash
#
# Instala a API de perguntas como serviço do systemd do usuário: sobe com a
# máquina e reinicia sozinha se cair. Não precisa de sudo, exceto o linger
# (uma vez), que faz o serviço subir no boot mesmo sem ninguém logado.
#
#   npm run api:service               instala (ou atualiza) e inicia
#   npm run api:service -- --status   estado do serviço e últimas linhas do log
#   npm run api:service -- --remover  para e remove o serviço
#
# Log: journalctl --user -u nfse-api -f
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
PROJECT_DIR="$(pwd)"
SERVICE="nfse-api"
UNIT_FILE="$HOME/.config/systemd/user/$SERVICE.service"

case "${1:-}" in
    --status)
        systemctl --user --no-pager status "$SERVICE" || true
        exit 0
        ;;
    --remover)
        systemctl --user disable --now "$SERVICE" 2>/dev/null || true
        rm -f "$UNIT_FILE"
        systemctl --user daemon-reload
        echo "✓ Serviço $SERVICE removido."
        exit 0
        ;;
esac

mkdir -p "$(dirname "$UNIT_FILE")"
cat > "$UNIT_FILE" <<EOF
# Gerado por $PROJECT_DIR/scripts/servico-api.sh — edite lá, não aqui.
[Unit]
Description=API de perguntas NFS-e ($PROJECT_DIR)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=/bin/bash $PROJECT_DIR/scripts/serve.sh
# O Neo4j e o Ollama podem subir depois: a API tenta de novo por ~1 min e,
# se ainda falhar, o systemd a reinicia.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE" >/dev/null
systemctl --user restart "$SERVICE"
echo "✓ Serviço $SERVICE instalado e iniciado."
echo "  Log: journalctl --user -u $SERVICE -f"

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
    echo
    echo "⚠️  Sem linger, o serviço só sobe quando $USER faz login. Para subir no boot:"
    echo "    sudo loginctl enable-linger $USER"
fi
