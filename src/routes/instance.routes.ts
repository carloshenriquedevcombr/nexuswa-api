import dns from 'node:dns/promises';
import net from 'node:net';
import type { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { encField } from '../lib/security.js';
import { isPrivateAddress } from '../lib/ssrf.js';
import { parse } from '../lib/validate.js';
import { inst, requireAdminOrUser, requireInstance, requireServerAdmin } from '../middlewares/auth.js';
import { sensitiveLimiter } from '../middlewares/rateLimit.js';
import { audit } from '../services/audit.js';
import { createInstance, createInstanceWithQuota, deleteInstance, rotateInstanceToken } from '../services/instanceService.js';
import { loadMedia } from '../services/media.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { presentInstance, presentStatus } from '../whatsapp/presenters.js';

export const instanceRouter = Router();

const actor = (req: Request) =>
  req.auth.adminToken
    ? { actorType: 'admintoken' as const, actorId: 'admintoken' }
    : req.auth.user
      ? { actorType: 'user' as const, actorId: req.auth.user.id }
      : { actorType: 'instance' as const, actorId: req.auth.instance?.id ?? '' };

// ---------- Administração (admintoken / admin / cliente com cota) ----------

instanceRouter.post('/instance/create', requireAdminOrUser, sensitiveLimiter, async (req, res) => {
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(100),
      systemName: z.string().trim().max(60).regex(/^[\w.-]*$/, 'use apenas letras, números, _ . -').optional(),
      adminField01: z.string().max(500).optional(),
      adminField02: z.string().max(500).optional(),
      owner_user_id: z.string().uuid().optional(),
    }),
    req.body,
  );
  const isServerAdmin = req.auth.adminToken || req.auth.user?.role === 'admin';
  const { instance, token } = isServerAdmin
    ? await createInstance({ ...body, ownerId: body.owner_user_id ?? req.auth.user?.id ?? null })
    : await createInstanceWithQuota(req.auth.user!.id, req.auth.user!.maxInstances, body);
  await audit({ ...actor(req), action: 'instance.create', targetType: 'instance', targetId: instance.id, ip: req.ip, requestId: req.id });
  res.status(201).json({
    response: 'Instance created successfully',
    instance: presentInstance(instance),
    status: presentStatus(instance),
    name: instance.name,
    token, // exibido UMA única vez — guarde em local seguro
    info: 'Guarde o token agora: por segurança ele não pode ser consultado novamente, apenas rotacionado.',
  });
});

instanceRouter.get('/instance/all', requireAdminOrUser, async (req, res) => {
  const where = req.auth.adminToken || req.auth.user?.role === 'admin' ? {} : { ownerId: req.auth.user!.id };
  const list = await prisma.instance.findMany({ where, orderBy: { createdAt: 'desc' }, take: 1000 });
  res.json(list.map(presentInstance));
});

instanceRouter.post('/instance/token/rotate', sensitiveLimiter, async (req, res, next) => {
  // Aceita admin (qualquer instância, por id) ou o próprio dono via X-Instance-Id/token.
  if (req.auth.adminToken || req.auth.user?.role === 'admin') {
    const { id } = parse(z.object({ id: z.string().uuid(), confirm_impacts: z.boolean().optional() }), req.body);
    const target = await prisma.instance.findUnique({ where: { id } });
    if (!target) throw notFound('Instância não encontrada');
    req.auth.instance = target;
    return next();
  }
  return requireInstance(req, res, next);
}, async (req, res) => {
  const { instance, token } = await rotateInstanceToken(inst(req));
  await audit({ ...actor(req), action: 'instance.token.rotate', targetType: 'instance', targetId: instance.id, ip: req.ip, requestId: req.id });
  res.json({
    success: true,
    message: 'Token rotacionado',
    instance_id: instance.id,
    token,
    previous_token_invalidated: true,
    restart_requested: false,
    rotated_at: Date.now(),
    impacts: { chatwoot_reconfigure_requested: false, proxy_relay_reconnect_required: false, long_lived_clients_closed: false },
    warnings: ['Atualize todos os sistemas que usavam o token anterior'],
  });
});

instanceRouter.post('/instance/updateAdminFields', requireServerAdmin, async (req, res) => {
  const body = parse(z.object({ id: z.string().uuid(), adminField01: z.string().max(500).optional(), adminField02: z.string().max(500).optional() }), req.body);
  const updated = await prisma.instance.update({ where: { id: body.id }, data: { adminField01: body.adminField01, adminField02: body.adminField02 } }).catch(() => {
    throw notFound('Instância não encontrada');
  });
  res.json(presentInstance(updated));
});

// ---------- Escopo de instância ----------
// requireInstance é aplicado rota a rota: middleware em router-level rodaria para
// QUALQUER requisição que atravessasse este router, inclusive de outras rotas.
const r = Router();

