# NexusWA API 2.0

API multi-instância de automação do WhatsApp (Baileys), com **rotas e payloads compatíveis com a uazapi 2.4.2**, multi-tenant (contas com login) e construída no modelo **Secure-by-Design**.

- Envio de texto, mídia (imagem, vídeo, áudio, PTT, documento, sticker), contato, localização, **menus interativos** (botões, lista, enquete, carrossel), PIX, eventos e status
- **Campanhas** de envio em massa com agendamento, pausa e retomada, intervalo aleatório e métricas
- Fila assíncrona por instância (`async: true`), webhooks com retry, circuit breaker e assinatura HMAC, e SSE em tempo real
- Chats, CRM (leads, tags e campos personalizados), etiquetas, respostas rápidas, grupos, comunidades, canais e catálogo Business
- Contas de usuário (Argon2id + 2FA TOTP), papéis `admin`/`client`, isolamento por tenant e auditoria

> **Painel web:** abra `https://SEU-DOMINIO/` no navegador, faça login e gerencie instâncias (QR Code ou código), conversas, envios, campanhas, webhooks e usuários.

> Documentação complementar em [`docs/`](docs): arquitetura, matriz RBAC, segurança, cobertura de endpoints, checklist de produção e deploy na VPS.

---

## 1. Pré-requisitos

| Onde | Precisa ter |
|---|---|
| PC (Windows) | Node.js **22.12+** (`node -v`) e Docker Desktop, **ou** Postgres + Redis instalados (ver [`docs/RODAR-SEM-DOCKER.md`](docs/RODAR-SEM-DOCKER.md)) |
| VPS | Docker + Docker Compose, Nginx Proxy Manager (já existe na sua VPS) |

O Redis e o Postgres **vêm dentro do docker-compose**. Você não precisa instalar nada além do Docker.

---

## 2. Testar no PC (passo a passo)

> **Sem Docker?** Siga [`docs/RODAR-SEM-DOCKER.md`](docs/RODAR-SEM-DOCKER.md). Em resumo: `npm install` → `npm run setup:local` → `npm run user:create -- --email ... --role admin` → `npm run dev`. O roteiro de testes da seção 2.5 vale igual.

Abra o terminal (PowerShell) na pasta do projeto.

**2.1 — Dependências e lockfile**
```powershell
npm install
```
Isso gera o `package-lock.json` e o Prisma Client. **Versione o lockfile**: o build de produção usa `npm ci` com ele.

**2.2 — Segredos e `.env`**
```powershell
copy .env.example .env
npm run secrets:generate
```
Cole a saída do segundo comando no `.env`, substituindo as linhas `TROQUE_PELO_GERADO`.
**Guarde a `ENCRYPTION_KEY` no seu cofre de senhas.** Sem ela, as sessões do WhatsApp salvas no banco não podem ser recuperadas.

**2.3 — Subir tudo no Docker**
```powershell
docker compose -f docker-compose.yml -f docker-compose.pc.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.pc.yml logs -f api
```
As migrações do banco são aplicadas automaticamente. Espere a linha `NexusWA API no ar`.

> Prefere rodar a API fora do Docker (hot reload)? Suba só o banco e o Redis com `docker compose -f docker-compose.yml -f docker-compose.pc.yml up -d postgres redis`, depois rode `npx prisma migrate deploy` e `npm run dev`.

**2.4 — Criar o seu usuário admin** (a senha é pedida sem aparecer na tela)
```powershell
docker compose -f docker-compose.yml -f docker-compose.pc.yml exec api node dist/cli/createUser.js --email voce@exemplo.com --role admin --name "Carlos" --max 50
```

**2.5 — Roteiro de teste** (Postman ou `curl`; use o `ADMIN_TOKEN` do seu `.env`)

