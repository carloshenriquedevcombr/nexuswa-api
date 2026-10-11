/*
 * NexusWA — painel web (JavaScript puro, sem dependências externas).
 *
 * Segurança:
 *  - Todo conteúdo vindo da API/WhatsApp é inserido com textContent (função el):
 *    não há innerHTML com dados, então mensagens maliciosas não viram XSS.
 *  - Sessão por cookie HttpOnly; o JS só lê o cookie de CSRF e o envia no header.
 *  - O painel nunca recebe/guarda token de instância nem admintoken (exceto o token
 *    recém-criado, exibido UMA vez para o usuário copiar, e não armazenado).
 */
'use strict';

// ======================================================================= utilitários
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

/** Cria elemento com atributos/eventos. Strings viram nós de TEXTO (seguro contra XSS). */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    // CSSOM em vez de atributo style: a CSP (style-src 'self') bloqueia style="..." inline.
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = Boolean(v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function toast(msg, type = 'ok') {
  const t = el('div', { class: `toast ${type === 'error' ? 'error' : ''}` }, msg);
  $toasts.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}

function cookie(name) {
  const m = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}

const fmtDate = (ms) => {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n < 1e12 ? n * 1000 : n);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const STATUS_PT = { Queued: 'na fila', Pending: 'enviando', Sent: 'enviada', Delivered: 'entregue', Read: 'lida', Played: 'reproduzida', Failed: 'falhou', Canceled: 'cancelada', Deleted: 'apagada' };
const phoneOf = (jid) => String(jid || '').split('@')[0];
const initials = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) out[k] = typeof v === 'string' ? v.trim() : v;
  return out;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado!');
  } catch {
    toast('Não foi possível copiar automaticamente; selecione e copie manualmente.', 'error');
  }
}

/** Botão que se desabilita durante a ação assíncrona (evita duplo clique = envio duplicado). */
function actionBtn(label, fn, cls = 'btn') {
  const b = el('button', { class: cls, type: 'button' }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await fn();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

function modal(title, body, actions = []) {
  const bg = el('div', { class: 'modal-bg' });
  const close = () => bg.remove();
  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, el('h2', {}, title), body, el('div', { class: 'row', style: 'margin-top:16px;justify-content:flex-end' }, ...actions.map((a) => a(close)), el('button', { class: 'btn', type: 'button', onclick: close }, 'Fechar')));
  bg.append(box);
  bg.addEventListener('click', (e) => e.target === bg && close());
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.append(bg);
  return close;
}

/** Confirmação digitando o nome — para ações destrutivas (excluir instância, etc.). */
function confirmTyped(title, text, expected, onOk) {
  const input = el('input', { placeholder: expected, autocomplete: 'off' });
  modal(title, el('div', { class: 'stack' }, el('p', {}, text), el('p', { class: 'muted small' }, 'Digite ', el('b', {}, expected), ' para confirmar:'), input), [
    (close) =>
      actionBtn('Confirmar', async () => {
        if (input.value.trim() !== expected) throw new Error('O texto não confere');
        await onOk();
        close();
      }, 'btn danger'),
  ]);
}

// ======================================================================= API
class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let refreshing = null;
async function tryRefresh() {
  refreshing ??= (async () => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': cookie('nwa_csrf'), 'Content-Type': 'application/json' }, body: '{}' });
      if (r.ok) return true;
      if (r.status === 409) {
        await new Promise((res) => setTimeout(res, 800)); // outra aba está renovando
        continue;
      }
      return false;
    }
    return false;
  })().finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

async function api(path, { method = 'GET', body, instance, retry = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = cookie('nwa_csrf');
  if (instance) headers['X-Instance-Id'] = instance;
  // Conversas trancadas: comprovante da senha confirmada (15 min), só para este número.
  if (instance && state.unlock?.instanceId === instance && state.unlock.exp > Date.now()) headers['X-Unlock-Token'] = state.unlock.token;
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  if (r.status === 401 && retry && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    if (await tryRefresh()) return api(path, { method, body, instance, retry: false });
    const hadSession = Boolean(state.user);
    state.user = null;
    renderLogin(hadSession ? 'Sua sessão expirou. Entre novamente.' : undefined);
    throw new ApiError('Sessão expirada', 401);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = Array.isArray(data.details) ? ` (${data.details.map((d) => `${d.path}: ${d.message}`).join('; ')})` : '';
    throw new ApiError(`${data.error || `Erro HTTP ${r.status}`}${detail}`, r.status, data);
  }
  return data;
}
const iapi = (path, opts = {}) => api(path, { ...opts, instance: state.instanceId });

// ======================================================================= estado + rotas
const state = { user: null, instances: [], instanceId: null, instance: null, sse: null, timers: [] };

function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  clearTimers();
  sseHandlers.clear(); // cada página registra os próprios ouvintes de tempo real
  if (!state.user) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    // Atendente: só vê os números em que atende e as conversas distribuídas a ele.
    if (state.user.role === 'agent') {
      if (parts[0] === 'a' && parts[1]) {
        await selectAgentInstance(parts[1]);
        return pageChats();
      }
      closeSse();
      state.instanceId = null;
      state.instance = null;
      if (parts[0] === 'conta') return pageAccount();
      if (parts[0] === 'suporte') return pageSupport();
      return pageAgentHome();
    }
    if (parts[0] === 'i' && parts[1]) {
      await selectInstance(parts[1]);
      const page = parts[2] || 'visao';
      const pages = { visao: pageOverview, conversas: pageChats, enviar: pageSend, campanhas: pageCampaigns, webhooks: pageWebhooks, atendentes: pageAgents };
      return (pages[page] || pageOverview)();
    }
    closeSse();
    state.instanceId = null;
    state.instance = null;
    if (parts[0] === 'usuarios' && state.user.role === 'admin') return pageUsers();
    if (parts[0] === 'servidor' && state.user.role === 'admin') return pageServerWebhook();
    if (parts[0] === 'relatos' && state.user.role === 'admin') return pageBugReports();
    if (parts[0] === 'conta') return pageAccount();
    if (parts[0] === 'suporte') return pageSupport();
    return pageInstances();
  } catch (err) {
    if (err.status !== 401) layout('Erro', el('div', { class: 'alert error' }, err.message));
  }
}
window.addEventListener('hashchange', route);

async function selectInstance(id) {
  if (state.instanceId !== id || !state.instance) {
    closeSse();
    state.instanceId = id;
    const list = await api('/instance/all');
    state.instances = list;
    state.instance = list.find((i) => i.id === id) || null;
    if (!state.instance) throw new ApiError('Instância não encontrada', 404);
    openSse();
  }
}

async function loadAgentInstances() {
  const r = await api('/agent/me');
  state.agentInstances = r.instances;
  return r.instances;
}

async function selectAgentInstance(id) {
  if (state.instanceId !== id || !state.instance) {
    closeSse();
    state.instanceId = id;
    const list = await loadAgentInstances();
    state.instance = list.find((i) => i.id === id) || null;
    if (!state.instance) throw new ApiError('Número não encontrado', 404);
    openSse();
  }
}

// ======================================================================= tempo real (SSE)
// O stream pode cair (rede, proxy, token de 15 min). Reconecta SEMPRE, com espera
// crescente, e o chat faz uma verificação leve periódica enquanto o stream está fora —
// assim a resposta do cliente aparece mesmo se o tempo real falhar no caminho.
const sseHandlers = new Set();
const sseState = { lastEventAt: 0, connected: false, retry: 0 };
function openSse() {
  if (!state.instanceId) return;
  const id = state.instanceId;
  const es = new EventSource(`/sse?instance_id=${encodeURIComponent(id)}&events=connection,messages,messages_update,sender,call,chats`);
  state.sse = es;
  es.addEventListener('ready', () => {
    sseState.connected = true;
    sseState.retry = 0;
    sseState.lastEventAt = Date.now();
    document.body.classList.remove('rt-off');
  });
  for (const type of ['connection', 'messages', 'messages_update', 'sender', 'call', 'chats']) {
    es.addEventListener(type, (ev) => {
      sseState.lastEventAt = Date.now();
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (type === 'connection' && data.instance) {
        state.instance = { ...state.instance, ...data.instance };
      }
      sseHandlers.forEach((h) => h(type, data));
    });
  }
  es.onerror = async () => {
    es.close();
    if (state.sse !== es) return;
    state.sse = null;
    sseState.connected = false;
    document.body.classList.add('rt-off');
    sseState.retry = Math.min(sseState.retry + 1, 6);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** Math.min(sseState.retry, 4)));
    if (state.instanceId !== id) return;
    // Access token expira em 15 min: renova; se não precisar/der, tenta reabrir mesmo assim.
    await tryRefresh().catch(() => false);
    if (state.instanceId === id && !state.sse) openSse();
  };
}
function closeSse() {
  if (state.sse) state.sse.close();
  state.sse = null;
  sseState.connected = false;
  sseHandlers.clear();
}

// ======================================================================= layout
function navLink(hash, label) {
  const active = location.hash === hash || (hash !== '#/' && location.hash.startsWith(hash));
  return el('a', { href: hash, class: active ? 'active' : '' }, label);
}

function layout(title, content, { subtitle, actions } = {}) {
  const side = el(
    'aside',
    { class: 'side' },
    el('div', { class: 'brand' }, el('img', { src: '/assets/favicon.svg', alt: '' }), 'NexusWA'),
    state.user.role === 'agent' ? el('nav', { class: 'nav' },
      navLink('#/', '🎧  Atendimento'),
      (state.agentInstances || []).map((i) => navLink(`#/a/${i.id}`, `💬  ${i.name}`)),
      el('div', { class: 'nav-label' }, 'Conta'),
      navLink('#/conta', '🔐  Minha conta'),
      navLink('#/suporte', '🐞  Relatar problema'),
    ) : el('nav', { class: 'nav' },
      navLink('#/', '📱  Instâncias'),
      state.instance && [
        el('div', { class: 'nav-label' }, state.instance.name),
        navLink(`#/i/${state.instanceId}/visao`, '🔌  Conexão'),
        navLink(`#/i/${state.instanceId}/conversas`, '💬  Conversas'),
        navLink(`#/i/${state.instanceId}/enviar`, '✉️  Enviar mensagem'),
        navLink(`#/i/${state.instanceId}/campanhas`, '📣  Campanhas'),
        navLink(`#/i/${state.instanceId}/webhooks`, '🔗  Webhooks'),
        navLink(`#/i/${state.instanceId}/atendentes`, '🎧  Atendentes'),
      ],
      el('div', { class: 'nav-label' }, 'Conta'),
      state.user.role === 'admin' && navLink('#/usuarios', '👥  Usuários'),
      state.user.role === 'admin' && navLink('#/servidor', '🌐  Webhook do servidor'),
      state.user.role === 'admin' && navLink('#/relatos', '📥  Relatos recebidos'),
      navLink('#/conta', '🔐  Minha conta'),
      navLink('#/suporte', '🐞  Relatar problema'),
    ),
    el('div', { class: 'side-foot small' },
      el('div', { class: 'muted' }, state.user.email),
      el('div', { class: 'muted' }, { admin: 'Administrador', client: 'Cliente', agent: 'Atendente' }[state.user.role] || state.user.role),
      actionBtn('Sair', logout, 'btn sm'),
    ),
  );
  const menuBtn = el('button', { class: 'btn sm menu-btn', type: 'button', onclick: () => side.classList.toggle('open') }, '☰ Menu');
  side.addEventListener('click', (e) => e.target.tagName === 'A' && side.classList.remove('open'));
  const main = el('main', { class: 'main' },
    el('div', { class: 'head' },
      el('div', {}, menuBtn, el('h1', {}, title), subtitle && el('div', { class: 'muted' }, subtitle)),
      actions && el('div', { class: 'row' }, actions),
    ),
    content,
  );
  $app.replaceChildren(el('div', { class: 'shell' }, side, main));
}

function statusBadge(status) {
  const map = { connected: 'Conectado', connecting: 'Conectando', disconnected: 'Desconectado', hibernated: 'Hibernando' };
  return el('span', { class: `badge ${status}` }, map[status] || status);
}

// ======================================================================= login
function renderLogin(message) {
  closeSse();
  clearTimers();
  let needOtp = false;
  const otp = el('label', { style: 'display:none' }, 'Código do autenticador (2FA)', el('input', { name: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '\\d{6}' }));
  const err = el('div', { class: 'alert error', style: message ? '' : 'display:none' }, message || '');
  const btn = el('button', { class: 'btn primary', type: 'submit' }, 'Entrar');
  const form = el('form', { class: 'stack' },
    el('label', {}, 'E-mail', el('input', { name: 'email', type: 'email', required: true, autocomplete: 'username', autofocus: true })),
    el('label', {}, 'Senha', el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
    otp, err, btn,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.style.display = 'none';
    const f = formData(form);
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: f.email, password: f.password, ...(needOtp && f.otp ? { otp: f.otp } : {}) } });
      if (!cookie('nwa_csrf')) {
        throw new Error(location.protocol === 'http:' ? 'O navegador bloqueou o cookie de sessão porque a conexão não é HTTPS. Ative o SSL no Nginx Proxy Manager e acesse por https://' : 'O navegador bloqueou o cookie de sessão. Verifique se cookies estão permitidos para este site.');
      }
      state.user = r.user;
      if (!location.hash || location.hash === '#') location.hash = '#/';
      route();
    } catch (ex) {
      if (ex.data?.error_key === 'otp_required') {
        needOtp = true;
        otp.style.display = '';
        otp.querySelector('input').focus();
        err.textContent = 'Digite o código de 6 dígitos do seu app autenticador.';
      } else err.textContent = ex.message;
      err.style.display = '';
    } finally {
      btn.disabled = false;
    }
  });
  $app.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'card' }, el('div', { class: 'brand' }, el('img', { src: '/assets/favicon.svg', alt: '' }), 'NexusWA'), el('p', { class: 'muted', style: 'text-align:center;margin-top:0' }, 'Painel de automação do WhatsApp'), form)));
}

async function logout() {
  await api('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
  state.user = null;
  renderLogin('Você saiu da sua conta.');
}

// ======================================================================= instâncias
function toggleSwitch(name, checked, label) {
  return el('label', { class: 'switch-row' }, el('span', {}, label), el('span', { class: 'switch' }, el('input', { type: 'checkbox', name, checked }), el('span', { class: 'slider' })));
}

function copyField(label, value, { secret = false, hint } = {}) {
  const shown = el('span', { class: 'mono' }, secret ? '•'.repeat(Math.min(40, value.length)) : value);
  let visible = !secret;
  return el('div', { class: 'field' },
    el('div', { class: 'field-label' }, label),
    el('div', { class: 'field-box' },
      shown,
      el('span', { class: 'spacer' }),
      secret && el('button', { class: 'icon-btn', type: 'button', title: 'Mostrar/ocultar', onclick: () => { visible = !visible; shown.textContent = visible ? value : '•'.repeat(Math.min(40, value.length)); } }, '👁'),
      el('button', { class: 'icon-btn', type: 'button', title: 'Copiar', onclick: () => copy(value) }, '⧉'),
    ),
    hint && el('div', { class: 'muted small' }, hint),
  );
}

/** Admin Token escondido; aparece por 60 s só com o código do autenticador (2FA). */
function adminTokenField() {
  const box = el('div', { class: 'field-box muted' }, el('span', { class: 'mono' }, '•••••••••••••••••••••••••'), el('span', { class: 'spacer' }));
  const reveal = () => {
    const otp = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', class: 'otp-input' });
    modal('🔐 Ver Admin Token', el('div', { class: 'stack' }, el('p', { class: 'muted', style: 'margin:0' }, 'Digite o código de 6 dígitos do seu app autenticador (Google Authenticator, Authy…). O token aparece por 60 segundos.'), otp), [
      (close) => actionBtn('Mostrar', async () => {
        const r = await api('/admin/token/reveal', { method: 'POST', body: { otp: otp.value.trim() } });
        close();
        const shown = el('span', { class: 'mono' }, r.admin_token);
        box.replaceChildren(shown, el('span', { class: 'spacer' }), el('button', { class: 'icon-btn', type: 'button', title: 'Copiar', onclick: () => copy(r.admin_token) }, '⧉'));
        setTimeout(() => box.replaceChildren(el('span', { class: 'mono' }, '•••••••••••••••••••••••••'), el('span', { class: 'spacer' }), btn), (r.visible_for_seconds || 60) * 1000);
      }, 'btn primary'),
    ]);
  };
  const btn = el('button', { class: 'btn sm', type: 'button', onclick: reveal }, '👁 Ver (pede 2FA)');
  box.append(btn);
  return el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Admin Token'), box, el('div', { class: 'muted small' }, 'Chave-mestra do servidor. Só aparece com o código do autenticador (ative o 2FA em "Minha conta").'));
}

async function serverCard(total) {
  const dot = el('span', { class: 'dot' });
  const statusText = el('span', { class: 'small', style: 'font-weight:600' }, 'verificando…');
  const card = el('div', { class: 'card server-card' },
    el('div', { class: 'stack', style: 'flex:1;min-width:0' },
      copyField('Server URL', location.origin, { hint: 'Endereço base para n8n, sua loja e outros sistemas.' }),
      state.user.role === 'admin' && adminTokenField(),
      el('div', { class: 'row' }, dot, statusText, el('span', { class: 'muted small' }, `· ${total} instância(s)`)),
    ),
    el('button', { class: 'big-action', type: 'button', onclick: createInstanceModal }, '+', el('span', {}, 'Nova instância')),
  );
  fetch('/ready', { credentials: 'same-origin' })
    .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      dot.className = `dot ${ok ? 'on' : 'off'}`;
      statusText.textContent = ok ? 'online' : `instável (banco: ${j.database ? 'ok' : 'falha'}, redis: ${j.redis ? 'ok' : 'falha'})`;
    })
    .catch(() => {
      dot.className = 'dot off';
      statusText.textContent = 'offline';
    });
  return card;
}

function createInstanceModal() {
  const form = el('form', { class: 'stack' },
    el('label', {}, 'Nome da instância', el('input', { name: 'name', required: true, maxlength: '100', placeholder: 'Ex.: Loja - Atendimento' })),
    state.user.role === 'admin' && el('label', {}, 'Admin Field 01 (opcional)', el('input', { name: 'adminField01', maxlength: '500', placeholder: 'Ex.: cliente, plano, observação interna' })),
    state.user.role === 'admin' && el('label', {}, 'Admin Field 02 (opcional)', el('input', { name: 'adminField02', maxlength: '500' })),
  );
  let closeModal = () => undefined;
  const createBtn = actionBtn('Criar', async () => {
    const f = formData(form);
    if (!f.name) throw new Error('Informe um nome');
    const r = await api('/instance/create', { method: 'POST', body: { name: f.name, ...(f.adminField01 ? { adminField01: f.adminField01 } : {}), ...(f.adminField02 ? { adminField02: f.adminField02 } : {}) } });
    closeModal();
    showToken(r.token, r.instance.name, r.instance.id);
    if (!location.hash.startsWith('#/i/')) pageInstances();
  }, 'btn primary');
  closeModal = modal('Nova instância', form, [() => createBtn]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    createBtn.click();
  });
}

let instancesView = (() => {
  try {
    return localStorage.getItem('nwa_view') || 'cards';
  } catch {
    return 'cards';
  }
})();

async function pageInstances() {
  const list = await api('/instance/all');
  state.instances = list;
  const setView = (v) => {
    instancesView = v;
    try {
      localStorage.setItem('nwa_view', v);
    } catch {
      /* preferência apenas visual */
    }
    pageInstances();
  };
  const filter = el('input', { placeholder: 'Filtrar por nome ou número…', style: 'max-width:260px' });

  const cards = () => el('div', { class: 'grid cards' }, list.map((i) =>
    el('div', { class: 'card stack inst-card', 'data-q': `${i.name} ${i.owner} ${i.profileName}`.toLowerCase() },
      el('div', { class: 'row' },
        i.profilePicUrl ? el('img', { class: 'avatar', src: i.profilePicUrl, alt: '' }) : el('div', { class: 'avatar' }, initials(i.name)),
        el('div', { style: 'min-width:0;flex:1' }, el('div', { style: 'font-weight:600' }, i.name), el('div', { class: 'muted small' }, i.owner ? `+${i.owner}` : 'Sem número conectado')),
      ),
      el('div', { class: 'row' }, statusBadge(i.status), i.adminField01 && el('span', { class: 'tag' }, i.adminField01)),
      el('div', { class: 'muted small mono' }, `token: ${i.token_prefix}…`),
      el('div', { class: 'row' }, el('a', { class: 'btn primary sm', href: `#/i/${i.id}/visao` }, 'Abrir'), i.status === 'connected' && el('a', { class: 'btn sm', href: `#/i/${i.id}/conversas` }, 'Conversas'), el('a', { class: 'btn sm', href: `#/i/${i.id}/webhooks` }, 'Webhook')),
    )));

  const table = () => el('div', { class: 'card' }, el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ['Instância', 'Número', 'Status', 'Token', 'Admin Field 01', ''].map((h) => el('th', {}, h)))),
    el('tbody', {}, list.map((i) => el('tr', { class: 'inst-card', 'data-q': `${i.name} ${i.owner} ${i.profileName}`.toLowerCase() },
      el('td', {}, el('a', { href: `#/i/${i.id}/visao`, style: 'font-weight:600' }, i.name)),
      el('td', {}, i.owner ? `+${i.owner}` : '—'),
      el('td', {}, statusBadge(i.status)),
      el('td', { class: 'mono small' }, `${i.token_prefix}…`),
      el('td', { class: 'small' }, i.adminField01 || '—'),
      el('td', {}, el('a', { class: 'btn sm', href: `#/i/${i.id}/visao` }, 'Abrir')),
    ))),
  ));

  const body = list.length ? (instancesView === 'table' ? table() : cards()) : el('div', { class: 'card empty' }, el('p', {}, 'Nenhuma instância encontrada.'), el('button', { class: 'btn primary', type: 'button', onclick: createInstanceModal }, '+ Criar a primeira instância'));
  filter.addEventListener('input', () => {
    const q = filter.value.trim().toLowerCase();
    body.querySelectorAll('.inst-card').forEach((n) => {
      n.style.display = !q || n.getAttribute('data-q').includes(q) ? '' : 'none';
    });
  });

  layout('Conecte seu número', el('div', { class: 'stack' },
    await serverCard(list.length),
    el('div', { class: 'row' },
      el('h2', { style: 'margin:0' }, el('span', { class: 'count' }, list.length), ' total de instâncias'),
      el('span', { class: 'spacer' }),
      list.length > 0 && filter,
      el('div', { class: 'seg' },
        el('button', { type: 'button', class: instancesView === 'cards' ? 'active' : '', onclick: () => setView('cards') }, 'Cartões'),
        el('button', { type: 'button', class: instancesView === 'table' ? 'active' : '', onclick: () => setView('table') }, 'Tabela'),
      ),
      actionBtn('Atualizar', pageInstances, 'btn sm'),
    ),
    body,
  ), { subtitle: 'Cada instância é um número de WhatsApp conectado.' });
}

function showToken(token, name, id) {
  modal(`Token da instância "${name}"`, el('div', { class: 'stack' },
    el('div', { class: 'alert warn' }, 'Este token aparece SOMENTE AGORA — o servidor guarda apenas uma impressão digital (hash) dele. Guarde no seu cofre de senhas; ele vai no header "token" dos seus sistemas (n8n, loja…). Perdeu? Use "Gerar novo token".'),
    copyField('Instance Token', token),
    copyField('Server URL', location.origin),
    id && copyField('ID da instância', id),
    el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Teste rápido (terminal)'), el('pre', { class: 'code' }, `curl ${location.origin}/instance/status -H "token: ${token}"`)),
  ), [() => el('button', { class: 'btn primary', type: 'button', onclick: () => copy(token) }, 'Copiar token')]);
}

