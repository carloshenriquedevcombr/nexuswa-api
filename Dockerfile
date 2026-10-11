# syntax=docker/dockerfile:1.7
# ---------- deps: instala dependências (inclui dev para compilar) ----------
FROM node:25-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# npm ci exige package-lock.json (gerado no PC com "npm install" e versionado).
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------- build: compila TypeScript e remove devDependencies ----------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
# Depois do prune: lockfile gerado no Windows pode omitir o binário Linux do sharp — garante o correto.
RUN npm run build && npm prune --omit=dev \
 && (node -e "require('sharp')" 2>/dev/null || npm install --no-save --omit=dev --os=linux --libc=glibc --cpu="$(node -p process.arch)" sharp)

# ---------- runtime: imagem mínima, usuário sem privilégios ----------
FROM node:25-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    MEDIA_DIR=/app/storage/media \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CHECKPOINT_DISABLE=1
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node public ./public
COPY --chown=node:node package.json docker-entrypoint.sh ./
RUN mkdir -p /app/storage/media && chown -R node:node /app/storage && chmod 0755 docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini = PID 1 correto: repassa SIGTERM (shutdown gracioso preserva as sessões WhatsApp)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./docker-entrypoint.sh"]
