#!/usr/bin/env node
/**
 * Configuração do NexusWA para rodar DIRETO no PC (sem Docker).
 *
 *   npm install
 *   npm run setup:local
 *
 * O que faz (pode rodar quantas vezes quiser — é idempotente):
 *  1. Confere Node >= 22.12 e ffmpeg (necessário para áudio PTT)
 *  2. Cria o .env com segredos fortes (se ainda não existir)
 *  3. Cria o usuário e o banco "nexuswa" no PostgreSQL local
 *     (pede a senha do superusuário "postgres" sem mostrá-la na tela)
 *  4. Testa a conexão com o Redis usando a senha do .env
 *  5. Aplica as migrações do banco
 *
 * CREATEDB: o "prisma migrate dev" precisa criar um banco-sombra temporário quando você
 * alterar o schema. (Só no PC; na VPS o usuário não recebe esse privilégio.)
 *
 * Segurança: a senha do Postgres vai por variável de ambiente (PGPASSWORD) para o
 * processo filho e o SQL vai por stdin — nada aparece na linha de comando nem em arquivo.
 * As senhas geradas são hex, então não há como injetar SQL por elas.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath trata "C:\\Users\\Carlos Henrique" (letra de unidade e espaços) corretamente.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = path.join(ROOT, '.env');
const IS_WIN = process.platform === 'win32';

const ok = (m) => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const fail = (m) => console.log(`  \x1b[31m✖\x1b[0m ${m}`);
const step = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

// ---------------------------------------------------------------- utilitários
export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function buildLocalEnv({ pgPort = 5432, redisPort = 6379 } = {}) {
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const b64url = (n) => crypto.randomBytes(n).toString('base64url');
  const pg = hex(24);
  const redis = hex(24);
  return `# =====================================================================
# NexusWA — .env LOCAL (PC sem Docker) — gerado em ${new Date().toISOString()}
# NÃO versione este arquivo. Guarde ENCRYPTION_KEY e ADMIN_TOKEN no cofre de senhas.
# =====================================================================
NODE_ENV=development
PORT=3000
HOST=127.0.0.1
PUBLIC_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3001
TRUST_PROXY=0
COOKIE_SECURE=false

# PostgreSQL instalado no Windows (serviço local)
POSTGRES_DB=nexuswa
POSTGRES_USER=nexuswa
POSTGRES_PASSWORD=${pg}
DATABASE_URL=postgresql://nexuswa:${pg}@localhost:${pgPort}/nexuswa?schema=public

# Redis (WSL/Ubuntu ou Memurai). Configure "requirepass" com o valor abaixo.
REDIS_PASSWORD=${redis}
REDIS_URL=redis://:${redis}@localhost:${redisPort}

ADMIN_TOKEN=${b64url(36)}
JWT_SECRET=${b64url(48)}
ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}
METRICS_TOKEN=${b64url(24)}

MEDIA_DIR=./storage/media
MEDIA_MAX_MB=64
FILE_URL_TTL_HOURS=48
MESSAGE_RETENTION_DAYS=7
UNPAIRED_INSTANCE_TTL_MIN=60
WEBHOOK_INTERNAL_HOSTS=
SSRF_ALLOW_PRIVATE=false
# Se o ffmpeg não estiver no PATH, informe o caminho completo, ex.: C:\\ffmpeg\\bin\\ffmpeg.exe
FFMPEG_PATH=ffmpeg
OPENAI_API_KEY=
LOG_LEVEL=info
BAILEYS_LOG_LEVEL=warn
`;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/** Procura o psql no PATH e nas pastas padrão do instalador oficial do Windows. */
export function findPsql() {
  const probe = spawnSync(IS_WIN ? 'where' : 'which', ['psql'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  if (IS_WIN) {
    const base = 'C:\\Program Files\\PostgreSQL';
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base).filter((v) => /^\d+/.test(v)).sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const p = path.join(base, v, 'bin', 'psql.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return null;
}

/** PING no Redis falando o protocolo RESP direto (não depende do redis-cli no Windows). */
export function redisPing(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, error: 'REDIS_URL inválida' });
      return;
    }
    const sock = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) });
    const pass = decodeURIComponent(u.password || '');
    let buf = '';
    const done = (r) => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => done({ ok: false, error: 'tempo esgotado' }));
    sock.on('error', (e) => done({ ok: false, error: e.code === 'ECONNREFUSED' ? 'conexão recusada (Redis não está rodando?)' : e.message }));
    sock.on('connect', () => {
      const cmd = (...a) => `*${a.length}\r\n${a.map((x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`).join('')}`;
      sock.write((pass ? cmd('AUTH', pass) : '') + cmd('PING'));
    });
    sock.on('data', (d) => {
      buf += d.toString();
      if (/-ERR[^\r]*without any password configured/i.test(buf)) return done({ ok: false, error: 'no_password_configured' });
      if (/-(WRONGPASS|ERR)[^\r]*/.test(buf)) return done({ ok: false, error: buf.match(/-[^\r]+/)[0] });
      if (/-NOAUTH/.test(buf)) return done({ ok: false, error: 'Redis exige senha e REDIS_URL não tem' });
      if (buf.includes('+PONG')) done({ ok: true });
    });
  });
}

function run(cmd, args, opts = {}) {
  // No Windows, npx é um .cmd e precisa de shell; os argumentos aqui são constantes.
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN && cmd === 'npx', ...opts });
}

// ---------------------------------------------------------------- etapas
async function main() {
  console.log('\n\x1b[1mNexusWA — configuração local (sem Docker)\x1b[0m');
  let problems = 0;

  step('1/5 Ferramentas');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj > 22 || (maj === 22 && min >= 12)) ok(`Node ${process.versions.node}`);
  else {
    fail(`Node ${process.versions.node} — precisa 22.12+ (https://nodejs.org)`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(ROOT, 'node_modules', '.prisma'))) {
    fail('Dependências não instaladas. Rode antes:  npm install');
    process.exit(1);
  }
  ok('node_modules presente');

  step('2/5 Arquivo .env');
  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, buildLocalEnv(), { mode: 0o600 });
    ok('.env criado com segredos novos');
    warn('Faça backup de ENCRYPTION_KEY e ADMIN_TOKEN (sem a chave, sessões salvas não são recuperáveis)');
  } else ok('.env já existe (mantido)');
  const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));

  const ffmpegCmd = env.FFMPEG_PATH || 'ffmpeg';
  const ff = spawnSync(ffmpegCmd, ['-version'], { encoding: 'utf8' });
  if (ff.status === 0) ok('ffmpeg encontrado');
  else warn('ffmpeg não encontrado — áudio de voz (ptt) e conversões não vão funcionar. Instale: winget install Gyan.FFmpeg (e reabra o terminal)');

  step('3/5 PostgreSQL');
  const dbUrl = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  const psql = findPsql();
  if (!dbUrl) {
    fail('DATABASE_URL ausente no .env');
    problems++;
  } else if (!psql) {
    fail('psql não encontrado. Instale o PostgreSQL 17 para Windows (winget install PostgreSQL.PostgreSQL.17) e rode de novo.');
    problems++;
  } else {
    ok(`psql: ${psql}`);
    const appUser = decodeURIComponent(dbUrl.username);
    const appPass = decodeURIComponent(dbUrl.password);
    const dbName = dbUrl.pathname.replace(/^\//, '');
    const host = dbUrl.hostname;
    const port = dbUrl.port || '5432';
    if (![appUser, dbName].every((v) => /^[a-z_][a-z0-9_]{0,62}$/.test(v)) || !/^[A-Za-z0-9]+$/.test(appPass)) {
      fail('Usuário/banco/senha do DATABASE_URL precisam ser alfanuméricos (gere de novo o .env)');
      process.exit(1);
    }
    // Já conecta com o usuário da aplicação? Então nada a criar.
    const probe = spawnSync(psql, ['-h', host, '-p', port, '-U', appUser, '-d', dbName, '-tAc', 'SELECT 1'], {
      env: { ...process.env, PGPASSWORD: appPass, PGCONNECT_TIMEOUT: '5' },
      encoding: 'utf8',
    });
    if (probe.status === 0) ok(`banco "${dbName}" acessível com o usuário "${appUser}"`);
    else {
      console.log(`  Vou criar o usuário "${appUser}" e o banco "${dbName}".`);
      const superPass = await askHidden('  Senha do superusuário "postgres" (definida na instalação): ');
      const sql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${appUser}') THEN
    CREATE ROLE ${appUser} LOGIN CREATEDB PASSWORD '${appPass}';
  ELSE
    ALTER ROLE ${appUser} WITH LOGIN CREATEDB PASSWORD '${appPass}';
  END IF;
END $$;
SELECT 'CREATE DATABASE ${dbName} OWNER ${appUser}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${dbName}')\\gexec
GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${appUser};
`;
      const r = spawnSync(psql, ['-h', host, '-p', port, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], {
        input: sql,
        env: { ...process.env, PGPASSWORD: superPass, PGCONNECT_TIMEOUT: '5' },
        encoding: 'utf8',
      });
      if (r.status === 0) ok(`usuário "${appUser}" e banco "${dbName}" prontos`);
      else {
        fail(`não foi possível criar: ${(r.stderr || '').trim().split('\n')[0]}`);
        problems++;
      }
    }
  }

  step('4/5 Redis');
  const redis = await redisPing(env.REDIS_URL || '');
  if (redis.ok) ok('Redis respondeu PONG com a senha do .env');
  else {
    problems++;
    if (redis.error === 'no_password_configured') {
      fail('O Redis está rodando SEM senha. Defina a senha do .env nele:');
      console.log(`\n    No Ubuntu (WSL):\n      sudo sed -i 's/^#\\? *requirepass .*/requirepass ${env.REDIS_PASSWORD}/' /etc/redis/redis.conf\n      sudo service redis-server restart\n`);
    } else {
      fail(`Redis: ${redis.error}`);
      console.log('    Veja docs/RODAR-SEM-DOCKER.md (seção Redis) e rode este script de novo.');
    }
  }

  step('5/5 Migrações do banco');
  if (problems) {
    warn('Pulado: corrija os itens acima e rode "npm run setup:local" de novo.');
    process.exit(1);
  }
  const mig = run('npx', ['prisma', 'migrate', 'deploy']);
  if (mig.status !== 0) {
    fail('Falha ao aplicar migrações');
    process.exit(1);
  }
  ok('Banco atualizado');

  console.log(`
\x1b[32m\x1b[1mTudo pronto!\x1b[0m Próximos passos:

  1) Criar seu usuário admin:
       npm run user:create -- --email voce@exemplo.com --role admin --name "Carlos" --max 50
  2) Subir a API (recarrega sozinha ao salvar arquivos):
       npm run dev
  3) Testar:  http://localhost:3000/ready

  ADMIN_TOKEN para os testes está no seu .env.
`);
}

// Executa apenas quando chamado diretamente (permite importar as funções em testes).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'setup-local.mjs');
if (invokedDirectly) {
  main().catch((err) => {
    fail(err.message);
    process.exit(1);
  });
}
