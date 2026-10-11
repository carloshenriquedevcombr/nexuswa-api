import path from 'node:path';
import express, { Router } from 'express';
import helmet from 'helmet';
import { isProd } from '../config/env.js';

/**
 * Painel web (arquivos estáticos em /public), servido na MESMA origem da API.
 * Por quê mesma origem: o login usa cookies HttpOnly + SameSite=Strict + CSRF, sem
 * CORS e sem expor nenhum token ao JavaScript — o painel nunca vê token de instância
 * nem admintoken, só a sessão do usuário (padrão "backend for frontend").
 *
 * CSP própria (a da API é 'none'): só scripts/estilos do próprio domínio, nada inline,
 * imagens data: (QR Code) e https: (fotos de perfil do WhatsApp).
 */
export const panelRouter = Router();

const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

panelRouter.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        // blob: = pré-visualização local do anexo antes de enviar (arquivo nunca sai do navegador para isso).
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    hsts: isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }),
);

// Microfone só para o próprio painel (gravar áudio de voz no chat); câmera, GPS etc. bloqueados.
panelRouter.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()');
  next();
});

panelRouter.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    dotfiles: 'deny',
    fallthrough: true,
    setHeaders: (res, filePath) => {
      // index.html sem cache: uma atualização do painel aparece no próximo F5.
      res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
    },
  }),
);
