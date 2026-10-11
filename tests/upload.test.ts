import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';

// media.ts lê a configuração ao ser importado: define um ambiente mínimo e isolado.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nwa-up-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  MEDIA_DIR: dir,
  UPLOAD_QUOTA_MB: '10',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? 'a'.repeat(48),
  JWT_SECRET: process.env.JWT_SECRET ?? 'j'.repeat(64),
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString('base64'),
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:3000',
});

let m: typeof import('../src/services/media.js');
before(async () => {
  m = await import('../src/services/media.js');
});

const INST = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(200, 1)]);
const ZIP = Buffer.concat([Buffer.from('504b0304', 'hex'), Buffer.alloc(100, 2)]);

describe('pickUploadExt', () => {
  it('usa os bytes reais, não o nome', () => assert.equal(m.pickUploadExt(JPG, 'foto.png'), 'jpg'));
  it('aceita docx (zip) pelo nome', () => assert.equal(m.pickUploadExt(ZIP, 'contrato.docx'), 'docx'));
  it('aceita txt/csv sem assinatura', () => assert.equal(m.pickUploadExt(Buffer.from('nome;telefone\n'), 'lista.csv'), 'csv'));
  it('recusa HTML disfarçado de txt', () => assert.equal(m.pickUploadExt(Buffer.from('<html><script>x</script>'), 'nota.txt'), undefined));
  it('recusa "jpg" que não é imagem', () => assert.equal(m.pickUploadExt(Buffer.from('hello world'), 'foto.jpg'), undefined));
  it('recusa executáveis e svg', () => {
    assert.equal(m.pickUploadExt(Buffer.from('MZ\x90\x00'), 'setup.exe'), undefined);
    assert.equal(m.pickUploadExt(Buffer.from('<svg onload=alert(1)>'), 'logo.svg'), undefined);
  });
});

describe('saveUpload + loadMedia(upload:)', () => {
  it('salva e carrega pela própria instância', async () => {
    const r = await m.saveUpload(INST, JPG, 'Foto da loja.jpeg');
    assert.match(r.file, m.UPLOAD_REF);
    assert.equal(r.kind, 'image');
    const loaded = await m.loadMedia(r.file, undefined, INST);
    assert.equal(loaded.mimetype, 'image/jpeg');
    assert.equal(loaded.buffer.length, JPG.length);
  });
  it('outra instância não acessa o anexo (IDOR)', async () => {
    const r = await m.saveUpload(INST, JPG, 'a.jpg');
    await assert.rejects(m.loadMedia(r.file, undefined, OTHER), /não encontrado/);
    await assert.rejects(m.loadMedia(r.file), /instância/);
  });
  it('bloqueia path traversal na referência', async () => {
    await assert.rejects(m.loadMedia('upload:../../etc/passwd', undefined, INST));
    assert.throws(() => m.uploadDir('../x'));
  });
  it('respeita a cota por instância', async () => {
    const big = Buffer.concat([JPG, Buffer.alloc(6 * 1024 * 1024)]);
    await m.saveUpload(OTHER, big, 'a.jpg');
    await assert.rejects(m.saveUpload(OTHER, big, 'b.jpg'), /esgotado/);
  });
});
