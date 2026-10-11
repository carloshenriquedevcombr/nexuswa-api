# Subir na VPS só pelo celular (Termux)

## 1. Preparar o Termux (uma vez)
```bash
pkg update && pkg install -y openssh
termux-setup-storage          # autorize o acesso aos arquivos do celular
```

## 2. Enviar o projeto para a VPS
O arquivo `nexuswa-api.tar.gz` baixado fica em `~/storage/downloads`.
```bash
scp ~/storage/downloads/nexuswa-api.tar.gz root@IP_DA_VPS:/opt/
```

## 3. Instalar na VPS
```bash
ssh root@IP_DA_VPS
cd /opt && tar -xzf nexuswa-api.tar.gz && mv nexuswa-api nexuswa && cd nexuswa
bash deploy/vps-install.sh
```
O script pergunta só o domínio, a origem do dashboard e o seu e-mail/senha de admin. O resto é automático e ele pode ser rodado de novo com segurança.

## 4. Proxy Host no NPM (pelo navegador do celular)
Abra `https://npm.exemplo.com.br` e siga o quadro que o script mostra no final.
Para copiar a configuração Advanced:
```bash
cat /opt/nexuswa/deploy/nginx-proxy-manager/advanced.conf
```

## Comandos úteis (na VPS)
| Quero... | Comando |
|---|---|
| Ver os logs ao vivo | `cd /opt/nexuswa && docker compose -f docker-compose.yml -f docker-compose.vps.yml logs -f --tail 100 api` |
| Reiniciar a API | `docker restart nexuswa_api` |
| Status dos containers | `docker ps --filter name=nexuswa` |
| Editar configuração | `nano /opt/nexuswa/.env` e depois `bash deploy/vps-install.sh` |
| Atualizar para uma versão nova | envie o novo `.tar.gz`, extraia por cima (o `.env` é mantido) e rode `bash deploy/vps-install.sh` |

Dica para o Termux: segure a tela e use **More → Select URL / Copy** para copiar tokens e logs.