// ======================================================================= conexão / visão geral
const COUNTRIES = [['55', '🇧🇷 +55'], ['1', '🇺🇸 +1'], ['351', '🇵🇹 +351'], ['54', '🇦🇷 +54'], ['595', '🇵🇾 +595'], ['598', '🇺🇾 +598'], ['56', '🇨🇱 +56'], ['57', '🇨🇴 +57'], ['52', '🇲🇽 +52'], ['34', '🇪🇸 +34'], ['44', '🇬🇧 +44']];

async function pageOverview() {
  const id = state.instanceId;
  const refresh = async () => {
    const r = await iapi('/instance/status');
    state.instance = r.instance;
    return r;
  };
  await refresh();
  const box = el('div');
  const isAdmin = state.user.role === 'admin';

  const connectCard = (i) => {
    if (i.status === 'connected') {
      return el('div', { class: 'stack' }, el('div', { class: 'alert' }, '✅ WhatsApp conectado e pronto para enviar e receber mensagens.'), el('div', { class: 'row' }, el('a', { class: 'btn primary', href: `#/i/${id}/conversas` }, 'Abrir conversas'), el('a', { class: 'btn', href: `#/i/${id}/enviar` }, 'Enviar mensagem')));
    }
    const cancel = actionBtn('Cancelar tentativa', async () => {
      await iapi('/instance/disconnect', { method: 'POST', body: {} });
      await refresh();
      render();
    }, 'btn sm');
    if (i.qrcode) {
      return el('div', { class: 'stack center' },
        el('h3', {}, 'Escaneie o QR Code'),
        el('p', { class: 'muted small' }, 'No celular: WhatsApp → Aparelhos conectados → Conectar aparelho.'),
        el('div', { class: 'qr' }, el('img', { src: i.qrcode, alt: 'QR Code de conexão' })),
        el('p', { class: 'muted small' }, 'O QR Code se renova sozinho a cada ~20 segundos.'),
        cancel,
      );
    }
    if (i.paircode) {
      const last = state.lastPairPhone || '';
      // Contas brasileiras antigas são registradas SEM o 9 depois do DDD; o código só
      // funciona com o número exatamente como está registrado no WhatsApp.
      const alt = last.length === 13 && last.startsWith('55') && last[4] === '9' ? last.slice(0, 4) + last.slice(5) : last.length === 12 && last.startsWith('55') ? `${last.slice(0, 4)}9${last.slice(4)}` : '';
      return el('div', { class: 'stack center' },
        el('h3', {}, 'Digite este código no celular'),
        el('p', { class: 'muted small' }, 'WhatsApp → Aparelhos conectados → Conectar aparelho → "Conectar com número de telefone". Digite rápido: o código vale por pouco tempo.'),
        el('div', { class: 'paircode' }, i.paircode.replace(/^(.{4})(.{4})$/, '$1-$2')),
        el('button', { class: 'btn sm', type: 'button', onclick: () => copy(i.paircode) }, 'Copiar código'),
        el('div', { class: 'alert small' }, 'Se o celular disser "Não foi possível conectar o dispositivo", gere um código novo. Se continuar, tente o número no outro formato (com ou sem o 9).'),
        el('div', { class: 'row', style: 'justify-content:center' },
          last && actionBtn('🔄 Gerar código novo', () => connect({ phone: last }), 'btn sm'),
          alt && actionBtn(alt.length === 12 ? 'Tentar sem o 9' : 'Tentar com o 9', () => connect({ phone: alt }), 'btn sm'),
          cancel,
        ),
      );
    }
    const ddi = el('select', { class: 'ddi', 'aria-label': 'Código do país' }, COUNTRIES.map(([v, t]) => el('option', { value: v }, t)));
    const phone = el('input', { placeholder: '19 99999-9999', inputmode: 'tel', maxlength: '20', 'aria-label': 'Telefone' });
    const pairBtn = actionBtn('Gerar código de pareamento', () => {
      const digits = ddi.value + phone.value.replace(/\D/g, '');
      if (!/^\d{10,15}$/.test(digits)) throw new Error('Número inválido: informe DDD + número');
      return connect({ phone: digits });
    }, 'btn');
    pairBtn.disabled = true;
    phone.addEventListener('input', () => {
      pairBtn.disabled = phone.value.replace(/\D/g, '').length < 8;
    });
    return el('div', { class: 'stack' },
      el('h3', {}, 'Conectar'),
      el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Telefone'), el('div', { class: 'muted small' }, 'Opcional — serve para gerar o código de pareamento (quando você só tem o celular).'), el('div', { class: 'phone-row' }, ddi, phone)),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, pairBtn, actionBtn('Gerar QR Code', () => connect({}), 'btn primary')),
    );
  };

  const adminForm = (i) => {
    const form = el('form', { class: 'stack' },
      el('label', {}, 'Nome da instância', el('input', { name: 'name', value: i.name, maxlength: '100', required: true })),
      el('label', {}, 'Admin Field 01', el('input', { name: 'adminField01', value: i.adminField01 || '', maxlength: '500', disabled: !isAdmin, placeholder: 'Informações sobre a instância (01)' })),
      el('label', {}, 'Admin Field 02', el('input', { name: 'adminField02', value: i.adminField02 || '', maxlength: '500', disabled: !isAdmin, placeholder: 'Informações sobre a instância (02)' })),
      !isAdmin && el('p', { class: 'muted small' }, 'Os campos administrativos só podem ser editados por um administrador.'),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, el('button', { class: 'btn primary', type: 'submit' }, 'Salvar informações')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const f = formData(form);
        if (f.name && f.name !== i.name) await iapi('/instance/updateInstanceName', { method: 'POST', body: { name: f.name } });
        if (isAdmin && (f.adminField01 !== (i.adminField01 || '') || f.adminField02 !== (i.adminField02 || ''))) {
          await api('/instance/updateAdminFields', { method: 'POST', body: { id: i.id, adminField01: f.adminField01, adminField02: f.adminField02 } });
        }
        await refresh();
        state.instances = state.instances.map((x) => (x.id === i.id ? state.instance : x));
        toast('Informações salvas');
        layoutRefresh();
      } catch (ex) {
        toast(ex.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });
    return form;
  };

  const render = () => {
    const i = state.instance;
    box.replaceChildren(
      el('div', { class: 'grid cols-2' },
        el('div', { class: 'stack' },
          el('div', { class: 'card stack data-card' },
            el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Dados da instância'), el('span', { class: 'spacer' }), statusBadge(i.status)),
            copyField('Server URL', location.origin),
            el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Instance Token'), el('div', { class: 'field-box' }, el('span', { class: 'mono' }, `${i.token_prefix}…`), el('span', { class: 'spacer' }), el('span', { class: 'muted small' }, 'oculto por segurança'))),
            copyField('ID da instância', i.id),
            el('dl', { class: 'kv' },
              el('dt', {}, 'Número conectado'), el('dd', {}, i.owner ? `+${i.owner}` : '—'),
              el('dt', {}, 'Nome no WhatsApp'), el('dd', {}, i.profileName || '—'),
              el('dt', {}, 'Conta Business'), el('dd', {}, i.isBusiness ? 'Sim' : 'Não'),
              el('dt', {}, 'Status'), el('dd', {}, i.status),
              el('dt', {}, 'Última queda'), el('dd', {}, i.lastDisconnect ? `${new Date(i.lastDisconnect).toLocaleString('pt-BR')} (${i.lastDisconnectReason || '—'})` : '—'),
            ),
            el('div', { class: 'row' },
              actionBtn('Gerar novo token', async () => {
                const r = await iapi('/instance/token/rotate', { method: 'POST', body: { id: i.id } });
                showToken(r.token, i.name, i.id);
              }),
              el('a', { class: 'btn', href: `#/i/${id}/webhooks` }, 'Configurar webhook'),
              i.status !== 'disconnected' && actionBtn('Reiniciar conexão', async () => {
                await iapi('/instance/reset', { method: 'POST', body: {} });
                toast('Reiniciando…');
                setTimeout(() => refresh().then(render), 2000);
              }),
            ),
          ),
          el('div', { class: 'card' }, adminForm(i)),
        ),
        el('div', { class: 'stack' },
          el('div', { class: 'card' }, connectCard(i)),
          el('div', { class: 'card stack danger-zone' },
            el('h3', {}, 'Zona de perigo'),
            el('div', { class: 'row' },
              i.status !== 'disconnected' && actionBtn('Desconectar WhatsApp', async () => {
                confirmTyped('Desconectar WhatsApp', 'O aparelho será desvinculado e será preciso conectar de novo.', 'desconectar', async () => {
                  await iapi('/instance/disconnect', { method: 'POST', body: {} });
                  await refresh();
                  render();
                });
              }, 'btn danger'),
              actionBtn('⚠ Apagar instância', async () => {
                confirmTyped('Apagar instância', 'Apaga a instância, a sessão, conversas, campanhas e webhooks. Não pode ser desfeito.', i.name, async () => {
                  await iapi('/instance', { method: 'DELETE' });
                  toast('Instância apagada');
                  state.instance = null;
                  go('#/');
                });
              }, 'btn danger'),
            ),
          ),
        ),
      ),
    );
  };

  const connect = async (body) => {
    if (body.phone) state.lastPairPhone = body.phone;
    const r = await iapi('/instance/connect', { method: 'POST', body });
    state.instance = r.instance;
    render();
  };

  sseHandlers.add((type) => {
    if (type === 'connection' && state.instanceId === id) {
      render();
      if (state.instance.status === 'connected') toast('WhatsApp conectado! 🎉');
    }
  });
  // Fallback caso o SSE esteja bloqueado por algum proxy: consulta a cada 5s enquanto conecta.
  state.timers.push(setInterval(async () => {
    if (state.instance?.status === 'connecting') {
      await refresh().catch(() => undefined);
      render();
    }
  }, 5000));

  const layoutRefresh = () => layout(state.instance.name, box, { subtitle: 'Dados, conexão e configurações da instância' });
  render();
  layoutRefresh();
}

// ======================================================================= conversas
const TYPE_LABEL = { poll_vote: '📊 Votou na enquete', button_reply: '🔘 Tocou num botão', list_reply: '📋 Escolheu na lista', interactive_reply: '🔘 Respondeu', image: '📷 Foto', video: '🎥 Vídeo', ptv: '🎥 Vídeo', audio: '🎤 Áudio', document: '📄 Documento', sticker: '💟 Figurinha', location: '📍 Localização', contact: '👤 Contato', poll: '📊 Enquete', call: '📞 Chamada', interactive: '🔘 Mensagem com botões', event: '📅 Evento', reaction: 'Reação' };

/** Texto com *negrito*, _itálico_, ~riscado~ e links — tudo via nós de texto (sem HTML injetável). */
function richText(str) {
  const out = [];
  const urlRe = /(https?:\/\/[^\s<>"']+)/g;
  let last = 0;
  const fmt = (s) => {
    const parts = s.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
    return parts.map((p) => {
      if (/^\*[^*\n]+\*$/.test(p)) return el('strong', {}, p.slice(1, -1));
      if (/^_[^_\n]+_$/.test(p)) return el('em', {}, p.slice(1, -1));
      if (/^~[^~\n]+~$/.test(p)) return el('s', {}, p.slice(1, -1));
      return p;
    });
  };
  for (const m of str.matchAll(urlRe)) {
    out.push(...fmt(str.slice(last, m.index)));
    out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer nofollow' }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(...fmt(str.slice(last)));
  return out;
}

const fmtBytes = (n) => (!n ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fmtSecs = (s) => (!s ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);
const nameColor = (s) => {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `color:hsl(${h},65%,58%)`;
};

/** Baixa (sob demanda) a mídia de uma mensagem e devolve a URL assinada. Cache + limite de concorrência. */
const mediaCache = new Map();
let mediaActive = 0;
const mediaQueue = [];
function mediaUrl(m) {
  const cached = m.fileURL && Number(new URL(m.fileURL, location.origin).searchParams.get('e')) * 1000 > Date.now() + 60_000;
  if (cached) return Promise.resolve(m.fileURL);
  if (mediaCache.has(m.id)) return mediaCache.get(m.id);
  const p = new Promise((resolve, reject) => {
    const run = async () => {
      mediaActive++;
      try {
        const r = await iapi('/message/download', { method: 'POST', body: { id: m.id, generate_mp3: true } });
        resolve(r.fileURL);
      } catch (err) {
        mediaCache.delete(m.id);
        reject(err);
      } finally {
        mediaActive--;
        mediaQueue.shift()?.();
      }
    };
    if (mediaActive < 3) run();
    else mediaQueue.push(run);
  });
  mediaCache.set(m.id, p);
  return p;
}

const lazyObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    lazyObserver.unobserve(e.target);
    e.target.dispatchEvent(new Event('nwa-visible'));
  }
}, { rootMargin: '200px' }) : null;
function whenVisible(node, fn) {
  node.addEventListener('nwa-visible', fn, { once: true });
  if (lazyObserver) lazyObserver.observe(node);
  else fn();
}

function openImage(url) {
  const bg = el('div', { class: 'lightbox', onclick: () => bg.remove() }, el('img', { src: url, alt: '' }), el('a', { class: 'btn sm lb-dl', href: url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, 'Baixar'));
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      bg.remove();
      document.removeEventListener('keydown', esc);
    }
  });
  document.body.append(bg);
}

function mediaError(box, err) {
  box.replaceChildren(el('div', { class: 'media-err' }, '⚠ Não foi possível carregar a mídia', el('div', { class: 'small' }, err.message)));
}

function renderMedia(m) {
  const md = m.media || {};
  switch (md.kind) {
    case 'image':
    case 'sticker': {
      const sticker = md.kind === 'sticker';
      const img = el('img', { class: sticker ? 'sticker' : 'photo', alt: sticker ? 'Figurinha' : 'Foto', src: md.thumb || undefined });
      if (md.width && md.height && !sticker) img.style.aspectRatio = `${md.width} / ${md.height}`;
      const box = el('div', { class: `media ${sticker ? 'is-sticker' : ''} ${md.thumb ? 'blurred' : 'loading'}` }, img);
      whenVisible(box, () =>
        mediaUrl(m)
          .then((url) => {
            img.src = url;
            box.classList.remove('blurred', 'loading');
            if (!sticker) box.addEventListener('click', () => openImage(url));
          })
          .catch((err) => mediaError(box, err)),
      );
      return box;
    }
    case 'video':
    case 'ptv': {
      const box = el('div', { class: `media video ${md.kind === 'ptv' ? 'round' : ''} ${md.thumb ? '' : 'loading'}` },
        md.thumb && el('img', { class: 'photo', src: md.thumb, alt: '' }),
        el('button', { class: 'play', type: 'button', 'aria-label': 'Reproduzir vídeo' }, '▶'),
        md.seconds && el('span', { class: 'dur' }, `🎥 ${fmtSecs(md.seconds)}`),
      );
      box.querySelector('.play').addEventListener('click', async () => {
        box.classList.add('loading');
        try {
          const url = await mediaUrl(m);
          const v = el('video', { class: 'photo', src: url, controls: true, autoplay: true, playsinline: true, preload: 'auto' });
          if (md.gif) {
            v.loop = true;
            v.muted = true;
          }
          box.replaceChildren(v);
          box.classList.remove('loading');
        } catch (err) {
          mediaError(box, err);
        }
      });
      return box;
    }
    case 'audio': {
      const btn = el('button', { class: 'play-audio', type: 'button', 'aria-label': 'Ouvir áudio' }, '▶');
      const box = el('div', { class: 'audio-box' },
        el('div', { class: 'avatar mic' }, md.ptt ? '🎤' : '🎵'),
        btn,
        el('div', { class: 'wave' }, el('div', { class: 'bar' }), el('span', { class: 'small muted' }, fmtSecs(md.seconds) || (md.ptt ? 'Mensagem de voz' : 'Áudio'))),
      );
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const url = await mediaUrl(m);
          const a = el('audio', { src: url, controls: true, autoplay: true, preload: 'auto' });
          box.replaceChildren(el('div', { class: 'avatar mic' }, md.ptt ? '🎤' : '🎵'), a);
        } catch (err) {
          mediaError(box, err);
        }
      });
      return box;
    }
    case 'document': {
      const ext = (md.fileName || '').split('.').pop()?.toUpperCase().slice(0, 4) || 'DOC';
      const dl = el('button', { class: 'btn sm', type: 'button' }, 'Baixar');
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        try {
          const url = await mediaUrl(m);
          const a = el('a', { href: url, target: '_blank', rel: 'noopener' });
          document.body.append(a);
          a.click();
          a.remove();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          dl.disabled = false;
        }
      });
      return el('div', { class: 'doc' },
        md.thumb ? el('img', { class: 'doc-thumb', src: md.thumb, alt: '' }) : el('div', { class: 'doc-ico' }, ext),
        el('div', { class: 'doc-meta' }, el('div', { class: 'doc-name' }, md.fileName || 'Documento'), el('div', { class: 'small muted' }, [ext, fmtBytes(md.fileLength)].filter(Boolean).join(' · '))),
        dl,
      );
    }
    case 'location': {
      const q = `${md.latitude},${md.longitude}`;
      return el('a', { class: 'loc', href: `https://www.google.com/maps?q=${encodeURIComponent(q)}`, target: '_blank', rel: 'noopener noreferrer' },
        md.thumb ? el('img', { class: 'photo', src: md.thumb, alt: '' }) : el('div', { class: 'loc-map' }, '📍'),
        el('div', { class: 'loc-meta' }, el('strong', {}, md.name || 'Localização'), md.address && el('div', { class: 'small muted' }, md.address), el('div', { class: 'small muted' }, q)),
      );
    }
    case 'contact':
      return el('div', { class: 'stack', style: 'gap:6px' }, (md.contacts || []).map((c) =>
        el('div', { class: 'contact-card' }, el('div', { class: 'avatar' }, initials(c.name)), el('div', {}, el('strong', {}, c.name), c.phones.map((p) => el('div', { class: 'small muted' }, p))))));
    case 'poll': {
      const votes = Object.fromEntries(String(m.vote || '').split(',').map((s) => s.trim().split(':')).filter((p) => p.length === 2).map(([k, v]) => [k, Number(v)]));
      const total = Object.values(votes).reduce((a, b) => a + b, 0) || 0;
      return el('div', { class: 'poll' }, el('strong', {}, `📊 ${md.title || 'Enquete'}`), (md.options || []).map((o) => {
        const n = votes[o] || 0;
        return el('div', { class: 'poll-opt' }, el('div', { class: 'row' }, el('span', {}, o), el('span', { class: 'spacer' }), el('span', { class: 'small muted' }, n)), el('div', { class: 'progress' }, el('div', { style: `width:${total ? Math.round((n / total) * 100) : 0}%` })));
      }), el('div', { class: 'small muted' }, `${total} voto(s)`), String(m.error || '').startsWith('enquete:') && el('div', { class: 'small error-text' }, `⚠ ${m.error.slice(9)}`));
    }
    case 'interactive':
      return el('div', { class: 'interactive' },
        md.thumb && el('img', { class: 'photo', src: md.thumb, alt: '' }),
        md.title && el('strong', {}, md.title),
        md.body && el('div', { class: 'txt' }, richText(md.body)),
        md.options?.length > 0 && el('ul', { class: 'small list-opts' }, md.options.map((o) => el('li', {}, o))),
        md.footer && el('div', { class: 'small muted' }, md.footer),
      );
    case 'event':
      return el('div', { class: 'contact-card' }, el('div', { class: 'avatar' }, '📅'), el('div', {}, el('strong', {}, md.title || 'Evento'), md.body && el('div', { class: 'small' }, md.body), md.duration && el('div', { class: 'small muted' }, new Date(md.duration * 1000).toLocaleString('pt-BR'))));
    default:
      return null;
  }
}

function renderBubble(m, ctx) {
  const md = m.media || {};
  // "editada": para o dono/admin, clicar mostra o texto original (o atendente não recebe o original).
  const editedTag = m.edited ? (m.original_text ? el('button', { type: 'button', class: 'edited-tag', title: 'Ver o texto antes da correção', onclick: (e) => { e.stopPropagation(); modal('✏️ Mensagem corrigida', el('div', { class: 'stack' }, el('div', { class: 'field-label' }, 'Antes'), el('div', { class: 'field-box pre' }, m.original_text || '(sem texto)'), el('div', { class: 'field-label' }, 'Depois (o cliente vê esta)'), el('div', { class: 'field-box pre' }, m.text || ''))); } }, 'editada ✎ · ') : 'editada · ') : '';
  const when = el('span', { class: 'when' }, editedTag, fmtDate(m.messageTimestamp), m.fromMe ? el('span', { class: `tick ${m.status === 'Read' || m.status === 'Played' ? 'read' : ''}` }, { Queued: ' 🕓', Pending: ' 🕓', Sent: ' ✓', Delivered: ' ✓✓', Read: ' ✓✓', Played: ' ✓✓', Failed: ' ⚠' }[m.status] || '') : '');

  if (md.kind === 'call' || m.messageType === 'call') {
    const missed = ['timeout', 'reject', 'MISSED', 'missed'].includes(md.callStatus);
    return el('div', { class: `msg call ${m.fromMe ? 'me' : ''}` },
      el('div', { class: `call-ico ${missed ? 'missed' : ''}` }, md.isVideo ? '📹' : '📞'),
      el('div', {}, el('div', { style: 'font-weight:600' }, m.text || (md.isVideo ? 'Chamada de vídeo' : 'Chamada de voz')), md.duration && el('div', { class: 'small muted' }, fmtSecs(md.duration))),
      when,
    );
  }
  if (m.status === 'Deleted') {
    return el('div', { class: `msg ${m.fromMe ? 'me' : ''}` }, el('span', { class: 'deleted' }, '🚫 Mensagem apagada'), when);
  }

  const media = renderMedia(m);
  const quotedBox = md.quoted && md.quoted.id && (() => {
    const orig = ctx.byId.get(md.quoted.id);
    const who = orig ? (orig.fromMe ? 'Você' : orig.senderName || phoneOf(orig.sender)) : phoneOf(md.quoted.participant) || 'Mensagem';
    return el('div', { class: 'quote' }, el('div', { class: 'q-who', style: nameColor(who) }, who), el('div', { class: 'q-txt' }, md.quoted.text || TYPE_LABEL[md.quoted.type] || `[${md.quoted.type}]`));
  })();
  // Legenda: mídia com caption usa o campo text da própria mensagem.
  const showText = m.text && !['interactive', 'poll', 'contact', 'location', 'event'].includes(md.kind);
  const sticker = md.kind === 'sticker';
  const reacts = ctx.reactions.get(m.messageid);

  return el('div', { class: `msg ${m.fromMe ? 'me' : ''} ${sticker ? 'bare' : ''} ${media && !showText && ['image', 'video', 'ptv'].includes(md.kind) ? 'media-only' : ''}` },
    ctx.isGroup && !m.fromMe && el('div', { class: 'who', style: nameColor(m.senderName || m.sender) }, m.senderName || `+${phoneOf(m.sender)}`),
    md.forwarded && el('div', { class: 'fwd' }, '↪ Encaminhada'),
    md.viewOnce && el('div', { class: 'fwd' }, '① Visualização única'),
    quotedBox,
    media,
    showText && el('div', { class: 'txt' }, richText(m.text)),
    !media && !showText && el('div', { class: 'type' }, TYPE_LABEL[md.kind] || `[${String(m.messageType || 'mensagem').replace(/Message$/, '')}]`),
    m.transcription && el('div', { class: 'small muted' }, `📝 ${m.transcription}`),
    when,
    // Como no WhatsApp: a hora fica no corpo e os botões vêm depois, ocupando a largura toda.
    md.kind === 'interactive' && md.buttons?.length > 0 && el('div', { class: 'btns' }, md.buttons.map((b) => el('div', { class: 'wa-btn' }, b))),
    reacts && el('div', { class: 'reacts' }, [...new Set(reacts)].join(' '), reacts.length > 1 ? ` ${reacts.length}` : ''),
  );
}

