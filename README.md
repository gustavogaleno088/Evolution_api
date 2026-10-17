# Trocando Z-API por Evolution API (grátis, self-hosted)

```
troca_zapi/
├── infra/      docker-compose.yml, .env.example, setup-vps.sh  → vão para a VPS
├── backend/    API Express em TypeScript (envio + webhook)     → VPS (PM2) ou local
└── postman/    coleção pronta para importar no Postman
```

> ⚠️ A Evolution usa o Baileys (WhatsApp Web não oficial). Funciona bem, mas
> disparo em massa / spam pode banir o número. Use um chip dedicado para testes.

---

## 1. Hospedagem — Oracle Cloud Always Free

1. Crie a conta em https://www.oracle.com/cloud/free/ (pede cartão só para verificação).
2. **Compute → Instances → Create instance**
   - Image: **Canonical Ubuntu 24.04** (ou 22.04)
   - Shape: **VM.Standard.A1.Flex** (Ampere ARM) → 2 OCPU / 12 GB RAM (cabe no free: até 4 OCPU / 24 GB)
     - Se der "Out of capacity", tente outro *Availability Domain* ou use **VM.Standard.E2.1.Micro** (1 GB RAM — funciona com o swap do script).
   - Networking: crie VCN nova com **subnet pública** e "Assign public IPv4".
   - SSH keys: baixe/salve a chave privada.
3. Conecte:
   ```bash
   ssh -i caminho/da/chave.key ubuntu@SEU_IP_PUBLICO
   ```

### 🔥 Portas — libere em DOIS lugares na Oracle

**(a) Security List da VCN** — *Networking → Virtual Cloud Networks → sua VCN → Subnet → Security List → Add Ingress Rules*
(Source CIDR `0.0.0.0/0`, protocolo TCP):

| Porta | Uso | Liberar? |
|---|---|---|
| 22   | SSH | já vem aberta (ideal: restringir ao seu IP) |
| 8080 | Evolution API | sim (ou só seu IP; feche se usar proxy na 443) |
| 3000 | Backend / webhook | sim, se a Evolution ou clientes externos chamarem |
| 80, 443 | Nginx + HTTPS (opcional, recomendado em produção) | sim |
| 5432, 6379 | Postgres / Redis | **NÃO** — ficam só na rede interna do Docker |

**(b) iptables do Ubuntu** — a imagem da Oracle bloqueia tudo além da 22. O `setup-vps.sh` já libera 80/443/8080/3000 e persiste. *(Esquecer este passo é o erro nº 1: a porta fica "aberta" no painel e mesmo assim dá timeout.)*

Em outras VPS (Hetzner, DigitalOcean, AWS Lightsail etc.) basta o firewall do painel ou `ufw allow 8080/tcp`.

## 2. Preparar o ambiente (Docker, Node 22, PM2)

Do seu PC, envie a pasta e rode o script:

```bash
scp -i chave.key -r infra backend ubuntu@SEU_IP:~/
```
```bash
ssh -i chave.key ubuntu@SEU_IP "sudo bash ~/infra/setup-vps.sh"
```

Saia e entre no SSH de novo (para o grupo `docker` valer).

## 3. Instalação da Evolution API

```bash
cd ~/infra
cp .env.example .env
openssl rand -hex 32          # copie o resultado → AUTHENTICATION_API_KEY
openssl rand -hex 16          # → senha do Postgres
nano .env
```

No `.env` troque:
- `SERVER_URL=http://SEU_IP:8080`
- `AUTHENTICATION_API_KEY=<chave gerada>`
- `POSTGRES_PASSWORD=<senha>` **e a mesma senha** dentro de `DATABASE_CONNECTION_URI`

Suba:
```bash
docker compose up -d
```
```bash
docker compose logs -f evolution-api
```

Teste: abra `http://SEU_IP:8080` no navegador → deve retornar um JSON de boas-vindas.
Painel visual (opcional): `http://SEU_IP:8080/manager` (login com a API Key).

## 4. Testes no Postman

Importe `postman/evolution-api.postman_collection.json` e edite as variáveis da coleção (`evo`, `apikey`, `instance`, `number`, `backend`).

A **API Key** é o `AUTHENTICATION_API_KEY` do `.env` (chave global). Ela vai no header `apikey` em todas as chamadas.
Ao criar uma instância, a resposta traz também um `hash` = chave **só daquela instância** (pode usar no lugar da global no seu backend).

