import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { randomId, sha256Hex } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { signFile } from '../lib/signedUrl.js';
import { safeFetch } from '../lib/ssrf.js';

export const MAX_MEDIA_BYTES = env.MEDIA_MAX_MB * 1024 * 1024;
export const FILES_SECRET = sha256Hex(`files:${env.JWT_SECRET}`);

export interface LoadedMedia {
  buffer: Buffer;
  mimetype: string;
  fileName?: string;
}

/** Detecção por assinatura binária (magic bytes) — não confia no Content-Type informado. */
export function sniffMime(buf: Buffer): string | undefined {
  const hex = buf.subarray(0, 12).toString('hex');
  const ascii = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('89504e47')) return 'image/png';
  if (ascii.startsWith('GIF8')) return 'image/gif';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image/webp';
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii.startsWith('%PDF')) return 'application/pdf';
  if (ascii.startsWith('OggS')) return 'audio/ogg';
  if (ascii.startsWith('ID3') || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'audio/mpeg';
  if (ascii.slice(4, 8) === 'ftyp') {
    const brand = ascii.slice(8, 12);
    return brand.startsWith('M4A') ? 'audio/mp4' : 'video/mp4';
  }
  if (hex.startsWith('1a45dfa3')) return 'video/webm';
  if (hex.startsWith('504b0304')) return 'application/zip';
  return undefined;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/zip': 'zip',
};
export const extFor = (mime: string) => EXT[mime.split(';')[0]!.trim()] ?? 'bin';

const DATA_URL = /^data:([\w/+.-]+);base64,(.+)$/s;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/**
 * Converte o campo `file` (URL, data URL ou base64) em Buffer.
 * URLs passam OBRIGATORIAMENTE pelo safeFetch — o Baileys nunca recebe a URL do
 * usuário, senão ele mesmo faria a requisição sem proteção SSRF.
 */
export async function loadMedia(file: string, declaredMime?: string, instanceId?: string): Promise<LoadedMedia> {
  const input = file.trim();
  let buffer: Buffer;
  let headerMime: string | undefined;
  let fileName: string | undefined;

  const dataUrl = input.match(DATA_URL);
  const upload = input.match(UPLOAD_REF);
  if (upload) {
    // Anexo do painel: só é lido da pasta da PRÓPRIA instância — uma referência
    // copiada de outro cliente simplesmente não existe aqui (sem IDOR).
    if (!instanceId) throw badRequest('Anexo do painel só pode ser usado pela instância que o enviou');
    buffer = await fs.readFile(path.join(uploadDir(instanceId), upload[1]!)).catch(() => {
      throw badRequest('Anexo não encontrado ou expirado — envie o arquivo novamente');
    });
    headerMime = MIME_BY_EXT[upload[1]!.split('.').pop()!];
  } else if (dataUrl) {
    headerMime = dataUrl[1];
    buffer = Buffer.from(dataUrl[2]!, 'base64');
  } else if (/^https?:\/\//i.test(input)) {
    const res = await safeFetch(input, { maxBytes: MAX_MEDIA_BYTES, timeoutMs: 60_000, allowPrivate: env.SSRF_ALLOW_PRIVATE });
    if (res.status < 200 || res.status >= 300) throw badRequest(`Não foi possível baixar o arquivo (HTTP ${res.status})`);
    buffer = res.body;
    headerMime = String(res.headers['content-type'] ?? '').split(';')[0] || undefined;
    fileName = decodeURIComponent(new URL(res.finalUrl).pathname.split('/').pop() ?? '') || undefined;
  } else if (input.length > 16 && BASE64.test(input.slice(0, 4096))) {
    buffer = Buffer.from(input, 'base64');
  } else {
    throw badRequest('Campo file deve ser URL http(s), data URL ou base64');
  }

  if (!buffer.length) throw badRequest('Arquivo vazio');
  if (buffer.length > MAX_MEDIA_BYTES) throw badRequest(`Arquivo excede ${env.MEDIA_MAX_MB} MB`);
  const mimetype = declaredMime || sniffMime(buffer) || headerMime || 'application/octet-stream';
  return { buffer, mimetype, fileName: fileName?.replace(/[^\w.\- ]/g, '_').slice(0, 120) };
}

// ------------------------------------------------------------ anexos do painel
// Por quê: cliente leigo não sabe gerar link público de foto/vídeo. O painel envia
// o arquivo binário para /upload e recebe uma referência curta "upload:<nome>",
// que serve em /send/media, campanhas etc. no lugar da URL.

export const UPLOAD_REF = /^upload:([A-Za-z0-9_-]{16,64}\.[a-z0-9]{2,5})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tipos aceitos (allowlist). HTML, SVG, scripts e executáveis ficam de fora. */
export const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', amr: 'audio/amr',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function uploadDir(instanceId: string): string {
  if (!UUID.test(instanceId)) throw badRequest('Instância inválida');
  return path.join(env.MEDIA_DIR, 'uploads', instanceId);
}