/** Nome para exibir: nunca mostra o ID interno @lid como se fosse telefone. */
function chatTitle(c) {
  const id = String(c.wa_chatid || '');
  return c.name || c.wa_contactName || c.wa_name || (id.endsWith('@lid') ? 'Contato (número oculto)' : c.wa_isGroup || id.endsWith('@g.us') ? 'Grupo sem nome' : `+${phoneOf(id)}`);
}
const chatSubtitle = (chatid) => (chatid.endsWith('@g.us') ? 'Grupo' : chatid.endsWith('@lid') ? 'Número oculto pelo WhatsApp' : `+${phoneOf(chatid)}`);

/** Número digitado → só dígitos, com 55 quando parece número brasileiro sem DDI. */
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 10 || d.length === 11 ? `55${d}` : d;
}

// Mensagens internas do WhatsApp que não devem virar bolha no chat.
const HIDDEN_TYPES = new Set(['reactionMessage', 'protocolMessage', 'pollUpdateMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'keepInChatMessage']);

/** Senha confirmada para ver conversas trancadas (15 min, só nesta aba). */
async function unlockChats() {
  const pw = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Sua senha de acesso ao painel' });
  return new Promise((resolve) => {
    modal('🔒 Conversas trancadas', el('div', { class: 'stack' }, el('p', { class: 'muted', style: 'margin:0' }, 'Por segurança, confirme sua senha para ver as conversas trancadas. Elas ficam abertas por 15 minutos.'), pw), [
      (close) => actionBtn('Abrir', async () => {
        const r = await iapi('/chat/unlock', { method: 'POST', body: { password: pw.value } });
        state.unlock = { instanceId: state.instanceId, token: r.unlock_token, exp: Date.now() + r.expires_in * 1000 };
        close();
        resolve(true);
      }, 'btn primary'),
    ]);
  });
}
const hasUnlock = () => state.unlock && state.unlock.instanceId === state.instanceId && state.unlock.exp > Date.now();

async function pageChats() {
  const isAgent = state.user.role === 'agent';
  const side = el('div', { class: 'chat-list' });
  const conv = el('div', { class: 'conv' }, el('div', { class: 'empty conv-empty' }, el('div', { class: 'big-ico' }, '💬'), el('div', {}, 'Escolha uma conversa na lista')));
  let view = 'chats';
  let current = null;
  let currentIsGroup = false;
  let search = '';
  let limit = 60;
  let chip = isAgent ? 'open' : 'all';
  let attendant = '';
  let lists = [];
  let replyTo = null;
  const chatsById = new Map();
  let team = [];
  const teamName = (id) => {
    if (isAgent && id === state.user.id) return 'Você';
    const a = team.find((x) => x.user_id === id);
    return a?.name || a?.email || 'Atendente';
  };
  const loadTeam = async () => {
    team = await iapi('/ticket/agents').catch(() => []);
  };
  const loadLists = async () => {
    lists = await iapi('/lists').catch(() => [{ id: 'favoritas', name: 'Favoritas', builtin: true }]);
  };

  // ------------------------------------------------------------ trilho lateral (como o WhatsApp Web)
  const railItems = [
    ['chats', '💬', 'Conversas'],
    !isAgent && ['updates', '⭕', 'Atualizações'],
    !isAgent && ['calls', '📞', 'Ligações'],
    (isAgent || team.length) && ['team', '🎧', 'Equipe'],
    !isAgent && ['profile', '⚙️', 'Perfil'],
  ];
  const rail = el('nav', { class: 'wa-rail', 'aria-label': 'Ferramentas' });
  const drawRail = () => {
    rail.replaceChildren(...railItems.filter(Boolean).map(([v, icon, label]) => el('button', { type: 'button', class: `rail-btn ${view === v ? 'active' : ''}`, title: label, onclick: () => { view = v; drawRail(); drawSide(); } }, el('span', { class: 'rail-ico' }, icon), el('span', { class: 'rail-label' }, label))));
  };

  // ------------------------------------------------------------ lista de conversas
  const listBox = el('div', { class: 'chat-list-items' });
  const searchInput = el('input', { type: 'search', placeholder: '🔎 Pesquisar nome, número ou grupo', 'aria-label': 'Pesquisar conversas' });
  let st;
  searchInput.addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(() => {
      search = searchInput.value.trim();
      loadChats();
    }, 300);
  });
  const chipsBox = el('div', { class: 'chat-tabs' });
  const attendantBox = el('div');

  const chipDefs = () => (isAgent
    ? [['open', 'Em atendimento'], ['closed', 'Finalizadas'], ['unread', 'Não lidas'], ['fav', '⭐ Favoritas']]
    : [['all', 'Tudo'], ['unread', 'Não lidas'], ['fav', '⭐ Favoritas'], ['groups', 'Grupos'], ...lists.filter((l) => !l.builtin).map((l) => [`list:${l.id}`, l.name]), ['archived', '📦 Arquivadas'], hasUnlock() && ['locked', '🔒 Trancadas']].filter(Boolean));
  const drawChips = () => {
    chipsBox.replaceChildren(...chipDefs().map(([v, l]) => el('button', { type: 'button', class: `tab-btn ${chip === v ? 'active' : ''}`, onclick: () => { chip = v; drawChips(); loadChats(); } }, l)),
      !isAgent && el('button', { type: 'button', class: 'tab-btn add', title: 'Criar lista', onclick: () => listEditor() }, '＋ Lista'));
    attendantBox.replaceChildren();
    if (!isAgent && team.length) {
      const sel = el('select', { class: 'attendant-filter', 'aria-label': 'Filtrar por atendente' },
        el('option', { value: '' }, '🎧 Todos os atendentes'),
        el('option', { value: 'queue' }, '⏳ Na fila (sem atendente)'),
        team.map((a) => el('option', { value: a.user_id }, `${a.online ? '🟢' : '⚪'} ${a.name || a.email}`)),
      );
      sel.value = attendant;
      sel.addEventListener('change', () => { attendant = sel.value; loadChats(); });
      attendantBox.append(sel);
    }
  };

  const ticketTag = (c) => {
    if (c.wa_isGroup || String(c.wa_chatid).endsWith('@g.us')) return null;
    if (!isAgent && !team.length) return null;
    if (c.lead_isTicketOpen && c.lead_assignedAttendant_id) return el('span', { class: 'tag assigned' }, `🎧 ${teamName(c.lead_assignedAttendant_id)}`);
    if (c.lead_isTicketOpen) return el('span', { class: 'tag queue' }, '⏳ Na fila');
    if (c.lead_assignedAttendant_id) return el('span', { class: 'tag done' }, `✔ Finalizado · ${teamName(c.lead_assignedAttendant_id)}`);
    return null;
  };

  const loadChats = async () => {
    const f = {};
    if (chip === 'open') f.lead_isTicketOpen = true;
    if (chip === 'closed') f.lead_isTicketOpen = false;
    if (chip === 'unread') f.unread = true;
    if (chip === 'fav') f.list = 'favoritas';
    if (chip === 'groups') f.wa_isGroup = true;
    if (chip.startsWith('list:')) f.list = chip.slice(5);
    if (chip === 'locked') f.locked = true;
    f.wa_archived = chip === 'archived';
    if (attendant) f.attendant = attendant;
    const body = { compact: true, limit: 150, sort: '-wa_lastMsgTimestamp', ...(search ? { q: search } : {}), ...f };
    let r;
    try {
      r = await iapi('/chat/find', { method: 'POST', body });
    } catch (err) {
      if (err.status === 403 && chip === 'locked') {
        chip = 'all';
        drawChips();
        return loadChats();
      }
      throw err;
    }
    r.chats.forEach((c) => chatsById.set(c.wa_chatid, c));
    if (!r.chats.length) {
      const msg = search ? 'Nada encontrado com esse nome ou número.' : isAgent && chip === 'open' ? 'Nenhum cliente com você agora. Quando chegar um, ele aparece aqui sozinho.' : chip === 'archived' ? 'Nenhuma conversa arquivada.' : 'Nenhuma conversa aqui.';
      return listBox.replaceChildren(el('div', { class: 'empty' }, msg));
    }
    listBox.replaceChildren(...r.chats.map((c) => {
      const title = chatTitle(c);
      const last = c.wa_lastMessageTextVote || TYPE_LABEL[c.wa_lastMessageType] || '';
      const more = el('button', { type: 'button', class: 'icon-btn chat-more', title: 'Mais opções', 'aria-label': 'Mais opções' }, '⌄');
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        chatMenu(more, c);
      });
      const item = el('div', { role: 'button', tabindex: '0', class: `chat-item ${current === c.wa_chatid ? 'active' : ''}`, onclick: () => openChat(c.wa_chatid) },
        c.image ? el('img', { class: 'avatar', src: c.image, alt: '' }) : el('div', { class: 'avatar' }, c.wa_isGroup ? '👥' : initials(title)),
        el('div', { class: 'meta' },
          el('div', { class: 'name' }, title, c.wa_isPinned && el('span', { class: 'mini-ico', title: 'Fixada' }, ' 📌'), (c.lists || []).includes('favoritas') && el('span', { class: 'mini-ico', title: 'Favorita' }, ' ⭐'), Number(c.wa_muteEndTime || 0) !== 0 && el('span', { class: 'mini-ico', title: 'Silenciada' }, ' 🔇'), c.wa_isBlocked && el('span', { class: 'mini-ico', title: 'Bloqueado' }, ' 🚫')),
          el('div', { class: 'last' }, last),
          ticketTag(c),
        ),
        el('div', { class: 'chat-side' }, el('div', { class: 'muted small' }, fmtDate(c.wa_lastMsgTimestamp)), c.wa_unreadCount > 0 ? el('span', { class: 'unread' }, c.wa_unreadCount) : null, more),
      );
      item.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        chatMenu(more, c);
      });
      item.addEventListener('keydown', (e) => e.key === 'Enter' && openChat(c.wa_chatid));
      return item;
    }));
  };

  /** Ações da conversa (⌄ ou botão direito), como no WhatsApp. */
  const chatMenu = (anchor, c) => {
    const number = c.wa_chatid;
    const fav = (c.lists || []).includes('favoritas');
    const muted = Number(c.wa_muteEndTime || 0) !== 0;
    const after = async (msg) => {
      toast(msg);
      await loadChats();
    };
    popMenu(anchor, [
      { icon: '📦', label: c.wa_archived ? 'Desarquivar' : 'Arquivar conversa', onClick: async () => { await iapi('/chat/archive', { method: 'POST', body: { number, archive: !c.wa_archived } }); await after(c.wa_archived ? 'Conversa desarquivada' : 'Conversa arquivada'); } },
      { icon: '📌', label: c.wa_isPinned ? 'Desafixar' : 'Fixar no topo', onClick: async () => { await iapi('/chat/pin', { method: 'POST', body: { number, pin: !c.wa_isPinned } }); await after(c.wa_isPinned ? 'Desafixada' : 'Fixada no topo'); } },
      { icon: '🔵', label: c.wa_unreadCount > 0 ? 'Marcar como lida' : 'Marcar como não lida', onClick: async () => { await iapi('/chat/read', { method: 'POST', body: { number, read: c.wa_unreadCount > 0 } }); await after('Pronto'); } },
      { icon: '⭐', label: fav ? 'Tirar das favoritas' : 'Adicionar às favoritas', onClick: async () => { await iapi('/chat/lists', { method: 'POST', body: { number, ...(fav ? { remove: ['favoritas'] } : { add: ['favoritas'] }) } }); await after(fav ? 'Tirada das favoritas' : 'Adicionada às favoritas'); } },
      { icon: '📋', label: 'Adicionar a uma lista…', hidden: isAgent, onClick: () => chooseLists(c) },
      { sep: true, hidden: isAgent },
      { icon: muted ? '🔔' : '🔇', label: muted ? 'Reativar notificações' : 'Silenciar por 8 horas', hidden: isAgent, onClick: async () => { await iapi('/chat/mute', { method: 'POST', body: { number, muteEndTime: muted ? 0 : 8 } }); await after(muted ? 'Notificações reativadas' : 'Silenciada por 8 horas'); } },
      { icon: '🔒', label: c.locked ? 'Destrancar conversa' : 'Trancar conversa', hidden: isAgent, onClick: async () => {
        if (c.locked && !hasUnlock()) await unlockChats();
        await iapi('/chat/lock', { method: 'POST', body: { number, locked: !c.locked } });
        if (current === number && !c.locked) conv.replaceChildren(el('div', { class: 'empty conv-empty' }, '🔒 Conversa trancada'));
        await after(c.locked ? 'Conversa destrancada' : 'Conversa trancada: some da lista e só abre com a sua senha');
      } },
      { icon: '🚫', label: c.wa_isBlocked ? 'Desbloquear contato' : 'Bloquear contato', hidden: isAgent || c.wa_isGroup, danger: !c.wa_isBlocked, onClick: () => confirmTyped(c.wa_isBlocked ? 'Desbloquear' : 'Bloquear contato', c.wa_isBlocked ? 'O contato volta a poder mandar mensagens.' : 'O contato não conseguirá mais mandar mensagens para este número.', c.wa_isBlocked ? 'DESBLOQUEAR' : 'BLOQUEAR', async () => { await iapi('/chat/block', { method: 'POST', body: { number, block: !c.wa_isBlocked } }); await after(c.wa_isBlocked ? 'Desbloqueado' : 'Contato bloqueado'); }) },
      { icon: '🧹', label: 'Limpar conversa (apagar mensagens)', hidden: isAgent, danger: true, onClick: () => confirmTyped('Limpar conversa', 'Apaga todas as mensagens desta conversa neste número e no painel. A conversa continua na lista. O cliente mantém as mensagens dele.', 'LIMPAR', async () => {
        await iapi('/chat/delete', { method: 'POST', body: { number, clearChatWhatsApp: true, deleteMessagesDB: true } });
        if (current === number) await loadMsgs();
        await after('Conversa limpa');
      }) },
      { icon: '🗑', label: 'Apagar conversa', hidden: isAgent, danger: true, onClick: () => confirmTyped('Apagar conversa', 'Apaga a conversa deste painel e do WhatsApp deste número. O contato continua com as mensagens dele.', 'APAGAR', async () => {
        await iapi('/chat/delete', { method: 'POST', body: { number, deleteChatDB: true, deleteMessagesDB: true, deleteChatWhatsApp: true } });
        if (current === number) conv.replaceChildren(el('div', { class: 'empty conv-empty' }, 'Conversa apagada.'));
        await after('Conversa apagada');
      }) },
    ]);
  };

  const listEditor = () => {
    const name = el('input', { maxlength: '40', placeholder: 'Ex.: Clientes VIP, Orçamentos, Fornecedores' });
    modal('📋 Nova lista', el('div', { class: 'stack' }, el('p', { class: 'muted', style: 'margin:0' }, 'Listas servem para separar conversas (como no WhatsApp). Depois, no ⌄ de cada conversa, escolha "Adicionar a uma lista".'), el('label', {}, 'Nome da lista', name)), [
      (close) => actionBtn('Criar lista', async () => {
        lists = await iapi('/lists', { method: 'POST', body: { action: 'create', name: name.value } });
        close();
        drawChips();
        toast('Lista criada');
      }, 'btn primary'),
    ]);
  };
  const chooseLists = (c) => {
    const own = lists.filter((l) => !l.builtin);
    if (!own.length) return listEditor();
    const boxes = own.map((l) => ({ l, cb: el('input', { type: 'checkbox', checked: (c.lists || []).includes(l.id) }) }));
    modal(`Listas de ${chatTitle(c)}`, el('div', { class: 'stack' }, boxes.map(({ l, cb }) => el('label', { class: 'inline big-check' }, cb, l.name)), el('button', { type: 'button', class: 'btn sm', onclick: () => listEditor() }, '＋ Criar outra lista')), [
      (close) => actionBtn('Salvar', async () => {
        await iapi('/chat/lists', { method: 'POST', body: { number: c.wa_chatid, add: boxes.filter((b) => b.cb.checked).map((b) => b.l.id), remove: boxes.filter((b) => !b.cb.checked).map((b) => b.l.id) } });
        close();
        toast('Listas atualizadas');
        await loadChats();
      }, 'btn primary'),
    ]);
  };

  const newGroup = async () => {
    const r = await iapi('/chat/find', { method: 'POST', body: { compact: true, limit: 200, wa_isGroup: false, sort: '-wa_lastMsgTimestamp' } });
    const name = el('input', { maxlength: '100', placeholder: 'Nome do grupo' });
    const extra = el('textarea', { rows: '2', placeholder: 'Outros números (um por linha), com DDD' });
    const filter = el('input', { type: 'search', placeholder: '🔎 Procurar contato' });
    const chosen = new Set();
    const box = el('div', { class: 'pick-list' });
    const draw = () => {
      const q = filter.value.toLowerCase();
      box.replaceChildren(...r.chats.filter((c) => !q || `${chatTitle(c)} ${c.wa_chatid}`.toLowerCase().includes(q)).map((c) => {
        const cb = el('input', { type: 'checkbox', checked: chosen.has(c.wa_chatid) });
        cb.addEventListener('change', () => (cb.checked ? chosen.add(c.wa_chatid) : chosen.delete(c.wa_chatid)));
        return el('label', { class: 'pick-item' }, cb, el('span', { class: 'avatar sm' }, initials(chatTitle(c))), el('span', { class: 'pick-meta' }, el('strong', {}, chatTitle(c)), el('span', { class: 'small muted' }, chatSubtitle(c.wa_chatid))));
      }));
    };
    filter.addEventListener('input', draw);
    draw();
    modal('👥 Novo grupo', el('div', { class: 'stack' }, el('label', {}, 'Nome do grupo', name), el('div', { class: 'field-label' }, 'Quem vai participar'), filter, box, extra), [
      (close) => actionBtn('Criar grupo', async () => {
        const participants = [...chosen, ...extra.value.split(/\s*\n\s*|,/).map(normalizePhone).filter((d) => d.length >= 12)];
        if (!name.value.trim()) throw new Error('Dê um nome ao grupo');
        if (!participants.length) throw new Error('Escolha pelo menos uma pessoa');
        const g = await iapi('/group/create', { method: 'POST', body: { name: name.value.trim(), participants } });
        close();
        toast(g.failed?.length ? `Grupo criado. ${g.failed.length} número(s) não puderam ser adicionados.` : 'Grupo criado');
        await loadChats();
      }, 'btn primary'),
    ]);
  };

  // ------------------------------------------------------------ outras telas do trilho
  const updatesView = async (box) => {
    box.replaceChildren(el('div', { class: 'empty' }, 'Carregando…'));
    const [st, channels] = await Promise.all([
      iapi('/message/find', { method: 'POST', body: { chatid: 'status@broadcast', limit: 100 } }).catch(() => ({ messages: [] })),
      iapi('/newsletter/list').catch(() => null),
    ]);
    const bySender = new Map();
    for (const m of st.messages) {
      if (m.fromMe || HIDDEN_TYPES.has(m.messageType)) continue;
      const k = m.sender || 'x';
      bySender.set(k, [...(bySender.get(k) || []), m]);
    }
    const chList = Array.isArray(channels?.response) ? channels.response : Array.isArray(channels) ? channels : [];
    box.replaceChildren(
      el('div', { class: 'side-section' }, el('div', { class: 'section-title' }, 'Status'),
        el('button', { type: 'button', class: 'big-row', onclick: () => statusComposer() }, el('span', { class: 'avatar' }, '➕'), el('span', {}, el('strong', {}, 'Publicar meu status'), el('div', { class: 'small muted' }, 'Texto, foto ou vídeo — some em 24 horas'))),
        bySender.size ? [...bySender.entries()].map(([sender, items]) => el('button', { type: 'button', class: 'big-row', onclick: () => modal(items[0].senderName || `+${phoneOf(sender)}`, el('div', { class: 'msgs wa-bg status-view' }, items.slice().reverse().map((m) => renderBubble(m, { isGroup: false, reactions: new Map(), byId: new Map() })))) },
          el('span', { class: 'avatar ring' }, initials(items[0].senderName || '?')),
          el('span', {}, el('strong', {}, items[0].senderName || `+${phoneOf(sender)}`), el('div', { class: 'small muted' }, `${items.length} atualização(ões) · ${fmtDate(items[0].messageTimestamp)}`)),
        )) : el('p', { class: 'muted small pad' }, 'Nenhum status dos seus contatos nas últimas 24 horas.'),
      ),
      el('div', { class: 'side-section' }, el('div', { class: 'section-title' }, 'Canais'),
        chList.length ? chList.slice(0, 50).map((c) => el('div', { class: 'big-row' }, el('span', { class: 'avatar' }, '📢'), el('span', {}, el('strong', {}, c.name || c.thread_metadata?.name?.text || c.id), el('div', { class: 'small muted' }, c.subscribers ? `${c.subscribers} seguidores` : 'Canal')))) : el('p', { class: 'muted small pad' }, 'Nenhum canal seguido ou criado.'),
      ),
      el('p', { class: 'muted small pad' }, 'ℹ️ Anúncios pagos (Facebook/Instagram) só podem ser criados no app oficial WhatsApp Business.'),
    );
  };

  const statusComposer = () => {
    const text = el('textarea', { rows: '4', maxlength: '700', placeholder: 'Escreva seu status…' });
    const colors = ['#25D366', '#128C7E', '#34B7F1', '#FF8A8C', '#C1A03F', '#6E267D', '#243640', '#0B64C0'];
    let color = 1;
    const colorRow = el('div', { class: 'row' }, colors.map((cl, i) => el('button', { type: 'button', class: 'color-dot', title: `Cor ${i + 1}`, style: `background:${cl}`, onclick: () => { color = i + 1; } })));
    const drop = fileDrop({ label: 'Ou uma foto/vídeo', hint: 'Foto ou vídeo', accept: 'image/*,video/*' });
    modal('⭕ Publicar status', el('div', { class: 'stack' }, el('label', {}, 'Texto', text), el('div', { class: 'field-label' }, 'Cor de fundo (só para texto)'), colorRow, drop.el, el('p', { class: 'muted small', style: 'margin:0' }, 'Quem vê: os contatos salvos deste número.')), [
      (close) => actionBtn('Publicar', async () => {
        if (drop.has()) {
          const up = await drop.ready();
          await iapi('/send/status', { method: 'POST', body: { type: up.kind === 'video' ? 'video' : 'image', file: up.file, ...(text.value.trim() ? { text: text.value.trim() } : {}) } });
        } else {
          if (!text.value.trim()) throw new Error('Escreva o texto ou escolha uma foto/vídeo');
          await iapi('/send/status', { method: 'POST', body: { type: 'text', text: text.value.trim(), background_color: color } });
        }
        close();
        toast('Status publicado');
      }, 'btn primary'),
    ]);
  };

  const callsView = async (box) => {
    box.replaceChildren(el('div', { class: 'empty' }, 'Carregando…'));
    const r = await iapi('/message/find', { method: 'POST', body: { messageType: 'call', limit: 100 } }).catch(() => ({ messages: [] }));
    box.replaceChildren(
      el('p', { class: 'muted small pad' }, 'Histórico de ligações recebidas. Pelo painel não é possível ligar (o WhatsApp não permite para aparelhos conectados).'),
      el('div', {}, r.messages.length ? r.messages.map((m) => {
        const md = m.media || {};
        const missed = ['timeout', 'reject', 'missed', 'MISSED'].includes(md.callStatus);
        const c = chatsById.get(m.chatid);
        return el('button', { type: 'button', class: 'big-row', onclick: () => { view = 'chats'; drawRail(); drawSide(); openChat(m.chatid); } },
          el('span', { class: `avatar ${missed ? 'missed' : ''}` }, md.isVideo ? '📹' : '📞'),
          el('span', {}, el('strong', { class: missed ? 'error-text' : '' }, c ? chatTitle(c) : m.senderName || chatSubtitle(m.chatid)), el('div', { class: 'small muted' }, `${missed ? '↙ Perdida' : '↙ Recebida'} · ${md.isVideo ? 'vídeo' : 'voz'} · ${fmtDate(m.messageTimestamp)}`)),
        );
      }) : el('div', { class: 'empty' }, 'Nenhuma ligação registrada.')),
    );
  };

  const teamView = async (box) => {
    await loadTeam();
    const me = isAgent ? (state.agentInstances || []).find((i) => i.id === state.instanceId) : null;
    box.replaceChildren(...[
      me && el('div', { class: 'side-section' }, el('div', { class: 'section-title' }, 'Meu status'), el('div', { class: 'pad' }, agentStatusControl(me, async () => { await loadAgentInstances(); drawSide(); }))),
      el('div', { class: 'side-section' }, el('div', { class: 'section-title' }, `Equipe (${team.filter((a) => a.online).length} online)`),
        team.length ? team.map((a) => el('div', { class: 'big-row' },
          el('span', { class: 'avatar presence-wrap' }, initials(a.name || a.email || '?'), el('span', { class: `presence ${a.online ? 'on' : 'off'}`, title: a.online ? 'Online' : 'Offline' })),
          el('span', {}, el('strong', {}, `${a.name || a.email || 'Atendente'}${a.me ? ' (você)' : ''}`), el('div', { class: 'small muted' }, `${a.online ? '🟢 Online' : '⚪ Offline'} · ${PAUSE_PT[a.availability] || a.availability}`)),
        )) : el('p', { class: 'muted small pad' }, 'Nenhum atendente neste número.'),
      ),
      el('p', { class: 'muted small pad' }, 'Online = está com o painel aberto agora. Em almoço, férias ou pausa a pessoa não recebe clientes novos.'),
    ].filter(Boolean));
  };

  const profileView = async (box) => {
    box.replaceChildren(el('div', { class: 'empty' }, 'Carregando…'));
    let info;
    try {
      info = await iapi('/profile/info');
    } catch (err) {
      return box.replaceChildren(el('div', { class: 'alert warn' }, err.message));
    }
    const name = el('input', { maxlength: '25', value: info.name || '' });
    const about = el('input', { maxlength: '139', value: info.about || '', placeholder: 'Ex.: Atendimento de seg a sáb, 9h às 18h' });
    const photo = fileDrop({ label: 'Trocar foto do perfil', hint: 'Foto quadrada', accept: 'image/*' });
    const b = info.business || {};
    const desc = el('textarea', { rows: '3', maxlength: '512', placeholder: 'O que sua empresa faz' });
    desc.value = b.description || '';
    const email = el('input', { type: 'email', maxlength: '128', value: b.email || '', placeholder: 'contato@empresa.com.br' });
    const address = el('input', { maxlength: '256', value: b.address || '', placeholder: 'Rua, número, bairro, cidade' });
    const sites = Array.isArray(b.website) ? b.website : Array.isArray(b.websites) ? b.websites : [];
    const site1 = el('input', { type: 'url', value: sites[0] || '', placeholder: 'https://seusite.com.br' });
    const site2 = el('input', { type: 'url', value: sites[1] || '', placeholder: 'https://instagram.com/suaempresa' });
    const catalogBox = el('div', { class: 'stack' });
    const loadCatalog = async () => {
      if (!info.isBusiness) return;
      const r = await iapi('/business/catalog/list', { method: 'POST', body: { jid: info.phone } }).catch(() => null);
      const products = r?.response?.products || [];
      catalogBox.replaceChildren(
        products.length ? products.map((p) => el('div', { class: 'big-row' }, p.imageUrls?.original ? el('img', { class: 'avatar', src: p.imageUrls.original, alt: '' }) : el('span', { class: 'avatar' }, '🛍'), el('span', {}, el('strong', {}, p.name), el('div', { class: 'small muted' }, p.price ? `${(Number(p.price) / 1000).toLocaleString('pt-BR', { style: 'currency', currency: p.currency || 'BRL' })}` : 'Sem preço')))) : el('p', { class: 'muted small' }, 'Nenhum produto ou serviço no catálogo.'),
        el('button', { type: 'button', class: 'btn', onclick: () => productEditor(loadCatalog) }, '＋ Adicionar produto ou serviço'),
      );
    };
    box.replaceChildren(
      el('div', { class: 'side-section stack pad' },
        el('div', { class: 'row' }, info.picture ? el('img', { class: 'avatar lg', src: info.picture, alt: '' }) : el('span', { class: 'avatar lg' }, '🏪'), el('div', {}, el('strong', {}, info.name || 'Sem nome'), el('div', { class: 'small muted' }, info.phone ? `+${info.phone}` : ''))),
        photo.el,
        el('label', {}, 'Nome que aparece para os clientes', name),
        el('label', {}, 'Recado', about),
        actionBtn('Salvar nome, foto e recado', async () => {
          if (name.value.trim() && name.value.trim() !== info.name) await iapi('/profile/name', { method: 'POST', body: { name: name.value.trim() } });
          if (about.value !== (info.about || '')) await iapi('/profile/status', { method: 'POST', body: { about: about.value } });
          if (photo.has()) {
            const up = await photo.ready();
            await iapi('/profile/image', { method: 'POST', body: { image: up.file } });
          }
          toast('Perfil atualizado');
        }, 'btn primary'),
      ),
      el('div', { class: 'side-section stack pad' },
        el('div', { class: 'section-title' }, 'Campos do cliente (variáveis)'),
        el('p', { class: 'muted small', style: 'margin:0' }, customFields().length ? customFields().map((f) => f.label).join(' · ') : 'Crie campos como CPF, CNPJ, endereço, número da conta ou boleto para usar nas mensagens.'),
        el('button', { type: 'button', class: 'btn', onclick: () => fieldsEditor(() => profileView(box)) }, '⚙️ Criar ou mudar campos'),
      ),
      info.isBusiness ? el('div', { class: 'side-section stack pad' },
        el('div', { class: 'section-title' }, 'Empresa (WhatsApp Business)'),
        el('label', {}, 'Descrição', desc),
        el('label', {}, 'E-mail', email),
        el('label', {}, 'Endereço', address),
        el('label', {}, 'Site', site1),
        el('label', {}, 'Rede social ou 2º site', site2),
        el('p', { class: 'muted small', style: 'margin:0' }, 'O WhatsApp aceita até 2 links: use site e Instagram/Facebook.'),
        actionBtn('Salvar dados da empresa', async () => {
          const websites = [site1.value.trim(), site2.value.trim()].filter(Boolean);
          await iapi('/business/update/profile', { method: 'POST', body: { description: desc.value, email: email.value.trim(), address: address.value, websites } });
          toast('Dados da empresa salvos');
        }, 'btn primary'),
        el('div', { class: 'section-title' }, 'Catálogo (produtos e serviços)'),
        catalogBox,
      ) : el('p', { class: 'muted small pad' }, 'Descrição, e-mail, endereço, site e catálogo aparecem quando o número usa o WhatsApp Business.'),
    );
    await loadCatalog();
  };

  const productEditor = (onSaved) => {
    const name = el('input', { maxlength: '200', placeholder: 'Ex.: Aluguel de vestido longo' });
    const price = el('input', { inputmode: 'decimal', placeholder: 'Ex.: 199,90' });
    const desc = el('textarea', { rows: '3', maxlength: '5000' });
    const url = el('input', { type: 'url', placeholder: 'https:// (opcional)' });
    const img = fileDrop({ label: 'Foto', hint: 'Foto do produto', accept: 'image/*' });
    modal('🛍 Produto ou serviço', el('div', { class: 'stack' }, el('label', {}, 'Nome', name), el('label', {}, 'Preço (R$)', price), el('label', {}, 'Descrição', desc), el('label', {}, 'Link', url), img.el), [
      (close) => actionBtn('Salvar no catálogo', async () => {
        if (!name.value.trim()) throw new Error('Dê um nome');
        const cents = price.value.trim() ? Math.round(Number(price.value.replace(/\./g, '').replace(',', '.')) * 1000) : null;
        if (price.value.trim() && !Number.isFinite(cents)) throw new Error('Preço inválido. Ex.: 199,90');
        const up = img.has() ? await img.ready() : null;
        await iapi('/business/catalog/save', { method: 'POST', body: { name: name.value.trim(), ...(cents ? { price: String(cents) } : {}), ...(desc.value.trim() ? { description: desc.value.trim() } : {}), ...(url.value.trim() ? { url: url.value.trim() } : {}), ...(up ? { image_data: up.file } : {}) } });
        close();
        toast('Salvo no catálogo');
        onSaved();
      }, 'btn primary'),
    ]);
  };

  // ------------------------------------------------------------ montagem do painel lateral
  const drawSide = () => {
    if (view === 'chats') {
      const menu = el('button', { type: 'button', class: 'icon-btn', title: 'Mais opções' }, '⋮');
      menu.addEventListener('click', () => popMenu(menu, [
        { icon: '👥', label: 'Novo grupo', hidden: isAgent, onClick: newGroup },
        { icon: '📋', label: 'Nova lista', hidden: isAgent, onClick: () => listEditor() },
        { icon: '🔒', label: hasUnlock() ? 'Ver conversas trancadas' : 'Abrir conversas trancadas', hidden: isAgent, onClick: async () => { if (!hasUnlock()) await unlockChats(); chip = 'locked'; drawChips(); await loadChats(); } },
        { icon: '📦', label: 'Ver arquivadas', onClick: async () => { chip = 'archived'; drawChips(); await loadChats(); } },
      ]));
      const newBtn = !isAgent && el('button', { class: 'btn sm primary', type: 'button', title: 'Conversar com um número novo', onclick: () => newChatModal((jid) => openChat(jid)) }, '＋ Nova');
      side.replaceChildren(el('div', { class: 'chat-list-head' }, el('div', { class: 'row side-title' }, el('strong', {}, isAgent ? 'Meus atendimentos' : 'Conversas'), el('span', { class: 'spacer' }), newBtn, menu), searchInput, chipsBox, attendantBox), listBox);
      drawChips();
      loadChats().catch((err) => toast(err.message, 'error'));
      return;
    }
    const titles = { updates: 'Atualizações', calls: 'Ligações', team: 'Equipe', profile: 'Perfil do WhatsApp' };
    const box = el('div', { class: 'chat-list-items' });
    side.replaceChildren(el('div', { class: 'chat-list-head' }, el('div', { class: 'row side-title' }, el('strong', {}, titles[view]))), box);
    const loaders = { updates: updatesView, calls: callsView, team: teamView, profile: profileView };
    loaders[view](box).catch((err) => box.replaceChildren(el('div', { class: 'alert error' }, err.message)));
  };

  // ------------------------------------------------------------ conversa aberta
  const msgsBox = el('div', { class: 'msgs wa-bg' });
  let composerText = null;
  let replyBar = null;

  const ticketBar = (chatid) => {
    if (chatid.endsWith('@g.us') || (!isAgent && !team.length)) return null;
    const c = chatsById.get(chatid) || {};
    const mine = isAgent && c.lead_assignedAttendant_id === state.user.id;
    const select = el('select', { class: 'sm', title: 'Passar para outro atendente' },
      el('option', { value: '__' }, isAgent ? '↪ Passar para…' : c.lead_assignedAttendant_id ? `🎧 ${teamName(c.lead_assignedAttendant_id)} (trocar)` : '⏳ Na fila (escolher)'),
      el('option', { value: '' }, '⏳ Devolver para a fila'),
      team.filter((a) => a.user_id !== state.user.id).map((a) => el('option', { value: a.user_id }, `${a.online ? '🟢' : '⚪'} ${a.name || a.email}${a.available ? '' : ' (pausa)'}`)),
    );
    if (isAgent && !mine) select.disabled = true;
    select.addEventListener('change', async () => {
      if (select.value === '__') return;
      try {
        await iapi('/ticket/transfer', { method: 'POST', body: { chatid, to: select.value } });
        toast('Conversa passada adiante');
        if (isAgent) conv.replaceChildren(el('div', { class: 'empty conv-empty' }, 'Conversa transferida.'));
        await loadChats();
      } catch (err) {
        toast(err.message, 'error');
        select.value = '__';
      }
    });
    const closeBtn = actionBtn(c.lead_isTicketOpen === false ? '✔ Finalizado' : '✔ Finalizar', async () => {
      await iapi('/ticket/close', { method: 'POST', body: { chatid } });
      toast('Atendimento finalizado');
      await loadChats();
      await openChat(chatid);
    }, 'btn sm');
    if (c.lead_isTicketOpen === false) closeBtn.disabled = true;
    return el('div', { class: 'row ticket-bar' }, select, closeBtn);
  };

  const sendTo = (chatid) => async (endpoint, body) => {
    await iapi(endpoint, { method: 'POST', body: { number: chatid, ...body, ...(replyTo ? { replyid: replyTo.id } : {}) } });
    setReply(null);
    await loadMsgs(true);
  };
  const setReply = (m) => {
    replyTo = m;
    if (!replyBar) return;
    replyBar.replaceChildren(...(m ? [el('div', { class: 'reply-box' }, el('div', { class: 'q-who' }, m.fromMe ? 'Você' : m.senderName || 'Cliente'), el('div', { class: 'q-txt' }, m.text || TYPE_LABEL[m.media?.kind] || 'Mensagem')), el('button', { type: 'button', class: 'icon-btn', title: 'Cancelar resposta', onclick: () => setReply(null) }, '✕')] : []));
    replyBar.classList.toggle('open', Boolean(m));
    if (m) composerText?.focus();
  };

  const openChat = async (chatid) => {
    const c = chatsById.get(chatid) || { wa_chatid: chatid };
    const title = chatTitle(c);
    current = chatid;
    currentIsGroup = chatid.endsWith('@g.us');
    limit = 60;
    replyTo = null;
    listBox.querySelectorAll('.chat-item').forEach((n) => n.classList.remove('active'));
    const text = el('textarea', { placeholder: 'Digite uma mensagem', maxlength: '4096', rows: '1', 'aria-label': 'Mensagem' });
    composerText = text;
    const hint = el('div', { class: 'var-hint' });
    text.addEventListener('input', () => {
      text.style.height = 'auto';
      text.style.height = `${Math.min(text.scrollHeight, 140)}px`;
      hint.textContent = /\{\{/.test(text.value) ? `Vai chegar assim: ${fillVars(text.value, title.startsWith('+') ? '' : title)}` : '';
    });
    const sendBtn = actionBtn('➤', async () => {
      const t = text.value.trim();
      if (!t) return;
      await sendTo(chatid)('/send/text', { text: t, readchat: true });
      text.value = '';
      hint.textContent = '';
      text.style.height = '';
    }, 'btn primary send-btn');
    sendBtn.title = 'Enviar';
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });

    // Arquivos: prévia com legenda antes de enviar (também por arrastar ou Ctrl+V).
    const sendFiles = (files, forced) => {
      files = [...files].filter(Boolean).slice(0, 10);
      if (!files.length) return;
      const items = files.map((file) => ({ file, url: URL.createObjectURL(file), bar: el('div', { class: 'progress' }, el('div', { style: 'width:0%' })) }));
      const caption = el('textarea', { rows: '2', placeholder: 'Adicione uma legenda (opcional)…', maxlength: '4096' });
      caption.value = text.value.trim();
      const grid = el('div', { class: 'att-grid' }, items.map((it) => el('div', { class: 'att-item' }, filePreview(it.file, it.url), el('div', { class: 'small muted att-name' }, `${it.file.name} · ${fmtBytes(it.file.size)}`), it.bar)));
      const cleanup = () => items.forEach((it) => URL.revokeObjectURL(it.url));
      modal(files.length > 1 ? `Enviar ${files.length} arquivos` : 'Enviar arquivo', el('div', { class: 'stack' }, grid, el('div', { class: 'row' }, caption, varButton(caption, { compact: true }))), [
        (closeFn) => actionBtn('Enviar ➤', async () => {
          for (const [i, it] of items.entries()) {
            const up = await uploadFile(it.file, (p) => (it.bar.firstChild.style.width = `${p}%`));
            it.bar.classList.add('done');
            const kind = forced === 'document' ? 'document' : up.kind;
            const type = kind === 'image' && up.mimetype === 'image/webp' ? 'sticker' : kind;
            const cap = i === 0 && caption.value.trim() && !['audio', 'sticker'].includes(type) ? { text: caption.value.trim() } : {};
            await sendTo(chatid)('/send/media', { type, file: up.file, ...cap, ...(type === 'document' ? { docName: it.file.name } : {}) });
          }
          text.value = '';
          cleanup();
          closeFn();
        }, 'btn primary'),
      ]);
    };
    const pick = (accept, forced) => {
      const inp = el('input', { type: 'file', multiple: true, accept, class: 'hidden-input' });
      inp.addEventListener('change', () => sendFiles(inp.files || [], forced));
      document.body.append(inp);
      inp.click();
      setTimeout(() => inp.remove(), 60_000);
    };
    const attach = el('button', { class: 'btn attach', type: 'button', title: 'Anexar: foto, vídeo, documento, enquete, botões, lista, localização…', 'aria-label': 'Anexar' }, '📎');
    attach.addEventListener('click', () => attachMenu(attach, {
      media: () => pick('image/*,video/*'),
      document: () => pick('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,.7z,application/*', 'document'),
      audio: () => pick('audio/*'),
      special: (kind) => specialMessageModal(kind, { clientName: title.startsWith('+') ? '' : title, onSend: sendTo(chatid) }),
    }));
    text.addEventListener('paste', (e) => {
      if (e.clipboardData?.files?.length) {
        e.preventDefault();
        sendFiles(e.clipboardData.files);
      }
    });

    // Áudio de voz gravado no navegador (o servidor converte para o formato do WhatsApp).
    let rec = null;
    const mic = el('button', { class: 'btn attach mic-btn', type: 'button', title: 'Gravar áudio: clique para começar e de novo para enviar' }, '🎤');
    mic.addEventListener('click', async () => {
      if (rec) return rec.stop();
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return toast('Seu navegador não permite gravar áudio aqui', 'error');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        return toast('Permita o uso do microfone para gravar', 'error');
      }
      const chunks = [];
      const started = Date.now();
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
      const tick = setInterval(() => (mic.textContent = `⏹ ${fmtSecs((Date.now() - started) / 1000) || '0:00'}`), 500);
      mic.classList.add('recording');
      mic.textContent = '⏹ 0:00';
      rec.onstop = async () => {
        clearInterval(tick);
        stream.getTracks().forEach((t) => t.stop());
        mic.classList.remove('recording');
        mic.textContent = '🎤';
        rec = null;
        if (Date.now() - started < 800) return toast('Áudio muito curto');
        const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
        const file = new File([blob], `audio-${Date.now()}.${blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: blob.type });
        try {
          toast('Enviando áudio…');
          const up = await uploadFile(file);
          await sendTo(chatid)('/send/media', { type: 'ptt', file: up.file });
        } catch (err) {
          toast(err.message, 'error');
        }
      };
      rec.start();
    });

    const dropOverlay = el('div', { class: 'drop-overlay' }, el('div', {}, '📎', el('div', {}, 'Solte aqui para enviar')));
    const convDrag = (on) => conv.classList.toggle('dragging', on);
    conv.ondragenter = (e) => e.dataTransfer?.types?.includes('Files') && convDrag(true);
    conv.ondragover = (e) => {
      e.preventDefault();
      convDrag(true);
    };
    conv.ondragleave = (e) => !conv.contains(e.relatedTarget) && convDrag(false);
    conv.ondrop = (e) => {
      e.preventDefault();
      convDrag(false);
      sendFiles(e.dataTransfer?.files || []);
    };

    const headMenu = el('button', { type: 'button', class: 'icon-btn', title: 'Opções da conversa' }, '⋮');
    const dataBtn = !currentIsGroup && el('button', { type: 'button', class: 'btn sm', title: 'Nome, CPF, endereço, boleto… usados nas variáveis', onclick: () => clientDataModal(chatid, () => loadChats()).catch((err) => toast(err.message, 'error')) }, '📝 Dados do cliente');
    headMenu.addEventListener('click', () => chatMenu(headMenu, chatsById.get(chatid) || c));
    replyBar = el('div', { class: 'reply-bar' });
    const who = ticketTag(c);
    conv.replaceChildren(
      el('div', { class: 'conv-head' },
        c.image ? el('img', { class: 'avatar', src: c.image, alt: '' }) : el('div', { class: 'avatar' }, currentIsGroup ? '👥' : initials(title)),
        el('div', { class: 'conv-title' }, el('div', { style: 'font-weight:600' }, title), el('div', { class: 'muted small' }, chatSubtitle(chatid), who ? ' · ' : '', who)),
        dataBtn,
        ticketBar(chatid),
        headMenu,
      ),
      msgsBox,
      replyBar,
      el('div', { class: 'composer' }, attach, el('div', { class: 'composer-text' }, text, hint), varButton(text, { compact: true }), mic, sendBtn),
      dropOverlay,
    );
    await loadMsgs(true);
    if (c.wa_unreadCount > 0) iapi('/chat/read', { method: 'POST', body: { number: chatid, read: true } }).then(() => loadChats()).catch(() => undefined);
  };

  const editMessage = (m) => {
    const t = el('textarea', { rows: '4', maxlength: '4096' });
    t.value = m.text || '';
    modal('✏️ Corrigir mensagem', el('div', { class: 'stack' }, el('p', { class: 'muted small', style: 'margin:0' }, 'O cliente verá a mensagem corrigida com a marca "editada". O WhatsApp permite corrigir até 15 minutos depois do envio.'), t), [
      (close) => actionBtn('Salvar correção', async () => {
        if (!t.value.trim()) throw new Error('A mensagem não pode ficar vazia');
        await iapi('/message/edit', { method: 'POST', body: { id: m.id, text: t.value.trim() } });
        close();
        toast('Mensagem corrigida');
        await loadMsgs();
      }, 'btn primary'),
    ]);
  };
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const bubbleMenu = (anchor, m) => {
    popMenu(anchor, [
      { icon: '↩', label: 'Responder', onClick: () => setReply(m) },
      { icon: '😀', label: 'Reagir', onClick: () => popMenu(anchor, REACTIONS.map((r) => ({ icon: r, label: r === '👍' ? 'Curtir' : r === '❤️' ? 'Amei' : r === '😂' ? 'Engraçado' : r === '😮' ? 'Uau' : r === '😢' ? 'Triste' : 'Obrigado', onClick: async () => { await iapi('/message/react', { method: 'POST', body: { id: m.id, text: r } }); await loadMsgs(); } }))) },
      { icon: '📋', label: 'Copiar texto', hidden: !m.text, onClick: () => copy(m.text) },
      // Corrigir: só mensagens de texto enviadas por este número, dentro do prazo do WhatsApp (15 min).
      { icon: '✏️', label: 'Corrigir mensagem', hidden: !m.fromMe || !m.text || !['conversation', 'extendedTextMessage'].includes(m.messageType) || m.status === 'Deleted' || Date.now() - (Number(m.messageTimestamp) < 1e12 ? Number(m.messageTimestamp) * 1000 : Number(m.messageTimestamp)) > 15 * 60_000, onClick: () => editMessage(m) },
      { sep: true, hidden: isAgent },
      // Apagar é só do dono do número (atendente corrige, não apaga).
      { icon: '🗑', label: 'Apagar para mim', danger: true, hidden: isAgent, onClick: () => confirmTyped('Apagar para mim', 'A mensagem some só deste número. O cliente continua vendo.', 'APAGAR', async () => { await iapi('/message/delete', { method: 'POST', body: { id: m.id, for_me: true } }); await loadMsgs(); }) },
      { icon: '🗑', label: 'Apagar para todos', danger: true, hidden: isAgent || !m.fromMe || m.status === 'Deleted', onClick: () => confirmTyped('Apagar para todos', 'A mensagem será apagada também no celular do cliente (se ainda estiver no prazo do WhatsApp).', 'APAGAR', async () => { await iapi('/message/delete', { method: 'POST', body: { id: m.id } }); await loadMsgs(); }) },
    ]);
  };

  const loadMsgs = async (scrollBottom = false) => {
    if (!current) return;
    const nearBottom = msgsBox.scrollHeight - msgsBox.scrollTop - msgsBox.clientHeight < 120;
    const prevHeight = msgsBox.scrollHeight;
    const r = await iapi('/message/find', { method: 'POST', body: { chatid: current, limit } });
    const items = r.messages.slice().reverse();
    const reactions = new Map();
    const byId = new Map();
    for (const m of items) {
      byId.set(m.messageid, m);
      if (m.messageType === 'reactionMessage' && m.quoted && m.reaction) reactions.set(m.quoted, [...(reactions.get(m.quoted) || []), m.reaction]);
    }
    const ctx = { isGroup: currentIsGroup, reactions, byId };
    const nodes = [];
    let lastDay = '';
    for (const m of items.filter((x) => !HIDDEN_TYPES.has(x.messageType))) {
      const d = new Date(Number(m.messageTimestamp) < 1e12 ? Number(m.messageTimestamp) * 1000 : Number(m.messageTimestamp));
      const day = d.toLocaleDateString('pt-BR');
      if (day !== lastDay) {
        lastDay = day;
        nodes.push(el('div', { class: 'day' }, d.toDateString() === new Date().toDateString() ? 'Hoje' : day));
      }
      const bubble = renderBubble(m, ctx);
      if (m.messageType !== 'call' && m.status !== 'Deleted') {
        const more = el('button', { type: 'button', class: 'msg-more', title: 'Responder, reagir, apagar…', 'aria-label': 'Opções da mensagem' }, '⌄');
        more.addEventListener('click', (e) => {
          e.stopPropagation();
          bubbleMenu(more, m);
        });
        bubble.append(more);
        bubble.addEventListener('dblclick', () => setReply(m));
      }
      nodes.push(bubble);
    }
    if (r.hasMore) {
      nodes.unshift(el('button', { class: 'btn sm load-more', type: 'button', onclick: async () => {
        limit += 60;
        await loadMsgs();
        msgsBox.scrollTop = msgsBox.scrollHeight - prevHeight;
      } }, 'Carregar mensagens anteriores'));
    }
    msgsBox.replaceChildren(...(nodes.length ? nodes : [el('div', { class: 'empty' }, 'Sem mensagens ainda. Escreva abaixo para começar.')]));
    if (scrollBottom || nearBottom) msgsBox.scrollTop = msgsBox.scrollHeight;
  };

  // ------------------------------------------------------------ tempo real (+ verificação de segurança)
  let pending;
  const refreshSoon = (chatid) => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (view === 'chats') loadChats().catch(() => undefined);
      if (!chatid || chatid === current) loadMsgs().catch(() => undefined);
    }, 300);
  };
  sseHandlers.add((type, data) => {
    if (!['messages', 'messages_update', 'call', 'chats'].includes(type)) return;
    if (type === 'chats' && data.event?.type !== 'assignment') return;
    refreshSoon(data.message?.chatid || data.event?.chatid);
  });
  // Se o tempo real ficar mudo por mais de 20 s (proxy, rede), confere sozinho a cada 5 s.
  state.timers.push(setInterval(() => {
    if (document.hidden) return;
    if (!sseState.connected || Date.now() - sseState.lastEventAt > 20_000) {
      if (current) loadMsgs().catch(() => undefined);
      if (view === 'chats') loadChats().catch(() => undefined);
    }
  }, 5000));

  if (state.instance.status !== 'connected') {
    return layout(isAgent ? state.instance.name : 'Conversas', el('div', { class: 'alert warn' }, isAgent ? 'Este número está desconectado no momento. Avise o responsável.' : 'A instância não está conectada. ', !isAgent && el('a', { href: `#/i/${state.instanceId}/visao` }, 'Conectar agora')));
  }
  await Promise.all([loadTeam(), loadLists()]);
  if (!isAgent && team.length && !railItems.some((r) => r && r[0] === 'team')) railItems.splice(3, 0, ['team', '🎧', 'Equipe']);
  drawRail();
  drawSide();
  const rt = el('span', { class: 'rt-badge', title: 'Tempo real' }, el('span', { class: 'rt-dot' }), el('span', { class: 'rt-on' }, 'Tempo real'), el('span', { class: 'rt-off-label' }, 'Reconectando…'));
  layout(isAgent ? `Atendimento · ${state.instance.name}` : 'Conversas', el('div', { class: 'card chat wa3' }, rail, side, conv), { actions: [rt, isAgent && agentStatusControl(state.instance, () => route())].filter(Boolean) });
}

/** Nova conversa: confere o número no WhatsApp (pega o JID certo, com/sem 9) e, se quiser, salva o contato. */
function newChatModal(onOpen) {
  const number = el('input', { name: 'number', required: true, inputmode: 'tel', placeholder: '55 19 99999-9999', autofocus: true });
  const name = el('input', { name: 'name', placeholder: 'Nome (opcional)', maxlength: '200' });
  const save = el('input', { type: 'checkbox', name: 'save', checked: true });
  const out = el('div');
  modal('Nova conversa', el('div', { class: 'stack' },
    el('label', {}, 'Número com DDI e DDD', number),
    el('label', {}, 'Nome', name),
    el('label', { class: 'inline' }, save, 'Salvar nos contatos do WhatsApp'),
    el('p', { class: 'muted small', style: 'margin:0' }, 'Dica: para o Brasil use 55 + DDD + número. O sistema confere se o número tem WhatsApp.'),
    out,
  ), [
    (close) => actionBtn('Abrir conversa', async () => {
      const digits = normalizePhone(number.value); // "19 99999-9999" vira 5519999999999
      if (digits.length < 10) throw new Error('Número incompleto: use DDI + DDD + número');
      const [r] = await iapi('/chat/check', { method: 'POST', body: { numbers: [digits] } });
      if (!r?.isInWhatsapp) {
        out.replaceChildren(el('div', { class: 'alert warn' }, 'Este número não tem WhatsApp (ou está incorreto).'));
        return;
      }
      if (save.checked && name.value.trim()) await iapi('/contact/add', { method: 'POST', body: { number: r.jid, name: name.value.trim() } }).catch(() => undefined);
      close();
      onOpen(r.jid, name.value.trim() || `+${phoneOf(r.jid)}`);
    }, 'btn primary'),
  ]);
}

// ======================================================================= atendentes
const PAUSE_PT = { disponivel: '🟢 Disponível', almoco: '🍽 Almoço', ferias: '🏖 Férias', outro: '⏸ Pausa', pausa: '⏸ Pausa', desativado: '⛔ Desativado' };

/** Seletor de status do próprio atendente (por número). */
function agentStatusControl(inst, onChanged) {
  const sel = el('select', { class: 'status-select', 'aria-label': 'Meu status' },
    ['disponivel', 'almoco', 'ferias', 'outro'].map((v) => el('option', { value: v }, PAUSE_PT[v])),
  );
  sel.value = inst.availability === 'desativado' ? 'outro' : inst.availability === 'pausa' ? 'outro' : inst.availability || 'disponivel';
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v === 'ferias') return ferias(); // modal próprio para escolher a data de volta
    await send(v, null);
  });
  const send = async (v, until) => {
    try {
      await api('/agent/status', { method: 'POST', body: v === 'disponivel' ? { instance_id: inst.id, status: 'available' } : { instance_id: inst.id, status: 'paused', pause_reason: v, ...(until ? { paused_until: until } : {}) } });
      toast(v === 'disponivel' ? 'Você está disponível para novos clientes' : 'Pausado: você não recebe novos clientes');
      onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const ferias = () => {
    const date = el('input', { type: 'date', min: new Date().toISOString().slice(0, 10) });
    modal('Férias', el('div', { class: 'stack' }, el('label', {}, 'Volto em (opcional)', date), el('p', { class: 'muted small', style: 'margin:0' }, 'Na data escolhida você volta a receber clientes sozinho. Sem data, fica pausado até você mudar.')), [
      (close) => actionBtn('Confirmar férias', async () => {
        const until = date.value ? new Date(`${date.value}T08:00:00`).toISOString() : null;
        close();
        await send('ferias', until);
      }, 'btn primary'),
    ]);
  };
  return el('label', { class: 'inline status-wrap' }, 'Meu status:', sel);
}

async function pageAgentHome() {
  const list = await loadAgentInstances();
  const cards = list.map((i) => el('div', { class: 'card stack agent-card' },
    el('div', { class: 'row' },
      i.profilePicUrl ? el('img', { class: 'avatar', src: i.profilePicUrl, alt: '' }) : el('div', { class: 'avatar' }, '📱'),
      el('div', { class: 'conv-title' }, el('div', { style: 'font-weight:600' }, i.name), el('div', { class: 'muted small' }, i.owner ? `+${i.owner}` : 'Número não conectado')),
      el('span', { class: 'spacer' }),
      statusBadge(i.status),
    ),
    el('div', { class: 'row' }, el('span', { class: 'tag' }, PAUSE_PT[i.availability] || i.availability), i.break_start && el('span', { class: 'muted small' }, `Almoço automático ${i.break_start}–${i.break_end}`), el('span', { class: 'spacer' }), el('strong', {}, `${i.open_chats} aberto(s)`)),
    el('div', { class: 'row' }, agentStatusControl(i, () => route()), el('span', { class: 'spacer' }), el('a', { class: 'btn primary', href: `#/a/${i.id}` }, 'Abrir conversas')),
  ));
  layout('Atendimento', list.length ? el('div', { class: 'grid cols-2' }, cards) : el('div', { class: 'card empty' }, 'Você ainda não foi adicionado a nenhum número. Peça ao responsável.'), { subtitle: 'Seus números e seu status. Em pausa você não recebe clientes novos.' });
}

async function pageAgents() {
  const box = el('div', { class: 'stack' });
  const load = async () => {
    const { agents, queue } = await iapi('/agents');
    const rows = agents.map((a) => el('tr', {},
      el('td', {}, el('div', { style: 'font-weight:600' }, a.name || '—'), el('div', { class: 'muted small' }, a.email)),
      el('td', {}, el('span', { class: `tag ${a.available ? 'ok' : ''}` }, PAUSE_PT[a.availability] || a.availability), a.paused_until && el('div', { class: 'muted small' }, `volta ${new Date(a.paused_until).toLocaleDateString('pt-BR')}`)),
      el('td', { class: 'small' }, a.break_start ? `${a.break_start}–${a.break_end}` : '—'),
      el('td', {}, a.open_chats),
      el('td', { class: 'small muted' }, a.last_login_at ? new Date(a.last_login_at).toLocaleString('pt-BR') : 'nunca entrou'),
      el('td', {}, el('div', { class: 'row' },
        el('button', { class: 'btn sm', type: 'button', onclick: () => agentEditor(a, load) }, 'Editar'),
        el('button', { class: 'btn sm danger', type: 'button', onclick: () => confirmTyped('Remover atendente', `Remover ${a.email} deste número? As conversas abertas dele voltam para a fila.`, 'REMOVER', async () => {
          await iapi(`/agents/${a.user_id}`, { method: 'DELETE' });
          toast('Atendente removido');
          await load();
        }) }, 'Remover'),
      )),
    ));
    box.replaceChildren(
      el('div', { class: 'grid cols-3' },
        el('div', { class: 'card stat' }, el('div', { class: 'muted small' }, 'Atendentes'), el('div', { class: 'stat-num' }, agents.length)),
        el('div', { class: 'card stat' }, el('div', { class: 'muted small' }, 'Disponíveis agora'), el('div', { class: 'stat-num' }, agents.filter((a) => a.available).length)),
        el('div', { class: 'card stat' }, el('div', { class: 'muted small' }, 'Clientes na fila'), el('div', { class: 'stat-num' }, queue), queue > 0 && actionBtn('Distribuir agora', async () => {
          const r = await iapi('/agents/drain', { method: 'POST', body: {} });
          toast(r.assigned ? `${r.assigned} conversa(s) distribuída(s)` : 'Ninguém disponível no momento');
          await load();
        }, 'btn sm')),
      ),
      el('div', { class: 'card' }, agents.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Atendente', 'Status', 'Almoço automático', 'Abertos', 'Último acesso', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      )) : el('div', { class: 'empty' }, el('p', {}, 'Nenhum atendente neste número ainda.'), el('button', { class: 'btn primary', type: 'button', onclick: () => agentEditor(null, load) }, '+ Adicionar atendente'))),
      el('div', { class: 'card small muted' },
        el('strong', {}, 'Como funciona: '),
        'cada cliente novo vai para o próximo atendente disponível (rodízio). Se o cliente já foi atendido antes, volta para o mesmo atendente, se ele estiver disponível. Quem está em almoço, férias ou pausa não recebe clientes novos; se ninguém estiver disponível, o cliente espera na fila e é distribuído assim que alguém voltar. Os atendentes entram com o próprio e-mail e senha neste mesmo site e só veem as conversas deles — não conseguem conectar/desconectar o número, ver o token nem outras conversas.',
      ),
    );
  };
  layout('Atendentes', box, { subtitle: `Quem responde o número ${state.instance.name}${state.instance.owner ? ` (+${state.instance.owner})` : ''}`, actions: [el('button', { class: 'btn primary', type: 'button', onclick: () => agentEditor(null, load) }, '+ Adicionar atendente'), actionBtn('Atualizar', load)] });
  await load();
}

function agentEditor(a, onSaved) {
  const isNew = !a;
  const f = el('form', { class: 'stack' },
    el('label', {}, 'Nome', el('input', { name: 'name', value: a?.name || '', maxlength: '200' })),
    el('label', {}, 'E-mail (login)', el('input', { name: 'email', type: 'email', value: a?.email || '', required: true, disabled: !isNew, autocomplete: 'off' })),
    el('label', {}, isNew ? 'Senha inicial' : 'Nova senha (deixe em branco para manter)', el('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: '10' })),
    el('p', { class: 'muted small', style: 'margin:0' }, 'Senha forte: 10+ caracteres. Passe ao atendente por um canal seguro; ele pode trocar em "Minha conta".'),
    el('div', { class: 'grid cols-2' },
      el('label', {}, 'Almoço automático — início', el('input', { name: 'break_start', type: 'time', value: a?.break_start || '' })),
      el('label', {}, 'fim', el('input', { name: 'break_end', type: 'time', value: a?.break_end || '' })),
    ),
    !isNew && el('label', {}, 'Status agora', el('select', { name: 'state' },
      ['disponivel', 'almoco', 'ferias', 'outro'].map((v) => el('option', { value: v, selected: (a.availability === v || (v === 'outro' && a.availability === 'pausa')) ? true : undefined }, PAUSE_PT[v])),
    )),
    !isNew && toggleSwitch('active', a.active, 'Recebe clientes deste número'),
    !isNew && toggleSwitch('login_enabled', a.login_enabled, 'Login liberado'),
  );
  modal(isNew ? 'Adicionar atendente' : `Atendente: ${a.email}`, f, [
    (close) => actionBtn('Salvar', async () => {
      const d = formData(f);
      if (isNew) {
        await iapi('/agents', { method: 'POST', body: { email: d.email, name: d.name, ...(d.password ? { password: d.password } : {}), break_start: d.break_start || '', break_end: d.break_end || '' } });
        toast('Atendente adicionado');
      } else {
        const st = d.state;
        await iapi(`/agents/${a.user_id}`, { method: 'PATCH', body: {
          name: d.name,
          ...(d.password ? { password: d.password } : {}),
          break_start: d.break_start || '',
          break_end: d.break_end || '',
          active: Boolean(d.active),
          login_enabled: Boolean(d.login_enabled),
          ...(st === 'disponivel' ? { status: 'available' } : { status: 'paused', pause_reason: st }),
        } });
        toast('Atendente atualizado');
      }
      close();
      onSaved();
    }, 'btn primary'),
  ]);
}

// ======================================================================= anexos (arrastar e soltar)
// Por quê: cliente não sabe gerar link de foto/vídeo. Todo lugar que aceita mídia no
// painel recebe o arquivo por arrastar-e-soltar, clipe ou Ctrl+V, mostra a prévia e
// envia o binário para /upload — a API devolve "upload:<nome>", usado no lugar da URL.
const MAX_UPLOAD_MB = 64;
const ACCEPT_ALL = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar,.7z';
const kindOfFile = (f) => (f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document');
const KIND_PT = { image: 'Foto', video: 'Vídeo', audio: 'Áudio', document: 'Documento' };

// Soltar um arquivo fora da área certa faria o navegador abrir o arquivo e sair do painel.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

/** Envia o arquivo com barra de progresso (XHR tem evento de upload; fetch não). */
function uploadFile(file, onProgress = () => undefined, retry = true) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_UPLOAD_MB * 1048576) return reject(new Error(`Arquivo maior que ${MAX_UPLOAD_MB} MB`));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-CSRF-Token', cookie('nwa_csrf'));
    xhr.setRequestHeader('X-Instance-Id', state.instanceId);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'arquivo'));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => reject(new Error('Falha de conexão ao enviar o arquivo'));
    xhr.onload = async () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* resposta não-JSON (ex.: 413 do proxy) */
      }
      if (xhr.status === 401 && retry && (await tryRefresh())) return uploadFile(file, onProgress, false).then(resolve, reject);
      if (xhr.status === 413) return reject(new Error('Arquivo grande demais para o servidor'));
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `Erro HTTP ${xhr.status} no envio do arquivo`));
      resolve(data);
    };
    xhr.send(file);
  });
}

