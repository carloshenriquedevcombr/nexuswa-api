import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type ConnectionState,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { Instance, Prisma } from '@prisma/client';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { pino } from 'pino';
import QRCode from 'qrcode';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from '../config/env.js';
import { notImplemented } from '../lib/errors.js';
import { phoneFromJid } from '../lib/jid.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { decField } from '../lib/security.js';
import { clearAuthState, usePostgresAuthState } from './authState.js';
import { eventBus } from './eventBus.js';
import { statusFromBaileys } from './normalizer.js';
import { presentInstance, presentStatus } from './presenters.js';
import { applyStatusUpdate, deserializeWaMessage, findMessageRow, mergeLidChat, saveCall, saveMessages, upsertChatsFromSync, upsertContacts } from './store.js';
import { onInboundChats } from '../services/agentRouter.js';
import { resolvePollVote } from './pollCrypto.js';
import crypto from 'node:crypto';

export type BrowserChoice = 'auto' | 'safari' | 'firefox' | 'edge' | 'chrome';

const baileysLogger = pino({ level: env.BAILEYS_LOG_LEVEL });

function browserFor(choice: BrowserChoice): [string, string, string] {
  switch (choice) {
    case 'safari':
      return Browsers.macOS('Safari');
    case 'firefox':
      return Browsers.ubuntu('Firefox');
    case 'edge':
      return Browsers.windows('Edge');
    case 'chrome':
      return Browsers.ubuntu('Chrome');
    default:
      // "Desktop" no macOS recebe o histórico mais completo na sincronização inicial.
      return Browsers.macOS('Desktop');
  }
}

let cachedVersion: [number, number, number] | undefined;
async function waVersion(): Promise<[number, number, number] | undefined> {
  if (cachedVersion) return cachedVersion;
  try {
    const { version } = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    cachedVersion = version as [number, number, number];
  } catch {
    cachedVersion = undefined; // usa a versão embutida no Baileys
  }
  return cachedVersion;
}

/**
 * Uma sessão WhatsApp (um número). Encapsula o socket Baileys, a máquina de estados
 * de conexão e a política de reconexão com backoff exponencial.
 */
export class InstanceSession {
  sock?: WASocket;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private unpairedTimer?: NodeJS.Timeout;
  private stopped = false;
  private groupCache = new Map<string, { data: GroupMetadata; at: number }>();
  private pairingRequested = false;
  private lidCache = new Map<string, { pn: string; at: number }>();
  private namedGroups = new Set<string>();
  lastGroupsFetch?: { at: number; groups: GroupMetadata[] };

  constructor(
    public instance: Instance,
    private readonly onFinished: (id: string) => void,
  ) {}

  get id() {
    return this.instance.id;
  }

  get isConnected() {
    return this.instance.status === 'connected' && Boolean(this.sock?.user);
  }

