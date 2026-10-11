import { Router, type Request } from 'express';
import { z } from 'zod';
import { notImplemented } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { loadMedia } from '../services/media.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import type { InstanceSession } from '../whatsapp/session.js';

/**
 * Canais (newsletters). As funções de newsletter do Baileys 7 ainda são RC e mudam
 * de nome entre versões; `callAny` tenta os nomes conhecidos e responde 501 quando
 * nenhum existe — o cliente recebe um erro claro em vez de um 500 genérico.
 */
export const newsletterRouter = Router();

const njid = z.string().regex(/^\d{5,30}@newsletter$/, 'jid deve terminar em @newsletter');

async function sess(req: Request) {
  return SessionManager.requireConnected(inst(req));
}

async function callAny<T>(s: InstanceSession, names: string[], ...args: unknown[]): Promise<T> {
  const sock = s.sock as unknown as Record<string, unknown>;
  const name = names.find((n) => typeof sock?.[n] === 'function');
  if (!name) throw notImplemented(`Recurso de canal indisponível nesta versão do Baileys (${names[0]})`);
  return s.call<T>(name, ...args);
}

const ok = (response: unknown) => ({ response });

newsletterRouter.post('/newsletter/create', async (req, res) => {
  const p = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2048).optional(), picture: z.string().max(15_000_000).optional() }), req.body);
  const s = await sess(req);
  const created = await callAny<{ id?: string }>(s, ['newsletterCreate'], p.name, p.description ?? '');
  if (p.picture && created?.id) await callAny(s, ['newsletterUpdatePicture'], created.id, (await loadMedia(p.picture, undefined, s.id)).buffer).catch(() => undefined);
  res.json(ok(created));
});

newsletterRouter.get('/newsletter/list', async (req, res) => {
  const s = await sess(req);
  res.json(ok(await callAny(s, ['newsletterSubscribed', 'newsletterFetchAllParticipating', 'newsletterFetchSubscribed'])));
});