/** Miniatura/prévia local do arquivo (não depende do servidor). */
function filePreview(file, url, { compact = false } = {}) {
  const kind = kindOfFile(file);
  if (kind === 'image') return el('div', { class: 'media' }, el('img', { class: 'photo', src: url, alt: file.name }));
  if (kind === 'video') return el('div', { class: 'media video' }, el('video', { class: 'photo', src: url, controls: !compact, muted: compact, preload: 'metadata', playsinline: true }));
  if (kind === 'audio') return el('div', { class: 'audio-box' }, el('div', { class: 'avatar mic' }, '🎤'), el('audio', { src: url, controls: true, preload: 'metadata' }));
  const ext = (file.name.split('.').pop() || 'DOC').toUpperCase().slice(0, 4);
  return el('div', { class: 'doc' }, el('div', { class: 'doc-ico' }, ext), el('div', { class: 'doc-meta' }, el('div', { class: 'doc-name' }, file.name), el('div', { class: 'small muted' }, [ext, fmtBytes(file.size)].join(' · '))));
}

/**
 * Área de anexo reutilizável. O upload começa assim que o arquivo é escolhido;
 * `ready()` espera terminar e devolve { file: "upload:...", kind, name, mimetype }.
 */
function fileDrop({ label = 'Anexo', hint = 'Foto, vídeo, áudio ou documento', accept = ACCEPT_ALL, onChange = () => undefined } = {}) {
  let current = null; // { file, url, promise, result }
  const input = el('input', { type: 'file', accept, class: 'hidden-input' });
  const bar = el('div', { class: 'progress' }, el('div', { style: 'width:0%' }));
  const status = el('div', { class: 'small muted' });
  const body = el('div', { class: 'drop-body' });
  const zone = el('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': `${label}: arraste um arquivo ou clique para escolher` }, body, input);

  const empty = () => {
    body.replaceChildren(el('div', { class: 'drop-ico' }, '📎'), el('div', { class: 'drop-title' }, 'Arraste e solte o arquivo aqui'), el('div', { class: 'small muted' }, `ou clique para escolher · ${hint} · até ${MAX_UPLOAD_MB} MB`));
    zone.classList.remove('filled');
  };
  const clear = () => {
    if (current?.url) URL.revokeObjectURL(current.url);
    current = null;
    empty();
    onChange(null);
  };
  const set = (file) => {
    if (!file) return;
    if (current?.url) URL.revokeObjectURL(current.url);
    const url = URL.createObjectURL(file);
    bar.firstChild.style.width = '0%';
    status.textContent = 'Enviando…';
    status.className = 'small muted';
    const promise = uploadFile(file, (p) => {
      bar.firstChild.style.width = `${p}%`;
      status.textContent = p < 100 ? `Enviando… ${p}%` : 'Processando…';
    }).then((r) => {
      if (current?.file !== file) return r;
      current.result = { ...r, name: file.name };
      status.textContent = `✅ Pronto — ${KIND_PT[r.kind] || 'Arquivo'} · ${fmtBytes(file.size)}`;
      bar.classList.add('done');
      return current.result;
    }, (err) => {
      if (current?.file === file) {
        status.textContent = `⚠ ${err.message}`;
        status.className = 'small error-text';
        current.error = err;
      }
      throw err;
    });
    promise.catch(() => undefined);
    current = { file, url, promise, result: null };
    bar.classList.remove('done');
    zone.classList.add('filled');
    body.replaceChildren(
      // Documento: só o ícone (o nome já aparece ao lado); mídia: prévia real tocável.
      kindOfFile(file) === 'document'
        ? el('div', { class: 'doc-ico big' }, (file.name.split('.').pop() || 'DOC').toUpperCase().slice(0, 4))
        : el('div', { class: 'drop-preview' }, filePreview(file, url)),
      el('div', { class: 'drop-info' },
        el('div', { class: 'doc-name' }, file.name),
        bar,
        status,
        el('div', { class: 'row' },
          el('button', { class: 'btn sm', type: 'button', onclick: (e) => { e.stopPropagation(); input.click(); } }, 'Trocar'),
          el('button', { class: 'btn sm danger', type: 'button', onclick: (e) => { e.stopPropagation(); clear(); } }, 'Remover'),
        ),
      ),
    );
    onChange({ file, url, kind: kindOfFile(file) });
  };

  zone.addEventListener('click', (e) => {
    if (e.target.closest('button, audio, video')) return;
    input.click();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    set(input.files?.[0]);
    input.value = '';
  });
  zone.addEventListener('dragenter', () => zone.classList.add('drag'));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', (e) => !zone.contains(e.relatedTarget) && zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    set(e.dataTransfer?.files?.[0]);
  });
  zone.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])][0];
    if (f) {
      e.preventDefault();
      set(f);
    }
  });
  empty();

  return {
    el: el('div', { class: 'field' }, el('div', { class: 'field-label' }, label), zone),
    has: () => Boolean(current),
    kind: () => (current ? kindOfFile(current.file) : null),
    async ready() {
      if (!current) return null;
      return current.promise;
    },
    clear,
  };
}

