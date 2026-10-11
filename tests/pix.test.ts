import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectPixType, isValidCnpj, isValidCpf, normalizeBoleto, resolvePixKey } from '../src/services/pix.js';
import { pixButtonSchema, requestPaymentSchema } from '../src/services/sendSchemas.js';

const CPF = '529.982.247-25';
const CNPJ = '11.222.333/0001-81';
const BOLETO = '34191.79001 01043.510047 91020.150008 1 96610000012345';

describe('chave Pix', () => {
  it('valida CPF e CNPJ pelos dígitos verificadores', () => {
    assert.equal(isValidCpf(CPF), true);
    assert.equal(isValidCpf('529.982.247-24'), false);
    assert.equal(isValidCpf('111.111.111-11'), false);
    assert.equal(isValidCnpj(CNPJ), true);
    assert.equal(isValidCnpj('11.222.333/0001-80'), false);
  });

  it('deduz o tipo pela chave', () => {
    assert.equal(detectPixType(CPF), 'CPF');
    assert.equal(detectPixType(CNPJ), 'CNPJ');
    assert.equal(detectPixType('Loja@Exemplo.com.br'), 'EMAIL');
    assert.equal(detectPixType('+55 (19) 99999-8888'), 'PHONE');
    assert.equal(detectPixType('19 99999-8888'), 'PHONE');
    assert.equal(detectPixType('123e4567-e89b-12d3-a456-426614174000'), 'EVP');
    assert.equal(detectPixType('chave qualquer'), null);
  });

  it('normaliza a chave no formato aceito pelos bancos', () => {
    assert.deepEqual(resolvePixKey(CPF), { key: '52998224725', type: 'CPF' });
    assert.deepEqual(resolvePixKey(CNPJ), { key: '11222333000181', type: 'CNPJ' });
    assert.deepEqual(resolvePixKey('19 99999-8888'), { key: '+5519999998888', type: 'PHONE' });
    assert.deepEqual(resolvePixKey('5519999998888', 'PHONE'), { key: '+5519999998888', type: 'PHONE' });
    assert.deepEqual(resolvePixKey(' Loja@Exemplo.com.br '), { key: 'loja@exemplo.com.br', type: 'EMAIL' });
  });

  it('recusa chave que não serve para o tipo informado', () => {
    assert.ok('error' in resolvePixKey(CPF, 'EVP'));
    assert.ok('error' in resolvePixKey('loja@exemplo.com', 'CPF'));
  });

  it('linha digitável do boleto só com dígitos', () => {
    assert.equal(normalizeBoleto(BOLETO), '34191790010104351004791020150008196610000012345');
    assert.equal(normalizeBoleto('123'), null);
  });
});

describe('schemas de pagamento', () => {
  const base = { number: '5519999998888', amount: 10 };

  it('CPF sem pixType vira tipo CPF (antes ia como EVP)', () => {
    const r = requestPaymentSchema.parse({ ...base, pixKey: CPF });
    assert.equal(r.pixType, 'CPF');
    assert.equal(r.pixKey, '52998224725');
  });

  it('boleto vai só com dígitos', () => {
    const r = requestPaymentSchema.parse({ ...base, boletoCode: BOLETO });
    assert.equal(r.boletoCode, '34191790010104351004791020150008196610000012345');
  });

  it('recusa cobrança sem forma de pagamento, chave inválida e boleto incompleto', () => {
    assert.equal(requestPaymentSchema.safeParse(base).success, false);
    assert.equal(requestPaymentSchema.safeParse({ ...base, pixKey: CPF, pixType: 'EVP' }).success, false);
    assert.equal(requestPaymentSchema.safeParse({ ...base, boletoCode: '1234' }).success, false);
    assert.equal(requestPaymentSchema.safeParse({ ...base, paymentLink: 'https://pagar.exemplo.com/1' }).success, true);
  });

  it('orderMessageId sozinho continua passando pelo schema', () => {
    assert.equal(requestPaymentSchema.safeParse({ number: '5519999998888', orderMessageId: 'ABC' }).success, true);
  });

  it('botão Pix também normaliza a chave', () => {
    const r = pixButtonSchema.parse({ number: '5519999998888', pixKey: '(19) 99999-8888', pixType: 'PHONE' });
    assert.equal(r.pixKey, '+5519999998888');
  });
});