newsletterRouter.post('/newsletter/info', async (req, res) => {
  const { jid } = parse(z.object({ jid: njid }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterMetadata'], 'jid', jid)));
});

newsletterRouter.post('/newsletter/link', async (req, res) => {
  const { key } = parse(z.object({ key: z.string().min(3).max(200).transform((v) => v.replace(/^https?:\/\/whatsapp\.com\/channel\//i, '')) }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterMetadata'], 'invite', key)));
});

newsletterRouter.post('/newsletter/subscribe', async (req, res) => {
  const { jid } = parse(z.object({ jid: njid }), req.body);
  res.json(ok(await callAny(await sess(req), ['subscribeNewsletterUpdates', 'newsletterSubscribeLiveUpdates'], jid)));
});

newsletterRouter.post('/newsletter/messages', async (req, res) => {
  const p = parse(z.object({ jid: njid, count: z.coerce.number().int().min(1).max(100).default(20), beforeid: z.coerce.number().int().optional() }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterFetchMessages'], 'jid', p.jid, p.count, p.beforeid)));
});

newsletterRouter.post('/newsletter/updates', async (req, res) => {
  const p = parse(z.object({ jid: njid, count: z.coerce.number().int().min(1).max(100).default(20), afterid: z.coerce.number().int().optional(), since: z.coerce.number().int().optional() }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterFetchUpdates'], p.jid, p.count, p.afterid, p.since)));
});

newsletterRouter.post('/newsletter/messages/edit', async (req, res) => {
  const p = parse(z.object({ jid: njid, messageid: z.string().max(200).optional(), serverid: z.coerce.number().int().optional(), text: z.string().max(65_000).optional(), caption: z.string().max(65_000).optional() }), req.body);
  const s = await sess(req);
  const id = p.messageid ?? String(p.serverid ?? '');
  const sent = await s.sock!.sendMessage(p.jid, { text: p.text ?? p.caption ?? '', edit: { remoteJid: p.jid, id, fromMe: true } });
  res.json(ok(sent?.key ?? null));
});

newsletterRouter.post('/newsletter/messages/delete', async (req, res) => {
  const p = parse(z.object({ jid: njid, messageid: z.string().max(200).optional(), serverid: z.coerce.number().int().optional() }), req.body);
  const s = await sess(req);
  const id = p.messageid ?? String(p.serverid ?? '');
  const sent = await s.sock!.sendMessage(p.jid, { delete: { remoteJid: p.jid, id, fromMe: true } });
  res.json(ok(sent?.key ?? null));
});

newsletterRouter.post('/newsletter/viewed', async (req, res) => {
  const p = parse(z.object({ jid: njid, serverids: z.array(z.coerce.number().int()).min(1).max(100) }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterMarkViewed', 'newsletterViewed'], p.jid, p.serverids)));
});

newsletterRouter.post('/newsletter/reaction', async (req, res) => {
  const p = parse(z.object({ jid: njid, serverid: z.coerce.number().int(), reaction: z.string().max(20).optional() }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterReactMessage'], p.jid, String(p.serverid), p.reaction)));
});

for (const [path, names] of [
  ['/newsletter/follow', ['newsletterFollow']],
  ['/newsletter/unfollow', ['newsletterUnfollow']],
  ['/newsletter/mute', ['newsletterMute']],
  ['/newsletter/unmute', ['newsletterUnmute']],
  ['/newsletter/delete', ['newsletterDelete']],
  ['/newsletter/admin/accept', ['newsletterAcceptAdminInvite']],
] as const) {
  newsletterRouter.post(path, async (req, res) => {
    const { jid } = parse(z.object({ jid: njid }), req.body);
    res.json(ok(await callAny(await sess(req), [...names], jid)));
  });
}

newsletterRouter.post('/newsletter/picture', async (req, res) => {
  const p = parse(z.object({ jid: njid, picture: z.string().min(1).max(15_000_000) }), req.body);
  const s = await sess(req);
  if (p.picture === 'remove') res.json(ok(await callAny(s, ['newsletterRemovePicture'], p.jid)));
  else res.json(ok(await callAny(s, ['newsletterUpdatePicture'], p.jid, (await loadMedia(p.picture, undefined, s.id)).buffer)));
});

newsletterRouter.post('/newsletter/name', async (req, res) => {
  const p = parse(z.object({ jid: njid, name: z.string().trim().min(1).max(100) }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterUpdateName'], p.jid, p.name)));
});

newsletterRouter.post('/newsletter/description', async (req, res) => {
  const p = parse(z.object({ jid: njid, description: z.string().max(2048).default('') }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterUpdateDescription'], p.jid, p.description)));
});

newsletterRouter.post('/newsletter/settings', async (req, res) => {
  const p = parse(z.object({ jid: njid, reactionCodes: z.enum(['ALL', 'BASIC', 'NONE', 'BLOCKLIST']) }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterReactionMode', 'newsletterUpdateSettings'], p.jid, p.reactionCodes)));
});

newsletterRouter.post('/newsletter/search', async (req, res) => {
  const p = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), view: z.string().max(40).optional(), countryCodes: z.array(z.string().max(4)).max(20).optional(), searchText: z.string().max(100).optional(), after: z.string().max(200).optional() }), req.body);
  res.json(ok(await callAny(await sess(req), ['newsletterSearch', 'newsletterDirectorySearch'], p)));
});

for (const [path, names] of [
  ['/newsletter/admin/invite', ['newsletterInviteAdmin']],
  ['/newsletter/admin/remove', ['newsletterDemote']],
  ['/newsletter/admin/revoke', ['newsletterRevokeAdminInvite']],
] as const) {
  newsletterRouter.post(path, async (req, res) => {
    const p = parse(z.object({ jid: njid, phone: z.string().min(8).max(40) }), req.body);
    res.json(ok(await callAny(await sess(req), [...names], p.jid, toJid(p.phone))));
  });
}

newsletterRouter.post('/newsletter/owner/transfer', async (req, res) => {
  const p = parse(z.object({ jid: njid, phone: z.string().min(8).max(40), quitAdmin: z.boolean().default(false) }), req.body);
  const s = await sess(req);
  const result = await callAny(s, ['newsletterChangeOwner'], p.jid, toJid(p.phone));
  if (p.quitAdmin) await callAny(s, ['newsletterDemote'], p.jid, s.sock!.user!.id).catch(() => undefined);
  res.json(ok(result));
});