// Prévia usa os mesmos exemplos dos botões de variáveis (ver EASY_VARS).
const fillSample = (x) => fillVars(x);

/** Prévia "como vai chegar no WhatsApp" — atualizada enquanto o usuário digita. */
function waPreview(title = 'Pré-visualização') {
  const box = el('div', { class: 'msgs wa-bg preview-box' });
  const wrap = el('div', { class: 'card preview-card' }, el('div', { class: 'field-label' }, title), box, el('div', { class: 'small muted' }, 'Nome, saudação e data aparecem com um exemplo; o cliente recebe os dados dele.'));
  const update = ({ text = '', att = null, buttons = [], footer = '', listButton = '' } = {}) => {
    const t = fillSample(text);
    if (!t && !att && !buttons.length) {
      box.replaceChildren(el('div', { class: 'empty small' }, 'Escreva a mensagem ou anexe um arquivo para ver a prévia.'));
      return;
    }
    const media = att ? filePreview(att.file, att.url, { compact: false }) : null;
    const onlyMedia = media && !t && ['image', 'video'].includes(att.kind) && !buttons.length;
    const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    box.replaceChildren(el('div', { class: `msg me ${onlyMedia ? 'media-only' : ''}` },
      media,
      t && el('div', { class: 'txt' }, richText(t)),
      footer && el('div', { class: 'small muted' }, footer),
      el('span', { class: 'when' }, now, el('span', { class: 'tick read' }, ' ✓✓')),
      buttons.length > 0 && el('div', { class: 'btns' }, buttons.map((b) => el('div', { class: 'wa-btn' }, b))),
      listButton && el('div', { class: 'btns' }, el('div', { class: 'wa-btn' }, `☰ ${listButton}`)),
    ));
  };
  update();
  return { el: wrap, update };
}

