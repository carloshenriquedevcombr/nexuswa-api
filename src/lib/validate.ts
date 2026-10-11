import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Valida entrada com Zod e devolve dado tipado.
 * Por quê: 100% das entradas passam por schema — campos inesperados são descartados
 * (strip), tipos são coeridos de forma explícita e o erro devolvido ao cliente lista
 * apenas caminho + motivo, sem ecoar o valor enviado (evita reflected XSS em painéis).
 */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) {
    throw badRequest(
      'Payload inválido',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
