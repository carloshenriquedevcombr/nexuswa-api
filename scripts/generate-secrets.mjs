#!/usr/bin/env node
/**
 * Gera segredos criptograficamente fortes para o .env.
 * Senhas de Postgres/Redis em hex: seguras e sem caracteres que quebrem URLs de conexão.
 */
import crypto from 'node:crypto';

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64url = (n) => crypto.randomBytes(n).toString('base64url');

const pg = hex(24);
const redis = hex(24);
console.log(`# Cole no seu .env (gerado em ${new Date().toISOString()})
POSTGRES_PASSWORD=${pg}
REDIS_PASSWORD=${redis}
DATABASE_URL=postgresql://nexuswa:${pg}@localhost:5433/nexuswa?schema=public
REDIS_URL=redis://:${redis}@localhost:6380
ADMIN_TOKEN=${b64url(36)}
JWT_SECRET=${b64url(48)}
ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}
METRICS_TOKEN=${b64url(24)}
# IMPORTANTE: faça backup da ENCRYPTION_KEY em local seguro (cofre de senhas).
# Sem ela, as sessões WhatsApp e segredos cifrados no banco ficam irrecuperáveis.`);
