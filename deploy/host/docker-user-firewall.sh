#!/usr/bin/env bash
# O Docker publica portas escrevendo regras próprias no iptables, que PASSAM POR CIMA do UFW.
# Na sua VPS, o NPM admin (81), o Portainer (9443) e o n8n (5678) estão publicados direto
# na internet, sem passar pelo proxy com TLS. Esta regra na chain DOCKER-USER bloqueia o
# acesso externo a elas, liberando apenas o seu IP administrativo (opcional).
#
# Uso:  sudo ADMIN_IP=200.200.200.200 ./docker-user-firewall.sh
# Persistência: instale "iptables-persistent" e rode "netfilter-persistent save".
# Alternativa mais limpa: publicar essas portas como "127.0.0.1:81:81" nos compose
# e acessar Portainer/n8n só pelos domínios HTTPS do NPM.
set -euo pipefail
PORTS="${PORTS:-81,9443,5678}"
IFACE="${IFACE:-$(ip route | awk '/default/ {print $5; exit}')}"

iptables -N DOCKER-USER 2>/dev/null || true
# Remove regras antigas deste script (idempotente)
iptables -S DOCKER-USER | grep -- '--comment nexuswa-hardening' | sed 's/^-A/-D/' | while read -r rule; do iptables $rule; done

if [[ -n "${ADMIN_IP:-}" ]]; then
  iptables -I DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports "$PORTS" -s "$ADMIN_IP" -j RETURN -m comment --comment nexuswa-hardening
fi
iptables -A DOCKER-USER -i "$IFACE" -p tcp -m multiport --dports "$PORTS" -m conntrack --ctstate NEW -j DROP -m comment --comment nexuswa-hardening
iptables -S DOCKER-USER