r.post('/instance/connect', requireInstance, async (req, res) => {
  const body = parse(
    z.object({
      phone: z.string().regex(/^\d{10,15}$/).optional(),
      browser: z.enum(['auto', 'safari', 'firefox', 'edge', 'chrome']).default('auto'),
      systemName: z.string().max(60).optional(),
    }),
    req.body,
  );
  const instance = inst(req);
  if (body.systemName) await prisma.instance.update({ where: { id: instance.id }, data: { systemName: body.systemName } });
  const session = await SessionManager.connect(instance, { phone: body.phone, browser: body.browser });
  // Aguarda brevemente o QR/código ficar disponível para devolver já na resposta.
  for (let i = 0; i < 20 && !session.instance.qrcode && !session.instance.paircode && session.instance.status !== 'connected'; i++) {
    await new Promise((r2) => setTimeout(r2, 250));
  }
  const fresh = session.instance;
  res.json({ ...presentStatus(fresh), instance: presentInstance(fresh) });
});

r.post('/instance/disconnect', requireInstance, async (req, res) => {
  await SessionManager.disconnect(inst(req), true);
  const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: inst(req).id } });
  res.json({ instance: presentInstance(fresh), response: 'Disconnected', info: 'Sessão encerrada e credenciais removidas' });
});

r.post('/instance/reset', requireInstance, async (req, res) => {
  await SessionManager.reset(inst(req));
  res.json({ response: 'Reset iniciado', resetting: true, instanceId: inst(req).id, queuedRecoveryAttempted: false });
});

r.get('/instance/status', requireInstance, async (req, res) => {
  const fresh = SessionManager.get(inst(req).id)?.instance ?? (await prisma.instance.findUniqueOrThrow({ where: { id: inst(req).id } }));
  res.json({ instance: presentInstance(fresh), status: presentStatus(fresh) });
});

r.get('/instance/wa_messages_limits', requireInstance, (_req, res) => {
  res.status(501).json({ error: 'O Baileys não expõe os limites de novas conversas do WhatsApp', error_key: 'not_supported' });
});

const leadField = z.string().max(100).optional();
r.post('/instance/updateFieldsMap', requireInstance, async (req, res) => {
  const shape: Record<string, typeof leadField> = {};
  for (let i = 1; i <= 20; i++) shape[`lead_field${String(i).padStart(2, '0')}`] = leadField;
  const body = parse(z.object(shape), req.body);
  const current = (inst(req).fieldsMap ?? {}) as Record<string, string>;
  const updated = await prisma.instance.update({ where: { id: inst(req).id }, data: { fieldsMap: { ...current, ...body } as Prisma.InputJsonValue } });
  res.json(presentInstance(updated));
});

r.post('/instance/updateInstanceName', requireInstance, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  res.json(presentInstance(await prisma.instance.update({ where: { id: inst(req).id }, data: { name } })));
});

r.post('/instance/updateDelaySettings', requireInstance, async (req, res) => {
  const body = parse(z.object({ msg_delay_min: z.coerce.number().int().min(0).max(3600), msg_delay_max: z.coerce.number().int().min(0).max(3600) }), req.body);
  if (body.msg_delay_max < body.msg_delay_min) throw badRequest('msg_delay_max deve ser >= msg_delay_min');
  const updated = await prisma.instance.update({ where: { id: inst(req).id }, data: { msgDelayMin: body.msg_delay_min, msgDelayMax: body.msg_delay_max } });
  res.json({ instance: presentInstance(updated) });
});

r.post('/instance/openai', requireInstance, async (req, res) => {
  const { openai_apikey } = parse(z.object({ openai_apikey: z.string().max(300) }), req.body);
  await prisma.instance.update({
    where: { id: inst(req).id },
    data: { openaiApiKeyEnc: openai_apikey ? encField(openai_apikey, `openai:${inst(req).id}`) : null },
  });
  res.json({ response: openai_apikey ? 'Chave configurada' : 'Chave removida' });
});

r.get('/instance/proxy', requireInstance, (req, res) => {
  const i = inst(req);
  res.json({ mode: i.proxyUrlEnc ? 'custom' : 'none', effective_mode: i.proxyUrlEnc ? 'custom' : 'none', proxy_url: i.proxyUrlEnc ? '[configurado]' : '', managed: false });
});

