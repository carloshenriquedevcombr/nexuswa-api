#!/usr/bin/env bash
# Firewall do host (UFW). Revise antes de executar — rode como root.
# ATENÇÃO: confirme a porta do seu SSH antes (padrão 22) para não perder acesso.
set -euo pipefail
SSH_PORT="${SSH_PORT:-22}"

ufw default deny incoming
ufw default allow outgoing
ufw limit "${SSH_PORT}/tcp" comment 'SSH com limite anti brute-force'
ufw allow 80/tcp  comment 'HTTP (redirect + ACME Lets Encrypt)'
ufw allow 443/tcp comment 'HTTPS (Nginx Proxy Manager)'
ufw --force enable
ufw status verbose

echo
echo "IMPORTANTE: portas publicadas pelo Docker (ex.: 81, 9443, 5678) IGNORAM o UFW."
echo "Use deploy/host/docker-user-firewall.sh para fechá-las."
