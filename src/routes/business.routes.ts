import { Router, type Request } from 'express';
import { z } from 'zod';
import { notFound, notImplemented } from '../lib/errors.js';
import { toJid } from '../lib/jid.js';
import { parse } from '../lib/validate.js';
import { inst } from '../middlewares/auth.js';
import { loadMedia } from '../services/media.js';
import { SessionManager } from '../whatsapp/SessionManager.js';
import type { InstanceSession } from '../whatsapp/session.js';

/** Perfil comercial e catálogo (exige conta WhatsApp Business conectada). */
export const businessRouter = Router();

/* eslint-disable @typescript-eslint/no-explicit-any */
async function sess(req: Request) {
  return SessionManager.requireConnected(inst(req));
}

async function callAny<T>(s: InstanceSession, names: string[], ...args: unknown[]): Promise<T> {
  const sock = s.sock as unknown as Record<string, unknown>;
  const name = names.find((n) => typeof sock?.[n] === 'function');
  if (!name) throw notImplemented(`Recurso Business indisponível nesta versão do Baileys (${names[0]})`);
  return s.call<T>(name, ...args);
}

const me = (s: InstanceSession) => s.sock!.user!.id.replace(/:\d+@/, '@');

async function findProduct(s: InstanceSession, id: string): Promise<any> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r: any = await s.sock!.getCatalog({ jid: me(s), limit: 50, cursor });
    const hit = r?.products?.find((p: any) => p.id === id);
    if (hit) return hit;
    cursor = r?.nextPageCursor;
    if (!cursor) break;
  }
  throw notFound('Produto não encontrado no catálogo');
}

businessRouter.post('/business/get/profile', async (req, res) => {
  const { jid } = parse(z.object({ jid: z.string().max(120).optional() }), req.body);
  const s = await sess(req);
  res.json({ response: await s.sock!.getBusinessProfile(jid ? toJid(jid) : me(s)) });
});

businessRouter.get('/business/get/categories', () => {
  throw notImplemented('Listagem de categorias de negócio não é exposta pelo Baileys');
});

businessRouter.post('/business/update/profile', async (req, res) => {
  // websites: o WhatsApp aceita até 2 links (site e/ou rede social). Só http(s), sem javascript: etc.
  const p = parse(
    z.object({
      description: z.string().max(512).optional(),
      address: z.string().max(256).optional(),
      email: z.string().email().max(128).or(z.literal('')).optional(),
      websites: z.array(z.string().url().max(256).regex(/^https?:\/\//i, 'use um link http(s)')).max(2).optional(),
    }),
    req.body,
  );
  const s = await sess(req);
  const result = await callAny(s, ['updateBusinessProfile', 'updateBussinesProfile'], p);
  res.json({ response: result, updated: Object.keys(p), failed: [] });
});

businessRouter.post('/business/catalog/list', async (req, res) => {
  const p = parse(z.object({ jid: z.string().max(120), after: z.string().max(500).optional() }), req.body);
  const s = await sess(req);
  res.json({ response: await s.sock!.getCatalog({ jid: toJid(p.jid), limit: 50, cursor: p.after }) });
});

businessRouter.post('/business/catalog/info', async (req, res) => {
  const p = parse(z.object({ jid: z.string().max(120), id: z.string().max(100) }), req.body);
  const s = await sess(req);
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r: any = await s.sock!.getCatalog({ jid: toJid(p.jid), limit: 50, cursor });
    const hit = r?.products?.find((x: any) => x.id === p.id);
    if (hit) {
      res.json({ response: hit });
      return;
    }
    cursor = r?.nextPageCursor;
    if (!cursor) break;
  }
  throw notFound('Produto não encontrado');
});

businessRouter.post('/business/catalog/delete', async (req, res) => {
  const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.body);
  const s = await sess(req);
  res.json({ response: await s.sock!.productDelete([id]) });
});

async function setHidden(req: Request, hidden: boolean) {
  const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.body);
  const s = await sess(req);
  const p = await findProduct(s, id);
  return s.sock!.productUpdate(id, {
    name: p.name,
    description: p.description ?? '',
    price: Number(p.price ?? 0),
    currency: p.currency ?? 'BRL',
    isHidden: hidden,
    images: (p.imageUrls ? Object.values(p.imageUrls) : []).map((url: any) => ({ url })),
    retailerId: p.retailerId,
    url: p.url,
  } as any);
}
businessRouter.post('/business/catalog/show', async (req, res) => {
  res.json({ response: await setHidden(req, false) });
});
businessRouter.post('/business/catalog/hide', async (req, res) => {
  res.json({ response: await setHidden(req, true) });
});

businessRouter.post('/business/catalog/save', async (req, res) => {
  const p = parse(
    z.object({
      id: z.string().max(100).optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      currency: z.string().length(3).default('BRL'),
      price: z.string().regex(/^\d{1,12}$/, 'preço em milésimos, ex.: 19990 = R$ 19,99').optional(),
      url: z.string().url().max(2000).optional(),
      retailer_id: z.string().max(100).optional(),
      is_hidden: z.boolean().default(false),
      image_urls: z.array(z.string().url()).max(10).optional(),
      image_data: z.string().max(15_000_000).optional(),
      image_url: z.string().url().optional(),
    }),
    req.body,
  );
  const s = await sess(req);
  const images: Array<{ url: string } | Buffer> = (p.image_urls ?? []).map((url) => ({ url }));
  // Imagens novas são baixadas por nós (SSRF-safe) e enviadas como Buffer.
  if (p.image_url) images.push((await loadMedia(p.image_url)).buffer);
  if (p.image_data) images.push((await loadMedia(p.image_data, undefined, s.id)).buffer);
  const product = {
    name: p.name,
    description: p.description ?? '',
    price: Math.round(Number(p.price ?? '0') / 10), // milésimos → centavos (formato Baileys)
    currency: p.currency,
    isHidden: p.is_hidden,
    retailerId: p.retailer_id,
    url: p.url,
    images,
  };
  const result = p.id ? await s.sock!.productUpdate(p.id, product as any) : await s.sock!.productCreate(product as any);
  res.json({ response: result });
});

businessRouter.get('/business/catalog/collection/list', async (req, res) => {
  const s = await sess(req);
  res.json({ response: await s.sock!.getCollections(me(s), 50) });
});

for (const [method, path] of [
  ['post', '/business/catalog/collection/create'],
  ['patch', '/business/catalog/collection/:id'],
  ['delete', '/business/catalog/collection/:id'],
] as const) {
  businessRouter[method](path, () => {
    throw notImplemented('Edição de coleções do catálogo não é suportada pelo Baileys');
  });
}
