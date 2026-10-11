import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircuitBreaker, MemoryBreakerStore } from '../src/lib/circuitBreaker.js';
import { buildChatWhere, buildSort, stringCondition } from '../src/lib/chatFilter.js';
import { InvalidNumberError, toJid } from '../src/lib/jid.js';
import { signFile, verifyFile } from '../src/lib/signedUrl.js';
import { applyPlaceholders, fieldSlug, parseButton, parseCarouselChoices, parseList, parsePoll, toNativeFlowButton } from '../src/whatsapp/choices.js';
import { buildWebhookUrl, chatAllowed, chatKey, isExcluded } from '../src/whatsapp/eventBus.js';
import { extractText, keepAfterLast, mediaDownloadHost, normalize, protocolOf, shouldUpdateStatus } from '../src/whatsapp/normalizer.js';
import { buildVCard } from '../src/whatsapp/vcard.js';

describe('toJid', () => {
  it('normaliza número internacional', () => assert.equal(toJid('+55 (19) 99999-8888'), '5519999998888@s.whatsapp.net'));
  it('preserva grupo, lid e newsletter', () => {
    assert.equal(toJid('120363000000000000@g.us'), '120363000000000000@g.us');
    assert.equal(toJid('123456789@lid'), '123456789@lid');
    assert.equal(toJid('120363000000000000@newsletter'), '120363000000000000@newsletter');
  });
  it('rejeita lixo e tentativas de injeção', () => {
    for (const bad of ['', 'abc', '123', "55' OR 1=1--", '55999@evil.com', '../../etc@g.us']) assert.throws(() => toJid(bad), InvalidNumberError);
  });
});

describe('URLs assinadas de arquivo', () => {
  it('valida link correto e rejeita expirado/adulterado/traversal', () => {
    const now = 1_000_000;
    const q = signFile('k', 'abcdefghijklmnopqrstuv.jpg', now + 60);
    const sig = new URLSearchParams(q.split('?')[1]).get('s')!;
    assert.equal(verifyFile('k', 'abcdefghijklmnopqrstuv.jpg', now + 60, sig, now), true);
    assert.equal(verifyFile('k', 'abcdefghijklmnopqrstuv.jpg', now + 60, sig, now + 61), false);
    assert.equal(verifyFile('k', 'abcdefghijklmnopqrstuw.jpg', now + 60, sig, now), false);
    assert.equal(verifyFile('k', '../../../etc/passwd', now + 60, sig, now), false);
  });
});

describe('CircuitBreaker', () => {
  it('abre após N falhas e fecha após sucesso', async () => {
    let t = 0;
    const b = new CircuitBreaker(new MemoryBreakerStore(), { failureThreshold: 3, cooldownMs: 1000 }, () => t);
    await b.failure('x');
    await b.failure('x');
    assert.equal(await b.blockedFor('x'), 0);
    assert.equal((await b.failure('x')).opened, true);
    assert.equal(await b.blockedFor('x'), 1000);
    t = 1001;
    assert.equal(await b.blockedFor('x'), 0); // half-open: permite tentativa
    await b.success('x');
    assert.equal(await b.blockedFor('x'), 0);
  });
});

describe('filtros de webhook (excludeMessages)', () => {
  it('wasSentByApi evita loop de automação', () => {
    assert.equal(isExcluded({ wasSentByApi: true, fromMe: true }, ['wasSentByApi']), true);
    assert.equal(isExcluded({ wasSentByApi: false, fromMe: true }, ['wasSentByApi']), false);
    assert.equal(isExcluded({ isGroup: true }, ['isGroupYes']), true);
    assert.equal(isExcluded({ isGroup: false }, ['isGroupYes']), false);
    assert.equal(isExcluded({}, []), false);
  });
  it('monta URL com segmentos', () => {
    assert.equal(buildWebhookUrl('https://x.com/hook', 'messages', 'text', { addUrlEvents: true, addUrlTypesMessages: true }), 'https://x.com/hook/messages/text');
    assert.equal(buildWebhookUrl('https://x.com/hook/', 'messages', 'text', { addUrlEvents: false, addUrlTypesMessages: false }), 'https://x.com/hook/');
  });
});

