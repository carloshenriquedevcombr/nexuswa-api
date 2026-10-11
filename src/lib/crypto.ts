import crypto from 'node:crypto';

/**
 * Primitivas criptográficas centralizadas.
 * Por quê: um único ponto auditável evita que cada módulo reinvente (e erre)
 * cifragem, comparação de segredos ou geração de tokens.
 * Depende apenas de node:crypto para ser testável sem infraestrutura.
 */

const IV_LEN = 12; // recomendado para GCM
const VERSION = 'v1';

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Hex(secret: string | Buffer, data: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Comparação em tempo constante; hasheia antes para neutralizar diferença de tamanho. */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Token opaco com prefixo identificável (facilita secret-scanning em repositórios). */
export function generateToken(prefix: string, bytes = 32): string {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomInt(min: number, max: number): number {
  if (max <= min) return min;
  return crypto.randomInt(min, max + 1);
}

/**
 * AES-256-GCM com IV aleatório e AAD opcional.
 * O AAD amarra o ciphertext ao seu contexto (ex.: instanceId) — impede que um
 * valor cifrado seja copiado de um registro para outro e continue válido.
 */
export class Cipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes');
    this.key = key;
  }

  encrypt(plain: string | Buffer, aad = ''): string {
    const iv = crypto.randomBytes(IV_LEN);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) c.setAAD(Buffer.from(aad));
    const enc = Buffer.concat([c.update(plain), c.final()]);
    const tag = c.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
  }

  decryptToBuffer(payload: string, aad = ''): Buffer {
    const [version, ivB, tagB, dataB] = payload.split('.');
    if (version !== VERSION || !ivB || !tagB || dataB === undefined) throw new Error('ciphertext inválido');
    // authTagLength fixo: sem ele, uma tag truncada (ex.: 4 bytes) seria aceita e facilitaria forjar o texto cifrado.
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'), { authTagLength: 16 });
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64url')), d.final()]);
  }

  decrypt(payload: string, aad = ''): string {
    return this.decryptToBuffer(payload, aad).toString('utf8');
  }
}

/** Assinatura de webhook no formato "t=<unix>,v1=<hmac>" (mesma ideia do Stripe). */
export function signWebhook(secret: string, body: string, timestampSec: number): string {
  const sig = hmacSha256Hex(secret, `${timestampSec}.${body}`);
  return `t=${timestampSec},v1=${sig}`;
}

export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec || !parts.v1) return false;
  return safeEqual(hmacSha256Hex(secret, `${t}.${body}`), parts.v1);
}
