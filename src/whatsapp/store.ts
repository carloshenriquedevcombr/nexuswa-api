import { BufferJSON, type WAMessage } from '@whiskeysockets/baileys';
import type { Instance, Message, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { eventBus } from './eventBus.js';
import { keepAfterLast, normalize, protocolOf, shouldUpdateStatus, statusFromBaileys, toNumberTs } from './normalizer.js';
import { presentChat, presentMessage } from './presenters.js';

/**
 * Persistência dos eventos do WhatsApp (mensagens, chats, contatos).
 * A sessão Baileys apenas repassa eventos para cá; aqui ficam as regras de
 * negócio de armazenamento (idempotência por ID, status que nunca regride, contadores).
 */

export interface ApiSendMeta {
  trackSource?: string;
  trackId?: string;
  sendFunction: string;
  folderId?: string;
  /** Nome de quem enviou pelo painel (variável {{atendente}}). */
  senderName?: string;
}

/** IDs gerados pela API antes do envio → permite marcar wasSentByApi mesmo se o eco chegar antes do retorno. */
const apiSent = new Map<string, { meta: ApiSendMeta; at: number }>();
export function registerApiSend(messageId: string, meta: ApiSendMeta): void {
  apiSent.set(messageId, { meta, at: Date.now() });
  if (apiSent.size > 5000) {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of apiSent) if (v.at < cutoff) apiSent.delete(k);
  }
}

export const rowId = (owner: string, messageid: string) => `${owner || 'pending'}:${messageid}`;

export function serializeWaMessage(msg: WAMessage): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(msg, BufferJSON.replacer)) as Prisma.InputJsonValue;
}

export function deserializeWaMessage(content: unknown): WAMessage | null {
  if (!content) return null;
  return JSON.parse(JSON.stringify(content), BufferJSON.reviver) as WAMessage;
}

export async function findMessageRow(instanceId: string, id: string): Promise<Message | null> {
  // Aceita o id consolidado ("owner:msgid") ou apenas o messageid.
  if (id.includes(':')) {
    const byId = await prisma.message.findFirst({ where: { instanceId, id } });
    if (byId) return byId;
  }
  return prisma.message.findFirst({ where: { instanceId, messageid: id.split(':').pop() ?? id }, orderBy: { createdAt: 'desc' } });
}

export async function loadWaMessage(instanceId: string, id: string): Promise<{ row: Message; msg: WAMessage }> {
  const row = await findMessageRow(instanceId, id);
  const msg = row ? deserializeWaMessage(row.content) : null;
  if (!row || !msg) {
    const { notFound } = await import('../lib/errors.js');
    throw notFound('Mensagem não encontrada na janela de retenção local');
  }
  return { row, msg };
}

/**
 * Move uma conversa gravada pelo LID para o número real (mesmo chat, sem duplicar).
 * Se o chat do número já existir, só as mensagens são movidas e o registro LID sai.
 */
export async function mergeLidChat(instanceId: string, lid: string, pn: string, attempt = 0): Promise<void> {
  const lidChat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId, chatid: lid } } });
  if (!lidChat) return;
  const pnChat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId, chatid: pn } } });
  try {
    if (!pnChat) {
      await prisma.$transaction([
        prisma.message.updateMany({ where: { instanceId, chatid: lid }, data: { chatid: pn } }),
        prisma.chat.update({ where: { id: lidChat.id }, data: { chatid: pn, chatlid: lid } }),
      ]);
      return;
    }
    // Os dois existem: o chat do número fica, herdando o que só o chat LID tinha
    // (atendimento em andamento, lead, etiquetas, não lidas) — nada se perde na fusão.
    // Só herda o atendente se ele ainda atende este número e consegue entrar.
    const lidAgentOk = lidChat.leadAssignedAttendantId
      ? Boolean(await prisma.instanceAgent.findFirst({ where: { instanceId, userId: lidChat.leadAssignedAttendantId, active: true, user: { isActive: true } }, select: { id: true } }))
      : false;
    const keepTicket = !pnChat.leadIsTicketOpen && lidChat.leadIsTicketOpen && lidAgentOk;
    await prisma.$transaction([
      prisma.message.updateMany({ where: { instanceId, chatid: lid }, data: { chatid: pn } }),
      prisma.chat.update({
        where: { id: pnChat.id },
        data: {
          chatlid: lid,
          unreadCount: pnChat.unreadCount + lidChat.unreadCount,
          labels: [...new Set([...(pnChat.labels ?? []), ...(lidChat.labels ?? [])])],
          ...(keepTicket ? { leadIsTicketOpen: true, leadAssignedAttendantId: lidChat.leadAssignedAttendantId } : {}),
          ...(!pnChat.leadAssignedAttendantId && lidAgentOk && !keepTicket ? { leadAssignedAttendantId: lidChat.leadAssignedAttendantId } : {}),
          ...(!pnChat.leadName && lidChat.leadName ? { leadName: lidChat.leadName } : {}),
          ...(!pnChat.leadStatus && lidChat.leadStatus ? { leadStatus: lidChat.leadStatus } : {}),
          ...(!pnChat.pushName && lidChat.pushName ? { pushName: lidChat.pushName } : {}),
          ...(Number(lidChat.lastMsgTimestamp) > Number(pnChat.lastMsgTimestamp)
            ? { lastMsgTimestamp: lidChat.lastMsgTimestamp, lastMessageText: lidChat.lastMessageText, lastMessageType: lidChat.lastMessageType, lastMessageSender: lidChat.lastMessageSender }
            : {}),
        },
      }),
      prisma.chat.delete({ where: { id: lidChat.id } }),
    ]);
    if (keepTicket) {
      // Avisa o painel do atendente na hora (senão ele só veria a conversa na próxima recarga).
      eventBus.publish({ instanceId, eventType: 'chats', payload: { event: { type: 'assignment', chatid: pn, lead_assignedAttendant_id: lidChat.leadAssignedAttendantId, lead_isTicketOpen: true, reason: 'fusao' } }, meta: { chatid: pn } });
    }
  } catch (err) {
    // Corrida: o chat do número foi criado entre a leitura e a escrita → refaz pelo caminho da fusão.
    if ((err as { code?: string }).code === 'P2002' && attempt < 2) return mergeLidChat(instanceId, lid, pn, attempt + 1);
    throw err;
  }
}

