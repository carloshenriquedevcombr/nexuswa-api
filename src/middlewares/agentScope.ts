import type { Request } from 'express';
import { forbidden, notFound } from '../lib/errors.js';
import { InvalidNumberError, toJid } from '../lib/jid.js';
import { prisma } from '../lib/prisma.js';
import { findMessageRow } from '../whatsapp/store.js';

/**
 * Autorização do ATENDENTE (papel `agent`).
 *
 * Um atendente usa o número de outra pessoa, então o acesso é por LISTA BRANCA:
 * só as rotas abaixo existem para ele, e cada uma confere que a conversa envolvida
 * está atribuída a ele. Tudo o mais (conectar/desconectar, token, webhooks,
 * campanhas, grupos, contatos, apagar...) responde 403.
 *
 * Por quê checar aqui e não em cada rota: um único ponto de decisão — uma rota nova
 * fica automaticamente PROIBIDA para atendentes até ser liberada de propósito.
 */

type Check = (req: Request, instanceId: string, userId: string) => Promise<void>;

const noCheck: Check = async () => undefined;

/** A conversa (pelo JID ou LID) precisa estar atribuída a este atendente. */
export async function assertAssigned(instanceId: string, userId: string, rawChat: unknown): Promise<string> {
  if (typeof rawChat !== 'string' || !rawChat.trim()) throw forbidden('Informe a conversa');
  let jid: string;
  try {
    jid = toJid(rawChat);
  } catch (err) {
    if (err instanceof InvalidNumberError) throw forbidden('Conversa inválida');
    throw err;
  }
  const chat = await prisma.chat.findFirst({
    where: { instanceId, leadAssignedAttendantId: userId, locked: false, OR: [{ chatid: jid }, { chatlid: jid }] },
    select: { chatid: true },
  });
  // 404 e não 403: não confirma a existência de conversas de outros atendentes.
  if (!chat) throw notFound('Conversa não encontrada');
  return chat.chatid;
}

/** Mensagem citada/encaminhada precisa ser da MESMA conversa (senão vazaria conteúdo de outra). */
async function assertMessageInChat(instanceId: string, chatid: string, messageId: unknown): Promise<void> {
  if (messageId === undefined || messageId === null || messageId === '') return;
  const row = await findMessageRow(instanceId, String(messageId));
  if (!row || row.chatid !== chatid) throw notFound('Mensagem não encontrada');
}

/** Ações sobre UMA mensagem (reagir, apagar): a mensagem precisa ser de conversa dele. */
const messageCheck: Check = async (req, instanceId, userId) => {
  const id = String(((req.body ?? {}) as Record<string, unknown>).id ?? '');
  const row = id ? await findMessageRow(instanceId, id) : null;
  if (!row) throw notFound('Mensagem não encontrada');
  await assertAssigned(instanceId, userId, row.chatid);
};

const sendCheck: Check = async (req, instanceId, userId) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const chatid = await assertAssigned(instanceId, userId, body.number);
  await assertMessageInChat(instanceId, chatid, body.replyid);
  // Normaliza o destino para o chat atribuído (evita variações do mesmo número).
  body.number = chatid;
};

const RULES: Record<string, Check> = {
  'POST /chat/find': noCheck, // a rota filtra por leadAssignedAttendantId = atendente
  'POST /message/find': async (req, instanceId, userId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const chatid = await assertAssigned(instanceId, userId, body.chatid);
    // Força a consulta a ficar dentro da conversa atribuída (o `id` sozinho buscaria em qualquer chat).
    body.chatid = chatid;
  },
  'POST /message/download': async (req, instanceId, userId) => {
    const id = String(((req.body ?? {}) as Record<string, unknown>).id ?? '');
    // Mesma resolução que a rota usa (findMessageRow): a mensagem checada é a que será servida.
    const row = id ? await findMessageRow(instanceId, id) : null;
    if (!row) throw notFound('Mensagem não encontrada');
    await assertAssigned(instanceId, userId, row.chatid);
  },
  'POST /send/text': sendCheck,
  'POST /send/media': sendCheck,
  'POST /send/menu': sendCheck, // enquete, botões, lista
  'POST /send/location': sendCheck,
  'POST /send/contact': sendCheck,
  'GET /lists': noCheck, // só os nomes das listas (para mostrar Favoritas)
  // Atendente só marca/desmarca FAVORITA nas conversas dele (listas da equipe são do dono).
  'POST /chat/lists': async (req, instanceId, userId) => {
    const body = (req.body ?? {}) as { number?: unknown; add?: unknown; remove?: unknown };
    const only = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => x === 'favoritas'));
    if (!only(body.add) || !only(body.remove)) throw forbidden('Atendentes só usam a lista Favoritas');
    await assertAssigned(instanceId, userId, body.number);
  },
  'POST /chat/read': async (req, instanceId, userId) => {
    await assertAssigned(instanceId, userId, ((req.body ?? {}) as Record<string, unknown>).number);
  },
  // Organização das próprias conversas (como no app): arquivar, fixar, reagir e apagar mensagens.
  'POST /chat/archive': async (req, instanceId, userId) => {
    await assertAssigned(instanceId, userId, ((req.body ?? {}) as Record<string, unknown>).number);
  },
  'POST /chat/pin': async (req, instanceId, userId) => {
    await assertAssigned(instanceId, userId, ((req.body ?? {}) as Record<string, unknown>).number);
  },
  'POST /message/react': messageCheck,
  // Atendente CORRIGE (edita) as próprias mensagens; apagar e limpar é só do dono.
  'POST /message/edit': messageCheck,
  // Dados do cliente (nome, e-mail, observações e campos como CPF/boleto) — nunca atribuição/fila.
  'POST /chat/editLead': async (req, instanceId, userId) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const allowed = /^(id|lead_name|lead_fullName|lead_email|lead_notes|lead_field\d{2})$/;
    const bad = Object.keys(body).find((k) => !allowed.test(k));
    if (bad) throw forbidden(`Campo não permitido para atendentes: ${bad}`);
    body.id = await assertAssigned(instanceId, userId, body.id);
  },
  'POST /upload': noCheck, // arquivo fica na pasta da instância; só é usado nos envios acima
  'GET /sse': noCheck, // o stream filtra os eventos pelas conversas do atendente
  'POST /ticket/close': async (req, instanceId, userId) => {
    await assertAssigned(instanceId, userId, ((req.body ?? {}) as Record<string, unknown>).chatid);
  },
  'POST /ticket/transfer': async (req, instanceId, userId) => {
    await assertAssigned(instanceId, userId, ((req.body ?? {}) as Record<string, unknown>).chatid);
  },
  'GET /ticket/agents': noCheck, // lista de colegas para transferir (nome e disponibilidade)
};

export function agentRouteKey(req: Request): string {
  return `${req.method.toUpperCase()} ${req.originalUrl.split('?')[0]!.replace(/\/+$/, '') || '/'}`;
}

export async function enforceAgentScope(req: Request, instanceId: string, userId: string): Promise<void> {
  const rule = RULES[agentRouteKey(req)];
  if (!rule) throw forbidden('Atendentes não têm acesso a esta função');
  await rule(req, instanceId, userId);
}
