import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SsrfError, assertSafeUrl, isPrivateAddress, safeFetch } from '../src/lib/ssrf.js';

describe('isPrivateAddress', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.21.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '224.0.0.1']) {
    it(`bloqueia ${ip}`, () => assert.equal(isPrivateAddress(ip), true));
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.0.1', '2001:4860:4860::8888']) {
    it(`permite ${ip}`, () => assert.equal(isPrivateAddress(ip), false));
  }
  it('trata entrada inválida como proibida', () => assert.equal(isPrivateAddress('not-an-ip'), true));
});

describe('assertSafeUrl', () => {
  it('rejeita esquemas perigosos', () => {
    for (const u of ['file:///etc/passwd', 'gopher://x', 'ftp://x', 'javascript:alert(1)', 'data:text/html,x']) {
      assert.throws(() => assertSafeUrl(u), SsrfError);
    }
  });
  it('rejeita credenciais embutidas', () => assert.throws(() => assertSafeUrl('https://user:pass@example.com'), SsrfError));
  it('aceita https normal', () => assert.equal(assertSafeUrl('https://example.com/a').hostname, 'example.com'));
});

describe('safeFetch contra servidor interno', () => {
  let server: http.Server;
  let port = 0;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
        return res.end();
      }
      if (req.url === '/big') {
        res.writeHead(200);
        return res.end(Buffer.alloc(2048));
      }
      res.end('internal-secret');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => server.close());

  it('bloqueia IP literal interno', async () => {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), SsrfError);
  });
  it('bloqueia hostname que resolve para loopback (validação no connect)', async () => {
    await assert.rejects(safeFetch(`http://localhost:${port}/`), /bloqueado/);
  });
  it('com allowPrivate funciona (prova que o bloqueio é a proteção, não falha de rede)', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/`, { allowPrivate: true });
    assert.equal(r.body.toString(), 'internal-secret');
  });
  it('limita tamanho da resposta', async () => {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/big`, { allowPrivate: true, maxBytes: 100 }), /excede/);
  });
  it('não segue redirect em POST', async () => {
    const r = await safeFetch(`http://127.0.0.1:${port}/redirect`, { allowPrivate: true, method: 'POST', body: 'x' });
    assert.equal(r.status, 302);
  });
});
