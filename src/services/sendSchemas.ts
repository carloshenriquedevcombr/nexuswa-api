import { z, type ZodTypeAny } from 'zod';
import { PIX_TYPES, normalizeBoleto, resolvePixKey, type PixType } from './pix.js';

/**
 * Schemas de envio compartilhados por /send/*, fila async e campanhas.
 * Limites explícitos em TODOS os campos: texto, listas e arrays não podem crescer sem
 * teto (proteção contra payloads gigantes que esgotam memória/CPU).
 */

const str = (max: number) => z.string().max(max);
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const commonSendFields = {
  number: str(120).min(3),
  replyid: str(200).optional(),
  mentions: str(4000).optional(),
  readchat: bool.optional(),
  readmessages: bool.optional(),
  delay: z.coerce.number().int().min(0).max(60_000).optional(),
  forward: bool.optional(),
  track_source: str(100).optional(),
  track_id: str(200).optional(),
  async: bool.optional(),
};

export const textSchema = z.object({
  ...commonSendFields,
  text: str(65_000).min(1),
  linkPreview: bool.optional(),
  linkPreviewTitle: str(300).optional(),
  linkPreviewDescription: str(1000).optional(),
  linkPreviewImage: str(8_000_000).optional(),
  linkPreviewLarge: bool.optional(),
});

export const MEDIA_TYPES = ['image', 'video', 'videoplay', 'document', 'audio', 'myaudio', 'ptt', 'ptv', 'sticker'] as const;
export const mediaSchema = z.object({
  ...commonSendFields,
  type: z.enum(MEDIA_TYPES),
  file: str(100_000_000).min(1),
  text: str(65_000).optional(),
  docName: str(255).optional(),
  thumbnail: str(2_000_000).optional(),
  mimetype: str(120).optional(),
  viewOnce: bool.optional(),
});

export const contactSchema = z.object({
  ...commonSendFields,
  fullName: str(200).min(1),
  phoneNumber: str(200).min(3), // aceita múltiplos separados por vírgula
  organization: str(200).optional(),
  email: str(200).optional(),
  url: str(500).optional(),
});

export const locationSchema = z.object({
  ...commonSendFields,
  name: str(300).optional(),
  address: str(500).optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
});

export const MENU_TYPES = ['button', 'button_legacy', 'list', 'poll', 'carousel'] as const;
export const menuSchema = z.object({
  ...commonSendFields,
  type: z.enum(MENU_TYPES),
  text: str(4096).min(1),
  footerText: str(60).optional(),
  listButton: str(20).optional(),
  selectableCount: z.coerce.number().int().min(0).max(12).optional(),
  choices: z.array(str(1024)).min(1).max(60),
  imageButton: str(2000).optional(),
});

const carouselButton = z.object({ id: str(2000).min(1), text: str(25).min(1), type: z.enum(['REPLY', 'URL', 'CALL', 'COPY']) });
export const carouselSchema = z.object({
  ...commonSendFields,
  text: str(4096).optional(),
  carousel: z
    .array(
      z.object({
        text: str(1024).min(1),
        image: str(2000).optional(),
        video: str(2000).optional(),
        document: str(2000).optional(),
        filename: str(255).optional(),
        buttons: z.array(carouselButton).min(1).max(3),
      }),
    )
    .min(1)
    .max(10),
});

export const locationButtonSchema = z.object({ ...commonSendFields, text: str(4096).min(1) });

export { PIX_TYPES };

/** Normaliza a chave Pix no próprio schema: a fila async e o envio direto recebem o mesmo valor limpo. */
function withPixKey<T extends { pixKey?: string; pixType?: PixType }>(v: T, ctx: z.RefinementCtx): T {
  if (!v.pixKey) return v;
  const r = resolvePixKey(v.pixKey, v.pixType);
  if ('error' in r) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pixKey'], message: r.error });
    return z.NEVER;
  }
  return { ...v, pixKey: r.key, pixType: r.type };
}

