# Subir na VPS pelo PowerShell do Windows (sem Git, sem VS Code)

Não precisa instalar nada: o Windows 10/11 já vem com `ssh`, `scp` e `tar`.

## 1. Confirmar as ferramentas
```powershell
ssh -V
```
Se aparecer a versão do OpenSSH, pode seguir. Se der "não reconhecido", o PC bloqueou o OpenSSH; nesse caso use o Termux (`docs/DEPLOY-TERMUX.md`).

## 2. Enviar o pacote do pendrive para a VPS
Troque `E:` pela letra do pendrive e `IP_DA_VPS` pelo IP.
```powershell
cd E:\
scp .\nexuswa-api.tar.gz root@IP_DA_VPS:/opt/
```
Envie o `.tar.gz` **sem extrair no Windows**: assim os scripts mantêm o formato Linux e as permissões.

## 3. Instalar (na VPS)
```powershell
ssh root@IP_DA_VPS
```
Já dentro da VPS:
```bash
cd /opt && tar -xzf nexuswa-api.tar.gz && mv nexuswa-api nexuswa && cd nexuswa
bash deploy/vps-install.sh
```
O instalador pergunta:
1. o domínio (Enter aceita `wa.exemplo.com.br`);
2. a origem do dashboard (Enter aceita o padrão);
3. seu e-mail e senha de admin (a senha não aparece enquanto você digita).

O resto é automático: `.env` com segredos, rede do NPM, rate limit, build e banco.

A primeira compilação leva de 3 a 10 minutos.

## 4. Proxy Host no NPM (pelo navegador)
Siga o quadro que o script mostra no final. Para ver o texto do campo Advanced:
```bash
cat /opt/nexuswa/deploy/nginx-proxy-manager/advanced.conf
```
Selecione com o mouse no PowerShell: **botão direito copia** o texto selecionado e **botão direito sem seleção cola**.

## 5. Atualizar depois
```powershell
scp .\nexuswa-api.tar.gz root@IP_DA_VPS:/opt/
ssh root@IP_DA_VPS "cd /opt && tar -xzf nexuswa-api.tar.gz && cp -a nexuswa-api/. nexuswa/ && rm -rf nexuswa-api && cd nexuswa && bash deploy/vps-install.sh"
```
O `.env` e os dados do banco são mantidos.

## Se algo der errado
| Sintoma | O que fazer |
|---|---|
| `Permission denied (publickey,password)` | Usuário ou senha do SSH errados. Confira se o login é `root` ou outro usuário (nesse caso use `sudo bash deploy/vps-install.sh`) |
| Build para com `Killed` ou `ENOMEM` | Pouca RAM. Crie swap com o comando que o script mostra e rode de novo |
| `A API não subiu` | O script mostra o log. Copie as últimas linhas e me envie |
| `curl https://.../ready` não responde | Confira o DNS (registro A) e o Proxy Host no NPM |
