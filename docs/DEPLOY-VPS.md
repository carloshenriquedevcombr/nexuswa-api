# Deploy na VPS (Docker + Nginx Proxy Manager)

> **Atalho:** `bash deploy/vps-install.sh` automatiza os passos 1, 3, 4 e a parte do `http_top.conf` do passo 5. Pelo celular, veja [`DEPLOY-TERMUX.md`](DEPLOY-TERMUX.md).

Baseado no que já roda na sua VPS: Portainer, NPM (`docker-base-nginx-1`), n8n, telegram_api e Absenteismo, na rede `172.21.0.0/16`.

## 1. Descobrir a rede do NPM

```bash
docker network ls
docker inspect docker-base-nginx-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```
O nome que aparecer (provavelmente `docker-base_default`) vai no `.env` como `PROXY_NETWORK=`.

## 2. Enviar o projeto

Recomendado: via GitHub (repositório **privado**).
```bash
sudo mkdir -p /opt/nexuswa && sudo chown $USER /opt/nexuswa && cd /opt/nexuswa
git clone git@github.com:SEU_USUARIO/nexuswa-api.git .
```
Alternativa: WinSCP/SFTP da pasta **sem** `node_modules`, `dist`, `.env` e `storage`.

## 3. Configurar o `.env` de produção

```bash
cp .env.example .env
node scripts/generate-secrets.mjs   # se não houver Node na VPS, gere no PC — NOVOS segredos, não os de teste
nano .env
chmod 600 .env
```
Valores obrigatórios de produção:
```
NODE_ENV=production
PUBLIC_URL=https://wa.exemplo.com.br
CORS_ORIGINS=https://painel.exemplo.com.br
COOKIE_SECURE=true
TRUST_PROXY=1                  # 2 se colocar Cloudflare na frente do NPM
WEBHOOK_INTERNAL_HOSTS=n8n     # permite webhook para http://n8n:5678/webhook/... pela rede interna
PROXY_NETWORK=docker-base_default
```

## 4. Subir

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs -f api
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec api node dist/cli/createUser.js --email voce@exemplo.com --role admin --name "Carlos" --max 50
```
A stack aparece no Portainer como `nexuswa` (controle "Limited", porque foi criada pelo CLI). Atualize sempre pelo CLI.

## 5. Nginx Proxy Manager

1. **Uma única vez**: no volume de dados do NPM, crie `nginx/custom/http_top.conf` com o conteúdo de `deploy/nginx-proxy-manager/http_top.conf` e reinicie o container do NPM.
2. Crie o DNS `wa.exemplo.com.br` (registro A para o IP da VPS).
3. NPM → Hosts → **Add Proxy Host**:
   - Domain: `wa.exemplo.com.br`
   - Scheme/Forward: `http` · `nexuswa_api` · `3000`
   - ✅ Block Common Exploits · ✅ Websockets Support
   - SSL: Request new Let's Encrypt · ✅ Force SSL · ✅ HTTP/2 · ✅ HSTS · ✅ HSTS Subdomains
   - Advanced: cole `deploy/nginx-proxy-manager/advanced.conf`
4. Teste: `curl https://wa.exemplo.com.br/ready`

## 6. Endurecer o host

```bash
sudo SSH_PORT=22 bash deploy/host/firewall-ufw.sh
sudo ADMIN_IP=SEU.IP.FIXO bash deploy/host/docker-user-firewall.sh   # fecha 81/9443/5678 para a internet
sudo apt install -y fail2ban iptables-persistent && sudo netfilter-persistent save
# fail2ban: siga as instruções no topo de deploy/host/fail2ban-nexuswa.conf
```
> Sem IP fixo? Deixe `ADMIN_IP` vazio e acesse Portainer, NPM e n8n pelos domínios HTTPS (`portainer.`, `nginx.`, `n8n.exemplo.com.br`), que já passam pelo proxy.

## 7. Backup

```bash
chmod +x deploy/host/backup.sh
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/nexuswa/deploy/host/backup.sh >> /var/log/nexuswa-backup.log 2>&1") | crontab -
```
Copie `backups/` para fora da VPS (Google Drive, rclone, S3). **A `ENCRYPTION_KEY` fica em outro lugar** (cofre de senhas).

## 8. Atualizar versão

```bash
cd /opt/nexuswa && git pull
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```
As migrações rodam sozinhas. As sessões WhatsApp continuam (credenciais no banco, shutdown sem logout).

## 9. Usar a partir do n8n (mesma VPS)

- n8n → NexusWA: nó HTTP Request para `http://nexuswa_api:3000/send/text` (rede interna), com header `token`.
- NexusWA → n8n: webhook `http://n8n:5678/webhook/<id>`, permitido por `WEBHOOK_INTERNAL_HOSTS=n8n`.

Para isso a API precisa estar na mesma rede do n8n, o que `docker-compose.vps.yml` já faz.