export async function saveMessages(
  instance: Instance,
  msgs: WAMessage[],
  opts: { source: 'realtime' | 'history'; notify: boolean; resolveLid?: (lid: string) => Promise<string | undefined> },
): Promise<Array<{ chatid: string; fromMe: boolean; isGroup: boolean }>> {
  const owner = instance.connectedPhone;
  const touched: Array<{ chatid: string; fromMe: boolean; isGroup: boolean }> = [];
  for (const msg of msgs) {
    if (!msg.key?.id || !msg.key.remoteJid || !msg.message) continue;
    const n = normalize(msg as unknown as Record<string, unknown>);
    // Conversa só com LID (sem número junto): tenta descobrir o número real. Sem isso o
    // painel mostra o ID interno ("+187063206998095") como se fosse um telefone.
    if (n.chatid.endsWith('@lid') && opts.resolveLid) {
      const pn = await opts.resolveLid(n.chatid).catch(() => undefined);
      if (pn) {
        // Falha na fusão não pode derrubar o lote: a mensagem é salva no chat do número de qualquer forma.
        await mergeLidChat(instance.id, n.chatid, pn).catch(() => undefined);
        if (n.sender === n.chatid) n.sender = pn;
        n.chatlid = n.chatid;
        n.chatid = pn;
      }
    }
    // protocolMessage (revogação/edição) e reações atualizam a mensagem-alvo, não criam linha nova.
    if (n.messageType === 'protocolMessage') {
      await handleProtocol(instance, msg);
      continue;
    }
    const api = apiSent.get(n.messageid);
    const id = rowId(owner, n.messageid);
    let tsMs = Math.floor(n.messageTimestampMs);
    if (api && opts.source === 'realtime') {
      const last = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: instance.id, chatid: n.chatid } }, select: { lastMsgTimestamp: true } });
      if (last) tsMs = keepAfterLast(tsMs, Number(last.lastMsgTimestamp));
    }
    const data = {
      instanceId: instance.id,
      messageid: n.messageid,
      chatid: n.chatid,
      sender: n.sender,
      senderName: n.senderName,
      fromMe: n.fromMe,
      isGroup: n.isGroup,
      messageType: n.messageType,
      source: opts.source,
      text: n.text,
      quoted: n.quoted,
      reaction: n.reaction,
      status: n.fromMe ? statusFromBaileys((msg as { status?: number }).status) || 'Sent' : 'Delivered',
      wasSentByApi: Boolean(api),
      sendFunction: api?.meta.sendFunction ?? '',
      trackSource: api?.meta.trackSource ?? '',
      trackId: api?.meta.trackId ?? '',
      sendFolderId: api?.meta.folderId ?? '',
      content: serializeWaMessage(msg),
      messageTimestamp: BigInt(tsMs),
    };
    const saved = await prisma.message.upsert({
      where: { id },
      create: { id, ...data },
      // No eco de um envio da API, preserva os campos de rastreio já gravados.
      update: { content: data.content, text: data.text, messageType: data.messageType },
    });

    const chat = await prisma.chat.upsert({
      where: { instanceId_chatid: { instanceId: instance.id, chatid: n.chatid } },
      create: {
        instanceId: instance.id,
        chatid: n.chatid,
        isGroup: n.isGroup,
        chatlid: n.chatlid,
        pushName: n.fromMe || n.isGroup ? '' : n.senderName,
        lastMsgTimestamp: data.messageTimestamp,
        lastMessageType: n.simpleType,
        lastMessageText: n.text.slice(0, 500),
        lastMessageSender: n.sender,
        unreadCount: n.fromMe || !opts.notify ? 0 : 1,
      },
      update: {
        ...(n.chatlid ? { chatlid: n.chatlid } : {}),
        ...(n.fromMe || n.isGroup || !n.senderName ? {} : { pushName: n.senderName }),
        lastMsgTimestamp: data.messageTimestamp,
        lastMessageType: n.simpleType,
        lastMessageText: n.text.slice(0, 500),
        lastMessageSender: n.sender,
        ...(n.fromMe || !opts.notify ? {} : { unreadCount: { increment: 1 } }),
      },
    });

    if (opts.source === 'realtime') {
      const isNewsletter = n.chatid.endsWith('@newsletter');
      eventBus.publish({
        instanceId: instance.id,
        eventType: isNewsletter ? 'newsletter_messages' : 'messages',
        payload: { message: { ...presentMessage(saved, owner), content: msg.message, buttonOrListid: n.selectedId }, chat: presentChat(chat, owner, true) },
        meta: { messageType: n.simpleType, fromMe: n.fromMe, wasSentByApi: saved.wasSentByApi, isGroup: n.isGroup, chatid: n.chatid, chatlid: n.chatlid ?? undefined },
      });
    }
    // Reações e atualizações de enquete não abrem atendimento.
    if (n.messageType !== 'reactionMessage' && n.messageType !== 'pollUpdateMessage') touched.push({ chatid: n.chatid, fromMe: n.fromMe, isGroup: n.isGroup });
  }
  return touched;
}

