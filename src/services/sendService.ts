import crypto from 'node:crypto';
import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  type AnyMessageContent,
  type WAMessage,
} from '@whiskeysockets/baileys';
import type { Instance } from '@prisma/client';
import { HttpError, badRequest } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { logger } from '../lib/logger.js';
import { messagesSent } from '../lib/metrics.js';
import { prisma } from '../lib/prisma.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import {
  ChoiceError,
  applyPlaceholders,
  fieldSlug,
  parseButtons,
  parseCarouselChoices,
  parseList,
  parsePoll,
  toNativeFlowButton,
  type ParsedButton,
} from '../whatsapp/choices.js';
import { presentMessage } from '../whatsapp/presenters.js';
import type { InstanceSession } from '../whatsapp/session.js';
import { loadWaMessage, registerApiSend, rowId, saveMessages, type ApiSendMeta } from '../whatsapp/store.js';
import { buildVCard } from '../whatsapp/vcard.js';
import { buildLinkPreview } from './linkPreview.js';
import { loadMedia, makeThumbnail, toSticker, toVoiceNote } from './media.js';
import type { SendKind } from './sendSchemas.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type P = Record<string, any>;

type Built =
  | { mode: 'plain'; content: AnyMessageContent }
  | { mode: 'interactive'; message: Record<string, unknown> };

/** Nó "biz" exigido pelo WhatsApp para renderizar mensagens nativeFlow (botões/lista/carrossel). */
const BIZ_NODES = [
  {
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }],
  },
];