| # | Método | Rota | Body |
|---|---|---|---|
| 2 | POST | `/instance/create` | `{"instanceName":"meu-whatsapp","qrcode":true,"integration":"WHATSAPP-BAILEYS"}` |
| 3 | GET | `/instance/connect/meu-whatsapp` | — retorna `base64` (imagem do QR) e `code` |
| 4 | GET | `/instance/connectionState/meu-whatsapp` | — espere `"state":"open"` |
| 5 | POST | `/webhook/set/meu-whatsapp` | ver coleção |
| 6 | POST | `/message/sendText/meu-whatsapp` | `{"number":"5511999999999","text":"Olá"}` |
| 7 | POST | `/message/sendMedia/meu-whatsapp` | `{"number":"...","mediatype":"image","mimetype":"image/png","media":"https://...","caption":"..."}` |

**Ler o QR:** copie o valor de `base64` (começa com `data:image/png;base64,...`), cole na barra de endereço do navegador e escaneie em *WhatsApp → Aparelhos conectados → Conectar aparelho*. O QR expira em ~40 s: se vencer, chame o passo 3 de novo.
Alternativa sem QR: passo **3b** (`?number=55...`) devolve um `pairingCode` para digitar em "Conectar com número de telefone".

## 5. Backend (TypeScript + Express)

Rotas:
- `POST /messages/text` → `{ number, text }`
- `POST /messages/media` → `{ number, mediatype: image|video|audio|document, media: URL|base64, caption?, fileName?, mimetype? }`
- `GET  /whatsapp/status`
- `POST /webhook/evolution` → recebe eventos da Evolution e imprime o JSON no console

Todas (menos o webhook) exigem o header `x-api-token: <BACKEND_TOKEN>`.

Na VPS:
```bash
cd ~/backend
cp .env.example .env && nano .env      # EVOLUTION_API_KEY = mesma chave do infra/.env
npm install && npm run build
pm2 start ecosystem.config.js
pm2 save && pm2 startup                # rode o comando que o pm2 imprimir
pm2 logs whatsapp-backend              # aqui aparecem os JSONs do webhook
```

Depois chame o passo **5 (Configurar webhook)** do Postman com
`"url": "http://SEU_IP:3000/webhook/evolution"`.

> Dica: se backend e Evolution estão na mesma VPS, a Evolution roda em container e
> `localhost` lá dentro **não** é a VPS. Use o IP público, ou `http://172.17.0.1:3000/webhook/evolution` (IP do host na bridge do Docker) — aí nem precisa abrir a 3000 para a internet.

Desenvolvimento local (no seu PC): `npm run dev`. Para a Evolution alcançar o webhook do seu PC, use um túnel (`ngrok http 3000` ou `cloudflared tunnel --url http://localhost:3000`).

## 5b. Painel (dashboard)

O backend serve um painel em `http://SEU_IP:3000/dashboard/` com: status da Evolution, memória do servidor,
instâncias (conectada/desconectada, número, mensagens, contatos, webhook), botões para conectar por QR ou
código, reiniciar, desconectar, excluir, testar envio e criar instância nova (já com webhook), além dos últimos eventos recebidos.

O login é o `BACKEND_TOKEN` do `backend/.env`. Para ver o seu (no Git Bash):

```bash
ssh root@SEU_IP "grep BACKEND_TOKEN /opt/troca_zapi/backend/.env"
```

Atualizar o backend na VPS depois de mudar o código (no Git Bash, dentro de `troca_zapi`):

```bash
tar -czf - backend/src backend/public | ssh root@SEU_IP "tar -xzf - -C /opt/troca_zapi && cd /opt/troca_zapi/backend && npm run build && pm2 reload whatsapp-backend"
```

## 6. Produção (recomendado)

- Coloque um domínio + Nginx + Certbot na frente (443 → 8080 e 443 → 3000) e feche 8080/3000 na Security List.
- `WEBHOOK_SECRET` no backend + URL do webhook com `?secret=...`.
- Backup do volume `postgres_data` / `evolution_instances` (guardam a sessão do WhatsApp).
- Depois que estiver estável, fixe a tag da imagem no `docker-compose.yml` em vez de `latest`.

### Equivalência rápida Z-API → Evolution

| Z-API | Evolution |
|---|---|
| `POST /send-text` `{phone, message}` | `POST /message/sendText/{instance}` `{number, text}` |
| `POST /send-image` `{phone, image, caption}` | `POST /message/sendMedia/{instance}` `{number, mediatype:"image", media, caption}` |
| `POST /send-document/{ext}` | `sendMedia` com `mediatype:"document"`, `fileName` |
| `GET /qr-code/image` | `GET /instance/connect/{instance}` |
| `GET /status` | `GET /instance/connectionState/{instance}` |
| Header `Client-Token` | Header `apikey` |
| Webhook "on-message-received" | evento `messages.upsert` |
