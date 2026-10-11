# Checklist de Produção (Go-Live) — NexusWA

Status: ✅ entregue no código · 🔧 entregue, depende de aplicar na VPS · ⏳ pendente de ação sua

| # | Item | Status | Evidência / ação |
|---|---|:-:|---|
| 1 | Documentação funcional escrita e atualizada | ✅ | `README.md`, `docs/API.md` (cobertura endpoint a endpoint) |
| 2 | Mapa de arquitetura | ✅ | `docs/ARQUITETURA.md` (diagrama Mermaid + fluxos) |
| 3 | Matriz RBAC | ✅ | `docs/RBAC.md` |
| 4 | Isolamento lógico multi-tenant | ✅ | `Instance.ownerId`; `requireInstance` com ownership; toda query filtra `instanceId`; 404 para outro tenant |
| 5 | Travas de concorrência e integridade | ✅ | `FOR UPDATE SKIP LOCKED` (campanhas), transação `Serializable` (cota), rotação atômica de refresh token, lock Redis por sessão, `@@unique` e FKs com cascade |
| 6 | Auditoria de senhas / nada hardcoded | ✅ | `docs/SEGURANCA.md` §2; `.env` validado no boot; gitleaks no CI |
| 7 | Integrações isoladas e documentadas | ✅ | Webhooks por instância com HMAC, SSRF-safe, circuit breaker e fila própria. Hosts internos só por whitelist (`WEBHOOK_INTERNAL_HOSTS`) |
| 8 | Mecanismo de report de bugs | ✅ | `POST /support/bug-report` (usuário ou token) + `GET/PATCH /admin/bug-reports`. O `requestId` de cada erro liga o relato ao log |
| 9 | Testes automatizados | ✅ / ⏳ | 66 testes (`npm test`) cobrindo crypto, SSRF, JWT, TOTP, filtros, parsers e normalização. ⏳ Testes de integração HTTP com Postgres/Redis reais: próxima etapa recomendada |
| 10 | Auditoria de segurança de código | ✅ / ⏳ | ESLint com regras de segurança, Semgrep (OWASP) e `npm audit` no CI. ⏳ Rode o CI no GitHub e o roteiro de pentest de `docs/SEGURANCA.md` §5 |
| 11 | Escudo na borda (WAF/Firewall) | 🔧 | `deploy/nginx-proxy-manager/*` (rate limit, bloqueio de dotfiles e `/metrics`), `deploy/host/firewall-ufw.sh`, `docker-user-firewall.sh`, `fail2ban-nexuswa.conf`. ⏳ Recomendado: Cloudflare na frente (DDoS volumétrico) |
| 12 | Tráfego 100% HTTPS | 🔧 | NPM com Let's Encrypt + Force SSL + HSTS; `PUBLIC_URL` https obrigatório em produção; cookies `Secure`; webhooks https obrigatórios em produção |

## Antes de ligar em produção

- [ ] `npm install` no PC e versionar o `package-lock.json`
- [ ] Rodar o roteiro de teste do README (12 passos) no PC
- [ ] Gerar segredos **novos** para a VPS (não reutilize os do PC)
- [ ] Backup da `ENCRYPTION_KEY` e do `ADMIN_TOKEN` no cofre de senhas
- [ ] NPM: proxy host + `advanced.conf` + `http_top.conf`
- [ ] Fechar 81/9443/5678 (`docker-user-firewall.sh`)
- [ ] fail2ban ativo; `backup.sh` no cron
- [ ] Criar usuário admin com 2FA ativado (`/auth/2fa/setup` → `/auth/2fa/enable`)
- [ ] Rodar o roteiro de pentest (`docs/SEGURANCA.md` §5) contra o domínio público
