/**
 * Parser do campo `choices` do /send/menu (formato uazapi). Módulo puro e testável.
 *
 *  button: "Texto|id"          → resposta rápida
 *          "Texto|https://..." → abre URL
 *          "Texto|call:+55..." → ligação
 *          "Texto|copy:CODIGO" → copia código
 *  list:   "[Seção]" inicia seção; "Texto|rowId|descrição" adiciona linha
 *  poll:   texto puro por opção
 *  carousel (mini-sintaxe): "[Texto do card]", "{url_da_imagem}", botões como em button
 */

export type ButtonKind = 'reply' | 'url' | 'call' | 'copy';

export interface ParsedButton {
  kind: ButtonKind;
  text: string;
  value: string;
}

export interface ListSection {
  title: string;
  rows: Array<{ id: string; title: string; description: string }>;
}

export interface CarouselCard {
  text: string;
  image?: string;
  buttons: ParsedButton[];
}

export class ChoiceError extends Error {}

const MAX_LEN = 1024;

function clean(s: string | undefined): string {
  return (s ?? '').trim().slice(0, MAX_LEN);
}

export function parseButton(choice: string): ParsedButton {
  const idx = choice.indexOf('|');
  const text = clean(idx === -1 ? choice : choice.slice(0, idx));
  const value = clean(idx === -1 ? choice : choice.slice(idx + 1));
  if (!text) throw new ChoiceError(`Botão sem texto: "${choice.slice(0, 40)}"`);
  if (/^https?:\/\//i.test(value)) return { kind: 'url', text, value };
  if (/^call:/i.test(value)) return { kind: 'call', text, value: value.slice(5).trim() };
  if (/^copy:/i.test(value)) return { kind: 'copy', text, value: value.slice(5).trim() };
  return { kind: 'reply', text, value: value || text };
}

export function parseButtons(choices: string[]): ParsedButton[] {
  if (!choices.length || choices.length > 10) throw new ChoiceError('Informe de 1 a 10 botões');
  return choices.map(parseButton);
}

export function parseList(choices: string[]): ListSection[] {
  const sections: ListSection[] = [];
  let current: ListSection | undefined;
  for (const raw of choices) {
    const c = raw.trim();
    const header = c.match(/^\[(.+)]$/);
    if (header) {
      current = { title: clean(header[1]), rows: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { title: 'Opções', rows: [] };
      sections.push(current);
    }
    const [title, id, description] = c.split('|');
    if (!clean(title)) throw new ChoiceError('Item de lista sem título');
    current.rows.push({ title: clean(title), id: clean(id) || clean(title), description: clean(description) });
  }
  const total = sections.reduce((a, s) => a + s.rows.length, 0);
  if (!total || total > 10) throw new ChoiceError('A lista deve ter de 1 a 10 itens');
  return sections.filter((s) => s.rows.length);
}

export function parsePoll(choices: string[]): string[] {
  const opts = choices.map(clean).filter(Boolean);
  if (opts.length < 2 || opts.length > 12) throw new ChoiceError('Enquete precisa de 2 a 12 opções');
  if (new Set(opts).size !== opts.length) throw new ChoiceError('Opções de enquete devem ser únicas');
  return opts;
}

export function parseCarouselChoices(choices: string[]): CarouselCard[] {
  const cards: CarouselCard[] = [];
  let card: CarouselCard | undefined;
  for (const raw of choices) {
    const c = raw.trim();
    const text = c.match(/^\[(.+)]$/s);
    const img = c.match(/^\{(.+)}$/);
    if (text) {
      card = { text: clean(text[1]), buttons: [] };
      cards.push(card);
    } else if (img) {
      if (!card) throw new ChoiceError('Imagem antes de "[texto do card]"');
      card.image = clean(img[1]);
    } else {
      if (!card) throw new ChoiceError('Botão antes de "[texto do card]"');
      card.buttons.push(parseButton(c));
    }
  }
  if (!cards.length || cards.length > 10) throw new ChoiceError('Carrossel precisa de 1 a 10 cards');
  return cards;
}

/** Converte um botão para o formato nativeFlow do WhatsApp. */
export function toNativeFlowButton(b: ParsedButton): { name: string; buttonParamsJson: string } {
  switch (b.kind) {
    case 'url':
      return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: b.text, url: b.value, merchant_url: b.value }) };
    case 'call':
      return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: b.text, phone_number: b.value }) };
    case 'copy':
      return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: b.text, copy_code: b.value, id: b.value }) };
    default:
      return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.value }) };
  }
}

/**
 * Recorte de uma variável: {{cpf|primeiros:6}}, {{cnpj|ultimos:6}}, {{boleto|digitos}}.
 * Por quê: mensagens de cobrança e conferência mostram só parte do documento
 * (privacidade) — "CPF final 123456". Com dígitos no valor, conta só os dígitos
 * (ignora pontos e traços); sem dígitos, conta caracteres.
 */
export function applyModifier(value: string, mod?: string, arg?: string): string {
  if (!mod) return value;
  const n = Math.max(1, Math.min(50, Number(arg) || 6));
  const digits = value.replace(/\D/g, '');
  const base = digits.length ? digits : value;
  switch (mod) {
    case 'primeiros':
      return base.slice(0, n);
    case 'ultimos':
      return base.slice(-n);
    case 'digitos':
      return digits;
    case 'maiusculas':
      return value.toUpperCase();
    default:
      return value;
  }
}

/** Substitui {{variavel}} (e {{variavel|recorte:N}}) pelos dados do chat/lead. Desconhecida vira vazio. */
export function applyPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]{1,40})\s*(?:\|\s*(primeiros|ultimos|digitos|maiusculas)\s*(?::\s*(\d{1,2}))?\s*)?}}/g, (_m, k: string, mod?: string, arg?: string) =>
    applyModifier(vars[k] ?? '', mod, arg),
  );
}

/** "Número da conta" → "numero_da_conta": nome da variável a partir do rótulo do campo. */
export function fieldSlug(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}
