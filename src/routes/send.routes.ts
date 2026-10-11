import { Router, type Request, type Response } from 'express';
import { badRequest } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { idempotency } from '../middlewares/idempotency.js';
import { sendLimiter } from '../middlewares/rateLimit.js';
import { enqueueSend } from '../services/asyncQueue.js';
import { loadMedia, toVoiceNote } from '../services/media.js';
import { SCHEMAS, statusSchema, type SendKind } from '../services/sendSchemas.js';
import { executeSend } from '../services/sendService.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

export const sendRouter = Router();

const OK_MESSAGES: Partial<Record<SendKind, string>> = {
  menu: 'Menu sent successfully',
  carousel: 'Carousel sent successfully',
  'pix-button': 'PIX button sent successfully',
  'request-payment': 'Payment request sent successfully',
};

/** Fábrica de handlers de envio: valida, decide síncrono x fila, responde no formato uazapi. */
function sendHandler(kind: SendKind) {
  return async (req: Request, res: Response) => {
    const payload = parse(SCHEMAS[kind], req.body) as Record<string, unknown>;
    toJid(String(payload.number)); // valida destino antes de qualquer trabalho
    const instance = inst(req);
    if (payload.async) {
      const queued = await enqueueSend(instance, kind, payload);
      res.status(202).json({ ...queued, response: { status: 'Queued', message: 'Mensagem enfileirada' } });
      return;
    }
    // Nome de quem está no painel, para a variável {{atendente}} ("Aqui é a Maria").
    const senderName = req.auth.user ? (await prisma.user.findUnique({ where: { id: req.auth.user.id }, select: { name: true } }))?.name ?? '' : '';
    const { message } = await executeSend(instance, kind, payload, {
      sendFunction: kind,
      senderName,
      trackSource: payload.track_source as string | undefined,
      trackId: payload.track_id as string | undefined,
    });
    res.json({ ...message, response: { status: 'success', message: OK_MESSAGES[kind] ?? 'Message sent successfully' } });
  };
}

const guard = [sendLimiter, idempotency];
sendRouter.post('/send/text', ...guard, sendHandler('text'));
sendRouter.post('/send/media', ...guard, sendHandler('media'));
sendRouter.post('/send/contact', ...guard, sendHandler('contact'));
sendRouter.post('/send/location', ...guard, sendHandler('location'));
sendRouter.post('/send/menu', ...guard, sendHandler('menu'));
sendRouter.post('/send/carousel', ...guard, sendHandler('carousel'));
sendRouter.post('/send/location-button', ...guard, sendHandler('location-button'));
sendRouter.post('/send/pix-button', ...guard, sendHandler('pix-button'));
sendRouter.post('/send/request-payment', ...guard, sendHandler('request-payment'));
sendRouter.post('/send/event', ...guard, sendHandler('event'));

// Paleta aproximada das 19 cores de fundo de status do WhatsApp.
const STATUS_COLORS = ['#000000', '#FF8A8C', '#54C265', '#C1A03F', '#AB7F92', '#7E90A3', '#72666A', '#6E267D', '#57C9FF', '#243640', '#B6B327', '#C69FCC', '#8294CA', '#A62C71', '#90A841', '#7ACBA5', '#FFB7B1', '#5696FF', '#0B64C0', '#EEA0F0'];

sendRouter.post('/send/status', ...guard, async (req, res) => {
  const p = parse(statusSchema, req.body);
  const instance = inst(req);
  const session = await SessionManager.requireConnected(instance);

  // Audiência: lista explícita validada ou contatos da agenda.
  const discarded: Array<{ input: string; reason: string }> = [];
  let recipients: string[];
  if (p.recipients?.length) {
    recipients = [];
    for (const r of p.recipients) {
      try {
        recipients.push(toJid(r));
      } catch {
        discarded.push({ input: r.slice(0, 40), reason: 'invalid_number' });
      }
    }
  } else {
    const contacts = await prisma.contact.findMany({ where: { instanceId: instance.id, inAddressBook: true, jid: { endsWith: '@s.whatsapp.net' } }, select: { jid: true }, take: 10_000 });
    recipients = contacts.map((c) => c.jid);
  }
  if (p.max_recipients) recipients = recipients.slice(0, p.max_recipients);
  if (!recipients.length) {
    res.status(400).json({ error: 'Nenhum destinatário para o status', error_key: 'no_recipients', debug: { discarded_recipients: discarded } });
    return;
  }

  let content: Record<string, unknown>;
  if (p.type === 'text') content = { text: p.text ?? '' };
  else {
    if (!p.file) throw badRequest('file obrigatório para status de mídia');
    let media = await loadMedia(p.file, p.mimetype, instance.id);
    if (p.type === 'image') content = { image: media.buffer, caption: p.text };
    else if (p.type === 'video') content = { video: media.buffer, caption: p.text };
    else {
      if (p.type !== 'audio') media = await toVoiceNote(media);
      content = { audio: media.buffer, mimetype: media.mimetype, ptt: p.type !== 'audio' };
    }
  }
  const sent = await session.sock!.sendMessage('status@broadcast', content as never, {
    statusJidList: recipients,
    broadcast: true,
    ...(p.type === 'text' ? { backgroundColor: STATUS_COLORS[p.background_color ?? 1], font: p.font ?? 0 } : {}),
  } as never);
  res.json({
    Id: sent?.key.id,
    content: sent?.message,
    messageTimestamp: Number(sent?.messageTimestamp ?? 0),
    status: 'Pending',
    debug: { audience_recipient_count: recipients.length, explicit_recipients: Boolean(p.recipients?.length), discarded_recipient_count: discarded.length, discarded_recipients: discarded, max_recipients: p.max_recipients ?? null },
  });
});

sendRouter.post('/message/presence', async (req, res) => {
  const p = parse(z.object({ number: z.string().max(120), presence: z.enum(['composing', 'recording', 'paused']), delay: z.coerce.number().int().min(0).max(300_000).optional() }), req.body);
  const session = await SessionManager.requireConnected(inst(req));
  const jid = toJid(p.number);
  await session.sock!.presenceSubscribe(jid).catch(() => undefined);
  await session.sock!.sendPresenceUpdate(p.presence, jid);
  if (p.delay && p.presence !== 'paused') {
    // Encerra a presença após o tempo pedido sem segurar a requisição.
    setTimeout(() => void session.sock?.sendPresenceUpdate('paused', jid).catch(() => undefined), p.delay).unref();
  }
  res.json({ response: 'Presence updated' });
});