// ======================================================================= componentes fáceis
// Objetivo: qualquer pessoa usar sem saber o que é {{variavel}} ou "Texto|id".

/** Menu suspenso (⋮) perto de um botão. Fecha ao clicar fora ou com Esc. */
function popMenu(anchor, items) {
  document.querySelectorAll('.pop-menu').forEach((m) => m.remove());
  const menu = el('div', { class: 'pop-menu', role: 'menu' },
    items.filter((i) => i && !i.hidden).map((i) => i.sep
      ? el('div', { class: 'pop-sep' })
      : el('button', { type: 'button', role: 'menuitem', class: `pop-item ${i.danger ? 'danger' : ''}`, onclick: async (e) => {
        e.stopPropagation();
        menu.remove();
        try {
          await i.onClick();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, el('span', { class: 'pop-ico' }, i.icon || ''), i.label)),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const top = r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4;
  menu.style.cssText = `left:${left}px;top:${top}px`;
  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'mousedown' && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', close, true);
    document.removeEventListener('keydown', close, true);
  };
  setTimeout(() => {
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', close, true);
  }, 0);
  return menu;
}

/** Dados que podem entrar na mensagem, com nome humano (o servidor troca pelo valor real). */
const EASY_VARS = [
  ['saudacao', '👋', 'Saudação', 'Bom dia / Boa tarde / Boa noite, conforme a hora'],
  ['first_name', '🙋', 'Primeiro nome do cliente', 'Ex.: Maria'],
  ['name', '👤', 'Nome completo do cliente', 'Ex.: Maria Silva'],
  ['atendente', '🎧', 'Meu nome', 'Nome de quem está enviando'],
  ['data', '📅', 'Data de hoje', 'Ex.: 29/09/2026'],
  ['hora', '⏰', 'Hora agora', 'Ex.: 14:30'],
  ['dia_semana', '🗓', 'Dia da semana', 'Ex.: terça-feira'],
];

/** Mesmo algoritmo do servidor (fieldSlug): "Número da conta" → numero_da_conta. */
const fieldSlug = (label) => String(label || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/** Campos do cliente criados pelo dono (CPF, endereço, boleto…). Guardados no fieldsMap da instância. */
function customFields() {
  const map = state.instance?.fieldsMap || {};
  return Object.entries(map).filter(([, label]) => label && fieldSlug(label)).map(([key, label]) => ({ key, label, slug: fieldSlug(label) })).sort((a, b) => a.key.localeCompare(b.key));
}

/** Recortes (mesma regra do servidor: com dígitos, conta só os dígitos). */
function applyCut(value, mod, n) {
  const v = String(value ?? '');
  if (!mod) return v;
  const digits = v.replace(/\D/g, '');
  const base = digits.length ? digits : v;
  const k = Math.max(1, Math.min(50, Number(n) || 6));
  return mod === 'primeiros' ? base.slice(0, k) : mod === 'ultimos' ? base.slice(-k) : mod === 'digitos' ? digits : mod === 'maiusculas' ? v.toUpperCase() : v;
}
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]{1,40})\s*(?:\|\s*(primeiros|ultimos|digitos|maiusculas)\s*(?::\s*(\d{1,2}))?\s*)?\}\}/g;

/** Troca só as variáveis conhecidas em `vars`; as outras ficam para o servidor. */
function fillKnown(text, vars) {
  return String(text || '').replace(TOKEN_RE, (m, k, mod, n) => (k in vars ? applyCut(vars[k], mod, n) : m));
}

/** Valores de exemplo para a prévia (o envio real usa os dados do contato). */
function sampleVars(clientName, extra = {}) {
  const h = new Date().getHours();
  const full = clientName || 'Maria Silva';
  const samples = { cpf: '123.456.789-09', cnpj: '12.345.678/0001-90', endereco: 'Rua das Flores, 100 - Centro', numero_da_conta: '0012345-6', conta: '0012345-6', boleto: '34191.79001 01043.510047 91020.150008 1 96610000012345', codigo_do_boleto: '34191.79001 01043.510047 91020.150008 1 96610000012345', vencimento: '10/10/2026', valor: 'R$ 199,90' };
  const out = {
    saudacao: h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite',
    first_name: full.split(' ')[0],
    name: full,
    atendente: state.user?.name || state.user?.email?.split('@')[0] || 'Atendente',
    data: new Date().toLocaleDateString('pt-BR'),
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    dia_semana: new Date().toLocaleDateString('pt-BR', { weekday: 'long' }),
  };
  for (const f of customFields()) out[f.slug] = samples[f.slug] ?? `(${f.label})`;
  return { ...out, ...extra };
}
const fillVars = (s, clientName, extra) => fillKnown(s, sampleVars(clientName, extra));

/** Insere texto na posição do cursor (e avisa o formulário para atualizar a prévia). */
function insertAtCursor(field, text) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  const pos = start + text.length;
  field.focus();
  field.setSelectionRange?.(pos, pos);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Escolher "inteiro / 6 primeiros / 6 últimos" de um campo (CPF, CNPJ, boleto…). */
function cutMenu(anchor, field, slug, label) {
  popMenu(anchor, [
    { icon: '📌', label: `${label} (inteiro)`, onClick: () => insertAtCursor(field, `{{${slug}}}`) },
    { icon: '⬅️', label: `${label}: 6 primeiros números`, onClick: () => insertAtCursor(field, `{{${slug}|primeiros:6}}`) },
    { icon: '➡️', label: `${label}: 6 últimos números`, onClick: () => insertAtCursor(field, `{{${slug}|ultimos:6}}`) },
    { icon: '➡️', label: `${label}: 4 últimos números`, onClick: () => insertAtCursor(field, `{{${slug}|ultimos:4}}`) },
    { icon: '🔢', label: `${label}: só os números`, onClick: () => insertAtCursor(field, `{{${slug}|digitos}}`) },
  ]);
}

/** Itens de menu dos campos do cliente (+ colunas de planilha colada, quando houver). */
function customVarItems(anchor, field, extraColumns = []) {
  const items = [...customFields().map((f) => ({ slug: f.slug, label: f.label })), ...extraColumns.filter((c) => !customFields().some((f) => f.slug === c.slug))];
  return [
    { sep: true },
    ...items.map((f) => ({ icon: '📌', label: `${f.label}…`, onClick: () => cutMenu(anchor, field, f.slug, f.label) })),
    { icon: '⚙️', label: 'Criar ou mudar campos (CPF, endereço, boleto…)', hidden: state.user.role === 'agent', onClick: () => fieldsEditor() },
  ];
}

/** Botão "🙂" / "➕ Inserir" com os dados do cliente em linguagem simples. */
function varButton(field, { compact = false, columns } = {}) {
  const b = el('button', { type: 'button', class: compact ? 'btn attach var-btn' : 'btn sm var-btn', title: 'Colocar o nome do cliente, saudação, CPF, boleto…' }, compact ? '🙂' : '➕ Inserir nome, saudação, CPF…');
  b.addEventListener('click', () => popMenu(b, [
    ...EASY_VARS.map(([k, icon, label]) => ({ icon, label, onClick: () => insertAtCursor(field, `{{${k}}}`) })),
    ...customVarItems(b, field, columns ? columns() : []),
  ]));
  return b;
}

/** Faixa de chips fixa (para formulários grandes: enviar e campanhas). */
function varChips(field, { columns } = {}) {
  const box = el('div', { class: 'var-chips' });
  const draw = () => {
    const cols = columns ? columns() : [];
    const custom = [...customFields().map((f) => ({ slug: f.slug, label: f.label })), ...cols.filter((c) => !customFields().some((f) => f.slug === c.slug))];
    box.replaceChildren(
      el('span', { class: 'small muted' }, 'Clique para colocar na mensagem:'),
      ...EASY_VARS.slice(0, 5).map(([k, icon, label, hint]) => el('button', { type: 'button', class: 'chip-btn', title: hint, onclick: () => insertAtCursor(field, `{{${k}}}`) }, `${icon} ${label}`)),
      ...custom.map((f) => {
        const b = el('button', { type: 'button', class: 'chip-btn custom', title: 'Inteiro, 6 primeiros ou 6 últimos números' }, `📌 ${f.label} ▾`);
        b.addEventListener('click', () => cutMenu(b, field, f.slug, f.label));
        return b;
      }),
      state.user.role !== 'agent' && el('button', { type: 'button', class: 'chip-btn add', onclick: () => fieldsEditor(draw) }, '⚙️ Criar campo'),
    );
  };
  draw();
  box.redraw = draw;
  return box;
}

/**
 * Campos do cliente (variáveis personalizadas). Cada campo ocupa um "lead_fieldNN" (até 20)
 * e vira variável pelo nome: CPF → {{cpf}}. Apagar um campo só esvazia o nome.
 */
function fieldsEditor(onSaved) {
  const map = { ...(state.instance?.fieldsMap || {}) };
  const keys = Array.from({ length: 20 }, (_, i) => `lead_field${String(i + 1).padStart(2, '0')}`);
  const rows = el('div', { class: 'stack' });
  const inputs = {};
  const draw = () => rows.replaceChildren(...keys.filter((k) => map[k]).map((k) => {
    const inp = el('input', { value: map[k], maxlength: '40' });
    inputs[k] = inp;
    inp.addEventListener('input', () => (map[k] = inp.value));
    return el('div', { class: 'row field-row' }, inp, el('code', { class: 'small muted' }, `{{${fieldSlug(map[k]) || '…'}}}`), el('button', { type: 'button', class: 'icon-btn', title: 'Remover campo', onclick: () => { map[k] = ''; draw(); } }, '✕'));
  }), keys.every((k) => !map[k]) ? el('p', { class: 'muted small', style: 'margin:0' }, 'Nenhum campo ainda. Use os botões abaixo.') : null);
  const add = (label) => {
    const free = keys.find((k) => !map[k]);
    if (!free) return toast('Limite de 20 campos', 'error');
    if (Object.values(map).some((v) => v && fieldSlug(v) === fieldSlug(label))) return toast('Esse campo já existe', 'error');
    map[free] = label;
    draw();
  };
  const custom = el('input', { maxlength: '40', placeholder: 'Outro campo (ex.: Placa do carro)' });
  const presets = ['Endereço', 'CPF', 'CNPJ', 'Número da conta', 'Código do boleto', 'Vencimento', 'Valor', 'Protocolo'];
  draw();
  modal('📌 Campos do cliente', el('div', { class: 'stack' },
    el('p', { class: 'muted', style: 'margin:0' }, 'Crie os dados que você quer usar nas mensagens. Depois, em cada conversa, clique em "📝 Dados do cliente" para preencher, ou cole uma planilha na campanha.'),
    rows,
    el('div', { class: 'var-chips' }, presets.map((p) => el('button', { type: 'button', class: 'chip-btn', onclick: () => add(p) }, `＋ ${p}`))),
    el('div', { class: 'row' }, custom, el('button', { type: 'button', class: 'btn', onclick: () => { if (custom.value.trim()) { add(custom.value.trim()); custom.value = ''; } } }, 'Adicionar')),
  ), [
    (close) => actionBtn('Salvar campos', async () => {
      const body = Object.fromEntries(keys.map((k) => [k, (map[k] || '').trim()]));
      const inst = await iapi('/instance/updateFieldsMap', { method: 'POST', body });
      state.instance = { ...state.instance, fieldsMap: inst.fieldsMap || body };
      close();
      toast('Campos salvos');
      onSaved?.();
    }, 'btn primary'),
  ]);
}

/** Dados de um cliente (nome, e-mail, campos personalizados, observações). */
async function clientDataModal(chatid, onSaved) {
  const r = await iapi('/chat/find', { method: 'POST', body: { wa_fastid: chatid, limit: 1 } });
  const c = r.chats[0] || {};
  const fields = customFields();
  const name = el('input', { value: c.lead_name || c.name || '', maxlength: '200' });
  const email = el('input', { type: 'email', value: c.lead_email || '', maxlength: '200' });
  const notes = el('textarea', { rows: '3', maxlength: '5000' });
  notes.value = c.lead_notes || '';
  const inputs = fields.map((f) => ({ f, inp: el('input', { value: c[f.key] || '', maxlength: '1000' }) }));
  modal('📝 Dados do cliente', el('div', { class: 'stack' },
    el('label', {}, 'Nome', name),
    el('label', {}, 'E-mail', email),
    inputs.map(({ f, inp }) => el('label', {}, f.label, inp)),
    !fields.length && el('p', { class: 'muted small', style: 'margin:0' }, state.user.role === 'agent' ? 'O responsável ainda não criou campos como CPF ou endereço.' : 'Crie campos como CPF, endereço ou boleto em "⚙️ Criar campo".'),
    el('label', {}, 'Observações internas (o cliente não vê)', notes),
  ), [
    state.user.role !== 'agent' && ((close) => el('button', { type: 'button', class: 'btn', onclick: () => { close(); fieldsEditor(); } }, '⚙️ Criar campo')),
    (close) => actionBtn('Salvar', async () => {
      await iapi('/chat/editLead', { method: 'POST', body: { id: chatid, lead_name: name.value.trim(), ...(email.value.trim() ? { lead_email: email.value.trim() } : { lead_email: '' }), lead_notes: notes.value, ...Object.fromEntries(inputs.map(({ f, inp }) => [f.key, inp.value.trim()])) } });
      close();
      toast('Dados salvos');
      onSaved?.();
    }, 'btn primary'),
  ].filter(Boolean));
}

/**
 * Editor de opções em linhas (enquete, botões, lista) — no lugar de "Texto|id".
 * values() devolve o formato que a API espera.
 */
