/**
 * CLI para criar usuários (inclusive o primeiro admin) sem expor rota pública de cadastro.
 * A senha é lida do terminal sem eco — nunca por argumento (ficaria no histórico do shell
 * e visível em `ps`).
 *
 *   npm run user:create -- --email voce@exemplo.com --role admin --name "Carlos" --max 10
 *   docker compose exec api node dist/cli/createUser.js --email ... --role admin
 */
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { hashPassword, validatePasswordPolicy } from '../auth/password.js';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(question)) out.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string', default: '' },
      role: { type: 'string', default: 'client' },
      max: { type: 'string', default: '1' },
    },
  });
  const email = values.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Informe --email válido');
  if (values.role !== 'admin' && values.role !== 'client') throw new Error('--role deve ser admin ou client');

  const password = await askHidden('Senha: ');
  const confirm = await askHidden('Confirme a senha: ');
  if (password !== confirm) throw new Error('As senhas não conferem');
  const policy = validatePasswordPolicy(password, email);
  if (policy) throw new Error(policy);

  const { prisma } = await import('../lib/prisma.js');
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) throw new Error('Já existe usuário com este e-mail');
  const user = await prisma.user.create({
    data: { email, name: values.name ?? '', role: values.role, maxInstances: Number(values.max) || 1, passwordHash: await hashPassword(password) },
  });
  await prisma.auditLog.create({ data: { actorType: 'system', actorId: 'cli', action: 'user.create', targetType: 'user', targetId: user.id, metadata: { role: user.role } } });
  console.log(`Usuário criado: ${user.email} (${user.role})`);
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`Erro: ${err.message}`);
  process.exit(1);
});