/** ID de mensagem no formato do WhatsApp Web (3EB0 + hex). Gerado antes do envio para correlação. */
export function newMessageId(): string {
  return `3EB0${crypto.randomBytes(9).toString('hex').toUpperCase()}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Variáveis "de relógio" (saudação, data, hora) no fuso da equipe — o painel oferece
 * como botões ("👋 Saudação") para quem não sabe o que é {{variavel}}.
 */
export function timeVars(now = new Date(), tz = process.env.APP_TIMEZONE || 'America/Sao_Paulo'): Record<string, string> {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return {
    saudacao: hour < 5 ? 'Boa noite' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite',
    data: new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(now),
    hora: new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(now),
    dia_semana: new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long' }).format(now),
  };
}

async function placeholderVars(instanceId: string, jid: string, senderName = '', fieldsMap: Record<string, string> = {}): Promise<Record<string, string>> {
  const base = { ...timeVars(), atendente: senderName };
  const chat = await prisma.chat.findUnique({ where: { instanceId_chatid: { instanceId, chatid: jid } } });
  if (!chat) return base;
  const name = chat.leadName || chat.contactName || chat.pushName || chat.name;
  const vars: Record<string, string> = {
    ...base,
    name,
    first_name: name.split(' ')[0] ?? '',
    wa_name: chat.pushName,
    wa_contactName: chat.contactName,
    lead_name: chat.leadName,
    lead_fullName: chat.leadFullName,
    lead_email: chat.leadEmail,
    lead_personalid: chat.leadPersonalId,
    lead_status: chat.leadStatus,
  };
  for (const [k, v] of Object.entries((chat.leadFields ?? {}) as Record<string, string>)) vars[k] = String(v ?? '');
  // Campos personalizados também pelo NOME dado no painel: {{cpf}}, {{numero_da_conta}}.
  for (const [key, label] of Object.entries(fieldsMap)) {
    const slug = label ? fieldSlug(label) : '';
    if (slug && !(slug in vars)) vars[slug] = vars[key] ?? '';
  }
  return vars;
}

function interactive(body: string, footer: string | undefined, nativeFlow: Record<string, unknown>, header?: Record<string, unknown>) {
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          body: { text: body },
          ...(footer ? { footer: { text: footer } } : {}),
          header: header ?? { title: '', subtitle: '', hasMediaAttachment: false },
          nativeFlowMessage: nativeFlow,
        },
      },
    },
  };
}

async function mediaHeader(session: InstanceSession, url: string, kind: 'image' | 'video' | 'document', fileName?: string) {
  const media = await loadMedia(url, undefined, session.id);
  const prepared = await prepareWAMessageMedia(
    kind === 'document' ? { document: media.buffer, mimetype: media.mimetype, fileName: fileName ?? media.fileName ?? 'arquivo' } : ({ [kind]: media.buffer } as any),
    { upload: session.sock!.waUploadToServer },
  );
  return { title: '', hasMediaAttachment: true, ...prepared };
}

async function buildContent(session: InstanceSession, kind: SendKind, p: P, vars: Record<string, string>): Promise<Built> {
  const t = (s?: string) => (s ? applyPlaceholders(s, vars) : '');

  switch (kind) {
    case 'text': {
      const text = t(p.text);
      if (p.linkPreview || p.linkPreviewTitle || p.linkPreviewDescription || p.linkPreviewImage) {
        const linkPreview = await buildLinkPreview({ text, title: p.linkPreviewTitle, description: p.linkPreviewDescription, image: p.linkPreviewImage });
        if (linkPreview) return { mode: 'plain', content: { text, linkPreview } as any };
      }
      return { mode: 'plain', content: { text } };
    }

    case 'media': {
      let media = await loadMedia(p.file, p.mimetype, session.id);
      const caption = t(p.text) || undefined;
      const thumb = p.thumbnail ? await makeThumbnail((await loadMedia(p.thumbnail, undefined, session.id)).buffer) : undefined;
      const viewOnce = p.viewOnce && ['image', 'video', 'videoplay', 'ptv', 'audio', 'myaudio', 'ptt'].includes(p.type) ? { viewOnce: true } : {};
      switch (p.type) {
        case 'image':
          return { mode: 'plain', content: { image: media.buffer, caption, mimetype: media.mimetype, ...(thumb ? { jpegThumbnail: thumb.toString('base64') } : {}), ...viewOnce } as any };
        case 'video':
        case 'videoplay':
          return { mode: 'plain', content: { video: media.buffer, caption, mimetype: 'video/mp4', gifPlayback: p.type === 'videoplay', ...(thumb ? { jpegThumbnail: thumb.toString('base64') } : {}), ...viewOnce } as any };
        case 'ptv':
          return { mode: 'plain', content: { video: media.buffer, ptv: true, mimetype: 'video/mp4', ...viewOnce } as any };
        case 'document':
          return { mode: 'plain', content: { document: media.buffer, mimetype: media.mimetype, fileName: p.docName || media.fileName || 'arquivo', caption, ...(thumb ? { jpegThumbnail: thumb.toString('base64') } : {}) } as any };
        case 'audio':
          return { mode: 'plain', content: { audio: media.buffer, mimetype: media.mimetype.startsWith('audio/') ? media.mimetype : 'audio/mpeg', ...viewOnce } as any };
        case 'myaudio':
        case 'ptt':
          media = await toVoiceNote(media);
          return { mode: 'plain', content: { audio: media.buffer, mimetype: media.mimetype, ptt: true, ...viewOnce } as any };
        case 'sticker':
          media = await toSticker(media);
          return { mode: 'plain', content: { sticker: media.buffer } as any };
        default:
          throw badRequest('Tipo de mídia inválido');
      }
    }

    case 'contact':
      return { mode: 'plain', content: { contacts: { displayName: p.fullName, contacts: [{ vcard: buildVCard(p as any) }] } } };

    case 'location':
      return { mode: 'plain', content: { location: { degreesLatitude: p.latitude, degreesLongitude: p.longitude, name: p.name, address: p.address } } as any };

    case 'menu': {
      const text = t(p.text);
      try {
        if (p.type === 'poll') {
          return { mode: 'plain', content: { poll: { name: text, values: parsePoll(p.choices), selectableCount: p.selectableCount ?? 1 } } };
        }
        if (p.type === 'button_legacy') {
          const buttons = parseButtons(p.choices).slice(0, 3);
          return {
            mode: 'interactive',
            message: {
              buttonsMessage: {
                contentText: text,
                footerText: p.footerText ?? '',
                headerType: 1,
                buttons: buttons.map((b) => ({ buttonId: b.value, buttonText: { displayText: b.text }, type: 1 })),
              },
            },
          };
        }
        if (p.type === 'button') {
          const buttons = parseButtons(p.choices);
          const header = p.imageButton ? await mediaHeader(session, p.imageButton, 'image') : undefined;
          return { mode: 'interactive', message: interactive(text, p.footerText, { buttons: buttons.map(toNativeFlowButton), messageParamsJson: '' }, header) };
        }
        if (p.type === 'list') {
          const sections = parseList(p.choices);
          return {
            mode: 'interactive',
            message: interactive(text, p.footerText, {
              buttons: [{ name: 'single_select', buttonParamsJson: JSON.stringify({ title: p.listButton || 'Ver opções', sections }) }],
              messageParamsJson: '',
            }),
          };
        }
        // carousel via mini-sintaxe de choices
        const cards = parseCarouselChoices(p.choices);
        return buildCarousel(session, text, cards.map((c) => ({ text: c.text, image: c.image, buttons: c.buttons })));
      } catch (err) {
        if (err instanceof ChoiceError) throw badRequest(err.message);
        throw err;
      }
    }

    case 'carousel': {
      const cards = (p.carousel as P[]).map((c) => ({
        text: t(c.text),
        image: c.image,
        video: c.video,
        document: c.document,
        filename: c.filename,
        buttons: (c.buttons as P[]).map<ParsedButton>((b) => ({
          kind: b.type === 'URL' ? 'url' : b.type === 'CALL' ? 'call' : b.type === 'COPY' ? 'copy' : 'reply',
          text: b.text,
          value: b.id,
        })),
      }));
      return buildCarousel(session, t(p.text), cards);
    }

    case 'location-button':
      return {
        mode: 'interactive',
        message: interactive(t(p.text), undefined, { buttons: [{ name: 'send_location', buttonParamsJson: '{}' }], messageParamsJson: '' }),
      };

    case 'pix-button': {
      const params = {
        currency: 'BRL',
        total_amount: { value: 0, offset: 100 },
        reference_id: crypto.randomBytes(5).toString('hex').toUpperCase(),
        type: 'physical-goods',
        order: { status: 'pending', subtotal: { value: 0, offset: 100 }, order_type: 'ORDER', items: [] },
        payment_settings: [{ type: 'pix_static_code', pix_static_code: { merchant_name: p.pixName || 'Pix', key: p.pixKey, key_type: p.pixType } }],
        share_payment_status: false,
      };
      return { mode: 'interactive', message: interactive(' ', undefined, { buttons: [{ name: 'payment_info', buttonParamsJson: JSON.stringify(params) }], messageParamsJson: '' }) };
    }

    case 'request-payment': {
      if (p.orderMessageId && p.amount == null) {
        throw new HttpError(501, 'Cobrança vinculada a orderMessageId não é suportada nesta versão; informe amount', 'not_supported');
      }
      const value = Math.round(Number(p.amount) * 100);
      const settings: P[] = [];
      if (p.pixKey) settings.push({ type: 'pix_static_code', pix_static_code: { merchant_name: p.pixName || session.instance.profileName || 'Pix', key: p.pixKey, key_type: p.pixType } });
      if (p.boletoCode) settings.push({ type: 'boleto', boleto: { digitable_line: p.boletoCode } });
      if (p.paymentLink) settings.push({ type: 'payment_link', payment_link: { uri: p.paymentLink } });
      const params = {
        currency: 'BRL',
        total_amount: { value, offset: 100 },
        reference_id: (p.invoiceNumber || crypto.randomBytes(5).toString('hex')).toUpperCase(),
        type: 'physical-goods',
        order: {
          status: 'pending',
          subtotal: { value, offset: 100 },
          order_type: 'ORDER',
          items: [{ retailer_id: 'item-1', name: p.itemName || p.title || 'Pedido', amount: { value, offset: 100 }, quantity: 1 }],
        },
        payment_settings: settings,
        share_payment_status: true,
      };
      const header = p.fileUrl ? await mediaHeader(session, p.fileUrl, 'document', p.fileName) : { title: p.title ?? '', hasMediaAttachment: false };
      return {
        mode: 'interactive',
        message: interactive(t(p.text) || p.title || 'Pagamento', p.footer, { buttons: [{ name: 'review_and_pay', buttonParamsJson: JSON.stringify(params) }], messageParamsJson: '' }, header),
      };
    }

    case 'event': {
      const ms = (v: number) => (v < 1e12 ? v * 1000 : v);
      if (p.endTime && ms(p.endTime) < ms(p.startTime)) throw badRequest('endTime não pode ser anterior a startTime');
      return {
        mode: 'plain',
        content: {
          event: {
            name: p.name,
            description: p.description,
            startDate: new Date(ms(p.startTime)),
            ...(p.endTime ? { endDate: new Date(ms(p.endTime)) } : {}),
            ...(p.location ? { location: { name: p.location.name, address: p.location.address, degreesLatitude: p.location.latitude ?? 0, degreesLongitude: p.location.longitude ?? 0 } } : {}),
            ...(p.isScheduleCall ? { call: 'video' } : {}),
            ...(p.joinLink ? { joinLink: p.joinLink } : {}),
            extraGuestsAllowed: Boolean(p.extraGuestsAllowed),
            isCancelled: Boolean(p.isCanceled),
          },
        } as any,
      };
    }
    default:
      throw badRequest('Tipo de envio desconhecido');
  }
}

async function buildCarousel(
  session: InstanceSession,
  text: string,
  cards: Array<{ text: string; image?: string; video?: string; document?: string; filename?: string; buttons: ParsedButton[] }>,
): Promise<Built> {
  const built: Array<Record<string, unknown>> = [];
  for (const c of cards) {
    const header = c.image
      ? await mediaHeader(session, c.image, 'image')
      : c.video
        ? await mediaHeader(session, c.video, 'video')
        : c.document
          ? await mediaHeader(session, c.document, 'document', c.filename)
          : { title: '', hasMediaAttachment: false };
    built.push({ header, body: { text: c.text }, nativeFlowMessage: { buttons: c.buttons.map(toNativeFlowButton), messageParamsJson: '' } });
  }
  return {
    mode: 'interactive',
    message: {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: { body: { text: text || ' ' }, carouselMessage: { cards: built, messageVersion: 1 } },
        },
      },
    },
  };
}

export interface SendResult {
  message: ReturnType<typeof presentMessage> & Record<string, unknown>;
  waMessage?: WAMessage;
}

/**
 * Executa um envio (usado por /send/*, fila async e campanhas — Single Responsibility:
 * a regra de "como enviar" existe em um só lugar).
 */
export async function executeSend(instance: Instance, kind: SendKind, p: P, meta: ApiSendMeta & { messageId?: string }): Promise<SendResult> {
  const session = await SessionManager.requireConnected(instance);
  const sock = session.sock!;
  const jid = toJid(p.number);
  const vars = await placeholderVars(instance.id, jid, meta.senderName, (instance.fieldsMap ?? {}) as Record<string, string>);
  const built = await buildContent(session, kind, p, vars);

  const quoted = p.replyid ? (await loadWaMessage(instance.id, p.replyid)).msg : undefined;
  const mentions = p.mentions
    ? String(p.mentions)
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean)
        .map((m) => toJid(m))
    : undefined;

  if (p.delay && p.delay > 0) {
    const presence = kind === 'media' && ['ptt', 'myaudio', 'audio'].includes(p.type) ? 'recording' : 'composing';
    await sock.presenceSubscribe(jid).catch(() => undefined);
    await sock.sendPresenceUpdate(presence, jid).catch(() => undefined);
    await sleep(Math.min(p.delay, 60_000));
    await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
  }

  const messageId = meta.messageId ?? newMessageId();
  registerApiSend(messageId, meta);
  let wa: WAMessage | undefined;
  try {
    if (built.mode === 'plain') {
      const content = { ...(built.content as P) };
      if (mentions?.length) content.mentions = mentions;
      if (p.forward) content.contextInfo = { ...(content.contextInfo ?? {}), isForwarded: true, forwardingScore: 1 };
      wa = await sock.sendMessage(jid, content as AnyMessageContent, { quoted, messageId } as any);
    } else {
      const msg = generateWAMessageFromContent(jid, built.message as any, { userJid: sock.user!.id, quoted, messageId } as any);
      await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id!, additionalNodes: BIZ_NODES as any });
      wa = msg;
    }
    messagesSent.inc({ type: kind, result: 'ok' });
  } catch (err) {
    messagesSent.inc({ type: kind, result: 'error' });
    logger.warn({ instance: instance.id, kind, err: (err as Error).message }, 'falha no envio');
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `Falha ao enviar pelo WhatsApp: ${(err as Error).message.slice(0, 200)}`, 'send_failed');
  }

  // A partir daqui a mensagem JÁ FOI ENVIADA: nenhuma falha pode virar erro para o cliente,
  // senão ele (ou a fila) repetiria o envio e o destinatário receberia duplicado.
  try {
    if (wa) await saveMessages(session.instance, [wa], { source: 'realtime', notify: false });
  } catch (err) {
    logger.error({ instance: instance.id, err: (err as Error).message }, 'mensagem enviada, mas falhou ao persistir');
  }

  if (p.readchat || p.readmessages) {
   try {
    const unread = await prisma.message.findMany({
      where: { instanceId: instance.id, chatid: jid, fromMe: false },
      orderBy: { messageTimestamp: 'desc' },
      take: 20,
      select: { messageid: true, sender: true },
    });
    await sock
      .readMessages(unread.map((m) => ({ remoteJid: jid, id: m.messageid, participant: m.sender || undefined, fromMe: false })))
      .catch(() => undefined);
    await prisma.chat.updateMany({ where: { instanceId: instance.id, chatid: jid }, data: { unreadCount: 0 } });
   } catch (err) {
    logger.warn({ instance: instance.id, err: (err as Error).message }, 'falha ao marcar como lido após envio');
   }
  }

  const row = await prisma.message.findUnique({ where: { id: rowId(session.instance.connectedPhone, messageId) } }).catch(() => null);
  const presented = row ? presentMessage(row, session.instance.connectedPhone) : ({ messageid: messageId, chatid: jid, status: 'Sent' } as any);
  return { message: { ...presented, content: wa?.message ?? null }, waMessage: wa };
}
