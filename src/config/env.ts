import os from 'node:os';
import { z } from 'zod';

/**
 * Validação do ambiente no boot (fail-fast).
 * Por quê: um segredo ausente ou fraco em produção é pior que a API não subir.
 * Nenhum valor sensível possui default — todos vêm do .env / orquestrador.
 */
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url(),
  NODE_ID: z.string().default(os.hostname()),

  DATABASE_URL: z.string().startsWith('postgresql://'),
  REDIS_URL: z.string().regex(/^rediss?:\/\//),

  // Segredos: exigimos entropia mínima para impedir valores como "123456".
  ADMIN_TOKEN: z.string().min(32, 'ADMIN_TOKEN precisa de 32+ caracteres'),
  JWT_SECRET: z.string().min(48, 'JWT_SECRET precisa de 48+ caracteres'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY deve ser 32 bytes em base64'),
  METRICS_TOKEN: z.string().min(24).optional(),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: bool(true),

  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(5).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(60).default(14),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

  MEDIA_MAX_MB: z.coerce.number().int().min(1).max(100).default(64),
  MEDIA_DIR: z.string().default('./storage/media'),
  FILE_URL_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(48),
  // Anexos enviados pelo painel (arrastar/soltar). Ficam mais tempo que os links de
  // download porque campanhas agendadas precisam do arquivo no dia do disparo.
  // Fuso para horários de pausa dos atendentes (almoço "12:00-13:00").
  APP_TIMEZONE: z.string().default('America/Sao_Paulo'),
  UPLOAD_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  UPLOAD_QUOTA_MB: z.coerce.number().int().min(10).max(100_000).default(2048),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(7),
  UNPAIRED_INSTANCE_TTL_MIN: z.coerce.number().int().min(0).default(60),
  SSRF_ALLOW_PRIVATE: bool(false),
  // Hosts internos liberados SÓ para webhooks (ex.: "n8n" na mesma rede Docker).
  WEBHOOK_INTERNAL_HOSTS: z
    .string()
    .default('')
    .transform((v) => new Set(v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BAILEYS_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('warn'),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(10).default(600),
  RATE_LIMIT_SEND_PER_MIN: z.coerce.number().int().min(1).default(120),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Mostra apenas NOMES das variáveis com problema — nunca os valores.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[config] Variáveis de ambiente inválidas:\n${issues}\n`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (!env.PUBLIC_URL.startsWith('https://')) {
      console.error('[config] Em produção PUBLIC_URL deve ser https://');
      process.exit(1);
    }
    if (env.CORS_ORIGINS.includes('*')) {
      console.error('[config] CORS_ORIGINS não pode conter "*" em produção');
      process.exit(1);
    }
  }
  return env;
}

export const env: Env = load();
export const isProd = env.NODE_ENV === 'production';
