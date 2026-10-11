#!/bin/sh
# Aplica migrações pendentes antes de subir a API.
# `migrate deploy` só aplica migrações versionadas — nunca reseta nem altera dados fora delas.
set -e
node node_modules/prisma/build/index.js migrate deploy
exec node dist/server.js
