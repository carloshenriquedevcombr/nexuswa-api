# Segurança do NexusWA

## 1. Matriz de ameaças → controles

| Ataque | Controle implementado | Onde |
|---|---|---|
| SQL Injection | Só Prisma (queries parametrizadas). SQL cru apenas via template tag `$queryRaw`. `$queryRawUnsafe` é bloqueado pelo ESLint. Filtros do `/chat/find` passam por whitelist de campos. | `lib/prisma.ts`, `lib/chatFilter.ts`, `eslint.config.mjs` |
| Command Injection | ffmpeg via `spawn` com argumentos em array (sem shell). `exec`/`execSync` bloqueados pelo ESLint. | `services/media.ts` |
| **SSRF** | `safeFetch`: só http/https, sem credenciais na URL, IP validado **no connect** (anti DNS rebinding), bloqueio de redes privadas, loopback, link-local, metadata 169.254.169.254, CGNAT e IPv6 interno. Cada redirect é revalidado; há limite de tamanho e de tempo. O Baileys nunca recebe URL do usuário. | `lib/ssrf.ts` |
| IDOR | Instância resolvida pelo token ou por ownership. Queries sempre com `instanceId` da credencial. Outro tenant recebe 404. | `middlewares/auth.ts` |
| Escalação de privilégio | Middlewares `requireRole`/`requireServerAdmin`. Papel vem do banco a cada request (não é confiado só ao JWT). JWT sem `alg:none`/confusão de algoritmo. | `middlewares/auth.ts`, `auth/jwt.ts` |
| XSS | API só responde JSON. CSP `default-src 'none'`. Erros não ecoam o valor enviado. Arquivos servidos com `Content-Disposition: attachment` + `nosniff`. | `app.ts`, `routes/system.routes.ts` |
| CSRF | Cookies `SameSite=Strict` + double-submit (`X-CSRF-Token`) quando a credencial vem de cookie. | `middlewares/csrf.ts` |
| Brute force / credential stuffing | Rate limit Redis por IP+e-mail. Bloqueio progressivo da conta. Tempo de resposta igual para usuário inexistente. 2FA TOTP opcional. fail2ban na borda. | `auth/auth.service.ts`, `middlewares/rateLimit.ts` |
| Session hijacking | Access token de 15 min em cookie HttpOnly. Refresh opaco rotativo com **detecção de reuso** (revoga a família). Troca de senha invalida todos os tokens. | `auth/auth.service.ts` |
| Vazamento de credenciais | Tokens de instância e refresh guardados como hash SHA-256. Segredos em AES-256-GCM com AAD. Logs com `redact`. Query do SSE mascarada. | `lib/crypto.ts`, `lib/logger.ts` |
| Design inseguro | Cotas por cliente (transação serializável), limites de payload em todo schema, intervalo mínimo em campanhas, `Idempotency-Key`. | `services/*`, `routes/sender.routes.ts` |
| Configuração incorreta | `.env` validado no boot (a API não sobe sem segredo forte). Sem stack trace em produção. Container read-only, sem root, `cap_drop: ALL`. Banco e Redis sem porta pública. | `config/env.ts`, `Dockerfile`, `docker-compose.yml` |
| DoS / DDoS L7 | Limites de corpo por rota, timeouts HTTP (headers, request, keep-alive), `limit_req`/`limit_conn` no NPM, rate limit Redis, limite de conexões SSE por instância. **DDoS volumétrico exige CDN/WAF (ex.: Cloudflare).** | `app.ts`, `server.ts`, `deploy/` |
| Lógica de negócio | Toda decisão no servidor; status de mensagem monotônico; campanha valida cada item antes de gravar; `SKIP LOCKED` impede envio duplo. | `services/*` |
| Supply chain | Lockfile, `npm ci`, Baileys com versão fixa, `npm audit` + Semgrep + gitleaks no CI, Dependabot. | `.github/` |
| CORS permissivo | Whitelist `CORS_ORIGINS`; `*` é proibido em produção. | `app.ts`, `config/env.ts` |
| Clickjacking | `X-Frame-Options: DENY` + `frame-ancestors 'none'`. | `app.ts` |
| Deserialização insegura | Só JSON (`strict`) com schema Zod e tamanho máximo. | `app.ts`, `lib/validate.ts` |
| Exposição de `.env`/`.git` | `.dockerignore` impede que entrem na imagem; o NPM nega arquivos ocultos. | `.dockerignore`, `deploy/nginx-proxy-manager/advanced.conf` |
| Webhook forjado / replay | HMAC-SHA256 com timestamp (`t=`), tolerância de 5 min. O token da instância **não** vai no payload. | `services/webhookDispatcher.ts` |
| vCard / header injection | Escape de quebras de linha e separadores no vCard. | `whatsapp/vcard.ts` |
| Path traversal | Download só por nome aleatório validado por regex + assinatura HMAC com expiração. | `lib/signedUrl.ts` |