async function handleProtocol(instance: Instance, msg: WAMessage): Promise<void> {
  const p = protocolOf(msg.message as Record<string, unknown> | null) as NonNullable<WAMessage['message']>['protocolMessage'];
  const targetId = p?.key?.id;
  if (!p || !targetId) return;
  const where = { instanceId: instance.id, messageid: targetId };
  if (p.type === 0 /* REVOKE */) {
    await prisma.message.updateMany({ where, data: { status: 'Deleted' } });
    publishUpdate(instance, targetId, { status: 'Deleted' }, msg.key.remoteJid ?? undefined);
  } else if (p.editedMessage) {
    const text =
      p.editedMessage.conversation ?? p.editedMessage.extendedTextMessage?.text ?? p.editedMessage.imageMessage?.caption ?? '';
    await prisma.message.updateMany({ where, data: { text, edited: text } });
    publishUpdate(instance, targetId, { edited: text, text }, msg.key.remoteJid ?? undefined);
  }
}

function publishUpdate(instance: Instance, messageid: string, changes: Record<string, unknown>, chatid?: string): void {
  eventBus.publish({
    instanceId: instance.id,
    eventType: 'messages_update',
    payload: { event: { messageid, id: rowId(instance.connectedPhone, messageid), ...(chatid ? { chatid } : {}), ...changes } },
    meta: { chatid },
  });
}

/** Recibos de entrega/leitura. Idempotente e monotônico (Read nunca volta para Sent). */
export async function applyStatusUpdate(instance: Instance, messageid: string, status: string, chatid?: string): Promise<void> {
  if (!status) return;
  const row = await prisma.message.findFirst({ where: { instanceId: instance.id, messageid } });
  if (!row || !shouldUpdateStatus(row.status, status)) return;
  await prisma.message.update({ where: { id: row.id }, data: { status } });
  if (row.sendFolderId) await bumpCampaignCounter(row.sendFolderId, status);
  eventBus.publish({
    instanceId: instance.id,
    eventType: 'messages_update',
    payload: { event: { id: row.id, messageid, chatid: chatid ?? row.chatid, status, track_source: row.trackSource, track_id: row.trackId } },
    meta: { fromMe: row.fromMe, wasSentByApi: row.wasSentByApi, isGroup: row.isGroup, messageType: row.messageType, chatid: row.chatid },
  });
}

async function bumpCampaignCounter(folderId: string, status: string): Promise<void> {
  const field = status === 'Delivered' ? 'logDelivered' : status === 'Read' ? 'logRead' : status === 'Played' ? 'logPlayed' : null;
  if (!field) return;
  await prisma.campaignFolder.updateMany({ where: { id: folderId }, data: { [field]: { increment: 1 } } as Prisma.CampaignFolderUpdateManyMutationInput });
}

const CALL_TEXT: Record<string, string> = {
  offer: 'Chamada recebida',
  ringing: 'Chamada tocando',
  accept: 'Chamada atendida',
  reject: 'Chamada recusada',
  timeout: 'Chamada perdida',
  terminate: 'Chamada encerrada',
};

