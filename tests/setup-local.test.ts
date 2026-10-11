import assert from 'node:assert/strict';
import net from 'node:net';
import { describe, it } from 'node:test';
// @ts-expect-error — script .mjs sem declaração de tipos
import { buildLocalEnv, parseEnv, redisPing } from '../scripts/setup-local.mjs';

describe('setup local (sem Docker)', () => {
  it('gera .env com segredos fortes e únicos, só alfanuméricos nas senhas de banco', () => {
    const a = parseEnv(buildLocalEnv());
    const b = parseEnv(buildLocalEnv());
    assert.notEqual(a.ADMIN_TOKEN, b.ADMIN_TOKEN);
    assert.equal(Buffer.from(a.ENCRYPTION_KEY, 'base64').length, 32);
    assert.ok(a.JWT_SECRET.length >= 48 && a.ADMIN_TOKEN.length >= 32);
    assert.match(a.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/);
    assert.ok(a.DATABASE_URL.includes(a.POSTGRES_PASSWORD));
    assert.equal(a.HOST, '127.0.0.1'); // API local não fica exposta na rede da casa/empresa
  });

  it('redisPing reporta conexão recusada sem travar', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    srv.close();
    const r = await redisPing(`redis://:x@127.0.0.1:${port}`, 1000);
    assert.equal(r.ok, false);
  });

  it('redisPing entende PONG e erro de senha', async () => {
    const srv = net.createServer((s) => s.on('data', (d) => s.write(d.toString().includes('AUTH') && d.toString().includes('errada') ? '-WRONGPASS invalid password\r\n' : '+OK\r\n+PONG\r\n')));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    assert.equal((await redisPing(`redis://:certa@127.0.0.1:${port}`)).ok, true);
    assert.equal((await redisPing(`redis://:errada@127.0.0.1:${port}`)).ok, false);
    srv.close();
  });
});
