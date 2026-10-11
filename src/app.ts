import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { env, isProd } from './config/env.js';
import { authenticate, requireInstance } from './middlewares/auth.js';
import { csrfProtection } from './middlewares/csrf.js';
import { accessLog, errorHandler, notFoundHandler, requestId } from './middlewares/observability.js';
import { globalLimiter } from './middlewares/rateLimit.js';
import { adminRouter } from './routes/admin.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { businessRouter } from './routes/business.routes.js';
import { chatRouter } from './routes/chat.routes.js';
import { contactRouter } from './routes/contact.routes.js';
import { groupRouter } from './routes/group.routes.js';
import { instanceRouter } from './routes/instance.routes.js';
import { messageRouter } from './routes/message.routes.js';
import { newsletterRouter } from './routes/newsletter.routes.js';
import { panelRouter } from './routes/panel.routes.js';
import { sendRouter } from './routes/send.routes.js';
import { senderRouter } from './routes/sender.routes.js';
import { uploadRouter } from './routes/upload.routes.js';
import { supportRouter } from './routes/support.routes.js';
import { systemRouter } from './routes/system.routes.js';
import { accountWebhookRouter, globalWebhookRouter, webhookRouter } from './routes/webhook.routes.js';
import { agentRouter } from './routes/agent.routes.js';
import { toolsRouter } from './routes/tools.routes.js';

/** Prefixos cujas rotas SEMPRE exigem uma instância resolvida (token ou X-Instance-Id + ownership). */
const INSTANCE_SCOPED = [
  '/send',
  '/message',
  '/chat',
  '/lead',
  '/contacts',
  '/contact',
  '/label',
  '/labels',
  '/quickreply',
  '/call',
  '/group',
  '/community',
  '/newsletter',
  '/business',
  '/sender',
  '/webhook',
  '/sse',
  '/upload',
  '/agents',
  '/ticket',
  '/lists',
];

/** Rotas que recebem mídia em base64 — corpo maior permitido só nelas. */
const LARGE_BODY = /^\/(send\/(media|status|menu|carousel|request-payment)|sender\/|profile\/image|group\/updateImage|newsletter\/(create|picture)|business\/catalog\/save)/;

export function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  // Atrás do Nginx Proxy Manager: confia em N saltos para obter o IP real (rate limit/auditoria).
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  // Painel web antes do helmet da API (tem CSP própria). Só responde arquivos que existem
  // em /public; qualquer outra rota segue para a API normalmente.
  app.use(panelRouter);
  app.use(
    helmet({
      // API só responde JSON: CSP mais restritiva possível.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      frameguard: { action: 'deny' },
      hsts: isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        // Sem Origin = chamada servidor-a-servidor (n8n, curl): CORS não se aplica.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'token', 'admintoken', 'Authorization', 'X-Instance-Id', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  // Log logo no início: requisições barradas por auth/CSRF/rate limit também são registradas.
  app.use(accessLog);

  // Health antes do rate limit/auth: o Docker consulta com frequência.
  app.use(systemRouter);
  app.use(globalLimiter);
  // authenticate usa apenas headers/cookies/query — roda ANTES de ler o corpo.
  app.use(authenticate);

  // Corpo grande (mídia base64) só é aceito de quem já está autenticado:
  // um anônimo não consegue forçar o servidor a alocar ~90 MB por requisição.
  const small = express.json({ limit: '1mb', strict: true });
  const large = express.json({ limit: `${Math.ceil(env.MEDIA_MAX_MB * 1.4)}mb`, strict: true });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const authed = req.auth.adminToken || Boolean(req.auth.user) || Boolean(req.auth.instance);
    return (authed && LARGE_BODY.test(req.path) ? large : small)(req, res, next);
  });
  app.use(csrfProtection);

  app.use(authRouter);
  app.use(adminRouter);
  app.use(supportRouter);
  app.use(globalWebhookRouter);
  app.use(accountWebhookRouter);
  app.use(instanceRouter);

  app.use(INSTANCE_SCOPED, requireInstance);
  app.use(sendRouter);
  app.use(messageRouter);
  app.use(chatRouter);
  app.use(contactRouter);
  app.use(groupRouter);
  app.use(newsletterRouter);
  app.use(businessRouter);
  app.use(senderRouter);
  app.use(uploadRouter);
  app.use(agentRouter);
  app.use(toolsRouter);
  app.use(webhookRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
