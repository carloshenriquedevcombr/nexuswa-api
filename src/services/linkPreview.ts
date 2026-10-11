import { env } from '../config/env.js';
import { safeFetch } from '../lib/ssrf.js';
import { loadMedia, makeThumbnail } from './media.js';

/**
 * Gera link preview com Open Graph, usando o safeFetch (SSRF-safe).
 * Por quê não delegar ao Baileys: ele buscaria qualquer URL enviada no texto
 * a partir do servidor, sem bloqueio de rede interna.
 */

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function meta(html: string, prop: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']{0,1000})["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']{0,1000})["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  return decode(html.match(re)?.[1] ?? html.match(re2)?.[1] ?? '').trim();
}

export function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s<>"']{3,2000}/i)?.[0];
}

export interface PreviewInput {
  text: string;
  title?: string;
  description?: string;
  image?: string;
}

export async function buildLinkPreview(input: PreviewInput): Promise<Record<string, unknown> | undefined> {
  const url = firstUrl(input.text);
  if (!url) return undefined;
  let title = input.title ?? '';
  let description = input.description ?? '';
  let imageUrl = input.image;

  if (!title || !description || !imageUrl) {
    try {
      const res = await safeFetch(url, { maxBytes: 512 * 1024, timeoutMs: 8000, allowPrivate: env.SSRF_ALLOW_PRIVATE, headers: { accept: 'text/html' } });
      const html = res.body.toString('utf8');
      title ||= meta(html, 'og:title') || decode(html.match(/<title[^>]*>([^<]{0,300})<\/title>/i)?.[1] ?? '').trim();
      description ||= meta(html, 'og:description') || meta(html, 'description');
      imageUrl ||= meta(html, 'og:image') || undefined;
      if (imageUrl) imageUrl = new URL(imageUrl, res.finalUrl).toString();
    } catch {
      /* preview é opcional: falha nunca impede o envio do texto */
    }
  }

  let jpegThumbnail: Buffer | undefined;
  if (imageUrl) {
    try {
      const img = await loadMedia(imageUrl);
      if (img.buffer.length <= 5 * 1024 * 1024) jpegThumbnail = await makeThumbnail(img.buffer);
    } catch {
      /* ignora imagem inválida */
    }
  }
  if (!title && !description && !jpegThumbnail) return undefined;
  return { 'canonical-url': url, 'matched-text': url, title, description, jpegThumbnail };
}
