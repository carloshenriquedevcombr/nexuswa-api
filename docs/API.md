# Cobertura de endpoints (uazapi 2.4.2 → NexusWA)

Legenda:
- ✅ implementado
- 🟡 implementado, mas o WhatsApp pode ocultar ou recusar em contas não oficiais
- 🧪 depende de função do Baileys 7 RC; se ela não existir na versão instalada, responde **501** com a explicação
- ❌ não suportado pelo Baileys (**501**)

Autenticação, formatos de request e nomes de campos seguem a uazapi. A instância vem do header `token` ou, para usuários logados, de `X-Instance-Id`.

## Administração / instância
| Endpoint | Status | Observação |
|---|:-:|---|
| POST /instance/create | ✅ | `admintoken`, admin ou cliente (dentro da cota). O `token` aparece **uma vez**. Campo extra `owner_user_id` (admin). |
| POST /instance/token/rotate | ✅ | |
| GET /instance/all | ✅ | **Não** devolve tokens (guardados como hash) |
| POST /instance/connect | ✅ | QR (base64 em `instance.qrcode`) ou `phone` → `instance.paircode` |
| POST /instance/disconnect | ✅ | faz logout e apaga as credenciais |
| POST /instance/reset | ✅ | reinicia o socket preservando as credenciais |
| GET /instance/status | ✅ | |
| GET /instance/wa_messages_limits | ❌ | o Baileys não expõe esse dado |
| POST /instance/updateFieldsMap / updateInstanceName / updateAdminFields / updateDelaySettings | ✅ | |
| GET/POST /instance/proxy | ✅ | apenas `mode: custom` (http/https/socks), guardado cifrado. `internal` (gerenciado) não existe. |
| /proxy-managed/* | ❌ | serviço proprietário da uazapi |
| POST /profile/name, /profile/image | ✅ | `image: "remove"` remove a foto |
| DELETE /instance | ✅ | apaga sessão, filas e dados (cascade) |
| GET/POST /instance/privacy | ✅ | `calladd` é 🧪 |
| POST /instance/presence | ✅ | |
| GET /instance/history-sync/status | ✅ | contadores locais |
| POST /instance/openai | ✅ | extra: guarda a chave OpenAI da instância, cifrada |
| POST /admin/restart | ✅ | reinício gracioso (o Docker sobe de novo) |
| POST /admin/token/rotate | ❌ | por design, rotacione pelo `.env` |
| GET /status | ✅ | restrito a admin/admintoken (não é público como na uazapi) |

## Envio
| Endpoint | Status | Observação |
|---|:-:|---|
| POST /send/text | ✅ | placeholders `{{name}}`, `{{first_name}}`, `{{lead_*}}`; link preview gerado com proteção SSRF |
| POST /send/media | ✅ | image, video, videoplay, ptv, document, audio, myaudio/ptt (converte para OGG/Opus), sticker (converte para WebP), viewOnce |
| POST /send/contact | ✅ | múltiplos telefones separados por vírgula |
| POST /send/location | ✅ | |
| POST /send/menu `poll` | ✅ | **formato mais confiável** |
| POST /send/menu `button` / `list` / `carousel` / `button_legacy` | 🟡 | nativeFlow; `imageButton` suportado |
| POST /send/carousel | 🟡 | image/video/document por card; botões REPLY/URL/CALL/COPY |
| POST /send/location-button | 🟡 | |
| POST /send/pix-button | 🟡 | |
| POST /send/request-payment | 🟡 | `amount` obrigatório; `orderMessageId` sozinho → 501 |
| POST /message/payment/status | ❌ | |
| POST /send/event | 🧪 | |
| POST /send/status | ✅ | texto (cores 1-19, fontes), imagem, vídeo, áudio; audiência = agenda ou `recipients` |
| POST /message/presence | ✅ | |
| Campos comuns | ✅ | `replyid`, `mentions`, `readchat`, `readmessages`, `delay`, `forward`, `track_source`, `track_id`, `async` |

## Fila async
| Endpoint | Status |
|---|:-:|
| GET /message/async | ✅ |
| DELETE /message/async | ✅ |

## Mensagens
| Endpoint | Status | Observação |
|---|:-:|---|
| POST /message/find | ✅ | por id, chatid, messageType, track_source/track_id, paginação |
| POST /message/download | ✅ | `fileURL` assinado (48h), `return_base64`, `generate_mp3`, `download_quoted`, `transcribe` (Whisper) |
| POST /message/history-sync | 🧪 | pede ao celular; chega pelo evento `history` |
| POST /message/markread, /react, /delete, /edit, /pin | ✅ | `pin.duration` em dias (1, 7, 30) |

## Chats, CRM e contatos
| Endpoint | Status | Observação |
|---|:-:|---|
| POST /chat/find | ✅ | operadores `=`, `~`, `!~`, `!=`, `>`, `>=`, `<`, `<=`; `compact`; `sort` |
| GET /chat/totalcount | ✅ | |
| POST /chat/editLead | ✅ | lead_field01..20 |
| POST /chat/details, /chat/avatar, /chat/check | ✅ | |
| POST /chat/block, GET /chat/blocklist | ✅ | |
| POST /chat/archive, /read, /mute, /pin, /delete, /ephemeral | ✅ | |
| POST /chat/labels | 🧪 | `addChatLabel`/`removeChatLabel` (WhatsApp Business) |
| POST /chat/notes, /notes/refresh, /notes/edit | ✅ | notas locais (não sincronizam com o app) |
| GET /lead/tags, POST /lead/tags/edit | ✅ | |
| GET /contacts, POST /contacts/list | ✅ | |
| POST /contact/add, /contact/remove | ✅ | a gravação na agenda do celular é 🧪; o banco local é sempre atualizado |
| POST /label/edit, POST /labels/refresh | 🧪 | |
| GET /labels | ✅ | |
| POST /quickreply/edit, GET /quickreply/showall | ✅ | locais |
| POST /call/reject | ✅ | |
| POST /call/make | ❌ | |

## Grupos e comunidades
| Endpoint | Status |
|---|:-:|
| /group/create, info, inviteInfo, invitelink/:jid, join, leave | ✅ |
| GET /group/list, POST /group/list (paginado, busca) | ✅ |
| /group/resetInviteCode, updateAnnounce, updateJoinApproval, updateMemberAddMode, updateDescription, ephemeral, updateImage, updateLocked, updateName, updateParticipants (add/remove/promote/demote/approve/reject) | ✅ |
| /community/create, /community/editgroups | 🧪 |

## Canais (newsletter)
Todos os 27 endpoints `/newsletter/*` estão roteados e validados. A execução é 🧪 (API de newsletter do Baileys 7 RC). `edit`/`delete` de post usam `sendMessage` e são ✅.

## Business
| Endpoint | Status |
|---|:-:|
| POST /business/get/profile | ✅ |
| POST /business/update/profile | 🧪 |
| GET /business/get/categories | ❌ |
| POST /business/catalog/list, info, delete, save, show, hide | ✅ |
| GET /business/catalog/collection/list | ✅ |
| POST/PATCH/DELETE /business/catalog/collection/* | ❌ |

## Webhooks e SSE
| Endpoint | Status | Observação |
|---|:-:|---|
| GET/POST /webhook | ✅ | modo simples + `action` add/update/delete; até 10 por instância; `secret` HMAC na criação |
| GET /webhook/errors | ✅ | últimos 100, header `X-Webhook-Error-Capture-Started-At` |
| GET/POST /globalwebhook, GET /globalwebhook/errors | ✅ | |
| GET /sse | ✅ | `?token=` ou cookie de sessão + `?instance_id=`; filtros `events` e `excludeMessages` |

Envelope do webhook: `EventType`, `owner`, `BaseUrl`, `instanceName`, `instanceId`, `timestamp` + campos do evento. **Não contém `token`.** Headers: `X-NexusWA-Event`, `X-NexusWA-Delivery`, `X-NexusWA-Signature`.

### Webhook só para alguns números/grupos (`onlyChats`, extensão NexusWA)
Cada webhook pertence a **uma instância** (um número conectado): ele é salvo com o `instanceId` e só recebe eventos dela. O corpo de cada entrega traz `instanceId`, `instanceName` e `owner` (número conectado) para o receptor conferir.

Para limitar a certas conversas, envie `onlyChats` em `POST /webhook`:
```json
{ "action": "update", "id": "…", "url": "https://…", "onlyChats": ["5519999998888", "120363000000000000@g.us"] }
```
- Números são normalizados (com ou sem o 9º dígito casam). Grupos pelo ID `@g.us`.
- Com a lista preenchida, `messages`, `messages_update`, `presence`, `call` e `chat_labels` de outras conversas **não** são entregues; eventos gerais (`connection`, `history` etc.) continuam.
- `[]` remove o filtro; omitir o campo mantém o filtro atual.

## Campanhas
| Endpoint | Status | Observação |
|---|:-:|---|
| POST /sender/simple, /sender/advanced | ✅ | até 10.000 mensagens; `delayMin` ≥ 3s; `scheduled_for` em ms ou em minutos a partir de agora |
| POST /sender/edit (stop/continue/delete) | ✅ | |
| POST /sender/cleardone, DELETE /sender/clearall | ✅ | |
| GET /sender/listfolders, POST /sender/listmessages, GET /sender/stats | ✅ | |

## Rotas extras do NexusWA (não existem na uazapi)
`/auth/login|refresh|logout|me|password|2fa/*`, `/users` (CRUD admin), `/instance/assign`, `/admin/audit`, `/admin/bug-reports`, `/support/bug-report`, `/upload`, `/files/:name`, `/health`, `/ready`, `/metrics`.

### Anexos sem link: `POST /upload`
Para quem não sabe gerar link de arquivo. Envie o arquivo **binário** no corpo (não JSON):

```
curl -X POST https://SEU_DOMINIO/upload \
  -H "token: SEU_TOKEN" -H "Content-Type: image/jpeg" \
  -H "X-File-Name: foto.jpg" --data-binary @foto.jpg
```

Resposta `201`: `{"file":"upload:Ab12...jpg","mimetype":"image/jpeg","size":10240,"kind":"image","expiresInDays":30}`.
Use o valor de `file` no lugar da URL em `/send/media`, `/send/menu` (`imageButton`), `/sender/simple`, `/sender/advanced`, `/send/status`, `/profile/image` etc.

- Só a instância que enviou consegue usar a referência (outra instância recebe "Anexo não encontrado").
- Tipos aceitos: fotos, vídeos, áudios, PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP/RAR/7z. O tipo é conferido pelos bytes reais do arquivo; HTML, SVG e executáveis são recusados.
- Limites: `MEDIA_MAX_MB` por arquivo, `UPLOAD_QUOTA_MB` por instância, apagado após `UPLOAD_TTL_DAYS` dias.

## Atendimento multiusuário (extensão NexusWA)
Vários atendentes respondem o **mesmo número**, cada um com e-mail e senha próprios.
- `GET /agents`: lista os atendentes do número e a fila (`queue`).
- `POST /agents` `{email, name, password, break_start?, break_end?}`: cria o atendente e o vincula ao número. Sem `password`, vincula um atendente existente da mesma equipe.
- `PATCH /agents/:userId` `{active, login_enabled, password, status, pause_reason, paused_until, break_start, break_end, name}`
- `DELETE /agents/:userId`: as conversas abertas dele voltam para a fila.
- `POST /agents/drain`: distribui a fila agora.
- `POST /ticket/close` `{chatid}` · `POST /ticket/transfer` `{chatid, to}` (`to: ""` devolve à fila) · `GET /ticket/agents`
- `GET /agent/me` · `POST /agent/status` `{instance_id?, status: available|paused, pause_reason: almoco|ferias|outro, paused_until?}`: rotas do próprio atendente.

Regras de distribuição:
- Só conversas individuais entram na fila. Quando chega mensagem de um cliente sem atendimento aberto, ele vai para o último atendente que o atendeu, se estiver disponível. Senão, vai por rodízio para quem está há mais tempo sem receber.
- Ninguém disponível: a conversa fica na fila e é distribuída quando alguém volta (há uma varredura a cada 1 min).
- `break_start/break_end` ("12:00"/"13:00") definem uma pausa diária no fuso `APP_TIMEZONE`.
- Férias devolvem as conversas abertas à fila.
- Eventos de atribuição saem como `chats` com `event.type = "assignment"`.

`POST /chat/find` aceita `q` (busca livre: ignora acentos; número em qualquer formato, com ou sem o 9º dígito) e `queue: true`.

## Ferramentas estilo WhatsApp (extensão NexusWA)
- `GET /lists` · `POST /lists {action: create|rename|delete, id?, name?}`: listas de conversas. "favoritas" já vem pronta.
- `POST /chat/lists {number, add: [ids], remove: [ids]}`: o atendente só pode usar `favoritas`, e só nas conversas dele.
- `POST /chat/lock {number, locked}` e `POST /chat/unlock {password}`. O unlock devolve `unlock_token` (15 min), que vai no header `X-Unlock-Token`. Sem ele, conversas trancadas somem de `/chat/find` e `/message/find` para pessoas; atendentes nunca as veem.
- `POST /message/delete {id, for_me: true}`: apagar para mim (sem `for_me`, apaga para todos).
- `GET /profile/info` · `POST /profile/status {about}` (recado) · `POST /business/update/profile {description, email, address, websites[≤2]}`
- `POST /chat/find` aceita também `unread`, `list`, `attendant` (id ou `queue`) e `locked`.
- Variáveis extras em qualquer envio e campanha: `{{saudacao}}` (Bom dia/Boa tarde/Boa noite), `{{data}}`, `{{hora}}`, `{{dia_semana}}` e `{{atendente}}` (nome de quem enviou pelo painel).
- Campos do cliente: `POST /instance/updateFieldsMap {lead_field01: "CPF", ...}` define os nomes. Os valores de cada contato vão em `/chat/editLead`. Cada campo vira variável pelo nome: `{{cpf}}`, `{{numero_da_conta}}`.
- Recortes em qualquer variável: `{{cpf|primeiros:6}}`, `{{cnpj|ultimos:6}}`, `{{boleto|digitos}}`, `{{nome|maiusculas}}`. Havendo dígitos no valor, contam só os dígitos.
- Atendente: pode corrigir (`/message/edit`) as mensagens dele e editar os dados do cliente das conversas dele. Não pode apagar mensagens nem limpar ou apagar conversas.
- Votos de enquete são decifrados pelo servidor, tentando o criador e o votante tanto pelo número quanto pelo LID. A contagem guarda o voto atual de cada pessoa em `poll_votes`. Cada voto gera `messages_update` com `type: "poll_vote"`, `votes`, `voter` e `selected`.

## Webhooks em 3 níveis
| Nível | Rota | Recebe |
|---|---|---|
| Instância | `/webhook` | eventos de um número |
| Usuário (conta) | `/account/webhook` (+ `/account/webhook/errors`) | eventos de todos os números do usuário |
| Servidor (Server URL) | `/globalwebhook` (admin) | eventos de todas as instâncias |

Todas as entregas levam `instanceId`, `instanceName` e `owner` e são assinadas com HMAC (`X-NexusWA-Signature`).

## Chatwoot
Fora do escopo desta entrega (`/chatwoot/*` não está roteado).
