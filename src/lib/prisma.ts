import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env.js';

/**
 * Cliente Prisma único por processo (pool de conexões compartilhado).
 * Regra de segurança: todas as queries passam pelo Prisma (parametrizadas).
 * `$queryRawUnsafe`/`$executeRawUnsafe` são proibidos pelo lint; quando SQL cru
 * é necessário (ex.: SKIP LOCKED), usa-se a template tag `$queryRaw`, que também parametriza.
 */
export const prisma = new PrismaClient({
  log: isProd ? ['error'] : ['error', 'warn'],
});
