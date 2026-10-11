import type { GroupMetadata } from '@whiskeysockets/baileys';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { loadMedia } from '../services/media.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import type { InstanceSession } from '../whatsapp/session.js';

export const groupRouter = Router();

const gjid = z.string().regex(/^[0-9-]{5,40}@g\.us$/, 'groupjid deve terminar em @g.us');

/* eslint-disable @typescript-eslint/no-explicit-any */
export function presentGroup(g: GroupMetadata, extra: Record<string, unknown> = {}) {
  const m = g as any;
  return {
    JID: g.id,
    OwnerJID: g.owner ?? '',
    OwnerPN: m.ownerPn ?? '',
    Name: g.subject,
    NameSetAt: g.subjectTime ?? 0,
    NameSetBy: g.subjectOwner ?? '',
    Topic: g.desc ?? '',
    TopicID: g.descId ?? '',
    TopicSetBy: m.descOwner ?? '',
    IsLocked: Boolean(g.restrict),
    IsAnnounce: Boolean(g.announce),
    IsEphemeral: Boolean(g.ephemeralDuration),
    DisappearingTimer: g.ephemeralDuration ?? 0,
    IsParent: Boolean(m.isCommunity),
    IsJoinApprovalRequired: Boolean(m.joinApprovalMode),
    LinkedParentJID: m.linkedParent ?? '',
    IsDefaultSubGroup: Boolean(m.isCommunityAnnounce),
    GroupCreated: g.creation ?? 0,
    MemberAddMode: m.memberAddMode ? 'all_member_add' : 'admin_add',
    AddressingMode: m.addressingMode ?? '',
    Participants: (g.participants ?? []).map((p: any) => ({ JID: p.id, LID: p.lid ?? '', PhoneNumber: p.phoneNumber ?? '', IsAdmin: p.admin === 'admin' || p.admin === 'superadmin', IsSuperAdmin: p.admin === 'superadmin' })),
    ParticipantCount: g.size ?? g.participants?.length ?? 0,
    ...extra,
  };
}

async function meta(s: InstanceSession, jid: string, force = false): Promise<GroupMetadata> {
  const m = await s.sock!.groupMetadata(jid);
  s.cacheGroup(m);
  void force;
  return m;
}

async function sess(req: Request) {
  return SessionManager.requireConnected(inst(req));
}

async function after(s: InstanceSession, jid: string, response: string) {
  const g = await meta(s, jid).catch(() => undefined);
  return { response, group: g ? presentGroup(g) : null, needs_refresh: !g };
}

groupRouter.post('/group/create', async (req, res) => {
  const p = parse(z.object({ name: z.string().trim().min(1).max(100), participants: z.array(z.string().max(120)).max(1024).nullable().optional() }), req.body);
  const s = await sess(req);
  const participants = (p.participants ?? []).map(toJid);
  const g = await s.sock!.groupCreate(p.name, participants);
  s.cacheGroup(g);
  const present = new Set(g.participants.map((x) => x.id));
  res.json({ group: presentGroup(g), failed: participants.filter((x) => !present.has(x)) });
});

groupRouter.post('/group/info', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, getInviteLink: z.boolean().default(false), getRequestsParticipants: z.boolean().default(false), force: z.boolean().default(false) }), req.body);
  const s = await sess(req);
  const g = await meta(s, p.groupjid, p.force);
  const extra: Record<string, unknown> = {};
  if (p.getInviteLink) extra.invite_link = `https://chat.whatsapp.com/${await s.sock!.groupInviteCode(p.groupjid)}`;
  if (p.getRequestsParticipants) extra.request_participants = await s.sock!.groupRequestParticipantsList(p.groupjid).catch(() => []);
  extra.image_url = await s.sock!.profilePictureUrl(p.groupjid, 'image').catch(() => '');
  res.json(presentGroup(g, extra));
});