/**
 * Registra chamadas de voz/vídeo como "mensagens" do tipo call, para aparecerem na
 * conversa (como no WhatsApp) e em /message/find?messageType=call (padrão uazapi).
 * Uma linha por chamada: o status final sobrescreve o inicial.
 */
export async function saveCall(
  instance: Instance,
  c: { id: string; from: string; chatId?: string; isGroup?: boolean; groupJid?: string; isVideo?: boolean; status: string; date?: Date | string | number },
): Promise<void> {
  const chatid = (c.isGroup && c.groupJid) || c.chatId || c.from;
  if (!c.id || !chatid) return;
  const id = rowId(instance.connectedPhone, `call-${c.id}`);
  const existing = await prisma.message.findUnique({ where: { id } });
  // "terminate" depois de "offer" sem "accept" = chamada não atendida.
  const prev = (existing?.content as { call?: { status?: string } } | null)?.call?.status;
  const status = c.status === 'terminate' && (prev === 'offer' || prev === 'ringing') ? 'timeout' : c.status;
  const text = `${c.isVideo ? 'Chamada de vídeo' : 'Chamada de voz'} · ${(CALL_TEXT[status] ?? status).replace(/^Chamada /, '')}`;
  const content = { call: { isVideo: Boolean(c.isVideo), status, from: c.from } } as Prisma.InputJsonValue;
  const ts = BigInt(new Date(c.date ?? Date.now()).getTime() || Date.now());
  if (existing) {
    if (existing.content && (existing.content as { call?: { status?: string } }).call?.status === 'accept' && status === 'timeout') return;
    await prisma.message.update({ where: { id }, data: { content, text } });
    return;
  }
  await prisma.message.create({
    data: { id, instanceId: instance.id, messageid: `call-${c.id}`, chatid, sender: c.from, fromMe: false, isGroup: Boolean(c.isGroup), messageType: 'call', source: 'realtime', text, status: 'Delivered', content, messageTimestamp: ts },
  });
  await prisma.chat.upsert({
    where: { instanceId_chatid: { instanceId: instance.id, chatid } },
    create: { instanceId: instance.id, chatid, isGroup: Boolean(c.isGroup), lastMsgTimestamp: ts, lastMessageType: 'call', lastMessageText: text },
    update: { lastMsgTimestamp: ts, lastMessageType: 'call', lastMessageText: text },
  });
}

export async function upsertContacts(instance: Instance, contacts: Array<{ id?: string | null; lid?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }>, inAddressBook?: boolean): Promise<void> {
  for (const c of contacts) {
    if (!c.id || c.id.endsWith('@g.us')) continue;
    const data = {
      ...(c.name ? { fullName: c.name, firstName: c.name.split(' ')[0] ?? '' } : {}),
      ...(c.notify ? { pushName: c.notify } : {}),
      ...(c.verifiedName ? { businessName: c.verifiedName } : {}),
      ...(c.lid ? { lid: c.lid } : {}),
      ...(inAddressBook !== undefined ? { inAddressBook } : c.name ? { inAddressBook: true } : {}),
    };
    await prisma.contact.upsert({
      where: { instanceId_jid: { instanceId: instance.id, jid: c.id } },
      create: { instanceId: instance.id, jid: c.id, ...data },
      update: data,
    });
    if (c.name) {
      await prisma.chat.updateMany({ where: { instanceId: instance.id, chatid: c.id }, data: { contactName: c.name } });
    }
  }
}

export async function upsertChatsFromSync(instance: Instance, chats: Array<Record<string, unknown>>): Promise<void> {
  for (const c of chats) {
    const chatid = c.id as string | undefined;
    if (!chatid || chatid === 'status@broadcast') continue;
    const data = {
      ...(typeof c.name === 'string' ? { name: c.name } : {}),
      ...(typeof c.archived === 'boolean' ? { archived: c.archived } : {}),
      ...(c.pinned != null ? { pinned: Boolean(c.pinned) } : {}),
      ...(typeof c.unreadCount === 'number' ? { unreadCount: Math.max(0, c.unreadCount) } : {}),
      ...(c.muteEndTime != null ? { muteEndTime: BigInt(toNumberTs(c.muteEndTime)) } : {}),
      ...(c.ephemeralExpiration != null ? { ephemeralExpiration: Number(c.ephemeralExpiration) } : {}),
      ...(c.conversationTimestamp != null ? { lastMsgTimestamp: BigInt(toNumberTs(c.conversationTimestamp) * 1000) } : {}),
    };
    await prisma.chat.upsert({
      where: { instanceId_chatid: { instanceId: instance.id, chatid } },
      create: { instanceId: instance.id, chatid, isGroup: chatid.endsWith('@g.us'), ...data },
      update: data,
    });
  }
}