async function dirSize(dir: string): Promise<number> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((n) => fs.stat(path.join(dir, n)).then((s) => s.size).catch(() => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

/**
 * Decide a extensão final: o conteúdo real (magic bytes) manda. Só quando os bytes
 * não são reconhecíveis (docx/xlsx/txt/csv...) usamos a extensão do nome original,
 * e ainda assim apenas se estiver na allowlist. Uma "foto.jpg" que na verdade é
 * HTML é recusada.
 */
export function pickUploadExt(buf: Buffer, originalName: string): string | undefined {
  const sniffed = sniffMime(buf);
  const orig = (originalName.split('.').pop() ?? '').toLowerCase();
  if (sniffed === 'application/zip' && ['docx', 'xlsx', 'pptx', 'zip'].includes(orig)) return orig;
  if (sniffed) {
    if (sniffed === 'video/mp4' && ['mov', '3gp'].includes(orig)) return orig;
    if (sniffed === 'audio/ogg' && orig === 'opus') return 'opus';
    return extFor(sniffed);
  }
  const imageLike = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'pdf', 'mp3', 'wav', 'ogg', 'm4a', 'zip'];
  if (imageLike.includes(orig)) return undefined; // extensão promete um formato que os bytes não confirmam
  const head = buf.subarray(0, 512).toString('latin1').toLowerCase();
  if (/<(html|script|svg|!doctype)/.test(head)) return undefined;
  return orig in MIME_BY_EXT ? orig : undefined;
}

export async function saveUpload(instanceId: string, buffer: Buffer, originalName: string) {
  if (!buffer.length) throw badRequest('Arquivo vazio');
  if (buffer.length > MAX_MEDIA_BYTES) throw badRequest(`Arquivo excede ${env.MEDIA_MAX_MB} MB`);
  const ext = pickUploadExt(buffer, originalName);
  if (!ext) throw badRequest('Tipo de arquivo não permitido. Use foto, vídeo, áudio, PDF, Word, Excel, PowerPoint, TXT, CSV ou ZIP.');
  const dir = uploadDir(instanceId);
  await fs.mkdir(dir, { recursive: true });
  // Cota por instância: impede que um cliente encha o disco da VPS (DoS).
  if ((await dirSize(dir)) + buffer.length > env.UPLOAD_QUOTA_MB * 1024 * 1024) {
    throw badRequest(`Espaço de anexos da instância esgotado (${env.UPLOAD_QUOTA_MB} MB). Os anexos antigos são apagados após ${env.UPLOAD_TTL_DAYS} dias.`);
  }
  const name = `${randomId(18)}.${ext}`;
  await fs.writeFile(path.join(dir, name), buffer, { mode: 0o600 });
  const mimetype = MIME_BY_EXT[ext] ?? 'application/octet-stream';
  const kind = mimetype.startsWith('image/') ? 'image' : mimetype.startsWith('video/') ? 'video' : mimetype.startsWith('audio/') ? 'audio' : 'document';
  return { file: `upload:${name}`, mimetype, size: buffer.length, kind, expiresInDays: env.UPLOAD_TTL_DAYS };
}

async function cleanupUploads(): Promise<number> {
  const root = path.join(env.MEDIA_DIR, 'uploads');
  const cutoff = Date.now() - env.UPLOAD_TTL_DAYS * 86400_000;
  let removed = 0;
  for (const inst of await fs.readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, inst);
    for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null);
      if (st?.isFile() && st.mtimeMs < cutoff) {
        await fs.unlink(path.join(dir, f)).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}

/**
 * Executa o ffmpeg com argumentos em ARRAY (sem shell) — não há como injetar comandos,
 * pois nenhum dado do usuário é interpretado por /bin/sh. Entrada/saída por pipe,
 * com timeout e limite de saída.
 */
export function ffmpeg(input: Buffer, args: string[], timeoutMs = 60_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...args, 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let size = 0;
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_MEDIA_BYTES) proc.kill('SIGKILL');
      else out.push(c);
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-500);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg falhou (${code}): ${stderr}`));
    });
    proc.stdin.on('error', () => undefined);
    proc.stdin.end(input);
  });
}

/** Áudio de voz (PTT) no WhatsApp precisa ser OGG/Opus mono. */
export async function toVoiceNote(media: LoadedMedia): Promise<LoadedMedia> {
  if (media.mimetype.startsWith('audio/ogg')) return { ...media, mimetype: 'audio/ogg; codecs=opus' };
  const buffer = await ffmpeg(media.buffer, ['-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '64k', '-f', 'ogg']);
  return { buffer, mimetype: 'audio/ogg; codecs=opus' };
}

export async function toMp3(buffer: Buffer): Promise<Buffer> {
  return ffmpeg(buffer, ['-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3']);
}

export async function toSticker(media: LoadedMedia): Promise<LoadedMedia> {
  if (media.mimetype === 'image/webp') return media;
  const { default: sharp } = await import('sharp');
  const buffer = await sharp(media.buffer, { animated: false })
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 80 })
    .toBuffer();
  return { buffer, mimetype: 'image/webp' };
}

export async function makeThumbnail(buffer: Buffer): Promise<Buffer | undefined> {
  try {
    const { default: sharp } = await import('sharp');
    return await sharp(buffer).resize(192, 192, { fit: 'inside' }).jpeg({ quality: 60 }).toBuffer();
  } catch {
    return undefined;
  }
}

/** Grava o arquivo com nome aleatório e devolve URL assinada com expiração. */
export async function storeFile(buffer: Buffer, mimetype: string): Promise<string> {
  await fs.mkdir(env.MEDIA_DIR, { recursive: true });
  const name = `${randomId(18)}.${extFor(mimetype)}`;
  await fs.writeFile(path.join(env.MEDIA_DIR, name), buffer, { mode: 0o600 });
  const exp = Math.floor(Date.now() / 1000) + env.FILE_URL_TTL_HOURS * 3600;
  return `${env.PUBLIC_URL.replace(/\/$/, '')}/files/${signFile(FILES_SECRET, name, exp)}`;
}

export async function cleanupFiles(): Promise<number> {
  const cutoff = Date.now() - env.FILE_URL_TTL_HOURS * 3600_000;
  let removed = 0;
  const entries = await fs.readdir(env.MEDIA_DIR).catch(() => [] as string[]);
  for (const f of entries) {
    const p = path.join(env.MEDIA_DIR, f);
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile() && st.mtimeMs < cutoff) {
      await fs.unlink(p).catch(() => undefined);
      removed++;
    }
  }
  return removed + (await cleanupUploads());
}
