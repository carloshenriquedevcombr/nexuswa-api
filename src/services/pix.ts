/**
 * Chaves Pix e linha digitável de boleto no formato que o WhatsApp e os apps de banco aceitam.
 * Módulo puro (sem Baileys/DB) para ser testável isoladamente.
 *
 * Por quê: a chave vai dentro do botão "Revisar e pagar"; se o tipo não bate com a chave
 * (CPF enviado como EVP) ou se ela vai com máscara ("123.456.789-09", "19 99999-8888"),
 * o cliente toca em pagar e o banco recusa.
 */

export const PIX_TYPES = ['CPF', 'CNPJ', 'PHONE', 'EMAIL', 'EVP'] as const;
export type PixType = (typeof PIX_TYPES)[number];

const digits = (s: string) => s.replace(/\D/g, '');
const EVP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidCpf(value: string): boolean {
  const d = digits(value);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === Number(d[9]) && check(10) === Number(d[10]);
}

export function isValidCnpj(value: string): boolean {
  const d = digits(value);
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const check = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i]!;
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === Number(d[12]) && check(13) === Number(d[13]);
}

/** Telefone no formato da chave Pix: +55DDDNUMERO. Sem DDI, assume Brasil. */
function phoneKey(value: string): string | null {
  const d = digits(value);
  if (/^55\d{10,11}$/.test(d)) return `+${d}`;
  if (/^\d{10,11}$/.test(d) && !value.trim().startsWith('+')) return `+55${d}`;
  return null;
}

/** Deduz o tipo quando o integrador manda só a chave. */
export function detectPixType(key: string): PixType | null {
  const k = key.trim();
  if (EVP_RE.test(k)) return 'EVP';
  if (k.includes('@')) return EMAIL_RE.test(k) ? 'EMAIL' : null;
  if (k.startsWith('+')) return phoneKey(k) ? 'PHONE' : null;
  if (/[^\d\s.\-/()]/.test(k)) return null;
  if (isValidCpf(k)) return 'CPF';
  if (isValidCnpj(k)) return 'CNPJ';
  return phoneKey(k) ? 'PHONE' : null;
}

/** Devolve a chave normalizada para o tipo, ou null se a chave não serve para esse tipo. */
export function normalizePixKey(key: string, type: PixType): string | null {
  const k = key.trim();
  switch (type) {
    case 'CPF':
      return isValidCpf(k) ? digits(k) : null;
    case 'CNPJ':
      return isValidCnpj(k) ? digits(k) : null;
    case 'PHONE':
      return phoneKey(k);
    case 'EMAIL':
      return EMAIL_RE.test(k) ? k.toLowerCase() : null;
    case 'EVP':
      return EVP_RE.test(k) ? k.toLowerCase() : null;
  }
}

/**
 * Resolve tipo + chave. Tipo informado é respeitado, mas a chave precisa servir para ele;
 * sem tipo, ele é deduzido da chave.
 */
export function resolvePixKey(key: string, type?: PixType): { key: string; type: PixType } | { error: string } {
  const t = type ?? detectPixType(key);
  if (!t) return { error: 'Não foi possível identificar o tipo da chave Pix; informe pixType (CPF, CNPJ, PHONE, EMAIL ou EVP)' };
  const normalized = normalizePixKey(key, t);
  if (!normalized) return { error: `Chave Pix inválida para o tipo ${t}` };
  return { key: normalized, type: t };
}

/** Linha digitável só com dígitos: 47 (boleto bancário) ou 48 (arrecadação/convênio). */
export function normalizeBoleto(code: string): string | null {
  const d = digits(code);
  return d.length === 47 || d.length === 48 ? d : null;
}
