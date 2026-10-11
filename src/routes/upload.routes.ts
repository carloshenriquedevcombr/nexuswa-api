import express, { Router } from 'express';
import { env } from '../config/env.js';
import { badRequest } from '../lib/errors.js';
import { inst } from '../middlewares/auth.js';
import { saveUpload } from '../services/media.js';

/**
 * Anexos do painel (arrastar e soltar / clipe).
 * Por quê: o cliente não precisa hospedar o arquivo nem gerar link. O navegador envia
 * o arquivo BINÁRIO (sem base64, ~33% menor) e recebe "upload:<nome>", aceito no
 * campo `file` de /send/media, /send/menu (imagem), /sender/* etc.
 *
 * Segurança: rota exige instância resolvida (token ou sessão + ownership — ver
 * INSTANCE_SCOPED em app.ts), CSRF para cookie, corpo lido só DEPOIS da autenticação,
 * tipo validado por magic bytes + allowlist e cota de disco por instância.
 */
export const uploadRouter = Router();

const raw = express.raw({ type: () => true, limit: `${env.MEDIA_MAX_MB}mb` });

uploadRouter.post('/upload', raw, async (req, res) => {
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || !body.length) throw badRequest('Envie o arquivo no corpo da requisição');
  // Nome original vem codificado (acentos/espaços); é usado só para inferir a extensão.
  let name = '';
  try {
    name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).slice(0, 255);
  } catch {
    name = '';
  }
  const instance = inst(req);
  const saved = await saveUpload(instance.id, body, name);
  res.status(201).json(saved);
});