function optionRows(kind) {
  const max = kind === 'poll' ? 12 : kind === 'button' ? 3 : 10;
  const box = el('div', { class: 'opt-rows' });
  const rows = [];
  const addRow = (v = {}) => {
    if (rows.length >= max) return toast(`No máximo ${max} opções`, 'error');
    const text = el('input', { placeholder: kind === 'list' ? 'Nome da opção (ex.: Falar com vendas)' : kind === 'button' ? 'Texto do botão (ex.: Quero comprar)' : `Opção ${rows.length + 1}`, maxlength: kind === 'button' ? '25' : '100', value: v.text || '' });
    const extra = kind === 'list' ? el('input', { placeholder: 'Descrição (opcional)', maxlength: '72', value: v.desc || '' }) : null;
    const type = kind === 'button' ? el('select', { 'aria-label': 'O que o botão faz' },
      el('option', { value: 'reply' }, '💬 Responder'),
      el('option', { value: 'url' }, '🔗 Abrir site'),
      el('option', { value: 'call' }, '📞 Ligar'),
      el('option', { value: 'copy' }, '📋 Copiar código'),
    ) : null;
    const value = kind === 'button' ? el('input', { placeholder: '', class: 'opt-value hidden-input' }) : null;
    if (type) {
      const sync = () => {
        value.classList.toggle('hidden-input', type.value === 'reply');
        value.placeholder = { url: 'https://seusite.com.br', call: '+55 19 99999-9999', copy: 'CUPOM10' }[type.value] || '';
      };
      type.addEventListener('change', () => { sync(); box.dispatchEvent(new Event('input', { bubbles: true })); });
      sync();
    }
    const del = el('button', { type: 'button', class: 'icon-btn', title: 'Remover', onclick: () => {
      rows.splice(rows.indexOf(row), 1);
      line.remove();
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } }, '✕');
    const row = { text, extra, type, value };
    rows.push(row);
    const line = el('div', { class: 'opt-row' }, el('span', { class: 'opt-num' }, kind === 'poll' ? '○' : kind === 'list' ? '•' : '▭'), el('div', { class: 'opt-fields' }, el('div', { class: 'row' }, text, type), extra, value), del);
    list.append(line);
  };
  const list = el('div', { class: 'stack' });
  const add = el('button', { type: 'button', class: 'btn sm', onclick: () => addRow() }, kind === 'poll' ? '+ Adicionar opção' : kind === 'button' ? '+ Adicionar botão' : '+ Adicionar item');
  box.append(list, add);
  const initial = kind === 'button' ? 1 : 2;
  for (let i = 0; i < initial; i++) addRow();
  return {
    el: box,
    labels: () => rows.map((r) => r.text.value.trim()).filter(Boolean),
    values() {
      const out = [];
      for (const r of rows) {
        const t = r.text.value.trim().replace(/\|/g, '/');
        if (!t) continue;
        if (kind === 'button') {
          const v = r.value.value.trim();
          if (r.type.value !== 'reply' && !v) throw new Error(`Complete o botão "${t}"`);
          if (r.type.value === 'url' && !/^https?:\/\//i.test(v)) throw new Error(`O link do botão "${t}" precisa começar com https://`);
          out.push(r.type.value === 'reply' ? t : r.type.value === 'url' ? `${t}|${v}` : `${t}|${r.type.value}:${v}`);
        } else if (kind === 'list') {
          const d = r.extra.value.trim().replace(/\|/g, '/');
          out.push(`${t}|${t.toLowerCase().normalize('NFD').replace(/[^\w]+/g, '_').slice(0, 40) || 'item'}${d ? `|${d}` : ''}`);
        } else out.push(t);
      }
      if (kind === 'poll' && out.length < 2) throw new Error('A enquete precisa de pelo menos 2 opções');
      if (!out.length) throw new Error('Adicione pelo menos uma opção');
      return out;
    },
  };
}

/** Extrai latitude/longitude de um link do Google Maps colado pelo usuário. */
function coordsFromText(s) {
  const m = String(s).match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/) || String(s).match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

const KIND_INFO = {
  poll: { icon: '📊', title: 'Enquete', help: 'Uma pergunta com opções para o cliente tocar. Funciona em todos os celulares.' },
  button: { icon: '🔘', title: 'Botões', help: 'Mensagem com até 3 botões (responder, abrir site, ligar ou copiar código). Pode não aparecer em alguns celulares.' },
  list: { icon: '📋', title: 'Lista de opções', help: 'Um botão que abre uma lista para o cliente escolher. Pode não aparecer em alguns celulares.' },
  location: { icon: '📍', title: 'Localização', help: 'Mande o endereço da loja. Cole o link do Google Maps ou digite as coordenadas.' },
  contact: { icon: '👤', title: 'Contato', help: 'Envie o cartão de um contato (nome e telefone).' },
};

/**
 * Montador guiado de mensagens especiais, com prévia ao vivo.
 * onSend(endpoint, body) faz o envio (o chat e o envio avulso usam o mesmo montador).
 */
function specialMessageModal(kind, { clientName, onSend }) {
  const info = KIND_INFO[kind];
  const preview = waPreview('Como vai chegar');
  const fields = el('div', { class: 'stack' });
  const text = el('textarea', { rows: '3', maxlength: '1000', placeholder: kind === 'poll' ? 'Qual é a pergunta? Ex.: Qual o melhor horário para você?' : 'Escreva a mensagem. Ex.: {{saudacao}}, {{first_name}}! Escolha uma opção:' });
  let opts = null;
  let multi = null;
  let listButton = null;
  let footer = null;
  let img = null;
  let imgAtt = null;
  let refresh;
  if (['poll', 'button', 'list'].includes(kind)) {
    opts = optionRows(kind);
    if (kind === 'button') {
      img = fileDrop({ label: 'Foto no topo (opcional)', hint: 'Foto', accept: 'image/*', onChange: (a) => { imgAtt = a; refresh(); } });
      fields.append(img.el);
    }
    fields.append(el('label', {}, kind === 'poll' ? 'Pergunta' : 'Mensagem', text), el('div', { class: 'row' }, varButton(text)));
    fields.append(el('div', { class: 'field' }, el('div', { class: 'field-label' }, kind === 'poll' ? 'Opções de resposta' : kind === 'button' ? 'Botões' : 'Itens da lista'), opts.el));
    if (kind === 'poll') {
      multi = el('input', { type: 'checkbox' });
      fields.append(el('label', { class: 'inline' }, multi, 'Permitir marcar mais de uma opção'));
    }
    if (kind === 'list') {
      listButton = el('input', { maxlength: '20', placeholder: 'Ver opções', value: 'Ver opções' });
      fields.append(el('label', {}, 'Texto do botão que abre a lista', listButton));
    }
    if (kind !== 'poll') {
      footer = el('input', { maxlength: '60', placeholder: 'Ex.: Loja Festa • Atendimento' });
      fields.append(el('label', {}, 'Rodapé pequeno (opcional)', footer));
    }
  }
  const loc = kind === 'location' ? {
    link: el('input', { placeholder: 'Cole aqui o link do Google Maps ou "-22.37, -46.94"' }),
    name: el('input', { placeholder: 'Nome do local (ex.: Loja Centro)', maxlength: '100' }),
    address: el('input', { placeholder: 'Endereço (ex.: Rua X, 139 - Centro)', maxlength: '200' }),
  } : null;
  if (loc) fields.append(el('label', {}, 'Onde fica', loc.link), el('p', { class: 'muted small', style: 'margin:0' }, 'No Google Maps: abra o local → Compartilhar → Copiar link. Se o link for curto (maps.app.goo.gl), abra-o no navegador e copie o endereço completo.'), el('label', {}, 'Nome', loc.name), el('label', {}, 'Endereço', loc.address));
  const contact = kind === 'contact' ? { name: el('input', { placeholder: 'Nome do contato', maxlength: '100' }), phone: el('input', { placeholder: '+55 19 99999-9999', inputmode: 'tel' }) } : null;
  if (contact) fields.append(el('label', {}, 'Nome', contact.name), el('label', {}, 'Telefone', contact.phone));

  refresh = () => {
    const t = fillVars(text.value, clientName);
    if (kind === 'poll') preview.update({ text: `📊 ${t || 'Pergunta'}`, buttons: opts.labels().map((o) => `○ ${o}`) });
    else if (kind === 'button') preview.update({ text: t, att: imgAtt, buttons: opts.labels(), footer: footer?.value });
    else if (kind === 'list') preview.update({ text: t, footer: footer?.value, listButton: listButton.value || 'Ver opções' });
    else if (kind === 'location') {
      const c = coordsFromText(loc.link.value);
      preview.update({ text: `📍 ${loc.name.value || 'Localização'}\n${loc.address.value || (c ? `${c.latitude}, ${c.longitude}` : '')}` });
    } else if (kind === 'contact') preview.update({ text: `👤 ${contact.name.value || 'Contato'}\n${contact.phone.value}` });
  };
  const form = el('div', { class: 'compose-grid modal-compose' }, el('div', { class: 'stack' }, el('div', { class: 'alert small' }, info.help), fields), preview.el);
  form.addEventListener('input', refresh);
  refresh();

  modal(`${info.icon} ${info.title}`, form, [
    (close) => actionBtn('Enviar ➤', async () => {
      if (kind === 'poll') {
        if (!text.value.trim()) throw new Error('Escreva a pergunta');
        await onSend('/send/menu', { type: 'poll', text: text.value.trim(), choices: opts.values(), ...(multi.checked ? { selectableCount: 0 } : { selectableCount: 1 }) });
      } else if (kind === 'button' || kind === 'list') {
        if (!text.value.trim()) throw new Error('Escreva a mensagem');
        const image = kind === 'button' && img.has() ? await img.ready() : null;
        await onSend('/send/menu', { type: kind, text: text.value.trim(), choices: opts.values(), ...(footer.value.trim() ? { footerText: footer.value.trim() } : {}), ...(listButton ? { listButton: listButton.value.trim() || 'Ver opções' } : {}), ...(image ? { imageButton: image.file } : {}) });
      } else if (kind === 'location') {
        const c = coordsFromText(loc.link.value);
        if (!c) throw new Error('Não achei as coordenadas. Cole o link completo do Google Maps ou digite "-22.37, -46.94".');
        await onSend('/send/location', { ...c, ...(loc.name.value.trim() ? { name: loc.name.value.trim() } : {}), ...(loc.address.value.trim() ? { address: loc.address.value.trim() } : {}) });
      } else if (kind === 'contact') {
        const digits = contact.phone.value.replace(/\D/g, '');
        if (!contact.name.value.trim() || digits.length < 10) throw new Error('Informe nome e telefone com DDD');
        await onSend('/send/contact', { fullName: contact.name.value.trim(), phoneNumber: digits });
      }
      toast('Enviado ✓');
      close();
    }, 'btn primary'),
  ]);
}

/** Grade de ícones grandes (menu do 📎 no chat). */
function attachMenu(anchor, handlers) {
  popMenu(anchor, [
    { icon: '🖼', label: 'Foto ou vídeo', onClick: handlers.media },
    { icon: '📄', label: 'Documento (PDF, Word…)', onClick: handlers.document },
    { icon: '🎵', label: 'Áudio (arquivo)', onClick: handlers.audio },
    { sep: true },
    { icon: '📊', label: 'Enquete', onClick: () => handlers.special('poll') },
    { icon: '🔘', label: 'Botões', onClick: () => handlers.special('button') },
    { icon: '📋', label: 'Lista de opções', onClick: () => handlers.special('list') },
    { icon: '📍', label: 'Localização', onClick: () => handlers.special('location') },
    { icon: '👤', label: 'Contato', onClick: () => handlers.special('contact') },
  ]);
}

// ======================================================================= enviar
/** Cartões grandes para escolher o tipo de mensagem (no lugar de uma lista de opções). */
function kindTiles(kinds, selected, onPick) {
  const box = el('div', { class: 'kind-tiles', role: 'radiogroup' });
  const draw = (sel) => box.replaceChildren(...kinds.map(([v, icon, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(sel === v), class: `kind-tile ${sel === v ? 'active' : ''}`, onclick: () => { draw(v); onPick(v); } }, el('span', { class: 'kind-ico' }, icon), el('span', {}, label))));
  draw(selected);
  return box;
}

function pageSend() {
  const result = el('div');
  const preview = waPreview('Como vai chegar');
  let kind = 'text';
  let att = null;
  const number = el('input', { name: 'number', required: true, inputmode: 'tel', placeholder: 'Ex.: 19 99999-9999 (com DDD)' });
  const text = el('textarea', { name: 'text', rows: '4', placeholder: 'Escreva a mensagem…' });
  const drop = fileDrop({ label: 'Arquivo', onChange: (a) => { att = a; setMtypeOptions(a?.kind); refresh(); } });
  const mtype = el('select', { name: 'mtype' });
  const setMtypeOptions = (k) => {
    const opts = {
      image: [['image', 'Foto'], ['sticker', 'Figurinha']],
      video: [['video', 'Vídeo'], ['videoplay', 'GIF (repete sem som)'], ['ptv', 'Vídeo redondo (recado)']],
      audio: [['ptt', 'Áudio de voz (como se tivesse gravado)'], ['audio', 'Arquivo de música']],
      document: [['document', 'Documento']],
    }[k] || [['image', 'Foto']];
    mtype.replaceChildren(...opts.map(([v, l]) => el('option', { value: v }, l)));
  };
  setMtypeOptions('image');
  const typing = el('input', { type: 'checkbox' });
  const body = el('div', { class: 'stack' });
  const refresh = () => preview.update({ text: kind === 'media' && mtype.value === 'ptt' ? '' : text.value, att: kind === 'media' ? att : null });
  text.addEventListener('input', refresh);
  mtype.addEventListener('change', refresh);

  const special = (k) => el('div', { class: 'card special-card' },
    el('div', { class: 'big-ico' }, KIND_INFO[k].icon),
    el('p', {}, KIND_INFO[k].help),
    el('button', { type: 'button', class: 'btn primary big', onclick: () => {
      const n = normalizePhone(number.value);
      if (n.length < 12) return toast('Primeiro digite o número de destino (com DDD)', 'error');
      specialMessageModal(k, { clientName: '', onSend: async (endpoint, b) => {
        const r = await iapi(endpoint, { method: 'POST', body: { number: n, ...b, ...(typing.checked ? { delay: 3000 } : {}) } });
        result.replaceChildren(el('div', { class: 'alert' }, `✅ Enviado! (${r.messageid || r.id || 'ok'})`));
      } });
    } }, `Montar ${KIND_INFO[k].title.toLowerCase()}`),
  );
  const draw = () => {
    if (kind === 'text') body.replaceChildren(el('label', {}, 'Mensagem', text), varChips(text), el('p', { class: 'muted small', style: 'margin:0' }, 'Dica: *negrito*  _itálico_  ~riscado~'));
    else if (kind === 'media') body.replaceChildren(drop.el, el('label', {}, 'Enviar como', mtype), el('label', {}, 'Legenda (opcional)', text), varChips(text));
    else body.replaceChildren(special(kind));
    refresh();
  };
  const tiles = kindTiles([
    ['text', '💬', 'Texto'],
    ['media', '🖼', 'Foto, vídeo, áudio ou documento'],
    ['poll', '📊', 'Enquete'],
    ['button', '🔘', 'Botões'],
    ['list', '📋', 'Lista de opções'],
    ['location', '📍', 'Localização'],
    ['contact', '👤', 'Contato'],
  ], kind, (k) => { kind = k; draw(); });

  const sendBtn = el('button', { class: 'btn primary big', type: 'submit' }, 'Enviar ➤');
  const form = el('form', { class: 'card stack' },
    el('label', {}, '1. Para quem? (número com DDD ou ID do grupo)', number),
    el('div', { class: 'field-label' }, '2. O que você quer mandar?'), tiles,
    el('div', { class: 'field-label' }, '3. Monte a mensagem'), body,
    el('label', { class: 'inline' }, typing, 'Mostrar "digitando…" por 3 segundos antes'),
    el('div', { class: 'row' }, sendBtn),
    result,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!['text', 'media'].includes(kind)) return toast(`Use o botão "Montar ${KIND_INFO[kind].title.toLowerCase()}"`, 'error');
    const n = number.value.includes('@') ? number.value.trim() : normalizePhone(number.value);
    if (!n.includes('@') && n.length < 12) return toast('Número incompleto: coloque o DDD', 'error');
    sendBtn.disabled = true;
    try {
      const common = { number: n, ...(typing.checked ? { delay: 3000 } : {}) };
      let r;
      if (kind === 'text') {
        if (!text.value.trim()) throw new Error('Escreva a mensagem');
        r = await iapi('/send/text', { method: 'POST', body: { ...common, text: text.value, linkPreview: /https?:\/\//.test(text.value) } });
      } else {
        if (!drop.has()) throw new Error('Arraste ou escolha o arquivo');
        sendBtn.textContent = 'Enviando o arquivo…';
        const up = await drop.ready();
        r = await iapi('/send/media', { method: 'POST', body: { ...common, type: mtype.value, file: up.file, ...(text.value.trim() && !['ptt', 'audio', 'sticker'].includes(mtype.value) ? { text: text.value } : {}), ...(up.kind === 'document' ? { docName: up.name } : {}) } });
      }
      result.replaceChildren(el('div', { class: 'alert' }, `✅ Enviado! (${r.messageid || r.id})`));
      toast('Mensagem enviada');
    } catch (ex) {
      result.replaceChildren(el('div', { class: 'alert error' }, ex.message));
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Enviar ➤';
    }
  });
  draw();

  if (state.instance.status !== 'connected') {
    return layout('Enviar mensagem', el('div', { class: 'alert warn' }, 'A instância não está conectada. ', el('a', { href: `#/i/${state.instanceId}/visao` }, 'Conectar agora')));
  }
  layout('Enviar mensagem', el('div', { class: 'compose-grid' }, form, preview.el), { subtitle: 'Três passos: para quem, o que mandar e enviar' });
}

// ======================================================================= campanhas
/**
 * Lê a lista de destinatários. Aceita um número por linha OU uma planilha colada
 * (tab, ";" ou ","), com títulos na 1ª linha — a coluna de telefone é a que tem
 * "tel", "fone", "celular", "whats" ou "numero" no título (senão, a 1ª).
 */
function parseAudience(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { columns: [], rows: [] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : lines[0].includes(',') && /[a-z]/i.test(lines[0]) ? ',' : null;
  const header = sep && /[a-zà-ú]/i.test(lines[0].replace(/\d/g, '')) ? lines[0].split(sep).map((h) => h.trim()) : null;
  if (!header) {
    const rows = [...new Set(lines.flatMap((l) => l.split(/[,;]+/)).map((n) => (n.includes('@') ? n.trim() : normalizePhone(n))).filter((n) => n.length >= 12 || n.includes('@')))].map((number) => ({ number, vars: {} }));
    return { columns: [], rows };
  }
  let phoneIdx = header.findIndex((h) => /tel|fone|celular|whats|n[uú]mero/i.test(h));
  if (phoneIdx < 0) phoneIdx = 0;
  const columns = header.map((label, idx) => ({ label, idx, slug: fieldSlug(label) })).filter((c) => c.idx !== phoneIdx && c.slug);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep).map((c) => c.trim());
    const number = normalizePhone(cells[phoneIdx]);
    if (number.length < 12) continue;
    const vars = Object.fromEntries(columns.map((c) => [c.slug, cells[c.idx] ?? '']));
    // Coluna "Nome" também alimenta {{name}} e {{first_name}}.
    const nm = columns.find((c) => /^nome/.test(c.slug));
    if (nm && vars[nm.slug]) Object.assign(vars, { name: vars[nm.slug], first_name: vars[nm.slug].split(' ')[0] });
    rows.push({ number, vars });
  }
  return { columns, rows };
}

async function pageCampaigns() {
  const listBox = el('div', { class: 'card' });
  const statusName = { scheduled: 'Agendada', sending: 'Enviando', paused: 'Pausada', done: 'Concluída', deleting: 'Excluída' };

  const loadList = async () => {
    const folders = await iapi('/sender/listfolders');
    if (!folders.length) return listBox.replaceChildren(el('div', { class: 'empty' }, 'Nenhuma campanha ainda.'));
    listBox.replaceChildren(el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Campanha', 'Status', 'Progresso', 'Entregues / Lidas', 'Falhas', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, folders.map((f) => {
        const done = f.log_sucess + f.log_failed;
        const pct = f.log_total ? Math.round((done / f.log_total) * 100) : 0;
        return el('tr', {},
          el('td', {}, el('div', { style: 'font-weight:600' }, f.info || 'Sem nome'), el('div', { class: 'muted small' }, new Date(f.created).toLocaleString('pt-BR'))),
          el('td', {}, statusName[f.status] || f.status),
          el('td', { style: 'min-width:140px' }, el('div', { class: 'progress' }, el('div', { style: `width:${pct}%` })), el('div', { class: 'small muted' }, `${done} de ${f.log_total} (${pct}%)`)),
          el('td', {}, `${f.log_delivered} / ${f.log_read}`),
          el('td', {}, f.log_failed),
          el('td', {}, el('div', { class: 'row' },
            ['scheduled', 'sending'].includes(f.status) && actionBtn('Pausar', () => editFolder(f.id, 'stop'), 'btn sm'),
            f.status === 'paused' && actionBtn('Continuar', () => editFolder(f.id, 'continue'), 'btn sm'),
            !['done', 'deleting'].includes(f.status) && actionBtn('Cancelar', () => editFolder(f.id, 'delete'), 'btn sm danger'),
          )),
        );
      })),
    ));
  };
  const editFolder = async (id, action) => {
    await iapi('/sender/edit', { method: 'POST', body: { folder_id: id, action } });
    await loadList();
  };

  const preview = waPreview('Como o contato vai receber');
  let att = null;
  let kind = 'text';
  let opts = null;
  const drop = fileDrop({ label: 'Anexo (opcional)', hint: 'Foto, vídeo, áudio ou documento', onChange: (a) => { att = a; refresh(); } });
  // Botões: o WhatsApp só aceita foto no topo da mensagem (como no envio avulso).
  let btnImg = null;
  const btnDrop = fileDrop({ label: 'Foto no topo (opcional)', hint: 'Foto', accept: 'image/*', onChange: (a) => { btnImg = a; refresh(); } });
  const text = el('textarea', { name: 'text', rows: '4', placeholder: 'Ex.: {{saudacao}}, {{first_name}}! Temos novidades para você…' });
  // Planilha colada (Excel/Google): 1ª linha com títulos; cada coluna vira variável.
  const numbersArea = el('textarea', { name: 'numbers', required: true, rows: '5', placeholder: '19 99999-9999\n19 98888-8888\n\nOu cole da planilha, com títulos na 1ª linha:\nTelefone\tNome\tCPF\tBoleto' });
  let audience = { columns: [], rows: [] };
  const audienceInfo = el('div', { class: 'small muted' });
  const chips = varChips(text, { columns: () => audience.columns });
  numbersArea.addEventListener('input', () => {
    audience = parseAudience(numbersArea.value);
    audienceInfo.textContent = audience.columns.length
      ? `📄 Planilha: ${audience.rows.length} contato(s) e ${audience.columns.length} coluna(s) (${audience.columns.map((c) => c.label).join(', ')}). Use as colunas como variáveis abaixo.`
      : audience.rows.length ? `${audience.rows.length} número(s)` : '';
    chips.redraw();
    refresh();
  });
  const listButton = el('input', { maxlength: '20', value: 'Ver opções' });
  const extra = el('div', { class: 'stack' });
  const drawKind = () => {
    opts = ['poll', 'button', 'list'].includes(kind) ? optionRows(kind) : null;
    extra.replaceChildren(...(kind === 'text' ? [drop.el] : [
      el('div', { class: 'alert small' }, KIND_INFO[kind].help),
      kind === 'button' && btnDrop.el,
      el('div', { class: 'field' }, el('div', { class: 'field-label' }, kind === 'poll' ? 'Opções de resposta' : kind === 'button' ? 'Botões' : 'Itens da lista'), opts.el),
      kind === 'list' && el('label', {}, 'Texto do botão que abre a lista', listButton),
    ]));
    refresh();
  };
  const tiles = kindTiles([['text', '💬', 'Texto (com anexo opcional)'], ['poll', '📊', 'Enquete'], ['button', '🔘', 'Botões'], ['list', '📋', 'Lista de opções']], kind, (k) => { kind = k; drawKind(); });
  const form = el('form', { class: 'card stack' },
    el('h2', {}, 'Nova campanha (mesma mensagem para todos)'),
    el('label', {}, 'Nome da campanha', el('input', { name: 'info', placeholder: 'Ex.: Promoção de outubro', maxlength: '200' })),
    el('label', {}, 'Números (um por linha, com DDD) — ou cole uma planilha', numbersArea),
    audienceInfo,
    el('div', { class: 'field-label' }, 'Tipo de mensagem'), tiles,
    el('label', {}, 'Mensagem', text),
    chips,
    extra,
    el('div', { class: 'grid cols-2' },
      el('label', {}, 'Esperar no mínimo (segundos entre mensagens)', el('input', { name: 'delayMin', type: 'number', min: '3', value: '15', required: true })),
      el('label', {}, 'Esperar no máximo (segundos)', el('input', { name: 'delayMax', type: 'number', min: '3', value: '40', required: true })),
    ),
    el('label', {}, 'Agendar para (opcional)', el('input', { name: 'when', type: 'datetime-local' })),
    el('div', { class: 'alert warn small' }, 'Dica anti-bloqueio: use intervalos de 15 a 60 s, envie só para quem conhece você e evite mais de algumas centenas por dia em números novos. Anexos ficam guardados por 30 dias — agende dentro desse prazo.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary big', type: 'submit' }, 'Criar campanha')),
  );
  function refresh() {
    // Prévia com os dados da 1ª linha da planilha, quando houver.
    const t = audience.rows[0] ? fillKnown(text.value, audience.rows[0].vars) : text.value;
    if (kind === 'poll') preview.update({ text: `📊 ${t || 'Pergunta'}`, buttons: opts?.labels().map((o) => `○ ${o}`) || [] });
    else if (kind === 'button') preview.update({ text: t, att: btnImg, buttons: opts?.labels() || [] });
    else if (kind === 'list') preview.update({ text: t, listButton: listButton.value || 'Ver opções' });
    // Áudio de voz não tem legenda no WhatsApp: a prévia mostra só o áudio.
    else preview.update({ text: att?.kind === 'audio' ? '' : t, att });
  }
  form.addEventListener('input', refresh);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const f = formData(form);
      const numbers = [...new Set(audience.rows.map((r) => r.number))];
      if (!numbers.length) throw new Error('Informe ao menos um número com DDD');
      let body;
      if (kind === 'text') {
        if (!f.text && !drop.has()) throw new Error('Escreva a mensagem ou anexe um arquivo');
        let up = null;
        if (drop.has()) {
          btn.textContent = 'Aguardando o anexo…';
          up = await drop.ready();
        }
        const mediaType = up ? { image: 'image', video: 'video', audio: 'ptt', document: 'document' }[up.kind] : 'text';
        body = { type: mediaType, ...(f.text && mediaType !== 'ptt' ? { text: f.text } : {}), ...(up ? { file: up.file } : {}), ...(up?.kind === 'document' ? { docName: up.name } : {}) };
      } else {
        if (!f.text) throw new Error(kind === 'poll' ? 'Escreva a pergunta' : 'Escreva a mensagem');
        let image = null;
        if (kind === 'button' && btnDrop.has()) {
          btn.textContent = 'Aguardando a foto…';
          image = await btnDrop.ready();
        }
        body = { type: kind, text: f.text, choices: opts.values(), ...(kind === 'list' ? { listButton: listButton.value || 'Ver opções' } : {}), ...(kind === 'poll' ? { selectableCount: 1 } : {}), ...(image ? { imageButton: image.file } : {}) };
      }
      const common = { delayMin: Number(f.delayMin), delayMax: Number(f.delayMax), info: f.info, ...(f.when ? { scheduled_for: new Date(f.when).getTime() } : {}) };
      // Com planilha: cada contato recebe a mensagem já com os dados da linha dele.
      const r = audience.columns.length
        ? await iapi('/sender/advanced', { method: 'POST', body: { ...common, messages: audience.rows.map((row) => ({ number: row.number, ...body, ...(body.text ? { text: fillKnown(body.text, row.vars) } : {}) })) } })
        : await iapi('/sender/simple', { method: 'POST', body: { numbers, ...body, ...common } });
      toast(`Campanha criada com ${r.count} mensagens`);
      form.reset();
      drop.clear();
      btnDrop.clear();
      audience = { columns: [], rows: [] };
      audienceInfo.textContent = '';
      chips.redraw();
      drawKind();
      await loadList();
    } catch (ex) {
      toast(ex.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Criar campanha';
    }
  });
  drawKind();

  sseHandlers.add((type) => type === 'sender' && loadList().catch(() => undefined));
  state.timers.push(setInterval(() => loadList().catch(() => undefined), 15000));
  layout('Campanhas', el('div', { class: 'stack' }, listBox, el('div', { class: 'compose-grid' }, form, preview.el)), { subtitle: 'Envio em massa com intervalo aleatório, pausa e retomada', actions: [actionBtn('Atualizar', loadList)] });
  await loadList();
}

// ======================================================================= webhooks
const WH_EVENTS = [
  ['messages', 'Mensagens recebidas/enviadas'],
  ['messages_update', 'Entrega e leitura'],
  ['connection', 'Conexão da instância'],
  ['chats', 'Atualização de chats'],
  ['contacts', 'Contatos'],
  ['presence', 'Digitando / gravando'],
  ['groups', 'Grupos'],
  ['call', 'Chamadas'],
  ['history', 'Histórico sincronizado'],
  ['labels', 'Etiquetas'],
  ['chat_labels', 'Etiquetas do chat'],
  ['sender', 'Campanhas'],
  ['newsletter_messages', 'Canais'],
];
const WH_EXCLUDE = [
  ['wasSentByApi', 'Enviadas pela API (evita loop na automação)'],
  ['wasNotSentByApi', 'Não enviadas pela API'],
  ['fromMeYes', 'Enviadas por mim'],
  ['fromMeNo', 'Recebidas de outros'],
  ['isGroupYes', 'De grupos'],
  ['isGroupNo', 'De conversas individuais'],
];

/** Mesma regra do servidor (buildWebhookUrl): eventos/tipo viram SEGMENTOS do caminho. */
function previewWebhookUrl(base, addEv, addType) {
  try {
    const u = new URL(base);
    const segs = [addEv && 'messages', addType && 'text'].filter(Boolean);
    if (segs.length) u.pathname = `${u.pathname.replace(/\/+$/, '')}/${segs.join('/')}`;
    return u.toString();
  } catch {
    return '';
  }
}

/** Rótulo curto de um chat do filtro: número formatado ou "Grupo …". */
const chatLabel = (jid) => (String(jid).endsWith('@g.us') ? `👥 Grupo ${String(jid).split('@')[0].slice(-6)}` : `+${phoneOf(jid)}`);

