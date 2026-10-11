/**
 * Conversão de mensagens Baileys (WAMessage) para o formato de dados do NexusWA.
 * Módulo puro (sem Baileys/DB) para ser testável isoladamente.
 */

type AnyObj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
];

const IGNORED_KEYS = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);

/** Remove envelopes (efêmera, visualização única...) até chegar ao conteúdo real. */
export function unwrap(message: AnyObj | null | undefined): AnyObj {
  let m = message ?? {};
  for (let depth = 0; depth < 5; depth++) {
    const w = WRAPPERS.find((k) => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m;
}

export function contentType(message: AnyObj | null | undefined): string {
  const m = unwrap(message);
  return Object.keys(m).find((k) => !IGNORED_KEYS.has(k) && m[k] != null) ?? '';
}

/** Tipo simplificado (usado em addUrlTypesMessages e filtros). */
export function simpleType(rawType: string): string {
  const map: Record<string, string> = {
    conversation: 'text',
    extendedTextMessage: 'text',
    imageMessage: 'image',
    videoMessage: 'video',
    ptvMessage: 'ptv',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker',
    locationMessage: 'location',
    liveLocationMessage: 'location',
    contactMessage: 'contact',
    contactsArrayMessage: 'contact',
    pollCreationMessage: 'poll',
    pollCreationMessageV2: 'poll',
    pollCreationMessageV3: 'poll',
    pollUpdateMessage: 'poll_vote',
    reactionMessage: 'reaction',
    buttonsResponseMessage: 'button_reply',
    listResponseMessage: 'list_reply',
    templateButtonReplyMessage: 'button_reply',
    interactiveResponseMessage: 'interactive_reply',
    interactiveMessage: 'interactive',
    buttonsMessage: 'buttons',
    listMessage: 'list',
    protocolMessage: 'protocol',
    eventMessage: 'event',
    orderMessage: 'order',
  };
  return map[rawType] ?? (rawType.replace(/Message$/, '') || 'unknown');
}

export function extractText(message: AnyObj | null | undefined): string {
  const m = unwrap(message);
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    safeJson(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson)?.id ??
    m.interactiveResponseMessage?.body?.text ??
    m.interactiveMessage?.body?.text ??
    m.buttonsMessage?.contentText ??
    m.listMessage?.description ??
    m.pollCreationMessage?.name ??
    m.pollCreationMessageV2?.name ??
    m.pollCreationMessageV3?.name ??
    m.reactionMessage?.text ??
    m.locationMessage?.name ??
    m.contactMessage?.displayName ??
    m.eventMessage?.name ??
    ''
  );
}

/** ID da opção escolhida em respostas de botão/lista (útil para chatbots). */
export function extractSelectedId(message: AnyObj | null | undefined): string {
  const m = unwrap(message);
  return (
    m.buttonsResponseMessage?.selectedButtonId ??
    m.listResponseMessage?.singleSelectReply?.selectedRowId ??
    m.templateButtonReplyMessage?.selectedId ??
    safeJson(m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson)?.id ??
    ''
  );
}

export function contextInfo(message: AnyObj | null | undefined): AnyObj | undefined {
  const m = unwrap(message);
  const type = contentType(m);
  return type ? m[type]?.contextInfo : undefined;
}

function safeJson(v: unknown): AnyObj | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    return JSON.parse(v) as AnyObj;
  } catch {
    return undefined;
  }
}

/**
 * Horário de uma mensagem enviada por este servidor, sem ficar antes da última da conversa.
 * Por quê: o envio usa o relógio da VPS e o recebido usa o do WhatsApp; com a VPS alguns
 * segundos atrasada, a resposta da atendente aparecia ACIMA da pergunta do cliente.
 * O ajuste é limitado (maxShiftMs) para não arrastar a mensagem por um horário futuro absurdo.
 */
export function keepAfterLast(tsMs: number, lastMs: number, maxShiftMs = 5 * 60_000): number {
  return tsMs <= lastMs && lastMs - tsMs <= maxShiftMs ? lastMs + 1 : tsMs;
}

/**
 * Host para baixar a mídia quando o campo `url` da mensagem não é um endereço de mídia de verdade.
 * Por quê: o Baileys monta o download com o host tirado de `url`; figurinhas chegam com `url` de
 * marcador (só o host, sem caminho), e o download ia para um servidor que não entrega mídia.
 */
