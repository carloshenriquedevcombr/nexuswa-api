import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { parse } from '../lib/validate.js';
import { sensitiveLimiter } from '../middlewares/rateLimit.js';

/**
 * Report de bugs pelo usuário final (item 8 do checklist de produção).
 * Aceita usuário logado OU token de instância (integrações). O requestId do erro
 * visto pelo usuário liga o relato aos logs do servidor.
 */
export const supportRouter = Router();

supportRouter.post('/support/bug-report', sensitiveLimiter, async (req, res) => {
  if (!req.auth.user && !req.auth.instance) throw unauthorized();
  const p = parse(
    z.object({
      title: z.string().trim().min(3).max(200),
      description: z.string().trim().min(10).max(10_000),
      severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      requestId: z.string().max(64).optional(),
      context: z.record(z.string().max(2000)).optional(),
    }),
    req.body,
  );
  const report = await prisma.bugReport.create({
    data: {
      userId: req.auth.user?.id ?? null,
      instanceId: req.auth.instance?.id ?? null,
      title: p.title,
      description: p.description,
      severity: p.severity,
      requestId: p.requestId ?? '',
      context: (p.context ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
  logger.warn({ bugReport: report.id, severity: p.severity }, 'novo bug report');
  res.status(201).json({ id: report.id, status: report.status, message: 'Obrigado! Seu relato foi registrado.' });
});

/** Os relatos da própria pessoa, com o status (aberto, em análise, resolvido). */
supportRouter.get('/support/my-reports', async (req, res) => {
  if (!req.auth.user) throw unauthorized();
  const rows = await prisma.bugReport.findMany({ where: { userId: req.auth.user.id }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, title: true, status: true, severity: true, createdAt: true } });
  res.json(rows);
});