describe('choices do /send/menu', () => {
  it('interpreta tipos de botão', () => {
    assert.deepEqual(parseButton('Suporte|suporte'), { kind: 'reply', text: 'Suporte', value: 'suporte' });
    assert.equal(parseButton('Site|https://x.com').kind, 'url');
    assert.deepEqual(parseButton('Ligar|call:+5511999999999'), { kind: 'call', text: 'Ligar', value: '+5511999999999' });
    assert.equal(parseButton('Cupom|copy:DESC10').value, 'DESC10');
    assert.equal(JSON.parse(toNativeFlowButton(parseButton('Site|https://x.com')).buttonParamsJson).url, 'https://x.com');
  });
  it('lista com seções', () => {
    const s = parseList(['[Atendimento]', 'Suporte|suporte|Falar com o suporte', 'Vendas|vendas', '[Outros]', 'Sair']);
    assert.equal(s.length, 2);
    assert.equal(s[0]!.rows[0]!.description, 'Falar com o suporte');
    assert.equal(s[1]!.rows[0]!.id, 'Sair');
  });
  it('enquete exige opções únicas', () => {
    assert.deepEqual(parsePoll(['Manhã', 'Tarde']), ['Manhã', 'Tarde']);
    assert.throws(() => parsePoll(['A', 'A']));
    assert.throws(() => parsePoll(['A']));
  });
  it('carrossel por mini-sintaxe', () => {
    const c = parseCarouselChoices(['[Produto 1]', '{https://img/1.jpg}', 'Comprar|buy1', '[Produto 2]', 'Ver|https://x.com']);
    assert.equal(c.length, 2);
    assert.equal(c[0]!.image, 'https://img/1.jpg');
    assert.equal(c[1]!.buttons[0]!.kind, 'url');
  });
  it('placeholders', () => {
    assert.equal(applyPlaceholders('Oi {{first_name}}, {{ lead_field01 }}{{x}}!', { first_name: 'Ana', lead_field01: 'VIP' }), 'Oi Ana, VIP!');
  });
});

describe('vCard', () => {
  it('escapa quebra de linha (anti vCard injection)', () => {
    const v = buildVCard({ fullName: 'Ana\nTEL:+000', phoneNumber: '5511999999999' });
    assert.equal(v.split('\n').filter((l) => l.startsWith('TEL')).length, 1);
    assert.match(v, /waid=5511999999999/);
  });
});

describe('normalizer', () => {
  it('extrai texto de mensagem efêmera/view once', () => {
    assert.equal(extractText({ ephemeralMessage: { message: { extendedTextMessage: { text: 'oi' } } } }), 'oi');
    assert.equal(extractText({ viewOnceMessageV2: { message: { imageMessage: { caption: 'foto' } } } }), 'foto');
  });
  it('normaliza mensagem de grupo', () => {
    const n = normalize({ key: { id: 'ABC', remoteJid: '123-456@g.us', participant: '5511@s.whatsapp.net', fromMe: false }, pushName: 'Ana', messageTimestamp: 1700000000, message: { conversation: 'olá' } });
    assert.equal(n.isGroup, true);
    assert.equal(n.sender, '5511@s.whatsapp.net');
    assert.equal(n.simpleType, 'text');
    assert.equal(n.messageTimestampMs, 1700000000000);
  });
  it('status nunca regride', () => {
    assert.equal(shouldUpdateStatus('Read', 'Delivered'), false);
    assert.equal(shouldUpdateStatus('Sent', 'Read'), true);
  });
});

describe('filtros /chat/find', () => {
  it('operadores', () => {
    assert.deepEqual(stringCondition('leadStatus', '=ativo'), { leadStatus: { equals: 'ativo' } });
    assert.deepEqual(stringCondition('leadStatus', '!=ativo'), { NOT: { leadStatus: { equals: 'ativo' } } });
    assert.deepEqual(stringCondition('name', 'ana'), { name: { contains: 'ana', mode: 'insensitive' } });
  });
  it('ignora campos fora da whitelist (sem injeção de campo)', () => {
    const { conditions } = buildChatWhere({ lead_status: '~novo', instanceId: 'outra-instancia', 'OR': [{}], wa_isGroup: true });
    assert.equal(conditions.length, 2);
    assert.ok(!JSON.stringify(conditions).includes('outra-instancia'));
  });
  it('ordenação só por campos permitidos', () => {
    assert.deepEqual(buildSort('-wa_lastMsgTimestamp'), { lastMsgTimestamp: 'desc' });
    assert.deepEqual(buildSort('-passwordHash'), { lastMsgTimestamp: 'desc' });
  });
});