export const pixButtonSchema = z
  .object({
    ...commonSendFields,
    pixType: z.enum(PIX_TYPES).optional(),
    pixKey: str(100).min(1),
    pixName: str(100).optional(),
  })
  .transform(withPixKey);

export const requestPaymentSchema = z
  .object({
    ...commonSendFields,
    orderMessageId: str(200).optional(),
    title: str(200).optional(),
    text: str(4096).optional(),
    footer: str(60).optional(),
    itemName: str(200).optional(),
    invoiceNumber: str(100).optional(),
    amount: z.coerce.number().positive().max(10_000_000).optional(),
    pixKey: str(100).optional(),
    // Sem pixType, o tipo é deduzido da chave (antes caía em EVP e o banco recusava CPF/telefone).
    pixType: z.enum(PIX_TYPES).optional(),
    pixName: str(100).optional(),
    paymentLink: str(2000).url().optional(),
    fileUrl: str(2000).optional(),
    fileName: str(255).optional(),
    boletoCode: str(100).optional(),
  })
  .refine((v) => v.amount != null || v.orderMessageId, { message: 'Informe amount ou orderMessageId' })
  .refine((v) => v.amount == null || v.pixKey || v.boletoCode || v.paymentLink, {
    message: 'Informe ao menos uma forma de pagamento: pixKey, boletoCode ou paymentLink',
  })
  .transform((v, ctx) => {
    if (v.boletoCode) {
      const boleto = normalizeBoleto(v.boletoCode);
      if (!boleto) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['boletoCode'], message: 'Linha digitável do boleto deve ter 47 ou 48 dígitos' });
        return z.NEVER;
      }
      v = { ...v, boletoCode: boleto };
    }
    return withPixKey(v, ctx);
  });

export const eventSchema = z.object({
  ...commonSendFields,
  name: str(300).min(1),
  description: str(2000).optional(),
  startTime: z.coerce.number().int().positive(),
  endTime: z.coerce.number().int().positive().optional(),
  location: z
    .object({ name: str(300).optional(), address: str(500).optional(), latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() })
    .optional(),
  joinLink: str(2000).url().optional(),
  extraGuestsAllowed: bool.optional(),
  isScheduleCall: bool.optional(),
  isCanceled: bool.optional(),
  hasReminder: bool.optional(),
  reminderOffsetSec: z.coerce.number().int().min(0).optional(),
});

export const statusSchema = z.object({
  type: z.enum(['text', 'image', 'video', 'audio', 'myaudio', 'ptt']),
  text: str(4096).optional(),
  background_color: z.coerce.number().int().min(1).max(19).optional(),
  font: z.coerce.number().int().min(0).max(10).optional(),
  file: str(100_000_000).optional(),
  thumbnail: str(2_000_000).optional(),
  mimetype: str(120).optional(),
  recipients: z.array(str(120)).max(10_000).optional(),
  max_recipients: z.coerce.number().int().min(0).optional(),
});

export type SendKind = 'text' | 'media' | 'contact' | 'location' | 'menu' | 'carousel' | 'location-button' | 'pix-button' | 'request-payment' | 'event';

export const SCHEMAS: Record<SendKind, ZodTypeAny> = {
  text: textSchema,
  media: mediaSchema,
  contact: contactSchema,
  location: locationSchema,
  menu: menuSchema,
  carousel: carouselSchema,
  'location-button': locationButtonSchema,
  'pix-button': pixButtonSchema,
  'request-payment': requestPaymentSchema,
  event: eventSchema,
};

/** Converte o `type` de campanha (uazapi /sender) para o tipo de envio interno. */
export function campaignKind(type: string): SendKind {
  if ((MEDIA_TYPES as readonly string[]).includes(type)) return 'media';
  if (type === 'text') return 'text';
  if (type === 'contact') return 'contact';
  if (type === 'location') return 'location';
  if (['list', 'button', 'poll', 'carousel'].includes(type)) return 'menu';
  throw new Error(`Tipo de campanha não suportado: ${type}`);
}