const inviteCode = z.string().min(5).max(200).transform((v) => v.replace(/^https?:\/\/chat\.whatsapp\.com\//i, '').trim());

groupRouter.post('/group/inviteInfo', async (req, res) => {
  const { invitecode } = parse(z.object({ invitecode: inviteCode }), req.body);
  const s = await sess(req);
  res.json(presentGroup(await s.sock!.groupGetInviteInfo(invitecode)));
});

groupRouter.get('/group/invitelink/:groupJID', async (req, res) => {
  const jid = gjid.parse(req.params.groupJID);
  const s = await sess(req);
  res.json({ inviteLink: `https://chat.whatsapp.com/${await s.sock!.groupInviteCode(jid)}` });
});

groupRouter.post('/group/join', async (req, res) => {
  const { invitecode } = parse(z.object({ invitecode: inviteCode }), req.body);
  const s = await sess(req);
  const jid = await s.sock!.groupAcceptInvite(invitecode);
  res.json({ response: 'Joined', group: jid ? { JID: jid } : null, needs_refresh: true });
});

groupRouter.post('/group/leave', async (req, res) => {
  const { groupjid } = parse(z.object({ groupjid: gjid }), req.body);
  const s = await sess(req);
  await s.sock!.groupLeave(groupjid);
  res.json({ response: 'Left group' });
});

async function allGroups(s: InstanceSession, force: boolean): Promise<GroupMetadata[]> {
  // Reutiliza o último resultado por 20s (mesma regra da uazapi) para não martelar o WhatsApp.
  if (!force && s.lastGroupsFetch && Date.now() - s.lastGroupsFetch.at < 20_000) return s.lastGroupsFetch.groups;
  const groups = Object.values(await s.sock!.groupFetchAllParticipating());
  groups.forEach((g) => s.cacheGroup(g));
  s.lastGroupsFetch = { at: Date.now(), groups };
  return groups;
}

groupRouter.get('/group/list', async (req, res) => {
  const s = await sess(req);
  const noP = req.query.noParticipants === 'true';
  const groups = await allGroups(s, req.query.force === 'true');
  res.json({ groups: groups.map((g) => presentGroup(noP ? { ...g, participants: [] } : g)) });
});

groupRouter.post('/group/list', async (req, res) => {
  const p = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(50), offset: z.coerce.number().int().min(0).default(0), search: z.string().max(100).optional(), force: z.boolean().default(false), noParticipants: z.boolean().default(false) }), req.body);
  const s = await sess(req);
  let groups = await allGroups(s, p.force);
  if (p.search) {
    const q = p.search.toLowerCase();
    groups = groups.filter((g) => g.subject?.toLowerCase().includes(q) || g.desc?.toLowerCase().includes(q) || g.id.includes(q));
  }
  groups.sort((a, b) => (a.subject ?? '').localeCompare(b.subject ?? ''));
  const page = groups.slice(p.offset, p.offset + p.limit);
  res.json({ groups: page.map((g) => presentGroup(p.noParticipants ? { ...g, participants: [] } : g)), pagination: { totalRecords: groups.length, limit: p.limit, offset: p.offset } });
});

groupRouter.post('/group/resetInviteCode', async (req, res) => {
  const { groupjid } = parse(z.object({ groupjid: gjid }), req.body);
  const s = await sess(req);
  const code = await s.sock!.groupRevokeInvite(groupjid);
  res.json({ InviteLink: `https://chat.whatsapp.com/${code}`, ...(await after(s, groupjid, 'ok')) });
});

groupRouter.post('/group/updateAnnounce', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, announce: z.boolean() }), req.body);
  const s = await sess(req);
  await s.sock!.groupSettingUpdate(p.groupjid, p.announce ? 'announcement' : 'not_announcement');
  res.json(await after(s, p.groupjid, 'Announce updated'));
});

groupRouter.post('/group/updateLocked', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, locked: z.boolean() }), req.body);
  const s = await sess(req);
  await s.sock!.groupSettingUpdate(p.groupjid, p.locked ? 'locked' : 'unlocked');
  res.json(await after(s, p.groupjid, 'Locked updated'));
});

