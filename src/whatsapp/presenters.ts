import type { Chat, Instance, Message, Webhook } from '@prisma/client';
import { mediaInfo } from './mediaInfo.js';
import { extractText } from './normalizer.js';

/**
 * Presenters: convertem registros internos no formato de resposta compatível com a uazapi.
 * Regra de segurança: NENHUM presenter expõe segredos (tokenHash, chaves OpenAI,
 * proxy, segredo de webhook). O token da instância só é mostrado na criação/rotação.
 */

const n = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));

export function presentInstance(i: Instance) {
  return {
    id: i.id,
    token_prefix: i.tokenPrefix,
    status: i.status,
    paircode: i.paircode,
    qrcode: i.qrcode,
    name: i.name,
    profileName: i.profileName,
    profilePicUrl: i.profilePicUrl,
    isBusiness: i.isBusiness,
    plataform: i.platform,
    systemName: i.systemName,
    owner: i.connectedPhone,
    owner_user_id: i.ownerId,
    current_presence: i.currentPresence,
    lastDisconnect: i.lastDisconnect?.toISOString() ?? '',
    lastDisconnectReason: i.lastDisconnectReason,
    adminField01: i.adminField01,
    adminField02: i.adminField02,
    openai_apikey_configured: Boolean(i.openaiApiKeyEnc),
    proxy_configured: Boolean(i.proxyUrlEnc),
    msg_delay_min: i.msgDelayMin,
    msg_delay_max: i.msgDelayMax,
    fieldsMap: i.fieldsMap ?? {},
    currentTime: new Date().toISOString(),
    created: i.createdAt.toISOString(),
    updated: i.updatedAt.toISOString(),
  };
}

export function presentStatus(i: Instance) {
  return {
    connected: i.status === 'connected',
    loggedIn: i.status === 'connected' || Boolean(i.ownerJid),
    jid: i.ownerJid ? { user: i.connectedPhone, server: 's.whatsapp.net', full: i.ownerJid } : null,
  };
}

export function presentChat(c: Chat, owner = '', compact = false) {
  const fields = (c.leadFields ?? {}) as Record<string, string>;
  const base = {
    id: c.id,
    wa_fastid: `${owner}:${c.chatid}`,
    wa_chatid: c.chatid,
    wa_chatlid: c.chatlid,
    wa_archived: c.archived,
    wa_contactName: c.contactName,
    wa_name: c.pushName,
    name: c.name || c.contactName || c.pushName,
    image: c.image,
    wa_isBlocked: c.blocked,
    wa_isGroup: c.isGroup,
    wa_isPinned: c.pinned,
    wa_label: c.labels,
    wa_lastMessageType: c.lastMessageType,
    wa_lastMessageTextVote: c.lastMessageText,
    wa_lastMsgTimestamp: n(c.lastMsgTimestamp),
    wa_lastMessageSender: c.lastMessageSender,
    wa_unreadCount: c.unreadCount,
    wa_muteEndTime: n(c.muteEndTime),
    lead_name: c.leadName,
    lead_status: c.leadStatus,
    lead_tags: c.leadTags,
    lead_isTicketOpen: c.leadIsTicketOpen,
    lead_assignedAttendant_id: c.leadAssignedAttendantId,
    lists: c.lists ?? [],
    locked: c.locked,
    phone: c.isGroup ? '' : c.chatid.split('@')[0],
    owner,
  };
  if (compact) return base;
  const leadFields: Record<string, string> = {};
  for (let i = 1; i <= 20; i++) {
    const k = `lead_field${String(i).padStart(2, '0')}`;
    leadFields[k] = fields[k] ?? '';
  }
  return {
    ...base,
    wa_ephemeralExpiration: c.ephemeralExpiration,
    wa_isGroup_admin: c.isGroupAdmin,
    wa_isGroup_announce: c.isGroupAnnounce,
    wa_isGroup_member: c.isGroupMember,
    wa_notes: c.notes,
    lead_fullName: c.leadFullName,
    lead_email: c.leadEmail,
    lead_personalid: c.leadPersonalId,
    lead_notes: c.leadNotes,
    lead_kanbanOrder: n(c.leadKanbanOrder),
    ...leadFields,
    chatbot_disableUntil: n(c.chatbotDisableUntil),
  };
}

export function presentMessage(m: Message, owner = '') {
  return {
    id: m.id,
    messageid: m.messageid,
    chatid: m.chatid,
    sender: m.sender,
    senderName: m.senderName,
    isGroup: m.isGroup,
    fromMe: m.fromMe,
    messageType: m.messageType,
    source: m.source,
    messageTimestamp: n(m.messageTimestamp),
    status: m.status,
    text: m.text,
    quoted: m.quoted,
    edited: m.edited,
    reaction: m.reaction,
    vote: m.vote,
    owner,
    error: m.error,
    wasSentByApi: m.wasSentByApi,
    sendFunction: m.sendFunction,
    fileURL: m.fileURL,
    send_folder_id: m.sendFolderId,
    track_source: m.trackSource,
    track_id: m.trackId,
    pinned: m.pinned,
    transcription: m.transcription,
    // Resumo para exibição (tipo, legenda, miniatura, botões...). Sem chaves de mídia.
    media: mediaInfo(m.content as Record<string, unknown> | null),
    // Texto ANTES da correção: o conteúdo original nunca é sobrescrito na edição.
    // (Removido para atendentes em /message/find — eles só veem a versão corrigida.)
    ...(m.edited ? { original_text: extractText(((m.content as { message?: Record<string, unknown> } | null)?.message ?? null) as Record<string, unknown> | null) } : {}),
  };
}

export function presentWebhook(w: Webhook) {
  return {
    id: w.id,
    enabled: w.enabled,
    url: w.url,
    events: w.events,
    excludeMessages: w.excludeMessages,
    addUrlEvents: w.addUrlEvents,
    addUrlTypesMessages: w.addUrlTypesMessages,
    onlyChats: w.onlyChats ?? [],
  };
}