export const DEFAULT_MEDIA_HOST = 'mmg.whatsapp.net';
export function mediaDownloadHost(media: { url?: string | null; directPath?: string | null } | null | undefined): string | undefined {
  if (!media?.directPath) return undefined;
  try {
    const u = new URL(media.url ?? '');
    return u.pathname.length > 1 ? undefined : DEFAULT_MEDIA_HOST;
  } catch {
    return DEFAULT_MEDIA_HOST;
  }
}

/** protocolMessage (apagar/editar), inclusive quando vem embrulhada em editedMessage (edição feita no celular). */
export function protocolOf(message: AnyObj | null | undefined): AnyObj | undefined {
  return message?.protocolMessage ?? message?.editedMessage?.message?.protocolMessage ?? undefined;
}

export function toNumberTs(ts: unknown): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts === 'string') return Number(ts) || 0;
  const low = (ts as { low?: number; toNumber?: () => number });
  if (typeof low.toNumber === 'function') return low.toNumber();
  return Number(low.low ?? 0);
}

export interface NormalizedMessage {
  messageid: string;
  chatid: string;
  chatlid: string;
  sender: string;
  senderName: string;
  fromMe: boolean;
  isGroup: boolean;
  messageType: string;
  simpleType: string;
  text: string;
  quoted: string;
  reaction: string;
  selectedId: string;
  messageTimestampMs: number;
  isMedia: boolean;
}

const MEDIA = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage']);

export function normalize(msg: AnyObj): NormalizedMessage {
  const key = msg.key ?? {};
  // Baileys 7 endereça conversas por LID (@lid). Quando o número real vem junto
  // (remoteJidAlt/senderPn), usamos o número como chatid — assim chats criados pela API
  // (que usam @s.whatsapp.net) e mensagens recebidas caem no MESMO registro.
  const rawJid: string = key.remoteJid ?? '';
  const alt: string | undefined = [key.remoteJidAlt, key.senderPn].find((j: unknown) => typeof j === 'string' && (j as string).endsWith('@s.whatsapp.net'));
  const chatid: string = rawJid.endsWith('@lid') && alt ? alt : rawJid;
  const chatlid: string = rawJid.endsWith('@lid') ? rawJid : '';
  const isGroup = chatid.endsWith('@g.us');
  const type = contentType(msg.message);
  const ci = contextInfo(msg.message);
  const m = unwrap(msg.message);
  return {
    messageid: key.id ?? '',
    chatid,
    chatlid,
    sender: (isGroup ? key.participant : key.fromMe ? '' : chatid) ?? '',
    senderName: msg.pushName ?? '',
    fromMe: Boolean(key.fromMe),
    isGroup,
    messageType: type,
    simpleType: simpleType(type),
    text: extractText(msg.message),
    quoted: ci?.stanzaId ?? (type === 'reactionMessage' ? (m.reactionMessage?.key?.id ?? '') : ''),
    reaction: type === 'reactionMessage' ? (m.reactionMessage?.text ?? '') : '',
    selectedId: extractSelectedId(msg.message),
    messageTimestampMs: toNumberTs(msg.messageTimestamp) * 1000,
    isMedia: MEDIA.has(type),
  };
}

/** Ordem de status — atualizações fora de ordem nunca fazem a mensagem "regredir". */
const STATUS_RANK: Record<string, number> = {
  Queued: 0,
  Pending: 1,
  Sent: 2,
  Delivered: 3,
  Read: 4,
  Played: 5,
  Failed: 6,
  Expired: 6,
  Canceled: 6,
  Deleted: 7,
};

export function shouldUpdateStatus(current: string, next: string): boolean {
  return (STATUS_RANK[next] ?? -1) > (STATUS_RANK[current] ?? -1);
}

/** Mapeia o enum numérico WebMessageInfo.Status do Baileys. */
export function statusFromBaileys(code: number | null | undefined): string {
  switch (code) {
    case 0:
      return 'Failed';
    case 1:
      return 'Pending';
    case 2:
      return 'Sent';
    case 3:
      return 'Delivered';
    case 4:
      return 'Read';
    case 5:
      return 'Played';
    default:
      return '';
  }
}
