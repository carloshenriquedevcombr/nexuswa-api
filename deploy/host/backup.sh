#!/usr/bin/env bash
# Backup diário do Postgres do NexusWA (agende no cron: 0 3 * * * /opt/nexuswa/deploy/host/backup.sh)
# O dump contém credenciais WhatsApp CIFRADAS; sem a ENCRYPTION_KEY elas são inúteis —
# por isso guarde a chave SEPARADA do backup (cofre de senhas), nunca no mesmo lugar.
set -euo pipefail
cd "$(dirname "$0")/../.."
DEST="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$DEST" && chmod 700 "$DEST"
FILE="$DEST/nexuswa-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' | gzip -9 > "$FILE"
chmod 600 "$FILE"
find "$DEST" -name 'nexuswa-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $FILE"