r.post('/instance/proxy', requireInstance, async (req, res) => {
  const body = parse(z.object({ mode: z.enum(['custom', 'none', 'internal']).default('custom'), proxy_url: z.string().max(500).optional() }), req.body);
  const i = inst(req);
  if (body.mode === 'internal') throw badRequest('Proxy gerenciado (internal) não existe no NexusWA; use mode=custom com seu próprio proxy');
  let enc: string | null = null;
  if (body.mode === 'custom') {
    if (!body.proxy_url) throw badRequest('proxy_url obrigatório no modo custom');
    let u: URL;
    try {
      u = new URL(body.proxy_url);
    } catch {
      throw badRequest('proxy_url inválida');
    }
    if (!['http:', 'https:', 'socks5:', 'socks4:', 'socks:'].includes(u.protocol)) throw badRequest('Protocolo de proxy não suportado');
    if (!env.SSRF_ALLOW_PRIVATE) {
      // Resolve o hostname: um proxy "interno" transformaria a sessão em ponte para a rede privada.
      const host = u.hostname.replace(/^\[|\]$/g, '');
      const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
      if (!addrs.length) throw badRequest('Não foi possível resolver o host do proxy');
      if (addrs.some(isPrivateAddress)) throw badRequest('Proxy em rede interna não é permitido');
    }
    enc = encField(body.proxy_url, `proxy:${i.id}`);
  }
  await prisma.instance.update({ where: { id: i.id }, data: { proxyUrlEnc: enc } });
  res.json({ details: 'Proxy atualizado. Reinicie a conexão (/instance/reset) para aplicar.', proxy: { mode: body.mode }, restart_requested: false, rotated: false });
});

r.post('/profile/name', requireInstance, async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(25) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  await s.sock!.updateProfileName(name);
  await s.setStatus({ profileName: name }, false);
  res.json({ success: true, message: 'Nome atualizado', profile: { name } });
});

r.post('/profile/image', requireInstance, async (req, res) => {
  const { image } = parse(z.object({ image: z.string().min(1).max(15_000_000) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  const jid = s.sock!.user!.id;
  if (image === 'remove' || image === 'delete') await s.sock!.removeProfilePicture(jid);
  else await s.sock!.updateProfilePicture(jid, (await loadMedia(image, undefined, s.id)).buffer);
  res.json({ success: true, message: 'Imagem atualizada', profile: {} });
});

r.delete('/instance', requireInstance, async (req, res) => {
  const i = inst(req);
  await deleteInstance(i);
  await audit({ ...actor(req), action: 'instance.delete', targetType: 'instance', targetId: i.id, ip: req.ip, requestId: req.id });
  res.json({ response: 'Instance deleted', info: 'Instância, sessão e dados associados removidos' });
});

const PRIV = ['all', 'contacts', 'contact_blacklist', 'none'] as const;
r.get('/instance/privacy', requireInstance, async (req, res) => {
  const s = await SessionManager.requireConnected(inst(req));
  res.json(await s.sock!.fetchPrivacySettings(true));
});

r.post('/instance/privacy', requireInstance, async (req, res) => {
  const body = parse(
    z.object({
      groupadd: z.enum(PRIV).optional(),
      last: z.enum(PRIV).optional(),
      status: z.enum(PRIV).optional(),
      profile: z.enum(PRIV).optional(),
      readreceipts: z.enum(['all', 'none']).optional(),
      online: z.enum(['all', 'match_last_seen']).optional(),
      calladd: z.enum(['all', 'known']).optional(),
    }),
    req.body,
  );
  const s = await SessionManager.requireConnected(inst(req));
  const sock = s.sock!;
  if (body.groupadd) await sock.updateGroupsAddPrivacy(body.groupadd as never);
  if (body.last) await sock.updateLastSeenPrivacy(body.last as never);
  if (body.status) await sock.updateStatusPrivacy(body.status as never);
  if (body.profile) await sock.updateProfilePicturePrivacy(body.profile as never);
  if (body.readreceipts) await sock.updateReadReceiptsPrivacy(body.readreceipts as never);
  if (body.online) await sock.updateOnlinePrivacy(body.online as never);
  if (body.calladd) await s.call('updateCallPrivacy', body.calladd);
  res.json(await sock.fetchPrivacySettings(true));
});

r.post('/instance/presence', requireInstance, async (req, res) => {
  const { presence } = parse(z.object({ presence: z.enum(['available', 'unavailable']) }), req.body);
  const s = await SessionManager.requireConnected(inst(req));
  await s.sock!.sendPresenceUpdate(presence);
  await s.setStatus({ currentPresence: presence }, false);
  res.json({ response: 'Presença atualizada' });
});

r.get('/instance/history-sync/status', requireInstance, async (req, res) => {
  const i = inst(req);
  const [chats, messages, history] = await Promise.all([
    prisma.chat.count({ where: { instanceId: i.id } }),
    prisma.message.count({ where: { instanceId: i.id } }),
    prisma.message.count({ where: { instanceId: i.id, source: 'history' } }),
  ]);
  res.json({ processingComplete: true, pairedAt: i.pairedAt?.toISOString() ?? null, received: { chats, messages, historyMessages: history } });
});

instanceRouter.use(r);