describe('webhook onlyChats', () => {
  const only = ['5519999998888@s.whatsapp.net', '120363000000000000@g.us'];
  it('9º dígito brasileiro: com e sem o 9 são o mesmo chat', () => assert.equal(chatKey('5519999998888@s.whatsapp.net'), chatKey('551999998888@s.whatsapp.net')));
  it('lista vazia libera tudo', () => assert.equal(chatAllowed('messages', { chatid: '5511@s.whatsapp.net' }, []), true));
  it('entrega só para chats da lista', () => {
    assert.equal(chatAllowed('messages', { chatid: '551999998888@s.whatsapp.net' }, only), true);
    assert.equal(chatAllowed('messages', { chatid: '120363000000000000@g.us' }, only), true);
    assert.equal(chatAllowed('messages', { chatid: '5511988887777@s.whatsapp.net' }, only), false);
  });
  it('evento de chat sem chatid é bloqueado quando há filtro', () => assert.equal(chatAllowed('messages_update', {}, only), false));
  it('eventos gerais (connection) não são afetados', () => assert.equal(chatAllowed('connection', {}, only), true));
  it('aceita pelo LID quando o chat veio como @lid', () => assert.equal(chatAllowed('messages', { chatid: 'x@s.whatsapp.net', chatlid: '123@lid' }, ['123@lid']), true));
});

describe('variáveis com recorte', () => {
  const v = { cpf: '123.456.789-09', cnpj: '12.345.678/0001-90', nome: 'Maria' };
  it('6 primeiros e 6 últimos dígitos ignoram pontuação', () => {
    assert.equal(applyPlaceholders('{{cpf|primeiros:6}}', v), '123456');
    assert.equal(applyPlaceholders('{{ cnpj | ultimos : 6 }}', v), '000190');
  });
  it('só dígitos e texto sem dígitos', () => {
    assert.equal(applyPlaceholders('{{cnpj|digitos}}', v), '12345678000190');
    assert.equal(applyPlaceholders('{{nome|primeiros:3}}', v), 'Mar');
  });
  it('nome do campo vira variável', () => assert.equal(fieldSlug('Número da Conta'), 'numero_da_conta'));
});

describe('ordem das mensagens', () => {
  it('mensagem enviada não fica antes da última da conversa (relógio da VPS atrasado)', () => {
    assert.equal(keepAfterLast(1_000_000, 1_003_000), 1_003_001);
    assert.equal(keepAfterLast(1_003_000, 1_003_000), 1_003_001);
  });
  it('não mexe quando já está depois, nem arrasta por diferença grande', () => {
    assert.equal(keepAfterLast(1_005_000, 1_003_000), 1_005_000);
    assert.equal(keepAfterLast(1_000_000, 1_000_000 + 10 * 60_000), 1_000_000);
  });
});

describe('download de mídia', () => {
  it('url de marcador (sem caminho) usa o host de mídia padrão', () => {
    assert.equal(mediaDownloadHost({ url: 'https://web.whatsapp.net', directPath: '/v/t62.15575-24/abc?ccb=11' }), 'mmg.whatsapp.net');
    assert.equal(mediaDownloadHost({ url: '', directPath: '/v/t62/abc' }), 'mmg.whatsapp.net');
  });
  it('url real de mídia é respeitada', () => {
    assert.equal(mediaDownloadHost({ url: 'https://mmg.whatsapp.net/v/t62.7118-24/abc.enc?ccb=11', directPath: '/v/t62.7118-24/abc' }), undefined);
    assert.equal(mediaDownloadHost({ url: 'https://mmg.whatsapp.net/x' }), undefined);
  });
});

describe('edição de mensagem', () => {
  it('lê a protocolMessage direta e a embrulhada em editedMessage', () => {
    const inner = { type: 14, key: { id: 'ABC' }, editedMessage: { conversation: 'corrigido' } };
    assert.equal(protocolOf({ protocolMessage: inner }), inner);
    const wrapped = { editedMessage: { message: { protocolMessage: inner } } };
    assert.equal(protocolOf(wrapped), inner);
    assert.equal(normalize({ key: { id: 'X', remoteJid: '5519999998888@s.whatsapp.net' }, message: wrapped }).messageType, 'protocolMessage');
  });
});
