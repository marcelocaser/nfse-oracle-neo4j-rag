#!/usr/bin/env bash
#
# Remove o que o projeto gera ao rodar.
#
#   npm run clean       respostas/, neo4j/, import/
#   npm run clean:all   o anterior + node_modules/
#
# Por que não é um simples "rm -rf": o container do Neo4j escreve em neo4j/ e
# import/ como root, então o rm do usuário falha com "Permission denied". Nesse
# caso a remoção é feita de dentro de um container rodando como root, o que
# dispensa sudo no host.
set -euo pipefail

# Opera sempre na raiz do projeto, qualquer que seja o cwd de quem chamou.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REMOVE_NODE_MODULES=false
[[ "${1:-}" == "--all" ]] && REMOVE_NODE_MODULES=true

# A imagem já está em cache local (é a do docker-compose.yml), então o fallback
# não precisa baixar nada.
NEO4J_IMAGE="neo4j:5.14.0-community"

info() { printf '  %s\n' "$1"; }

# Remove um diretório, recorrendo ao container se o rm do usuário não der conta.
remove_dir() {
    local target="$1"

    if [[ ! -e "$target" ]]; then
        info "– $target (não existe)"
        return 0
    fi

    if rm -rf "$target" 2>/dev/null && [[ ! -e "$target" ]]; then
        info "✓ $target"
        return 0
    fi

    if ! command -v docker >/dev/null 2>&1; then
        info "✗ $target — root-owned e docker indisponível."
        info "  Remova manualmente: sudo rm -rf $target"
        return 1
    fi

    info "  $target é root-owned, removendo via container..."
    docker run --rm --user 0:0 --entrypoint sh \
        -v "$PWD":/target "$NEO4J_IMAGE" \
        -c "rm -rf '/target/$target'"

    if [[ -e "$target" ]]; then
        info "✗ $target — falhou. Remova manualmente: sudo rm -rf $target"
        return 1
    fi
    info "✓ $target (via container)"
}

echo "Derrubando a infra (se estiver de pé)..."
docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true

echo "Removendo artefatos gerados:"
status=0
remove_dir respostas || status=1
remove_dir neo4j     || status=1
remove_dir import    || status=1

if [[ "$REMOVE_NODE_MODULES" == true ]]; then
    remove_dir node_modules || status=1
    info "  rode 'npm ci' antes de usar o projeto de novo"
fi

echo
if [[ "$status" -eq 0 ]]; then
    echo "Limpeza concluída."
else
    echo "Limpeza incompleta — veja as mensagens acima."
fi
exit "$status"
