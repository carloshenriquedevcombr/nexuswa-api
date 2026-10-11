/**
 * Resumo de mídia/conteúdo rico de uma mensagem, para o painel desenhar a bolha
 * igual ao WhatsApp (foto, vídeo, áudio, documento, botões, enquete, chamada...).
 * Módulo puro: recebe o WAMessage serializado (BufferJSON) e devolve só dados de
 * exibição — nunca chaves de mídia (mediaKey/directPath), que permitiriam baixar
 * o arquivo cifrado fora do servidor.
 */
import { contentType, extractText, toNumberTs, unwrap } from './normalizer.js';

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MediaInfo {
  kind: string;
  mimetype?: string;
  caption?: string;
  fileName?: string;
  fileLength?: number;
  seconds?: number;
  ptt?: boolean;
  gif?: boolean;
  viewOnce?: boolean;
  width?: number;
  height?: number;
  /** data:image/jpeg;base64,... (miniatura embutida na própria mensagem) */
  thumb?: string;
  latitude?: number;
  longitude?: number;
  name?: string;
  address?: string;
  contacts?: Array<{ name: string; phones: string[] }>;
  title?: string;
  body?: string;
  footer?: string;
  buttons?: string[];
  options?: string[];
  isVideo?: boolean;
  callStatus?: string;
  duration?: number;
  quoted?: { id: string; text: string; type: string; participant: string };
  forwarded?: boolean;
}

const MAX_THUMB_B64 = 60_000; // miniaturas maiores são descartadas (payload leve)

/** Aceita base64 puro, {type:'Buffer',data} (BufferJSON) ou array de bytes. */
export function toBase64(v: unknown): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  const o = v as { type?: string; data?: unknown };
  if (o.type === 'Buffer' && typeof o.data === 'string') return o.data;
  if (o.type === 'Buffer' && Array.isArray(o.data)) return Buffer.from(o.data as number[]).toString('base64');
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString('base64');
  if (typeof v === 'object' && v !== null && Object.keys(v).every((k) => /^\d+$/.test(k))) {
    return Buffer.from(Object.values(v) as number[]).toString('base64');
  }
  return undefined;
}

function thumbOf(v: unknown): string | undefined {
  const b = toBase64(v);
  if (!b || b.length > MAX_THUMB_B64 || !/^[A-Za-z0-9+/=]+$/.test(b)) return undefined;
  return `data:image/jpeg;base64,${b}`;
}

const num = (v: unknown) => {
  const n = toNumberTs(v);
  return n > 0 ? n : undefined;
};

function vcardInfo(vcard: string | undefined, fallback: string): { name: string; phones: string[] } {
  const v = String(vcard ?? '');
  const name = v.match(/^FN:(.*)$/m)?.[1]?.trim() || fallback || 'Contato';
  const phones = [...v.matchAll(/^TEL[^:]*:(.*)$/gm)].map((m) => (m[1] ?? '').trim()).filter(Boolean).slice(0, 5);
  return { name, phones };
}

function nativeFlowButtons(buttons: AnyObj[] | undefined): string[] {
  return (buttons ?? [])
    .map((b) => {
      try {
        const p = JSON.parse(b.buttonParamsJson || '{}') as AnyObj;
        return String(p.display_text || p.title || b.name || '');
      } catch {
        return String(b.name || '');
      }
    })
    .filter(Boolean)
    .slice(0, 10);
}

function headerThumb(h: AnyObj | undefined): string | undefined {
  if (!h) return undefined;
  return thumbOf(h.imageMessage?.jpegThumbnail ?? h.videoMessage?.jpegThumbnail ?? h.documentMessage?.jpegThumbnail ?? h.jpegThumbnail);
}

