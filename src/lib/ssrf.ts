import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Cliente HTTP à prova de SSRF.
 *
 * Por quê: esta API recebe URLs de terceiros (mídia a enviar, webhooks, link preview).
 * Sem proteção, um usuário poderia fazer o servidor acessar o Postgres/Redis internos,
 * o painel do Portainer ou o endpoint de metadata da VPS (169.254.169.254).
 *
 * Defesas:
 *  1. Só http/https, sem credenciais embutidas na URL.
 *  2. O IP é validado NO MOMENTO da conexão (hook `lookup`), o que derrota DNS rebinding:
 *     não existe janela entre "validar" e "conectar" com outro IP.
 *  3. Redirects são seguidos manualmente e cada salto é revalidado.
 *  4. Limites de tempo e de tamanho do corpo (evita DoS por resposta gigante/lenta).
 */

const blocked = new net.BlockList();
// IPv4
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local + metadata de nuvem
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado + broadcast
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
// IPv6
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

export function isPrivateAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return true; // não é IP válido → trata como proibido
  if (family === 6) {
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

export interface SafeFetchOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowPrivate?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
}

export function assertSafeUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('URL inválida');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Somente http/https são permitidos');
  if (url.username || url.password) throw new SsrfError('Credenciais na URL não são permitidas');
  return url;
}

function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return (callback as (e: Error | null, a: string, f: number) => void)(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      const bad = !allowPrivate && list.find((a) => isPrivateAddress(a.address));
      if (bad || list.length === 0) {
        return (callback as (e: Error | null, a: string, f: number) => void)(
          new SsrfError(`Destino bloqueado (${hostname} resolve para rede interna)`),
          '',
          0,
        );
      }
      if ((options as dns.LookupOptions).all) {
        return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      }
      const first = list[0]!;
      (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family);
    });
  };
}

function requestOnce(url: URL, opts: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'allowPrivate'>> & SafeFetchOptions): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    // IP literal na URL não passa pelo lookup — validamos aqui.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !opts.allowPrivate && isPrivateAddress(host)) {
      reject(new SsrfError('Destino bloqueado (endereço interno)'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': 'NexusWA/2.0', ...opts.headers },
        lookup: guardedLookup(opts.allowPrivate),
        timeout: opts.timeoutMs,
        agent: false, // sem reuso de socket entre destinos diferentes
      },
      (res) => {
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          reject(new SsrfError(`Arquivo excede o limite de ${Math.round(opts.maxBytes / 1048576)} MB`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > opts.maxBytes) {
            res.destroy(new SsrfError(`Arquivo excede o limite de ${Math.round(opts.maxBytes / 1048576)} MB`));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), finalUrl: url.toString() }),
        );
      },
    );
    // Timeout total (o `timeout` do socket só mede inatividade).
    const hard = setTimeout(() => req.destroy(new SsrfError('Tempo limite excedido')), opts.timeoutMs);
    req.on('close', () => clearTimeout(hard));
    req.on('timeout', () => req.destroy(new SsrfError('Tempo limite excedido')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const opts = {
    timeoutMs: 15_000,
    maxBytes: 16 * 1024 * 1024,
    maxRedirects: 3,
    allowPrivate: false,
    ...options,
  };
  let url = assertSafeUrl(rawUrl);
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const res = await requestOnce(url, opts);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (opts.method === 'POST') return res; // não reenvia corpo para outro destino
      url = assertSafeUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    return res;
  }
  throw new SsrfError('Muitos redirecionamentos');
}