/** Deixa escolher números/grupos a partir das conversas existentes (sem digitar). */
async function pickChats(current, onPick) {
  const r = await iapi('/chat/find', { method: 'POST', body: { compact: true, limit: 300, sort: '-wa_lastMsgTimestamp' } });
  const chosen = new Set(current);
  const search = el('input', { placeholder: 'Filtrar por nome ou número…' });
  const listBox = el('div', { class: 'pick-list' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = r.chats.filter((c) => !q || `${c.name || ''} ${c.wa_chatid}`.toLowerCase().includes(q));
    listBox.replaceChildren(...(items.length ? items.map((c) => {
      const box = el('input', { type: 'checkbox', checked: chosen.has(c.wa_chatid) });
      box.addEventListener('change', () => (box.checked ? chosen.add(c.wa_chatid) : chosen.delete(c.wa_chatid)));
      return el('label', { class: 'pick-item' }, box, el('span', { class: 'avatar sm' }, c.wa_isGroup ? '👥' : initials(c.name)), el('span', { class: 'pick-meta' }, el('strong', {}, c.name || chatLabel(c.wa_chatid)), el('span', { class: 'small muted' }, c.wa_isGroup ? 'Grupo' : `+${phoneOf(c.wa_chatid)}`)));
    }) : [el('div', { class: 'empty small' }, 'Nenhuma conversa encontrada.')]));
  };
  search.addEventListener('input', draw);
  draw();
  modal('Escolher conversas', el('div', { class: 'stack' }, search, listBox), [
    (close) => el('button', { class: 'btn primary', type: 'button', onclick: () => { onPick([...chosen]); close(); } }, 'Usar selecionados'),
  ]);
}

/**
 * Três níveis de webhook, mesma tela:
 *  - instância: eventos de UM número (o mais comum);
 *  - conta: eventos de TODOS os números do usuário, num endpoint só;
 *  - servidor (Server URL, admin): eventos de todas as instâncias do servidor.
 */
function instanceWebhookCfg() {
  const inst = state.instance || {};
  return {
    kind: 'instance',
    multi: true,
    chatFilter: true,
    pickFromChats: true,
    list: () => iapi('/webhook'),
    errors: () => iapi('/webhook/errors').catch(() => []),
    save: (body) => iapi('/webhook', { method: 'POST', body }),
    banner: () => el('div', { class: 'owner-banner' }, el('span', { class: 'avatar' }, '📱'), el('div', {},
      el('div', { style: 'font-weight:600' }, `Instância: ${inst.name || '—'}`),
      el('div', { class: 'small muted' }, inst.owner ? `Número conectado: +${inst.owner} — só eventos DESTE número chegam aqui.` : 'Número ainda não conectado — só eventos desta instância chegam aqui.'))),
  };
}
function accountWebhookCfg() {
  return {
    kind: 'account',
    multi: true,
    chatFilter: true,
    pickFromChats: false,
    list: () => api('/account/webhook'),
    errors: () => api('/account/webhook/errors').catch(() => []),
    save: (body) => api('/account/webhook', { method: 'POST', body }),
    banner: () => el('div', { class: 'owner-banner' }, el('span', { class: 'avatar' }, '👤'), el('div', {},
      el('div', { style: 'font-weight:600' }, `Conta: ${state.user.email}`),
      el('div', { class: 'small muted' }, 'Recebe eventos de TODOS os seus números. Use os campos instanceId / instanceName / owner do evento para saber de qual número veio.'))),
  };
}
function serverWebhookCfg() {
  const toList = (g) => (g && g.url ? [{ ...g, onlyChats: [] }] : []);
  return {
    kind: 'server',
    multi: false,
    chatFilter: false,
    pickFromChats: false,
    list: async () => toList(await api('/globalwebhook')),
    errors: () => api('/globalwebhook/errors').catch(() => []),
    save: async (body) => {
      if (body.action === 'delete') return toList(await api('/globalwebhook', { method: 'POST', body: { url: body.url, enabled: false, events: ['connection'] } }));
      const { action, id, onlyChats, ...rest } = body;
      void action; void id; void onlyChats;
      if (!rest.events.length) throw new Error('No webhook do servidor, escolha ao menos um evento');
      return toList(await api('/globalwebhook', { method: 'POST', body: rest }));
    },
    banner: () => el('div', { class: 'owner-banner warn-banner' }, el('span', { class: 'avatar' }, '🌐'), el('div', {},
      el('div', { style: 'font-weight:600' }, 'Servidor inteiro (Server URL)'),
      el('div', { class: 'small muted' }, 'Recebe eventos de TODAS as instâncias de TODOS os clientes deste servidor. Use só para sistemas seus (monitoramento, n8n central).'))),
  };
}

function webhookEditor(hook, onSaved, cfg = instanceWebhookCfg()) {
  const isNew = !hook;
  const h = hook || { enabled: true, url: '', events: ['messages', 'connection'], excludeMessages: ['wasSentByApi'], addUrlEvents: false, addUrlTypesMessages: false, onlyChats: [] };
  // Filtro de conversas: "todas" ou "só estas" (números/grupos, um por linha).
  const chatsArea = el('textarea', { name: 'onlyChats', rows: '4', placeholder: '5519999998888\n5519888887777\n120363000000000000@g.us' });
  chatsArea.value = (h.onlyChats || []).map((j) => (j.endsWith('@s.whatsapp.net') ? phoneOf(j) : j)).join('\n');
  const scopeAll = el('input', { type: 'radio', name: 'scope', value: 'all', checked: !(h.onlyChats || []).length });
  const scopeSome = el('input', { type: 'radio', name: 'scope', value: 'some', checked: (h.onlyChats || []).length > 0 });
  const chatsBox = el('div', { class: 'stack' },
    chatsArea,
    el('div', { class: 'row' },
      cfg.pickFromChats && el('button', { class: 'btn sm', type: 'button', onclick: () => pickChats(chatsArea.value.split(/\s+/).filter(Boolean).map((v) => (v.includes('@') ? v : `${v.replace(/\D/g, '')}@s.whatsapp.net`)), (list) => { chatsArea.value = list.map((j) => (j.endsWith('@s.whatsapp.net') ? phoneOf(j) : j)).join('\n'); syncScope(); }).catch((e) => toast(e.message, 'error')) }, '📋 Escolher das conversas'),
      el('span', { class: 'muted small' }, 'Um por linha: número com DDI+DDD ou ID do grupo (@g.us).'),
    ),
  );
  const syncScope = () => {
    chatsBox.style.display = scopeSome.checked ? '' : 'none';
  };
  scopeAll.addEventListener('change', syncScope);
  scopeSome.addEventListener('change', syncScope);
  syncScope();
  const urlInput = el('input', { name: 'url', value: h.url, placeholder: 'https://n8n.exemplo.com.br/webhook/…  ou  http://n8n:5678/webhook/…', required: true });
  const finalUrl = el('div', { class: 'mono small field-box' }, '—');
  const form = el('form', { class: 'stack' },
    // Deixa explícito a quem este webhook pertence (número, conta ou servidor).
    cfg.banner(),
    toggleSwitch('enabled', h.enabled, 'Habilitado'),
    !isNew && el('div', { class: 'muted small mono' }, `id: ${h.id}`),
    el('div', { class: 'row' }, el('span', { class: 'tag method' }, 'POST'), el('span', { class: 'muted small' }, 'Os eventos são enviados como JSON, assinados com HMAC no header X-NexusWA-Signature.')),
    el('label', {}, 'URL', urlInput),
    toggleSwitch('addUrlEvents', h.addUrlEvents, 'addUrlEvents — acrescenta o tipo de evento na URL'),
    toggleSwitch('addUrlTypesMessages', h.addUrlTypesMessages, 'addUrlTypesMessages — acrescenta o tipo da mensagem na URL'),
    el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'URL final (exemplo para uma mensagem de texto)'), finalUrl),
    el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Escutar eventos'), el('div', { class: 'chips' }, WH_EVENTS.map(([v, t]) => el('label', { class: 'chip', title: t }, el('input', { type: 'checkbox', name: `ev_${v}`, checked: h.events.includes(v) }), v))), el('div', { class: 'muted small' }, 'Nenhum marcado = todos os eventos. Para automação de atendimento, "messages" costuma bastar.')),
    cfg.chatFilter && el('div', { class: 'field' },
      el('div', { class: 'field-label' }, 'Quais conversas'),
      el('div', { class: 'seg-radio' },
        el('label', { class: 'chip' }, scopeAll, 'Todas as conversas'),
        el('label', { class: 'chip' }, scopeSome, 'Só estes números e grupos'),
      ),
      chatsBox,
      el('div', { class: 'muted small' }, 'Com a lista preenchida, mensagens, leitura, digitando e chamadas de outras conversas NÃO são enviadas. Avisos de conexão continuam chegando.'),
    ),
    el('div', { class: 'field' }, el('div', { class: 'field-label' }, 'Excluir dos eventos escutados'), el('div', { class: 'chips' }, WH_EXCLUDE.map(([v, t]) => el('label', { class: 'chip', title: t }, el('input', { type: 'checkbox', name: `ex_${v}`, checked: h.excludeMessages.includes(v) }), v))), el('div', { class: 'muted small' }, 'Marque "wasSentByApi" para sua automação não responder às próprias mensagens; "isGroupYes" para ignorar grupos.')),
  );
  const updatePreview = () => {
    const f = formData(form);
    finalUrl.textContent = previewWebhookUrl(f.url, Boolean(f.addUrlEvents), Boolean(f.addUrlTypesMessages)) || '—';
  };
  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  updatePreview();

  const payload = () => {
    const f = formData(form);
    if (!f.url) throw new Error('Informe a URL');
    if (cfg.chatFilter && f.scope === 'some' && !String(f.onlyChats || '').trim()) throw new Error('Informe ao menos um número ou grupo, ou marque "Todas as conversas"');
    return {
      url: f.url,
      enabled: Boolean(f.enabled),
      addUrlEvents: Boolean(f.addUrlEvents),
      addUrlTypesMessages: Boolean(f.addUrlTypesMessages),
      events: WH_EVENTS.map(([v]) => v).filter((v) => f[`ev_${v}`]),
      excludeMessages: WH_EXCLUDE.map(([v]) => v).filter((v) => f[`ex_${v}`]),
      ...(cfg.chatFilter ? { onlyChats: f.scope === 'some' ? String(f.onlyChats || '').split(/[\s,;]+/).map((v) => v.trim()).filter(Boolean) : [] } : {}),
    };
  };
  const showSecret = (hooks) => {
    const created = hooks.find((x) => x.secret);
    if (!created) return;
    modal('Segredo de assinatura do webhook', el('div', { class: 'stack' },
      el('div', { class: 'alert warn' }, 'Aparece só agora. Use-o no receptor (n8n) para validar o header X-NexusWA-Signature e ter certeza de que o evento veio do seu servidor.'),
      copyField('Secret', created.secret),
    ));
  };

  const actions = [];
  if (!isNew) {
    actions.push((close) => actionBtn(cfg.multi ? '🗑 Excluir' : 'Desativar', async () => {
      await cfg.save({ action: 'delete', id: h.id, url: h.url });
      close();
      toast(cfg.multi ? 'Webhook excluído' : 'Webhook desativado');
      onSaved();
    }, 'btn danger'));
  }
  if (isNew || cfg.multi) {
    actions.push((close) => actionBtn(isNew ? 'Salvar' : 'Salvar como um novo', async () => {
      const hooks = await cfg.save({ action: 'add', ...payload() });
      close();
      toast('Webhook criado');
      showSecret(hooks);
      onSaved();
    }, isNew ? 'btn primary' : 'btn'));
  }
  if (!isNew) {
    actions.push((close) => actionBtn('Salvar', async () => {
      await cfg.save({ action: 'update', id: h.id, ...payload() });
      close();
      toast('Webhook atualizado');
      onSaved();
    }, 'btn primary'));
  }
  modal(isNew ? 'Novo webhook' : 'Webhook', form, actions);
}

/** Lista + erros de entrega de um nível de webhook (instância, conta ou servidor). */
function webhookSection(cfg) {
  const box = el('div', { class: 'stack' });
  const load = async () => {
    const [hooks, errors] = await Promise.all([cfg.list(), cfg.errors()]);
    box.replaceChildren(
      el('div', { class: 'card' }, hooks.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['', 'URL', 'Eventos', cfg.chatFilter ? 'Conversas' : null, 'Excluir', ''].filter((h) => h !== null).map((h) => el('th', {}, h)))),
        el('tbody', {}, hooks.map((h) => el('tr', {},
          el('td', {}, el('span', { class: `dot ${h.enabled ? 'on' : 'off'}`, title: h.enabled ? 'Habilitado' : 'Desabilitado' })),
          el('td', { class: 'mono small' }, h.url),
          el('td', { class: 'small' }, h.events.length ? h.events.join(', ') : 'todos'),
          cfg.chatFilter && el('td', { class: 'small', title: (h.onlyChats || []).map(chatLabel).join('\n') }, (h.onlyChats || []).length ? `só ${h.onlyChats.length}: ${h.onlyChats.slice(0, 2).map(chatLabel).join(', ')}${h.onlyChats.length > 2 ? '…' : ''}` : 'todas'),
          el('td', { class: 'small' }, h.excludeMessages.join(', ') || '—'),
          el('td', {}, el('button', { class: 'btn sm', type: 'button', onclick: () => webhookEditor(h, load, cfg) }, 'Editar')),
        ))),
      )) : el('div', { class: 'empty' }, el('p', {}, 'Nenhum webhook configurado.'), el('button', { class: 'btn primary', type: 'button', onclick: () => webhookEditor(null, load, cfg) }, '+ Configurar webhook'))),
      el('div', { class: 'card' }, el('h2', {}, 'Últimos erros de entrega'), errors.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Quando', 'Evento', 'HTTP', 'Tentativas', 'Erro'].map((h) => el('th', {}, h)))),
        el('tbody', {}, errors.slice(0, 20).map((e) => el('tr', {}, el('td', { class: 'small' }, new Date(e.created).toLocaleString('pt-BR')), el('td', {}, e.event), el('td', {}, e.status_code || '—'), el('td', {}, e.attempts), el('td', { class: 'small' }, e.error)))),
      )) : el('p', { class: 'muted' }, 'Nenhum erro recente. 👍')),
    );
  };
  const addBtn = el('button', { class: 'btn primary', type: 'button', onclick: () => webhookEditor(null, load, cfg) }, '+ Novo webhook');
  return { box, load, actions: [cfg.multi && addBtn, actionBtn('Atualizar', load)].filter(Boolean) };
}

async function pageWebhooks() {
  const sec = webhookSection(instanceWebhookCfg());
  layout('Webhooks', el('div', { class: 'stack' }, webhookLevels('instance'), sec.box), {
    subtitle: `Eventos da instância ${state.instance?.name || ''}${state.instance?.owner ? ` (+${state.instance.owner})` : ''} — cada número tem os próprios webhooks`,
    actions: sec.actions,
  });
  await sec.load();
}

async function pageServerWebhook() {
  const sec = webhookSection(serverWebhookCfg());
  layout('Webhook do servidor', el('div', { class: 'stack' }, webhookLevels('server'), sec.box), { subtitle: 'Server URL: um endpoint que recebe eventos de todas as instâncias', actions: sec.actions });
  await sec.load();
}

/** Explica os 3 níveis e onde configurar cada um. */
function webhookLevels(active) {
  const item = (k, icon, title, text, href) => el(href && active !== k ? 'a' : 'div', { class: `level ${active === k ? 'active' : ''}`, ...(href && active !== k ? { href } : {}) }, el('div', { class: 'level-title' }, `${icon} ${title}`), el('div', { class: 'small muted' }, text));
  return el('div', { class: 'levels' },
    item('instance', '📱', 'Por instância', 'Só os eventos de um número.', state.instanceId ? `#/i/${state.instanceId}/webhooks` : null),
    item('account', '👤', 'Por usuário (conta)', 'Todos os seus números num endpoint só.', '#/conta'),
    state.user.role === 'admin' && item('server', '🌐', 'Por servidor (Server URL)', 'Todas as instâncias do servidor. Só admin.', '#/servidor'),
  );
}

// ======================================================================= usuários (admin)
async function pageUsers() {
  const users = await api('/users');
  const form = el('form', { class: 'card stack' },
    el('h2', {}, 'Novo usuário'),
    el('div', { class: 'grid cols-2' },
      el('label', {}, 'E-mail', el('input', { name: 'email', type: 'email', required: true, autocomplete: 'off' })),
      el('label', {}, 'Nome', el('input', { name: 'name' })),
      el('label', {}, 'Senha inicial (12+ caracteres)', el('input', { name: 'password', type: 'password', required: true, minlength: '12', autocomplete: 'new-password' })),
      el('label', {}, 'Papel', el('select', { name: 'role' }, el('option', { value: 'client' }, 'Cliente — usa só os números (instâncias) dele'), el('option', { value: 'admin' }, 'Administrador — vê e gerencia tudo do servidor'))),
      el('div', { class: 'alert small' }, el('strong', {}, 'Cliente: '), 'quem usa o sistema (compra números/atendentes). Vê só as instâncias, conversas, campanhas e atendentes DELE — nunca os outros clientes. ', el('br'), el('strong', {}, 'Administrador: '), 'você (dono do servidor). Vê todos os clientes, cria usuários, recebe os relatos de problema e vê o Admin Token. ', el('br'), el('strong', {}, 'Atendente: '), 'não é criado aqui — o cliente cadastra na tela "Atendentes" do número dele.'),
      el('label', {}, 'Máximo de instâncias', el('input', { name: 'maxInstances', type: 'number', min: '0', value: '1' })),
    ),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit' }, 'Criar usuário')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const f = formData(form);
      await api('/users', { method: 'POST', body: { ...f, maxInstances: Number(f.maxInstances) } });
      toast('Usuário criado');
      pageUsers();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
  layout('Usuários', el('div', { class: 'stack' },
    el('div', { class: 'card' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['E-mail', 'Papel', 'Instâncias', 'Último acesso', 'Status', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, users.map((u) => el('tr', {},
        el('td', {}, el('div', { style: 'font-weight:600' }, u.email), el('div', { class: 'muted small' }, u.name)),
        el('td', {}, u.role === 'admin' ? 'Admin' : 'Cliente'),
        el('td', {}, `${u.instances} / ${u.maxInstances}`),
        el('td', { class: 'small' }, u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('pt-BR') : '—'),
        el('td', {}, u.isActive ? (u.lockedUntil && new Date(u.lockedUntil) > new Date() ? '🔒 Bloqueado' : 'Ativo') : 'Desativado'),
        el('td', {}, u.id !== state.user.id && el('div', { class: 'row' },
          u.lockedUntil && actionBtn('Desbloquear', async () => {
            await api(`/users/${u.id}`, { method: 'PATCH', body: { unlock: true } });
            pageUsers();
          }, 'btn sm'),
          actionBtn(u.isActive ? 'Desativar' : 'Ativar', async () => {
            await api(`/users/${u.id}`, { method: 'PATCH', body: { isActive: !u.isActive } });
            pageUsers();
          }, 'btn sm'),
        )),
      ))),
    )),
    form,
  ));
}

// ======================================================================= conta
async function pageAccount() {
  const pw = el('form', { class: 'card stack' },
    el('h2', {}, 'Trocar senha'),
    el('label', {}, 'Senha atual', el('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
    el('label', {}, 'Nova senha (12+ caracteres, misture letras, números e símbolos)', el('input', { name: 'newPassword', type: 'password', required: true, minlength: '12', autocomplete: 'new-password' })),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit' }, 'Trocar senha')),
  );
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: formData(pw) });
      state.user = null;
      renderLogin('Senha alterada. Entre com a nova senha.');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });

  const tfa = el('div', { class: 'card stack' }, el('h2', {}, 'Verificação em duas etapas (2FA)'));
  const render2fa = () => {
    tfa.replaceChildren(el('h2', {}, 'Verificação em duas etapas (2FA)'));
    if (state.user.totpEnabled) {
      const otp = el('input', { placeholder: 'Código de 6 dígitos', inputmode: 'numeric', maxlength: '6' });
      const pass = el('input', { type: 'password', placeholder: 'Sua senha', autocomplete: 'current-password' });
      tfa.append(el('div', { class: 'alert' }, '✅ 2FA ativo na sua conta.'), pass, otp, actionBtn('Desativar 2FA', async () => {
        await api('/auth/2fa/disable', { method: 'POST', body: { password: pass.value, otp: otp.value.trim() } });
        state.user.totpEnabled = false;
        toast('2FA desativado');
        render2fa();
      }, 'btn danger'));
    } else {
      tfa.append(el('p', { class: 'muted' }, 'Protege sua conta mesmo se a senha vazar. Use Google Authenticator, Authy ou 1Password.'), actionBtn('Ativar 2FA', async () => {
        const r = await api('/auth/2fa/setup', { method: 'POST', body: {} });
        const otp = el('input', { placeholder: 'Código de 6 dígitos', inputmode: 'numeric', maxlength: '6' });
        tfa.replaceChildren(
          el('h2', {}, 'Ativar 2FA'),
          el('p', {}, 'No app autenticador, adicione uma conta com a chave abaixo (opção "inserir chave manualmente"):'),
          el('div', { class: 'mono card' }, r.secret.replace(/(.{4})/g, '$1 ').trim()),
          el('p', { class: 'muted small' }, 'Depois digite o código que o app mostrar:'),
          otp,
          actionBtn('Confirmar e ativar', async () => {
            await api('/auth/2fa/enable', { method: 'POST', body: { otp: otp.value.trim() } });
            state.user.totpEnabled = true;
            toast('2FA ativado!');
            render2fa();
          }, 'btn primary'),
        );
      }, 'btn primary'));
    }
  };
  render2fa();
  // Webhook da conta (não existe para atendentes).
  const sec = state.user.role !== 'agent' ? webhookSection(accountWebhookCfg()) : null;
  layout('Minha conta', el('div', { class: 'stack' },
    el('div', { class: 'grid cols-2' }, pw, tfa),
    sec && el('div', { class: 'stack' }, el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Webhook da conta'), el('span', { class: 'spacer' }), ...sec.actions), webhookLevels('account'), sec.box),
  ), { subtitle: state.user.email });
  if (sec) await sec.load();
}

// ======================================================================= suporte
async function pageSupport() {
  const form = el('form', { class: 'card stack', style: 'max-width:640px' },
    el('label', {}, 'Título', el('input', { name: 'title', required: true, minlength: '3', maxlength: '200' })),
    el('label', {}, 'O que aconteceu? (passos, o que esperava, o que viu)', el('textarea', { name: 'description', required: true, minlength: '10' })),
    el('label', {}, 'Gravidade', el('select', { name: 'severity' }, [['low', 'Baixa'], ['medium', 'Média'], ['high', 'Alta'], ['critical', 'Crítica']].map(([v, t]) => el('option', { value: v, selected: v === 'medium' }, t)))),
    el('label', {}, 'ID do erro (se apareceu algum "requestId")', el('input', { name: 'requestId', maxlength: '64' })),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'submit' }, 'Enviar relato')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const f = formData(form);
      await api('/support/bug-report', { method: 'POST', body: { ...f, ...(f.requestId ? {} : { requestId: undefined }), context: { page: location.hash, ua: navigator.userAgent.slice(0, 300) } } });
      toast('Obrigado! Relato registrado — o administrador já recebe em "Relatos recebidos".');
      form.reset();
      await loadMine();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
  const mine = el('div', { class: 'card', style: 'max-width:640px' });
  const STATUS = { open: '🟡 Recebido', triaged: '🔵 Em análise', fixed: '🟢 Resolvido', wontfix: '⚪ Encerrado' };
  async function loadMine() {
    const rows = await api('/support/my-reports').catch(() => []);
    mine.replaceChildren(el('h2', {}, 'Meus relatos'), rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'table' }, el('tbody', {}, rows.map((r) => el('tr', {}, el('td', {}, r.title), el('td', {}, STATUS[r.status] || r.status), el('td', { class: 'small muted' }, new Date(r.createdAt).toLocaleString('pt-BR'))))))) : el('p', { class: 'muted' }, 'Nenhum relato enviado.'));
  }
  layout('Relatar problema', el('div', { class: 'stack' }, form, mine));
  await loadMine();
}

async function pageBugReports() {
  const box = el('div', { class: 'card' });
  const SEV = { low: 'Baixa', medium: 'Média', high: 'Alta', critical: '🔴 Crítica' };
  const load = async () => {
    const rows = await api('/admin/bug-reports');
    if (!rows.length) return box.replaceChildren(el('div', { class: 'empty' }, 'Nenhum relato recebido. 👍'));
    box.replaceChildren(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Quando', 'Quem', 'Problema', 'Gravidade', 'Status'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => {
        const sel = el('select', { class: 'sm' }, [['open', 'Recebido'], ['triaged', 'Em análise'], ['fixed', 'Resolvido'], ['wontfix', 'Encerrado']].map(([v, t]) => el('option', { value: v, selected: r.status === v }, t)));
        sel.addEventListener('change', async () => {
          await api(`/admin/bug-reports/${r.id}`, { method: 'PATCH', body: { status: sel.value } });
          toast('Status atualizado');
        });
        return el('tr', {},
          el('td', { class: 'small' }, new Date(r.createdAt).toLocaleString('pt-BR')),
          el('td', { class: 'small' }, r.user_name || r.user_email || '—', el('div', { class: 'muted' }, r.user_email)),
          el('td', {}, el('strong', {}, r.title), el('div', { class: 'small muted pre-wrap' }, r.description), r.context?.page && el('div', { class: 'small muted' }, `Tela: ${r.context.page}`), r.requestId && el('div', { class: 'small mono' }, `requestId: ${r.requestId}`)),
          el('td', {}, SEV[r.severity] || r.severity),
          el('td', {}, sel),
        );
      })),
    )));
  };
  layout('Relatos recebidos', box, { subtitle: 'Problemas enviados pelos clientes e atendentes em "Relatar problema"', actions: [actionBtn('Atualizar', load)] });
  await load();
}

// ======================================================================= inicialização
// Os cookies de sessão são "Secure": em http:// o navegador os descarta e o login "some".
// Fora do localhost, força https (defesa extra caso o Force SSL do proxy esteja desligado).
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (location.protocol === 'http:' && !LOCAL) location.replace(`https://${location.host}${location.pathname}${location.hash}`);

(async function boot() {
  try {
    const r = await api('/auth/me', { retry: true });
    state.user = r.user;
    route();
  } catch {
    if (!state.user) renderLogin();
  }
})();