export function mediaInfo(content: AnyObj | null | undefined): MediaInfo | null {
  if (!content) return null;
  // Chamada sintética gravada pelo servidor (evento "call" do Baileys)
  if (content.call) {
    return { kind: 'call', isVideo: Boolean(content.call.isVideo), callStatus: String(content.call.status ?? ''), duration: num(content.call.duration) };
  }
  const message = content.message ?? content;
  const m = unwrap(message);
  const type = contentType(m);
  const x = (m[type] ?? {}) as AnyObj;
  const ci = x.contextInfo as AnyObj | undefined;

  const base: MediaInfo = { kind: 'text' };
  if (ci?.quotedMessage) {
    base.quoted = {
      id: String(ci.stanzaId ?? ''),
      text: extractText(ci.quotedMessage).slice(0, 300),
      type: contentType(ci.quotedMessage).replace(/Message$/, ''),
      participant: String(ci.participant ?? ''),
    };
  }
  if (ci?.isForwarded) base.forwarded = true;
  if (message?.viewOnceMessage || message?.viewOnceMessageV2 || x.viewOnce) base.viewOnce = true;

  switch (type) {
    case 'conversation':
    case 'extendedTextMessage':
      return { ...base, kind: 'text', ...(x.jpegThumbnail && x.matchedText ? { thumb: thumbOf(x.jpegThumbnail), title: x.title, body: x.description } : {}) };
    case 'imageMessage':
      return { ...base, kind: 'image', mimetype: x.mimetype, caption: x.caption, thumb: thumbOf(x.jpegThumbnail), width: num(x.width), height: num(x.height), fileLength: num(x.fileLength) };
    case 'videoMessage':
      return { ...base, kind: 'video', mimetype: x.mimetype, caption: x.caption, thumb: thumbOf(x.jpegThumbnail), seconds: num(x.seconds), gif: Boolean(x.gifPlayback), width: num(x.width), height: num(x.height), fileLength: num(x.fileLength) };
    case 'ptvMessage':
      return { ...base, kind: 'ptv', mimetype: x.mimetype, thumb: thumbOf(x.jpegThumbnail), seconds: num(x.seconds) };
    case 'audioMessage':
      return { ...base, kind: 'audio', mimetype: x.mimetype, seconds: num(x.seconds), ptt: Boolean(x.ptt), fileLength: num(x.fileLength) };
    case 'documentMessage':
      return { ...base, kind: 'document', mimetype: x.mimetype, fileName: x.fileName || x.title || 'documento', caption: x.caption, fileLength: num(x.fileLength), thumb: thumbOf(x.jpegThumbnail) };
    case 'stickerMessage':
      return { ...base, kind: 'sticker', mimetype: x.mimetype || 'image/webp', gif: Boolean(x.isAnimated) };
    case 'locationMessage':
    case 'liveLocationMessage':
      return { ...base, kind: 'location', latitude: Number(x.degreesLatitude), longitude: Number(x.degreesLongitude), name: x.name, address: x.address, thumb: thumbOf(x.jpegThumbnail) };
    case 'contactMessage':
      return { ...base, kind: 'contact', contacts: [vcardInfo(x.vcard, x.displayName)] };
    case 'contactsArrayMessage':
      return { ...base, kind: 'contact', contacts: (x.contacts ?? []).slice(0, 10).map((c: AnyObj) => vcardInfo(c.vcard, c.displayName)) };
    case 'interactiveMessage': {
      const cards = x.carouselMessage?.cards as AnyObj[] | undefined;
      if (cards?.length) {
        return { ...base, kind: 'interactive', body: x.body?.text, options: cards.map((c) => c.body?.text ?? '').slice(0, 10), thumb: headerThumb(cards[0]?.header), buttons: nativeFlowButtons(cards[0]?.nativeFlowMessage?.buttons) };
      }
      return { ...base, kind: 'interactive', title: x.header?.title, body: x.body?.text, footer: x.footer?.text, thumb: headerThumb(x.header), buttons: nativeFlowButtons(x.nativeFlowMessage?.buttons) };
    }
    case 'buttonsMessage':
      return { ...base, kind: 'interactive', title: x.text, body: x.contentText, footer: x.footerText, thumb: thumbOf(x.imageMessage?.jpegThumbnail), buttons: (x.buttons ?? []).map((b: AnyObj) => b.buttonText?.displayText).filter(Boolean) };
    case 'templateMessage': {
      const t = (x.hydratedTemplate ?? x.hydratedFourRowTemplate ?? x.fourRowTemplate ?? {}) as AnyObj;
      return {
        ...base,
        kind: 'interactive',
        title: t.hydratedTitleText,
        body: t.hydratedContentText ?? t.content?.namespace,
        footer: t.hydratedFooterText,
        thumb: thumbOf(t.imageMessage?.jpegThumbnail),
        buttons: (t.hydratedButtons ?? []).map((b: AnyObj) => b.quickReplyButton?.displayText ?? b.urlButton?.displayText ?? b.callButton?.displayText).filter(Boolean),
      };
    }
    case 'listMessage':
      return { ...base, kind: 'interactive', title: x.title, body: x.description, footer: x.footerText, buttons: [x.buttonText || 'Ver opções'], options: (x.sections ?? []).flatMap((s: AnyObj) => (s.rows ?? []).map((r: AnyObj) => r.title)).slice(0, 20) };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { ...base, kind: 'poll', title: x.name, options: (x.options ?? []).map((o: AnyObj) => o.optionName).slice(0, 12) };
    case 'eventMessage':
      return { ...base, kind: 'event', title: x.name, body: x.description, duration: num(x.startTime) };
    case 'callLogMesssage':
    case 'callLogMessage':
      return { ...base, kind: 'call', isVideo: Boolean(x.isVideo), callStatus: String(x.callOutcome ?? ''), duration: num(x.durationSecs) };
    case 'buttonsResponseMessage':
    case 'listResponseMessage':
    case 'templateButtonReplyMessage':
    case 'interactiveResponseMessage':
      return { ...base, kind: 'reply' };
    default:
      return base.quoted || base.forwarded ? base : type ? { kind: type.replace(/Message$/, '') } : null;
  }
}