groupRouter.post('/group/updateJoinApproval', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, IsJoinApprovalRequired: z.boolean() }), req.body);
  const s = await sess(req);
  await s.sock!.groupJoinApprovalMode(p.groupjid, p.IsJoinApprovalRequired ? 'on' : 'off');
  res.json(await after(s, p.groupjid, 'Join approval updated'));
});

groupRouter.post('/group/updateMemberAddMode', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, MemberAddMode: z.enum(['admin_add', 'all_member_add']) }), req.body);
  const s = await sess(req);
  await s.sock!.groupMemberAddMode(p.groupjid, p.MemberAddMode);
  res.json(await after(s, p.groupjid, 'Member add mode updated'));
});

groupRouter.post('/group/updateDescription', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, description: z.string().max(2048) }), req.body);
  const s = await sess(req);
  await s.sock!.groupUpdateDescription(p.groupjid, p.description || undefined);
  res.json(await after(s, p.groupjid, 'Description updated'));
});

groupRouter.post('/group/updateName', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, name: z.string().trim().min(1).max(100) }), req.body);
  const s = await sess(req);
  await s.sock!.groupUpdateSubject(p.groupjid, p.name);
  res.json(await after(s, p.groupjid, 'Name updated'));
});

groupRouter.post('/group/ephemeral', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, duration: z.coerce.number().int().refine((v) => [0, 86400, 604800, 7776000].includes(v), 'use 0, 86400, 604800 ou 7776000') }), req.body);
  const s = await sess(req);
  await s.sock!.groupToggleEphemeral(p.groupjid, p.duration);
  res.json({ ...(await after(s, p.groupjid, 'Ephemeral updated')), chat: p.groupjid, ephemeral: p.duration });
});

groupRouter.post('/group/updateImage', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, image: z.string().min(1).max(15_000_000) }), req.body);
  const s = await sess(req);
  if (p.image === 'remove' || p.image === 'delete') await s.sock!.removeProfilePicture(p.groupjid);
  else await s.sock!.updateProfilePicture(p.groupjid, (await loadMedia(p.image, undefined, s.id)).buffer);
  res.json(await after(s, p.groupjid, 'Image updated'));
});

groupRouter.post('/group/updateParticipants', async (req, res) => {
  const p = parse(z.object({ groupjid: gjid, action: z.enum(['add', 'remove', 'promote', 'demote', 'approve', 'reject']), participants: z.array(z.string().max(120)).min(1).max(256) }), req.body);
  const s = await sess(req);
  const jids = p.participants.map(toJid);
  const result =
    p.action === 'approve' || p.action === 'reject'
      ? await s.sock!.groupRequestParticipantsUpdate(p.groupjid, jids, p.action)
      : await s.sock!.groupParticipantsUpdate(p.groupjid, jids, p.action);
  res.json({ groupUpdated: result, ...(await after(s, p.groupjid, 'Participants updated')) });
});

// ---------- Comunidades (Baileys 7 RC — verificado em runtime) ----------
groupRouter.post('/community/create', async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(2048).optional() }), req.body);
  const s = await sess(req);
  const g = await s.call<GroupMetadata>('communityCreate', name, (req.body as { description?: string }).description ?? '');
  res.json({ group: g ? presentGroup(g) : null, failed: [] });
});

groupRouter.post('/community/editgroups', async (req, res) => {
  const p = parse(z.object({ community: gjid, action: z.enum(['add', 'remove']), groupjids: z.array(gjid).min(1).max(100) }), req.body);
  const s = await sess(req);
  const success: string[] = [];
  const failed: string[] = [];
  for (const g of p.groupjids) {
    try {
      if (p.action === 'add') await s.call('communityLinkGroup', g, p.community);
      else await s.call('communityUnlinkGroup', g, p.community);
      success.push(g);
    } catch (err) {
      if ((err as { status?: number }).status === 501) throw err;
      failed.push(g);
    }
  }
  if (!success.length && failed.length) throw badRequest('Nenhum grupo pôde ser alterado');
  res.json({ message: 'ok', success, failed });
});
