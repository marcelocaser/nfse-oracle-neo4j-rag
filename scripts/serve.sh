#!/usr/bin/env bash
#
# Sobe a API de perguntas (src/server.ts) com o Node 22 do nvm. Usado pelo
# serviço do systemd (scripts/servico-api.sh), que não carrega o perfil do
# shell. Para rodar à mão, `npm run serve` basta.
set -euo pipefail

# Opera sempre na raiz do projeto, qualquer que seja o cwd de quem chamou.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# O nvm.sh não é compatível com `set -u`.
set +u
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" --no-use
nvm use --silent 22
set -u

# exec: o systemd passa a falar direto com o Node (SIGTERM → encerramento limpo).
exec node --no-warnings --env-file .env --experimental-strip-types src/server.ts
