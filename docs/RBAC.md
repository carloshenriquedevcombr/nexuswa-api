# Matriz RBAC (quem pode acessar o quê)

## Credenciais / papéis

| Ator | Como se autentica | Escopo |
|---|---|---|
| **Anônimo** | nenhuma | `/health`, `/ready`, `/auth/login`, `/auth/refresh`, `/files/*` com assinatura válida |
| **admintoken** | header `admintoken` (valor do `.env`, comparação em tempo constante) | Operações de servidor. Não gerencia usuários humanos. |
| **Token de instância** | header `token` (`?token=` só no `/sse`) | Todas as rotas de **uma** instância |
| **client** (usuário) | cookie de sessão/Bearer JWT; instância via `X-Instance-Id` | Somente instâncias em que `ownerId = user.id` |
| **admin** (usuário) | idem | Todas as instâncias, usuários, auditoria, bugs |
| **agent** (atendente) | cookie de sessão; instância via `X-Instance-Id` | Só os números em que está vinculado (`instance_agents`) e, neles, **só as conversas atribuídas a ele** |

## Matriz

Legenda: ✅ permitido · 🔒 somente as próprias instâncias · ❌ negado

| Recurso / rota | Anônimo | admintoken | token instância | client | admin |
|---|:-:|:-:|:-:|:-:|:-:|
| `/health` `/ready` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/status` (contagem de instâncias) | ❌ | ✅ | ❌ | ❌ | ✅ |
| `/metrics` | ❌ (exige `METRICS_TOKEN`) | ❌ | ❌ | ❌ | ❌ |
| `/auth/login` `/auth/refresh` `/auth/logout` | ✅ | — | — | ✅ | ✅ |
| `/auth/me` `/auth/password` `/auth/2fa/*` | ❌ | ❌ | ❌ | ✅ (a si mesmo) | ✅ (a si mesmo) |
| `POST /instance/create` | ❌ | ✅ | ❌ | ✅ até `maxInstances` | ✅ |
| `GET /instance/all` | ❌ | ✅ todas | ❌ | 🔒 | ✅ todas |
| `POST /instance/updateAdminFields` | ❌ | ✅ | ❌ | ❌ | ✅ |
| `POST /instance/token/rotate` | ❌ | ✅ (por `id`) | ✅ (a própria) | 🔒 | ✅ |
| `POST /instance/assign` (trocar dono) | ❌ | ❌ | ❌ | ❌ | ✅ |
| `/instance/*` (connect, status, proxy, privacy...) | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `DELETE /instance` | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/send/*` `/message/*` | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/chat/*` `/lead/*` `/contact(s)/*` `/label(s)/*` `/quickreply/*` `/call/*` | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/group/*` `/community/*` `/newsletter/*` `/business/*` | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/sender/*` (campanhas) | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/upload` (anexos) | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/webhook` `/webhook/errors` `/sse` | ❌ | ❌ | ✅ | 🔒 | ✅ |
| `/globalwebhook*` | ❌ | ✅ | ❌ | ❌ | ✅ |
| `/users*` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `/admin/audit` `/admin/bug-reports*` | ❌ | ❌ | ❌ | ❌ | ✅ |
| `/admin/restart` | ❌ | ✅ | ❌ | ❌ | ✅ |
| `/support/bug-report` | ❌ | ❌ | ✅ | ✅ | ✅ |

## Regras de implementação

1. A instância é resolvida **no middleware** (`requireInstance`). Pelo token, o próprio token identifica a instância. Pelo usuário, o `X-Instance-Id` só é aceito se `ownerId = user.id` (ou se o usuário for admin).
2. Uma instância de outro tenant responde **404**, e não 403, para não confirmar que ela existe.
3. Os handlers usam `inst(req).id` em todas as queries. Nenhum handler lê `instanceId` do corpo da requisição.
4. Um admin não pode rebaixar, desativar nem excluir a própria conta (evita lockout acidental).
5. Mudança de papel, desativação ou troca de senha revoga todas as sessões do usuário.
6. Rotas sensíveis passam por `sensitiveLimiter` e são auditadas (`audit_logs`).

## Atendentes (papel `agent`)

Lista branca em `src/middlewares/agentScope.ts`: qualquer rota fora dela responde **403** para atendentes, inclusive rotas novas que ainda não foram liberadas de propósito.

| Rota | O que o atendente pode |
|---|---|
| `POST /chat/find` | Só conversas com `leadAssignedAttendantId = ele` (o filtro é aplicado no servidor) |
| `POST /message/find` | Só com `chatid` de uma conversa dele |
| `POST /message/download` | Só mensagens de conversas dele |
| `POST /send/text` `POST /send/media` | Só para conversas dele; `replyid` precisa ser da mesma conversa |
| `POST /chat/read` | Só conversas dele |
| `POST /upload` | Anexos (pasta da instância) |
| `GET /sse` | Só eventos das conversas dele; o evento `connection` chega sem QR code nem campos administrativos |
| `POST /ticket/close` `POST /ticket/transfer` | Só conversas dele; destino precisa ser atendente ativo do mesmo número |
| `GET /ticket/agents` | Nome e disponibilidade dos colegas, sem e-mail |
| `GET /agent/me` `POST /agent/status` | Os próprios números e o próprio status (disponível, almoço, férias, pausa) |

Gestão da equipe (`/agents*`): leitura pelo dono, pelo admin ou pelo token da instância. **Alterações** (criar, trocar senha, remover) só pelo dono logado ou pelo admin. Um token vazado não cria contas. Um atendente só é reaproveitado por outra instância do **mesmo** dono. Remover o atendente devolve as conversas dele à fila, e sem nenhum número restante o login é desativado. Trocar o dono da instância (`/instance/assign`) remove os atendentes da equipe anterior.
