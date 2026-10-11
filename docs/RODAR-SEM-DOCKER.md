# Rodar no PC sem Docker (Windows)

A API roda direto com o Node. Postgres e Redis ficam instalados na sua máquina como serviços.

```
PowerShell ──> npm run dev (Node, porta 3000, só em 127.0.0.1)
                 ├── PostgreSQL 17 (serviço do Windows, porta 5432)
                 └── Redis (Ubuntu no WSL, porta 6379)
```

## 1. Instalar o que falta (uma vez só)

Abra o **PowerShell como administrador**:

```powershell
winget install OpenJS.NodeJS.LTS          # se "node -v" for menor que 22.12
winget install PostgreSQL.PostgreSQL.17   # anote a senha do usuário "postgres" definida na instalação
winget install Gyan.FFmpeg                # necessário para áudio de voz (ptt) e figurinhas
```
Feche e abra o terminal depois de instalar, para o PATH atualizar.

> Se você já tem outro Postgres ocupando a porta 5432 (por exemplo o container `postgres_dev` do Docker Desktop), pare esse container ou instale o novo em outra porta e ajuste o `DATABASE_URL` no `.env`.

### Redis: opção A — Ubuntu no WSL (recomendado, você já tem o Ubuntu-24.04)

O Redis não tem versão oficial para Windows. No WSL ele é o Redis real, e o Windows o acessa em `localhost:6379`.

```powershell
wsl -d Ubuntu-24.04
```
Dentro do Ubuntu:
```bash
sudo apt update && sudo apt install -y redis-server
sudo sed -i 's/^bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf   # só acesso local
sudo service redis-server start
```
A senha do Redis é configurada no passo 3: o script mostra o comando exato, com a senha gerada.

O WSL não inicia serviços sozinho. Sempre que ligar o PC, rode no PowerShell:
```powershell
wsl -d Ubuntu-24.04 -u root service redis-server start
```

### Redis: opção B — Memurai (nativo no Windows)

Instale o **Memurai Developer** (compatível com Redis e roda como serviço do Windows). A versão gratuita tem limitações de uso; confira no site. A senha vai no arquivo `memurai.conf`, linha `requirepass`.

## 2. Instalar as dependências do projeto

Na pasta do projeto (`nexuswa-api`):
```powershell
npm install
```

## 3. Configurar tudo com um comando

```powershell
npm run setup:local
```

| Etapa | O que o script faz |
|---|---|
| 1 | Confere o Node e o ffmpeg |
| 2 | Cria o `.env` com segredos fortes (se ainda não existir) |
| 3 | Cria o usuário e o banco `nexuswa` no Postgres (pede a senha do `postgres`, sem mostrar na tela) |
| 4 | Testa o Redis. Se estiver sem senha, mostra o comando `sed` para rodar no Ubuntu |
| 5 | Cria as tabelas (migrações) |

Se algo falhar, corrija o que ele indicou e **rode de novo**: ele pula o que já está pronto.

## 4. Criar seu usuário e subir a API

```powershell
npm run user:create -- --email voce@exemplo.com --role admin --name "Carlos" --max 50
npm run dev
```
Pronto quando aparecer `NexusWA API no ar`. Teste em `http://localhost:3000/ready`.

Depois siga o **roteiro de testes do README (seção 2.5)**. O `ADMIN_TOKEN` está no seu `.env`.

## Dia a dia

| Quero... | Comando |
|---|---|
| Ligar tudo depois de reiniciar o PC | `wsl -d Ubuntu-24.04 -u root service redis-server start` e depois `npm run dev` |
| Parar a API | `Ctrl + C` (as sessões do WhatsApp continuam salvas) |
| Ver/editar o banco | pgAdmin (vem com o Postgres), banco `nexuswa` |
| Mudei o `schema.prisma` | `npx prisma migrate dev --name descricao` |
| Rodar os testes | `npm test` |
| Gerar build de produção | `npm run build` e depois `npm start` |

## Problemas comuns

| Mensagem | Solução |
|---|---|
| `[config] Variáveis de ambiente inválidas` | O erro lista a variável. Confira o `.env` (não precisa colocar aspas nos valores) |
| `connect ECONNREFUSED 127.0.0.1:6379` | O Redis não está rodando: `wsl -d Ubuntu-24.04 -u root service redis-server start` |
| `WRONGPASS` / `NOAUTH` | A senha do Redis está diferente do `REDIS_PASSWORD` do `.env`. Rode `npm run setup:local`, que mostra o comando certo |
| `P1001: Can't reach database server` | Serviço do Postgres parado: `services.msc` → postgresql-x64-17 → Iniciar |
| `password authentication failed for user "nexuswa"` | Rode `npm run setup:local` de novo (ele reajusta a senha) |
| `ffmpeg falhou` ou `spawn ffmpeg ENOENT` ao enviar ptt | Instale o ffmpeg ou informe o caminho completo em `FFMPEG_PATH` no `.env` |
| `EADDRINUSE :3000` | Outra aplicação usa a porta 3000: mude `PORT` e `PUBLIC_URL` no `.env` |

## Segurança no modo local

- A API escuta só em `127.0.0.1` (`HOST` no `.env`), então outros aparelhos da rede não a acessam.
- O Redis fica com `bind 127.0.0.1` e senha; o Postgres usa usuário próprio com senha forte (não o `postgres`).
- **Use segredos diferentes na VPS.** O `.env` do PC é só para teste.
