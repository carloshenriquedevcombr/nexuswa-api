#!/usr/bin/env bash
# =====================================================================
# NexusWA — instalador para a VPS (pensado para rodar via Termux/SSH)
#
#   cd /opt/nexuswa && sudo bash deploy/vps-install.sh
#
# Pode rodar de novo quantas vezes quiser: mantém o .env existente
# (segredos NÃO são trocados) e só reconstrói/atualiza os containers.
#
# O que faz:
#  1. Confere Docker/Compose
#  2. Descobre a rede do Nginx Proxy Manager (e se o n8n está nela)
#  3. Cria o .env de PRODUÇÃO com segredos fortes (openssl, sem Node)
#  4. Instala as zonas de rate limit no NPM (http_top.conf) com backup
#  5. Build + sobe Postgres, Redis e API
#  6. Espera a API ficar saudável e cria o seu usuário admin
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.vps.yml)

c_ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
c_err()  { printf '  \033[31m✖\033[0m %s\n' "$*"; }
step()   { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 1
step "1/6 Pré-requisitos"
if [[ $EUID -ne 0 ]] && ! docker info >/dev/null 2>&1; then
  c_err "Rode com sudo (ou com um usuário do grupo docker)."; exit 1
fi
command -v docker >/dev/null || { c_err "Docker não encontrado."; exit 1; }
docker compose version >/dev/null 2>&1 || { c_err "Plugin 'docker compose' não encontrado."; exit 1; }
command -v openssl >/dev/null || { c_err "openssl não encontrado (apt install -y openssl)."; exit 1; }
c_ok "Docker $(docker version --format '{{.Server.Version}}') e Compose OK"

MEM_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if (( MEM_MB < 1200 )); then
  c_warn "Só ${MEM_MB} MB de RAM livre. O build pode falhar por falta de memória; considere criar swap:"
  echo "      fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile"
else
  c_ok "RAM livre: ${MEM_MB} MB"
fi

# ---------------------------------------------------------------- 2
step "2/6 Nginx Proxy Manager"
NPM_CONTAINER=$(docker ps --format '{{.Names}} {{.Image}}' | awk '/nginx-proxy-manager/ {print $1; exit}')
if [[ -z "$NPM_CONTAINER" ]]; then
  c_err "Container do Nginx Proxy Manager não encontrado em execução."; exit 1
fi
PROXY_NETWORK=$(docker inspect "$NPM_CONTAINER" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -v '^bridge$' | grep -v '^$' | head -1 || true)
[[ -z "$PROXY_NETWORK" ]] && { c_err "Não achei a rede Docker do NPM."; exit 1; }
c_ok "NPM: $NPM_CONTAINER — rede: $PROXY_NETWORK"

N8N_HOST=""
if docker network inspect "$PROXY_NETWORK" --format '{{range .Containers}}{{.Name}} {{end}}' | grep -q 'n8n'; then
  N8N_HOST="n8n"
  c_ok "n8n está na mesma rede — webhooks para http://n8n:5678 serão permitidos"
fi

# ---------------------------------------------------------------- 3
step "3/6 Arquivo .env (produção)"
if [[ -f .env ]]; then
  c_ok ".env já existe — mantido (segredos preservados)"
  DOMAIN=$(grep -E '^PUBLIC_URL=' .env | sed -E 's#^PUBLIC_URL=https?://##; s#/.*##')
else
  read -r -p "  Domínio da API [wa.exemplo.com.br]: " DOMAIN
  DOMAIN=${DOMAIN:-wa.exemplo.com.br}
  read -r -p "  Origem do dashboard (CORS) [https://painel.exemplo.com.br]: " CORS
  CORS=${CORS:-https://painel.exemplo.com.br}

  hex()    { openssl rand -hex "$1"; }
  b64url() { openssl rand -base64 "$1" | tr -d '\n=' | tr '+/' '-_'; }
  umask 077
  cat > .env <<EOF
# NexusWA — produção — gerado em $(date -Iseconds) por deploy/vps-install.sh
# NUNCA versione este arquivo. Faça backup de ENCRYPTION_KEY e ADMIN_TOKEN no cofre de senhas.
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://${DOMAIN}
CORS_ORIGINS=${CORS}
TRUST_PROXY=1
COOKIE_SECURE=true

POSTGRES_DB=nexuswa
POSTGRES_USER=nexuswa
POSTGRES_PASSWORD=$(hex 24)
REDIS_PASSWORD=$(hex 24)

ADMIN_TOKEN=$(b64url 36)
JWT_SECRET=$(b64url 48)
ENCRYPTION_KEY=$(openssl rand -base64 32)
METRICS_TOKEN=$(b64url 24)

ACCESS_TOKEN_TTL_MIN=15
REFRESH_TOKEN_TTL_DAYS=14
LOGIN_MAX_ATTEMPTS=5
LOGIN_LOCK_MINUTES=15
MEDIA_MAX_MB=64
FILE_URL_TTL_HOURS=48
MESSAGE_RETENTION_DAYS=7
UNPAIRED_INSTANCE_TTL_MIN=60
WEBHOOK_INTERNAL_HOSTS=${N8N_HOST}
SSRF_ALLOW_PRIVATE=false
OPENAI_API_KEY=
LOG_LEVEL=info
BAILEYS_LOG_LEVEL=warn
RATE_LIMIT_GLOBAL_PER_MIN=600
RATE_LIMIT_SEND_PER_MIN=120

PROXY_NETWORK=${PROXY_NETWORK}
EOF
  chmod 600 .env
  c_ok ".env criado (permissão 600) para https://${DOMAIN}"
fi
# Mantém a rede detectada mesmo em .env antigo.
if grep -q '^PROXY_NETWORK=' .env; then
  sed -i "s#^PROXY_NETWORK=.*#PROXY_NETWORK=${PROXY_NETWORK}#" .env
else
  echo "PROXY_NETWORK=${PROXY_NETWORK}" >> .env
fi

# ---------------------------------------------------------------- 4
step "4/6 Rate limit no Nginx Proxy Manager"
NPM_DATA=$(docker inspect "$NPM_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')
if [[ -n "$NPM_DATA" && -d "$NPM_DATA" ]]; then
  mkdir -p "$NPM_DATA/nginx/custom"
  TARGET="$NPM_DATA/nginx/custom/http_top.conf"
  if [[ -f "$TARGET" ]] && grep -q 'zone=nexuswa_api' "$TARGET"; then
    c_ok "zonas já instaladas em $TARGET"
  else
    [[ -f "$TARGET" ]] && cp "$TARGET" "$TARGET.bak.$(date +%s)"
    grep -v '^#' deploy/nginx-proxy-manager/http_top.conf >> "$TARGET"
    # Só recarrega se a configuração do nginx continuar válida (não derruba seus outros sites).
    if docker exec "$NPM_CONTAINER" nginx -t >/dev/null 2>&1; then
      docker exec "$NPM_CONTAINER" nginx -s reload >/dev/null
      c_ok "zonas de rate limit instaladas e NPM recarregado"
    else
      c_err "nginx -t falhou; revertendo"
      if ls "$TARGET".bak.* >/dev/null 2>&1; then cp "$(ls -t "$TARGET".bak.* | head -1)" "$TARGET"; else rm -f "$TARGET"; fi
      c_warn "Cole o advanced.conf SEM as linhas limit_req/limit_conn."
    fi
  fi
else
  c_warn "Não achei o volume /data do NPM; instale deploy/nginx-proxy-manager/http_top.conf manualmente."
fi

# ---------------------------------------------------------------- 5
step "5/6 Build e subida (pode levar alguns minutos na primeira vez)"
"${COMPOSE[@]}" up -d --build
c_ok "containers iniciados"

# ---------------------------------------------------------------- 6
step "6/6 Aguardando a API ficar saudável"
for i in $(seq 1 60); do
  STATUS=$(docker inspect nexuswa_api --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo "missing")
  [[ "$STATUS" == "healthy" ]] && break
  if [[ "$STATUS" == "exited" || "$STATUS" == "restarting" ]] && (( i > 6 )); then
    c_err "A API não subiu. Últimas linhas do log:"
    "${COMPOSE[@]}" logs --tail 60 api
    exit 1
  fi
  sleep 5
done
if [[ "$STATUS" != "healthy" ]]; then
  c_err "Tempo esgotado (status: $STATUS). Log:"; "${COMPOSE[@]}" logs --tail 60 api; exit 1
fi
c_ok "API saudável"

USERS=$(docker exec nexuswa_postgres psql -U nexuswa -d nexuswa -tAc "SELECT count(*) FROM users" 2>/dev/null || echo 0)
if [[ "${USERS// /}" == "0" ]]; then
  echo
  read -r -p "  E-mail do seu usuário admin: " ADMIN_EMAIL
  "${COMPOSE[@]}" exec api node dist/cli/createUser.js --email "$ADMIN_EMAIL" --role admin --name "Admin" --max 50
else
  c_ok "já existem usuários cadastrados"
fi

ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' .env | cut -d= -f2-)
cat <<EOF

========================================================================
 NexusWA no ar dentro da VPS.  Falta só o Proxy Host no NPM (pelo navegador):

   https://npm.exemplo.com.br  →  Hosts → Add Proxy Host
     Domain Names ......: ${DOMAIN}
     Scheme / Host / Port: http / nexuswa_api / 3000
     [x] Block Common Exploits   [x] Websockets Support
     SSL: Request new certificate, [x] Force SSL [x] HTTP/2 [x] HSTS
     Advanced: cole o conteúdo de deploy/nginx-proxy-manager/advanced.conf
               (para ver:  cat ${PROJECT_DIR}/deploy/nginx-proxy-manager/advanced.conf)

   Antes: crie o DNS tipo A  ${DOMAIN}  →  IP desta VPS.

 Teste depois:  curl https://${DOMAIN}/ready

 Seu ADMIN_TOKEN (guarde no cofre de senhas; não compartilhe):
   ${ADMIN_TOKEN}
   Para ver de novo:  grep ADMIN_TOKEN ${PROJECT_DIR}/.env
========================================================================
EOF
