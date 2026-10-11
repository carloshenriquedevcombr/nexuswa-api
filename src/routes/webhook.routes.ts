import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { env, isProd } from '../config/env.js';
import { generateToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { InvalidNumberError, toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { encField } from '../lib/security.js';
import { assertSafeUrl } from '../lib/ssrf.js';
import { parse } from '../lib/validate.js';
import { inst, requireServerAdmin, requireUser } from '../middlewares/auth.js';
import { handleSse } from '../services/sse.js';
import { invalidateUserWebhookCache, invalidateWebhookCache, secretAad, webhookErrors } from '../services/webhookDispatcher.js';
import { EVENT_TYPES, EXCLUDE_FILTERS } from '../whatsapp/eventBus.js';
import { presentWebhook } from '../whatsapp/presenters.js';

export const webhookRouter = Router();
export const globalWebhookRouter = Router();
export const accountWebhookRouter = Router();

const MAX_WEBHOOKS = 10;

/** Valida o destino: http(s), sem credenciais; em produção exige HTTPS (exceto hosts internos liberados). */
function validateDestination(url: string): string {
  const u = assertSafeUrl(url);
  if (isProd && u.protocol !== 'https:' && !env.WEBHOOK_INTERNAL_HOSTS.has(u.hostname.toLowerCase())) {
    throw badRequest('Em produção o webhook deve usar https:// (ou um host interno listado em WEBHOOK_INTERNAL_HOSTS)');
  }
  return u.toString();
}

const hookSchema = z.object({
  id: z.string().uuid().optional(),
  action: z.enum(['add', 'update', 'delete']).optional(),
  enabled: z.boolean().default(true),
  url: z.string().max(2000).optional(),
  events: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).default([]),
  excludeMessages: z.array(z.enum(EXCLUDE_FILTERS)).max(EXCLUDE_FILTERS.length).default([]),
  addUrlEvents: z.boolean().default(false),
  addUrlTypesMessages: z.boolean().default(false),
  // Extensão NexusWA: limitar o webhook a certos números/grupos. Ausente = não altera.
  onlyChats: z.array(z.string().max(120)).max(500).optional(),
});

/** Normaliza a lista (número → JID, grupo mantido), sem duplicados. Rejeita lixo com a linha exata. */
function normalizeChats(list: string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const out = new Set<string>();
  for (const raw of list.map((s) => s.trim()).filter(Boolean)) {
    try {
      out.add(toJid(raw));
    } catch (err) {
      if (err instanceof InvalidNumberError) throw badRequest(`Número ou grupo inválido no filtro: ${raw.slice(0, 40)}`);
      throw err;
    }
  }
  return [...out];
}

async function list(instanceId: string) {
  const hooks = await prisma.webhook.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  return hooks.map(presentWebhook);
}

webhookRouter.get('/webhook', async (req, res) => {
  res.json(await list(inst(req).id));
});

webhookRouter.post('/webhook', async (req: Request, res) => {
  const p = parse(hookSchema, req.body);
  const instanceId = inst(req).id;
  const data = {
    enabled: p.enabled,
    events: p.events,
    excludeMessages: p.excludeMessages,
    addUrlEvents: p.addUrlEvents,
    addUrlTypesMessages: p.addUrlTypesMessages,
    ...(p.onlyChats ? { onlyChats: normalizeChats(p.onlyChats) } : {}),
  };
  let secret: string | undefined;
  let createdId: string | undefined;

  const create = async () => {
    if (!p.url) throw badRequest('url obrigatória');
    const count = await prisma.webhook.count({ where: { instanceId } });
    if (count >= MAX_WEBHOOKS) throw badRequest(`Máximo de ${MAX_WEBHOOKS} webhooks por instância`);
    secret = generateToken('whsec', 24);
    // Cria com id definido para amarrar o AAD da cifragem ao próprio registro.
    const id = crypto.randomUUID();
    await prisma.webhook.create({ data: { id, instanceId, url: validateDestination(p.url), secretEnc: encField(secret, secretAad(instanceId, id)), ...data } });
    createdId = id;
  };

  if (p.action === 'delete' || p.action === 'update') {
    if (!p.id) throw badRequest('id obrigatório para update/delete');
    const found = await prisma.webhook.findFirst({ where: { id: p.id, instanceId } });
    if (!found) throw notFound('Webhook não encontrado');
    if (p.action === 'delete') await prisma.webhook.delete({ where: { id: p.id } });
    else await prisma.webhook.update({ where: { id: p.id }, data: { ...data, ...(p.url ? { url: validateDestination(p.url) } : {}) } });
  } else if (p.action === 'add') {
    await create();
  } else {
    // Modo simples: mantém um webhook principal (o mais antigo).
    const main = await prisma.webhook.findFirst({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
    if (main) await prisma.webhook.update({ where: { id: main.id }, data: { ...data, ...(p.url ? { url: validateDestination(p.url) } : {}) } });
    else await create();
  }
  invalidateWebhookCache(instanceId);
  const hooks = await list(instanceId);
  if (secret && createdId) {
    // O segredo HMAC é mostrado uma única vez; use-o para validar X-NexusWA-Signature.
    res.json(hooks.map((h) => (h.id === createdId ? { ...h, secret } : h)));
    return;
  }
  res.json(hooks);
});

webhookRouter.get('/webhook/errors', async (req, res) => {
  const { since, errors } = await webhookErrors(inst(req).id);
  if (since) res.setHeader('X-Webhook-Error-Capture-Started-At', since);
  res.json(errors);
});

webhookRouter.get('/sse', async (req, res) => {
  await handleSse(req, res, inst(req).id, req.auth.agent?.userId);
});

// ---------- Webhook global (admin) ----------
globalWebhookRouter.get('/globalwebhook', requireServerAdmin, async (_req, res) => {
  const g = await prisma.globalWebhook.findUnique({ where: { id: 'global' } });
  res.json(g ? { id: g.id, enabled: g.enabled, url: g.url, events: g.events, excludeMessages: g.excludeMessages, addUrlEvents: g.addUrlEvents, addUrlTypesMessages: g.addUrlTypesMessages } : {});
});

globalWebhookRouter.post('/globalwebhook', requireServerAdmin, async (req, res) => {
  const p = parse(hookSchema.extend({ url: z.string().max(2000), events: z.array(z.enum(EVENT_TYPES)).min(1) }), req.body);
  const existing = await prisma.globalWebhook.findUnique({ where: { id: 'global' } });
  const secret = existing ? undefined : generateToken('whsec', 24);
  const data = { url: validateDestination(p.url), enabled: p.enabled, events: p.events, excludeMessages: p.excludeMessages, addUrlEvents: p.addUrlEvents, addUrlTypesMessages: p.addUrlTypesMessages };
  const g = existing
    ? await prisma.globalWebhook.update({ where: { id: 'global' }, data })
    : await prisma.globalWebhook.create({ data: { id: 'global', ...data, secretEnc: encField(secret!, secretAad('global', 'global')) } });
  invalidateWebhookCache();
  res.json({ id: g.id, enabled: g.enabled, url: g.url, events: g.events, excludeMessages: g.excludeMessages, addUrlEvents: g.addUrlEvents, addUrlTypesMessages: g.addUrlTypesMessages, ...(secret ? { secret } : {}) });
});

globalWebhookRouter.get('/globalwebhook/errors', requireServerAdmin, async (_req, res) => {
  const { since, errors } = await webhookErrors('global');
  if (since) res.setHeader('X-Webhook-Error-Capture-Started-At', since);
  res.json(errors);
});

// ---------- Webhook da CONTA (todas as instâncias do usuário) ----------
// Útil para quem tem vários números e quer UM endpoint no n8n: cada evento traz
// instanceId/instanceName/owner para saber de qual número veio.
function accountUser(req: Request): string {
  const u = req.auth.user;
  if (!u) throw notFound();
  if (u.role === 'agent') throw badRequest('Atendentes não configuram webhooks');
  return u.id;
}

accountWebhookRouter.get('/account/webhook', requireUser, async (req, res) => {
  const userId = accountUser(req);
  const hooks = await prisma.userWebhook.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  res.json(hooks.map((w) => ({ id: w.id, enabled: w.enabled, url: w.url, events: w.events, excludeMessages: w.excludeMessages, onlyChats: w.onlyChats ?? [], addUrlEvents: w.addUrlEvents, addUrlTypesMessages: w.addUrlTypesMessages })));
});

accountWebhookRouter.post('/account/webhook', requireUser, async (req, res) => {
  const userId = accountUser(req);
  const p = parse(hookSchema, req.body);
  const data = {
    enabled: p.enabled,
    events: p.events,
    excludeMessages: p.excludeMessages,
    addUrlEvents: p.addUrlEvents,
    addUrlTypesMessages: p.addUrlTypesMessages,
    ...(p.onlyChats ? { onlyChats: normalizeChats(p.onlyChats) } : {}),
  };
  let secret: string | undefined;
  let createdId: string | undefined;
  if (p.action === 'delete' || p.action === 'update') {
    if (!p.id) throw badRequest('id obrigatório para update/delete');
    const found = await prisma.userWebhook.findFirst({ where: { id: p.id, userId } });
    if (!found) throw notFound('Webhook não encontrado');
    if (p.action === 'delete') await prisma.userWebhook.delete({ where: { id: p.id } });
    else await prisma.userWebhook.update({ where: { id: p.id }, data: { ...data, ...(p.url ? { url: validateDestination(p.url) } : {}) } });
  } else {
    if (!p.url) throw badRequest('url obrigatória');
    if ((await prisma.userWebhook.count({ where: { userId } })) >= MAX_WEBHOOKS) throw badRequest(`Máximo de ${MAX_WEBHOOKS} webhooks por conta`);
    secret = generateToken('whsec', 24);
    const id = crypto.randomUUID();
    await prisma.userWebhook.create({ data: { id, userId, url: validateDestination(p.url), secretEnc: encField(secret, secretAad(`user:${userId}`, id)), ...data } });
    createdId = id;
  }
  invalidateUserWebhookCache(userId);
  const hooks = await prisma.userWebhook.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  res.json(hooks.map((w) => ({ id: w.id, enabled: w.enabled, url: w.url, events: w.events, excludeMessages: w.excludeMessages, onlyChats: w.onlyChats ?? [], addUrlEvents: w.addUrlEvents, addUrlTypesMessages: w.addUrlTypesMessages, ...(w.id === createdId && secret ? { secret } : {}) })));
});

accountWebhookRouter.get('/account/webhook/errors', requireUser, async (req, res) => {
  const { errors } = await webhookErrors(`user:${accountUser(req)}`);
  res.json(errors);
});