| # | Teste | Chamada | Esperado |
|---|---|---|---|
| 1 | API viva | `GET http://localhost:3000/ready` | `{"status":"ready"}` |
| 2 | Criar instância | `POST /instance/create`, header `admintoken`, body `{"name":"teste"}` | 201 com `token` (**guarde, ele aparece uma única vez**) |
| 3 | Conectar | `POST /instance/connect`, header `token` | `instance.qrcode` com o QR em base64 (cole no navegador) |
| 4 | Ler o QR | WhatsApp → Aparelhos conectados | `GET /instance/status` retorna `connected: true` |
| 5 | Texto | `POST /send/text` `{"number":"55DDDNUMERO","text":"Olá {{first_name}}"}` | mensagem chega |
| 6 | Mídia | `POST /send/media` `{"number":"...","type":"image","file":"https://picsum.photos/400"}` | imagem chega |
| 7 | Enquete | `POST /send/menu` `{"number":"...","type":"poll","text":"Horário?","choices":["Manhã","Tarde"]}` | enquete chega |
| 8 | Webhook | `POST /webhook` `{"url":"https://webhook.site/SEU-ID","events":["messages"],"excludeMessages":["wasSentByApi"]}` | resposta traz `secret`; responda no celular e veja o evento chegar |
| 9 | Campanha | `POST /sender/simple` `{"numbers":["55..."],"type":"text","text":"Teste","delayMin":5,"delayMax":10}` → `GET /sender/listfolders` | status `done` |
| 10 | Segurança | `POST /send/media` com `"file":"http://127.0.0.1:5432"` | **400**, destino bloqueado (proteção SSRF) |
| 11 | Segurança | `GET /instance/status` com token errado | **401** |
| 12 | Login | `POST /auth/login` `{"email":"...","password":"..."}` | cookies `nwa_at`, `nwa_rt`, `nwa_csrf` |

**2.6 — Testes automatizados**
```powershell
npm test
npm run typecheck
npm run lint
```

---

## 3. Subir na VPS

Resumo abaixo; o passo a passo completo, com o Nginx Proxy Manager, firewall e backup, está em [`docs/DEPLOY-VPS.md`](docs/DEPLOY-VPS.md).

```bash
# na VPS (via SSH), em /opt/nexuswa
git clone <seu-repo> . # ou envie a pasta por scp/SFTP (sem node_modules e sem .env)
cp .env.example .env && nano .env         # NODE_ENV=production, PUBLIC_URL=https://wa.exemplo.com.br, COOKIE_SECURE=true
docker network ls                         # confirme o nome da rede do NPM → PROXY_NETWORK no .env
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec api node dist/cli/createUser.js --email voce@exemplo.com --role admin
```
Depois, no NPM, crie o Proxy Host `wa.exemplo.com.br` → `http://nexuswa_api:3000`, com SSL Let's Encrypt, Force SSL, HSTS e HTTP/2. Cole o conteúdo de [`deploy/nginx-proxy-manager/advanced.conf`](deploy/nginx-proxy-manager/advanced.conf) na aba Advanced.

---

## 4. Autenticação (resumo)

| Quem | Header | Pode |
|---|---|---|
| Automação de servidor | `admintoken: <ADMIN_TOKEN>` | criar/listar instâncias, webhook global, restart |
| Integração de uma instância | `token: <token da instância>` | tudo daquela instância |
| Usuário do dashboard | cookie de sessão (ou `Authorization: Bearer`) + `X-Instance-Id` | só as instâncias que são dele (admin: todas) |

Matriz completa em [`docs/RBAC.md`](docs/RBAC.md).

**Diferenças de segurança em relação à uazapi**
- O token da instância **não é enviado no payload do webhook**. Cada entrega é assinada com HMAC-SHA256 no header `X-NexusWA-Signature: t=<unix>,v1=<hex>`, e o `secret` aparece uma vez, na criação do webhook. Veja o exemplo de verificação em [`docs/SEGURANCA.md`](docs/SEGURANCA.md).
- O token da instância é guardado como hash no banco. Ele só aparece na criação e na rotação (`/instance/token/rotate`); `/instance/all` não o devolve.
- `Idempotency-Key` (opcional) nos envios e campanhas: repetir a requisição com a mesma chave não duplica a mensagem.

---

## 5. Estrutura

```
src/
  config/        validação do .env (fail-fast)
  lib/           crypto, SSRF, JID, erros, métricas, locks, circuit breaker
  auth/          Argon2id, JWT, TOTP, sessão com refresh rotativo
  middlewares/   autenticação, RBAC, CSRF, rate limit, idempotência, logs
  whatsapp/      sessão Baileys, auth state cifrado, eventos, normalização
  services/      envio, fila async, campanhas, webhooks, SSE, mídia
  routes/        rotas compatíveis com a uazapi + auth/admin/suporte
prisma/          schema + migrações
deploy/          Nginx Proxy Manager, UFW, DOCKER-USER, fail2ban, backup
tests/           testes automatizados (node:test)
```

## 6. Commits

Siga o padrão **Conventional Commits**: título no imperativo e corpo explicando o *porquê*.
```
feat(sender): adiciona pausa automática quando a sessão cai

Evita que mensagens da campanha sejam marcadas como falha enquanto o
WhatsApp reconecta; o worker agora aguarda a sessão voltar.
```