## 2. Auditoria de segredos (Zero Hardcoding)

Resultado da varredura no código-fonte (`src/`, `prisma/`, `scripts/`, `deploy/`):
- Nenhuma senha, token ou chave literal. Todos os segredos vêm do `.env`, validados em `config/env.ts`.
- `.env` está no `.gitignore` e no `.dockerignore`. Só o `.env.example` (com placeholders) é versionado.
- O único valor fixo sensível-parecido é o texto do hash "dummy" do Argon2 (`auth/password.ts`), que não é um segredo: serve só para igualar o tempo de resposta.
- O CI roda **gitleaks** em todo push.

Refaça a varredura manual a qualquer momento:
```bash
grep -rnEi "(password|secret|token|apikey)\s*[:=]\s*['\"][^'\"]{8,}" src prisma scripts deploy
```

> ⚠️ O `.env` que você anexou na conversa original tinha a senha real do Postgres. Se esse arquivo foi para algum lugar compartilhado, troque a senha.

## 3. Verificando a assinatura do webhook (no seu receptor)

```js
import crypto from 'node:crypto';

// secret = valor "secret" retornado UMA vez ao criar o webhook (guarde no .env do receptor)
function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false; // anti-replay
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}

// Express: use o corpo CRU (express.raw) — re-serializar o JSON muda os bytes e quebra a assinatura.
app.post('/hooks/whatsapp', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body.toString(), req.get('x-nexuswa-signature') ?? '', process.env.NEXUSWA_WEBHOOK_SECRET)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);                               // responda rápido
  queue.add(JSON.parse(req.body.toString()));        // processe depois
});
```

No **n8n**, adicione um nó *Code* logo após o Webhook que recalcula o HMAC com o mesmo algoritmo.

## 4. Achados na sua VPS atual (pelas capturas enviadas)

| Achado | Risco | Correção |
|---|---|---|
| NPM admin publicado em `:81`, Portainer em `:9443` e n8n em `:5678` diretamente na internet | Painéis administrativos acessíveis sem passar pelo proxy/TLS. O Docker ignora o UFW. | `deploy/host/docker-user-firewall.sh` ou publicar como `127.0.0.1:PORTA:PORTA` e acessar só pelos domínios HTTPS |
| Proxy host `smartmigrate` offline apontando para `172.17.0.1:5000` | Host morto no proxy: superfície desnecessária | Remova o proxy host se o serviço foi desativado |
| Imagens `:latest` (n8n, NPM, Portainer) | Atualização silenciosa ou quebra inesperada | Fixe as versões (ex.: `n8nio/n8n:1.x.y`) e atualize conscientemente |

## 5. Pentest: o que testar antes do go-live

- `/send/media` com `file` apontando para `http://127.0.0.1`, `http://169.254.169.254`, `http://[::1]`, um domínio que resolve para IP interno e um redirect 302 para IP interno. Todos devem dar 400.
- Token da instância A com `X-Instance-Id` da instância B. Deve dar 401 ou 404.
- Cliente acessando `/users`, `/globalwebhook` e `/admin/*`. Deve dar 403.
- JWT com `alg: none`, com payload adulterado e expirado. Deve dar 401.
- 20 logins errados. Deve dar 429/423.
- POST com cookie de sessão sem `X-CSRF-Token`. Deve dar 403.
- Anexo enviado pela instância A usado com o token da instância B (`upload:...`). Deve dar 400 "Anexo não encontrado".
- `POST /upload` com HTML renomeado para `.txt` ou `.jpg`, e com `.svg`/`.exe`. Deve dar 400 "Tipo de arquivo não permitido".
- `docker compose logs api | grep -i privKey` não deve retornar nada: os logs internos da libsignal (que imprimiam chaves da sessão) são descartados por `src/lib/consoleGuard.ts`.
- Atendente chamando `/instance/connect`, `/instance/status`, `/webhook`, `/sender/simple`, `/agents` ou `/chat/find` com o `X-Instance-Id` de outro número. Deve dar 403 ou 404.
- Atendente usando `/send/text` com `number` de uma conversa que não é dele, ou com `replyid` de outra conversa. Deve dar 404.
- Token de instância tentando `PATCH /agents/:id {password}`. Deve dar 403.
