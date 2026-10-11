import { EventEmitter } from 'node:events';

/** Tipos de evento idênticos aos da uazapi (campo `events` do webhook). */
export const EVENT_TYPES = [
  'connection',
  'history',
  'messages',
  'messages_update',
  'newsletter_messages',
  'call',
  'contacts',
  'presence',
  'groups',
  'labels',
  'chats',
  'chat_labels',
  'sender',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EXCLUDE_FILTERS = ['wasSentByApi', 'wasNotSentByApi', 'fromMeYes', 'fromMeNo', 'isGroupYes', 'isGroupNo'] as const;
export type ExcludeFilter = (typeof EXCLUDE_FILTERS)[number];

export interface EventMeta {
  messageType?: string;
  fromMe?: boolean;
  wasSentByApi?: boolean;
  isGroup?: boolean;
  /** Chat do evento (número@s.whatsapp.net, grupo@g.us) — usado pelo filtro onlyChats. */
  chatid?: string;
  chatlid?: string;
}

export interface WaEvent {
  instanceId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  meta: EventMeta;
  at: number;
}

/**
 * Barramento interno (Observer). A sessão Baileys publica; webhook e SSE consomem.
 * Desacopla a camada WhatsApp da camada de entrega — adicionar um novo consumidor
 * (ex.: Kafka, Chatwoot) não exige tocar no código da sessão.
 */
class Bus extends EventEmitter {
  publish(e: Omit<WaEvent, 'at'>): void {
    this.emit('event', { ...e, at: Date.now() } satisfies WaEvent);
  }
}

export const eventBus = new Bus();
eventBus.setMaxListeners(50);

/**
 * Regra `excludeMessages` da uazapi: a entrega é SUPRIMIDA se a mensagem
 * casar com qualquer filtro listado. Só se aplica a eventos com contexto de mensagem.
 */
export function isExcluded(meta: EventMeta, exclude: readonly string[]): boolean {
  if (!exclude.length) return false;
  const checks: Record<ExcludeFilter, boolean | undefined> = {
    wasSentByApi: meta.wasSentByApi === true,
    wasNotSentByApi: meta.wasSentByApi === false,
    fromMeYes: meta.fromMe === true,
    fromMeNo: meta.fromMe === false,
    isGroupYes: meta.isGroup === true,
    isGroupNo: meta.isGroup === false,
  };
  return exclude.some((f) => checks[f as ExcludeFilter] === true);
}

/**
 * Chave de comparação de chat. Números brasileiros existem com e sem o 9º dígito
 * no WhatsApp (contas antigas usam 8 dígitos no JID), então os dois viram a mesma
 * chave; sem isso, "5519999998888" nunca casaria com o JID "551999998888".
 */
export function chatKey(jid: string): string {
  const [user = '', server = ''] = jid.toLowerCase().split('@');
  if (server === 'g.us' || server === 'newsletter' || server === 'lid') return `${user}@${server}`;
  let d = user.split(':')[0]!.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') d = d.slice(0, 4) + d.slice(5);
  return d;
}

/** Eventos que pertencem a um chat específico (os únicos afetados por onlyChats). */
export const CHAT_SCOPED_EVENTS = new Set(['messages', 'messages_update', 'newsletter_messages', 'presence', 'call', 'chat_labels']);

/**
 * Filtro onlyChats: com lista preenchida, um evento de chat só passa se o chat
 * estiver na lista. Evento de chat SEM chatid conhecido é bloqueado (na dúvida, não
 * vaza conversa de quem não está no filtro). Eventos gerais (connection etc.) passam.
 */
export function chatAllowed(eventType: string, meta: EventMeta, onlyChats: readonly string[]): boolean {
  if (!onlyChats.length || !CHAT_SCOPED_EVENTS.has(eventType)) return true;
  const keys = [meta.chatid, meta.chatlid].filter((v): v is string => Boolean(v)).map(chatKey);
  if (!keys.length) return false;
  const allowed = new Set(onlyChats.map(chatKey));
  return keys.some((k) => allowed.has(k));
}

/** Monta a URL final conforme addUrlEvents / addUrlTypesMessages (segmentos de caminho). */
export function buildWebhookUrl(base: string, eventType: string, messageType: string | undefined, opts: { addUrlEvents: boolean; addUrlTypesMessages: boolean }): string {
  const url = new URL(base);
  const segs: string[] = [];
  if (opts.addUrlEvents) segs.push(eventType);
  if (opts.addUrlTypesMessages && messageType) segs.push(messageType);
  if (segs.length) url.pathname = `${url.pathname.replace(/\/+$/, '')}/${segs.map(encodeURIComponent).join('/')}`;
  return url.toString();
}