  async connect(opts: { phone?: string; browser?: BrowserChoice } = {}): Promise<void> {
    this.stopped = false;
    this.pairingRequested = false;
    const { state, saveCreds } = await usePostgresAuthState(this.id);
    const proxyUrl = decField(this.instance.proxyUrlEnc, `proxy:${this.id}`);
    const agent = proxyUrl ? (proxyUrl.startsWith('socks') ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl)) : undefined;
    const version = await waVersion();

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      // Código de pareamento: o WhatsApp recusa o vínculo quando o aparelho se apresenta como
      // "Desktop" (plataforma que não aceita "conectar com número"). Para código, usa Chrome.
      browser: opts.phone && (opts.browser ?? 'auto') === 'auto' ? Browsers.macOS('Chrome') : browserFor(opts.browser ?? 'auto'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Link preview é gerado por nós via safeFetch (SSRF-safe); nunca pelo Baileys.
      linkPreviewImageThumbnailWidth: 192,
      // Proxy aplicado ao WebSocket da sessão. (fetchAgent não é passado: no Baileys 7 o upload
      // usa fetch/undici e um http.Agent ali quebraria o envio de mídia.)
      ...(agent ? { agent } : {}),
      getMessage: async (key: WAMessageKey) => {
        if (!key.id) return undefined;
        const row = await findMessageRow(this.id, key.id);
        return deserializeWaMessage(row?.content)?.message ?? undefined;
      },
      cachedGroupMetadata: async (jid: string) => {
        const hit = this.groupCache.get(jid);
        return hit && Date.now() - hit.at < 5 * 60_000 ? hit.data : undefined;
      },
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(u, opts.phone).catch((err) => logger.error({ err: (err as Error).message, instance: this.id }, 'connection.update')));
    this.bindEvents(sock);
    await this.setStatus({ status: 'connecting' });
  }

  private async onConnectionUpdate(u: Partial<ConnectionState>, phone?: string): Promise<void> {
    if (u.qr) {
      if (phone && !this.pairingRequested && this.sock && !this.sock.authState.creds.registered) {
        this.pairingRequested = true;
        const code = await this.sock.requestPairingCode(phone.replace(/\D/g, ''));
        await this.setStatus({ status: 'connecting', paircode: code, qrcode: '' });
      } else if (!phone) {
        await this.setStatus({ status: 'connecting', qrcode: await QRCode.toDataURL(u.qr) });
      }
      this.armUnpairedTimeout();
    }

    if (u.connection === 'open' && this.sock?.user) {
      this.reconnectAttempts = 0;
      clearTimeout(this.unpairedTimer);
      const jid = this.sock.user.id;
      await this.setStatus({
        status: 'connected',
        qrcode: '',
        paircode: '',
        ownerJid: jid,
        connectedPhone: phoneFromJid(jid),
        profileName: this.sock.user.name ?? '',
        ...(this.instance.pairedAt ? {} : { pairedAt: new Date() }),
      });
      void this.refreshProfileExtras();
      void this.sweepLidChats().catch((err: Error) => logger.warn({ err: err.message, instance: this.id }, 'varredura de LID falhou'));
    }

    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      const reason = (u.lastDisconnect?.error as Error | undefined)?.message ?? 'unknown';
      this.sock = undefined;
      if (this.stopped) return;

      if (code === DisconnectReason.loggedOut) {
        // Sessão encerrada no celular: credenciais não valem mais.
        await clearAuthState(this.id);
        await this.setStatus({ status: 'disconnected', qrcode: '', paircode: '', ownerJid: '', lastDisconnect: new Date(), lastDisconnectReason: 'logged_out' });
        this.finish();
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Outra conexão assumiu o número: reconectar causaria disputa infinita.
        await this.setStatus({ status: 'disconnected', lastDisconnect: new Date(), lastDisconnectReason: 'connection_replaced' });
        this.finish();
        return;
      }
      await this.setStatus({ status: 'connecting', lastDisconnect: new Date(), lastDisconnectReason: `${code ?? ''} ${reason}`.trim() });
      this.scheduleReconnect(code === DisconnectReason.restartRequired ? 0 : undefined);
    }
  }

  private scheduleReconnect(forcedDelay?: number): void {
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 12) {
      void this.setStatus({ status: 'disconnected', lastDisconnectReason: 'max_reconnect_attempts' }).then(() => this.finish());
      return;
    }
    // Backoff exponencial com jitter: 1s, 2s, 4s... até 60s.
    const base = Math.min(60_000, 1000 * 2 ** (this.reconnectAttempts - 1));
    const delay = forcedDelay ?? base + Math.floor(Math.random() * 1000);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => logger.error({ err: (err as Error).message, instance: this.id }, 'reconnect falhou'));
    }, delay);
  }

  private armUnpairedTimeout(): void {
    if (!env.UNPAIRED_INSTANCE_TTL_MIN || this.unpairedTimer) return;
    this.unpairedTimer = setTimeout(() => {
      if (!this.isConnected) {
        logger.info({ instance: this.id }, 'pareamento expirou; encerrando tentativa');
        void this.stop(false);
      }
    }, env.UNPAIRED_INSTANCE_TTL_MIN * 60_000);
  }

  private async refreshProfileExtras(): Promise<void> {
    try {
      const jid = this.sock?.user?.id;
      if (!jid || !this.sock) return;
      const [pic, biz] = await Promise.allSettled([
        this.sock.profilePictureUrl(jid, 'image'),
        this.sock.getBusinessProfile(jid),
      ]);
      await this.setStatus({
        profilePicUrl: pic.status === 'fulfilled' ? (pic.value ?? '') : '',
        isBusiness: biz.status === 'fulfilled' && Boolean(biz.value),
        platform: (this.sock.authState.creds as { platform?: string }).platform ?? '',
      }, false);
    } catch {
      /* dados cosméticos — falha não afeta a sessão */
    }
  }

  async setStatus(data: Prisma.InstanceUpdateInput, emit = true): Promise<void> {
    this.instance = await prisma.instance.update({ where: { id: this.id }, data });
    if (emit && data.status) {
      eventBus.publish({
        instanceId: this.id,
        eventType: 'connection',
        payload: { instance: presentInstance(this.instance), status: presentStatus(this.instance) },
        meta: {},
      });
    }
  }

  /** LID → número real (mapa do Baileys; depois a agenda salva). Cache de 10 min, inclusive negativo. */
  async resolveLid(lid: string): Promise<string | undefined> {
    const hit = this.lidCache.get(lid);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.pn || undefined;
    let pn: string | undefined;
    try {
      const repo = (this.sock as unknown as { signalRepository?: { lidMapping?: { getPNForLID?: (l: string) => Promise<string | null | undefined> } } })?.signalRepository;
      pn = (await repo?.lidMapping?.getPNForLID?.(lid)) ?? undefined;
    } catch {
      pn = undefined;
    }
    if (!pn) pn = (await prisma.contact.findFirst({ where: { instanceId: this.id, lid }, select: { jid: true } }))?.jid;
    pn = pn?.replace(/:\d+(?=@)/, '');
    if (pn && !pn.endsWith('@s.whatsapp.net')) pn = undefined;
    this.lidCache.set(lid, { pn: pn ?? '', at: Date.now() });
    return pn;
  }

  /** Ao conectar: converte conversas antigas gravadas só com LID para o número real, quando conhecido. */
  private async sweepLidChats(): Promise<void> {
    const chats = await prisma.chat.findMany({ where: { instanceId: this.id, chatid: { endsWith: '@lid' } }, select: { chatid: true }, take: 500 });
    for (const c of chats) {
      const pn = await this.resolveLid(c.chatid);
      if (pn) await mergeLidChat(this.id, c.chatid, pn).catch((err: Error) => logger.warn({ err: err.message, instance: this.id }, 'fusão de LID falhou'));
    }
  }

  /** Grupos novos chegam sem nome (só o ID): busca o assunto uma vez e grava no chat. */
  private async ensureGroupNames(jids: string[]): Promise<void> {
    for (const jid of new Set(jids)) {
      if (!jid.endsWith('@g.us') || this.namedGroups.has(jid)) continue;
      this.namedGroups.add(jid);
      const chat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: this.id, chatid: jid } }, select: { name: true } });
      if (!chat || chat.name) continue;
      const cached = this.groupCache.get(jid)?.data;
      const meta = cached ?? (await this.sock?.groupMetadata(jid).catch(() => undefined));
      if (!meta) {
        this.namedGroups.delete(jid); // tenta de novo na próxima mensagem
        continue;
      }
      this.cacheGroup(meta);
      if (meta.subject) await prisma.chat.updateMany({ where: { instanceId: this.id, chatid: jid }, data: { name: meta.subject } });
    }
  }

  cacheGroup(meta: GroupMetadata): void {
    this.groupCache.set(meta.id, { data: meta, at: Date.now() });
  }

  private bindEvents(sock: WASocket): void {
    const ev = sock.ev;
    const guard = (name: string, fn: () => Promise<void>) => fn().catch((err) => logger.error({ err: (err as Error).message, event: name, instance: this.id }, 'erro processando evento'));

    ev.on('messages.upsert', ({ messages, type }) =>
      guard('messages.upsert', async () => {
        // Voto de enquete PRIMEIRO e isolado: um erro ao salvar outra mensagem do lote
        // não pode impedir a contagem (antes aparecia "[pollUpdate]" e 0 votos).
        for (const m of messages) if (m.message?.pollUpdateMessage) await this.processPollUpdate(m).catch((err: Error) => logger.warn({ err: err.message, instance: this.id }, 'voto de enquete não processado'));
        const touched = await saveMessages(this.instance, messages, { source: 'realtime', notify: type === 'notify', resolveLid: (lid) => this.resolveLid(lid) });
        const jids = messages.map((m) => m.key?.remoteJid ?? '').filter(Boolean);
        await this.ensureGroupNames(jids);
        // Distribui conversas novas entre os atendentes (se a instância tiver atendentes).
        if (type === 'notify') await onInboundChats(this.instance, touched);
      }),
    );

    ev.on('messages.update', (updates) =>
      guard('messages.update', async () => {
        for (const { key, update } of updates) {
          if (!key.id) continue;
          if (update.status != null) await applyStatusUpdate(this.instance, key.id, statusFromBaileys(update.status as number), key.remoteJid ?? undefined);
          if (update.pollUpdates?.length) await this.handlePollVote(key, update.pollUpdates);
        }
      }),
    );

    ev.on('message-receipt.update', (receipts) =>
      guard('message-receipt.update', async () => {
        for (const r of receipts) {
          if (!r.key.id) continue;
          const st = r.receipt.playedTimestamp ? 'Played' : r.receipt.readTimestamp ? 'Read' : r.receipt.receiptTimestamp ? 'Delivered' : '';
          await applyStatusUpdate(this.instance, r.key.id, st, r.key.remoteJid ?? undefined);
        }
      }),
    );

    ev.on('messaging-history.set', ({ chats, contacts, messages, progress, isLatest }) =>
      guard('history', async () => {
        await upsertChatsFromSync(this.instance, chats as unknown as Array<Record<string, unknown>>);
        await upsertContacts(this.instance, contacts);
        await saveMessages(this.instance, messages, { source: 'history', notify: false, resolveLid: (lid) => this.resolveLid(lid) });
        eventBus.publish({
          instanceId: this.id,
          eventType: 'history',
          payload: { history: { chats: chats.length, contacts: contacts.length, messages: messages.length, progress: progress ?? null, isLatest: isLatest ?? null } },
          meta: {},
        });
      }),
    );

    ev.on('chats.upsert', (chats) => guard('chats.upsert', () => this.publishChats(chats as unknown as Array<Record<string, unknown>>)));
    ev.on('chats.update', (chats) => guard('chats.update', () => this.publishChats(chats as unknown as Array<Record<string, unknown>>)));
    ev.on('chats.delete', (ids) =>
      guard('chats.delete', async () => {
        eventBus.publish({ instanceId: this.id, eventType: 'chats', payload: { event: { type: 'delete', chats: ids } }, meta: {} });
      }),
    );

    ev.on('contacts.upsert', (contacts) =>
      guard('contacts.upsert', async () => {
        await upsertContacts(this.instance, contacts);
        eventBus.publish({ instanceId: this.id, eventType: 'contacts', payload: { event: { type: 'upsert', contacts } }, meta: {} });
      }),
    );
    ev.on('contacts.update', (contacts) =>
      guard('contacts.update', async () => {
        await upsertContacts(this.instance, contacts as Array<{ id?: string | null }>);
        eventBus.publish({ instanceId: this.id, eventType: 'contacts', payload: { event: { type: 'update', contacts } }, meta: {} });
      }),
    );

    ev.on('presence.update', (p) =>
      guard('presence', async () => {
        eventBus.publish({ instanceId: this.id, eventType: 'presence', payload: { event: p }, meta: { chatid: (p as { id?: string }).id } });
      }),
    );

    ev.on('groups.update', (groups) =>
      guard('groups.update', async () => {
        for (const g of groups) {
          if (!g.id) continue;
          this.groupCache.delete(g.id);
          // Renomearam o grupo no WhatsApp: reflete no painel/busca.
          if (g.subject) await prisma.chat.updateMany({ where: { instanceId: this.id, chatid: g.id }, data: { name: g.subject } });
        }
        eventBus.publish({ instanceId: this.id, eventType: 'groups', payload: { event: { type: 'update', groups } }, meta: {} });
      }),
    );
    ev.on('group-participants.update', (e) =>
      guard('group-participants', async () => {
        this.groupCache.delete(e.id);
        eventBus.publish({ instanceId: this.id, eventType: 'groups', payload: { event: { type: 'participants', ...e } }, meta: {} });
      }),
    );

    ev.on('labels.edit', (label) =>
      guard('labels.edit', async () => {
        const l = label as { id: string; name?: string; color?: number; deleted?: boolean };
        if (l.deleted) await prisma.label.deleteMany({ where: { instanceId: this.id, labelid: l.id } });
        else
          await prisma.label.upsert({
            where: { instanceId_labelid: { instanceId: this.id, labelid: l.id } },
            create: { instanceId: this.id, labelid: l.id, name: l.name ?? '', color: l.color ?? 0 },
            update: { name: l.name ?? '', color: l.color ?? 0 },
          });
        eventBus.publish({ instanceId: this.id, eventType: 'labels', payload: { event: label }, meta: {} });
      }),
    );
    ev.on('labels.association', (e) =>
      guard('labels.association', async () => {
        const a = e.association as { type?: string; chatId?: string; labelId?: string };
        if (a.chatId && a.labelId) {
          const chat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: this.id, chatid: a.chatId } } });
          if (chat) {
            const labels = new Set(chat.labels);
            if (e.type === 'add') labels.add(a.labelId);
            else labels.delete(a.labelId);
            await prisma.chat.update({ where: { id: chat.id }, data: { labels: [...labels] } });
          }
        }
        eventBus.publish({ instanceId: this.id, eventType: 'chat_labels', payload: { event: e }, meta: { chatid: a.chatId } });
      }),
    );

    ev.on('call', (calls) =>
      guard('call', async () => {
        for (const c of calls) {
          await saveCall(this.instance, c as never).catch((err: Error) => logger.warn({ err: err.message }, 'falha ao registrar chamada'));
          const cc = c as { isGroup?: boolean; groupJid?: string; chatId?: string; from?: string };
          eventBus.publish({ instanceId: this.id, eventType: 'call', payload: { event: c }, meta: { chatid: (cc.isGroup && cc.groupJid) || cc.chatId || cc.from } });
        }
      }),
    );

    ev.on('blocklist.update', ({ blocklist, type }) =>
      guard('blocklist', async () => {
        await prisma.chat.updateMany({ where: { instanceId: this.id, chatid: { in: blocklist } }, data: { blocked: type === 'add' } });
      }),
    );
  }

  private async publishChats(chats: Array<Record<string, unknown>>): Promise<void> {
    await upsertChatsFromSync(this.instance, chats);
    eventBus.publish({ instanceId: this.id, eventType: 'chats', payload: { event: { type: 'update', chats } }, meta: {} });
  }

  /** Opções e segredo de uma enquete gravada (para decifrar e nomear os votos). */
  private pollInfo(content: unknown): { secret?: Buffer; options: string[] } {
    const msg = deserializeWaMessage(content)?.message as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    const inner = msg?.viewOnceMessage?.message ?? msg?.viewOnceMessageV2?.message ?? msg;
    const poll = inner?.pollCreationMessage ?? inner?.pollCreationMessageV2 ?? inner?.pollCreationMessageV3;
    const raw = inner?.messageContextInfo?.messageSecret ?? msg?.messageContextInfo?.messageSecret;
    const secret = raw ? Buffer.from(raw as Uint8Array) : undefined;
    return { secret, options: ((poll?.options ?? []) as Array<{ optionName?: string }>).map((o) => o.optionName ?? '').filter(Boolean) };
  }

  /** JID de uma pessoa em todas as formas conhecidas (número e LID), para decifrar votos. */
  private async jidVariants(...jids: Array<string | null | undefined>): Promise<string[]> {
    const out = new Set<string>();
    for (const j of jids) {
      if (!j) continue;
      const n = j.replace(/:\d+(?=@)/, '');
      out.add(n);
      if (n.endsWith('@lid')) {
        const pn = await this.resolveLid(n);
        if (pn) out.add(pn);
      } else if (n.endsWith('@s.whatsapp.net')) {
        try {
          const repo = (this.sock as unknown as { signalRepository?: { lidMapping?: { getLIDForPN?: (p: string) => Promise<string | null | undefined> } } })?.signalRepository;
          const lid = await repo?.lidMapping?.getLIDForPN?.(n);
          if (lid) out.add(lid.replace(/:\d+(?=@)/, ''));
        } catch {
          /* sem mapeamento: segue com o que tem */
        }
      }
    }
    return [...out];
  }

  private async processPollUpdate(m: WAMessage): Promise<void> {
    const pu = m.message?.pollUpdateMessage;
    const pollKey = pu?.pollCreationMessageKey;
    if (!pu?.vote?.encPayload || !pu.vote.encIv || !pollKey?.id) {
      logger.warn({ instance: this.id }, 'enquete: voto chegou sem conteúdo cifrado');
      return;
    }
    const row = await findMessageRow(this.id, pollKey.id);
    if (!row) {
      logger.warn({ instance: this.id, poll: pollKey.id }, 'enquete: voto de uma enquete que não está salva (enviada antes ou apagada)');
      return;
    }
    const { secret, options } = this.pollInfo(row.content);
    const fail = async (reason: string) => {
      // Motivo visível no painel (na própria enquete) — sem depender de ler logs.
      await prisma.message.update({ where: { id: row.id }, data: { error: `enquete: ${reason}` } }).catch(() => undefined);
      eventBus.publish({ instanceId: this.id, eventType: 'messages_update', payload: { event: { id: row.id, messageid: row.messageid, chatid: row.chatid, type: 'poll_vote_error', error: reason } }, meta: { chatid: row.chatid } });
    };
    if (!secret || !options.length) {
      logger.warn({ instance: this.id, poll: row.id }, 'enquete sem segredo gravado: voto não pode ser decifrado');
      await fail('esta enquete foi salva sem a chave de votos (envie uma enquete nova)');
      return;
    }
    const me = this.sock?.user as unknown as { id?: string; lid?: string } | undefined;
    const creation = deserializeWaMessage(row.content);
    const ck = (creation?.key ?? {}) as unknown as Record<string, string | undefined>;
    // Criador: o próprio número (e LID) quando fomos nós; senão o autor. Inclui também como o
    // VOTANTE enxerga o criador (pollCreationMessageKey do voto) — com LID, pode ser outro JID.
    const pk = pollKey as unknown as Record<string, string | undefined>;
    const chatRow = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId: this.id, chatid: row.chatid } }, select: { chatid: true, chatlid: true } });
    const creators = row.fromMe
      ? await this.jidVariants(me?.id, me?.lid, pk.remoteJid, pk.participant, this.sock?.authState.creds.me?.lid)
      : await this.jidVariants(ck.participant, ck.participantAlt, ck.remoteJid, ck.remoteJidAlt, row.sender, pk.participant, pk.remoteJid);
    const k = m.key as unknown as Record<string, string | undefined>;
    const voters = m.key.fromMe
      ? await this.jidVariants(me?.id, me?.lid)
      : await this.jidVariants(k.participant, k.participantAlt, k.senderPn, k.remoteJid, k.remoteJidAlt, row.isGroup ? undefined : chatRow?.chatid, row.isGroup ? undefined : chatRow?.chatlid);
    const names = resolvePollVote({ encPayload: Buffer.from(pu.vote.encPayload), encIv: Buffer.from(pu.vote.encIv) }, secret, pollKey.id, creators, voters, options);
    if (!names) {
      // Só tipos/quantidades — nada de números de telefone no log.
      const kinds = (l: string[]) => l.map((j) => j.split('@')[1]).join(',');
      logger.warn({ instance: this.id, poll: row.id, fromMe: row.fromMe, creators: kinds(creators), voters: kinds(voters), hasLid: Boolean(me?.lid) }, 'enquete: voto não decifrou com nenhum JID conhecido');
      await fail(`voto recebido, mas não foi possível abrir (criador: ${kinds(creators) || 'nenhum'}; votante: ${kinds(voters) || 'nenhum'})`);
      return;
    }
    logger.info({ instance: this.id, poll: row.id, options: names.length }, 'enquete: voto registrado');
    // Identidade estável do votante: número quando conhecido (o mesmo voto pode vir por LID).
    const voter = voters.find((v) => v.endsWith('@s.whatsapp.net')) ?? voters[0] ?? 'desconhecido';
    if (row.error) await prisma.message.update({ where: { id: row.id }, data: { error: '' } }).catch(() => undefined);
    await this.recordPollVote(row.id, row.messageid, row.chatid, row, voter, names);
  }

  /** Voto já decifrado pelo próprio Baileys (messages.update → pollUpdates). */
  private async handlePollVote(key: WAMessageKey, pollUpdates: unknown[]): Promise<void> {
    if (!key.id) return;
    const row = await findMessageRow(this.id, key.id);
    if (!row) return;
    const { options } = this.pollInfo(row.content);
    const byHash = new Map(options.map((n) => [crypto.createHash('sha256').update(n).digest('hex'), n]));
    const me = this.sock?.user as unknown as { id?: string } | undefined;
    for (const u of pollUpdates as Array<{ pollUpdateMessageKey?: WAMessageKey; vote?: { selectedOptions?: Uint8Array[] } }>) {
      const vk = u.pollUpdateMessageKey;
      const variants = vk?.fromMe ? await this.jidVariants(me?.id) : await this.jidVariants(vk?.participant, vk?.remoteJid);
      const voter = variants.find((v) => v.endsWith('@s.whatsapp.net')) ?? variants[0];
      if (!voter) continue;
      const names = (u.vote?.selectedOptions ?? []).map((h) => byHash.get(Buffer.from(h).toString('hex'))).filter((n): n is string => Boolean(n));
      await this.recordPollVote(row.id, row.messageid, row.chatid, row, voter, names);
    }
  }

  private async recordPollVote(pollId: string, messageid: string, chatid: string, row: { fromMe: boolean; wasSentByApi: boolean; isGroup: boolean }, voter: string, names: string[]): Promise<void> {
    await prisma.pollVote.upsert({
      where: { instanceId_pollId_voter: { instanceId: this.id, pollId, voter } },
      create: { instanceId: this.id, pollId, voter, options: names },
      update: { options: names },
    });
    const all = await prisma.pollVote.findMany({ where: { instanceId: this.id, pollId } });
    const tally = new Map<string, string[]>();
    for (const v of all) for (const n of v.options) tally.set(n, [...(tally.get(n) ?? []), v.voter]);
    const votes = [...tally.entries()].map(([name, voters]) => ({ name, voters }));
    const summary = votes.map((v) => `${v.name}:${v.voters.length}`).join(', ');
    await prisma.message.update({ where: { id: pollId }, data: { vote: summary } });
    eventBus.publish({
      instanceId: this.id,
      eventType: 'messages_update',
      payload: { event: { id: pollId, messageid, chatid, type: 'poll_vote', vote: summary, votes, voter, selected: names } },
      meta: { fromMe: row.fromMe, wasSentByApi: row.wasSentByApi, isGroup: row.isGroup, messageType: 'poll', chatid },
    });
  }

  /** Para a sessão. `logout=true` desvincula o aparelho no WhatsApp e apaga credenciais. */
  async stop(logout: boolean): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.unpairedTimer);
    const sock = this.sock;
    this.sock = undefined;
    try {
      if (logout && sock) await sock.logout();
      else sock?.end(undefined);
    } catch {
      /* socket já fechado */
    }
    if (logout) await clearAuthState(this.id);
    await this.setStatus({ status: 'disconnected', qrcode: '', paircode: '', ...(logout ? { ownerJid: '' } : {}), lastDisconnect: new Date(), lastDisconnectReason: logout ? 'logout' : 'stopped' });
    this.finish();
  }

  /** Fecha o socket local sem alterar o estado no banco (shutdown do processo / perda de lock). */
  detach(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.unpairedTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = undefined;
  }

  private finish(): void {
    this.onFinished(this.id);
  }

  /**
   * Chama um método do socket que pode não existir na versão instalada do Baileys (RC).
   * Em vez de quebrar em runtime com "is not a function", responde 501 explicando.
   */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const fn = (this.sock as unknown as Record<string, unknown> | undefined)?.[method];
    if (typeof fn !== 'function') throw notImplemented(`Recurso indisponível na versão instalada do Baileys (${method})`);
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(this.sock, args)) as T;
  }
}

export type { WAMessage };
