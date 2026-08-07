# Railway Setup — AgenteProspector

## URL pública

Após o primeiro deploy, copie a URL pública do Railway (ex: `https://seu-app.up.railway.app`).
Esta URL vai em `PUBLIC_BASE_URL` e também será usada pela Evolution API.

Railway também injeta `RAILWAY_PUBLIC_DOMAIN` automaticamente — o backend usa isso se existir.

---

## Variáveis obrigatórias

### 1. NVIDIA (LLM)
```
NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxxxxxxxx
```
Obter em: https://build.nvidia.com → API Keys

### 2. Evolution API
```
EVOLUTION_API_URL=https://sua-evolution.up.railway.app
EVOLUTION_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EVOLUTION_INSTANCE_NAME=consecom
```
- `EVOLUTION_API_URL`: URL completa (sem barra final)
- `EVOLUTION_INSTANCE_NAME`: nome da instância na Evolution

### 3. Webhook
```
WEBHOOK_SECRET=$(openssl rand -hex 32)
```
Este mesmo valor deve ser configurado na Evolution API ao registrar o webhook.

### 4. Supabase
```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxxxx...
```
⚠️ Use **service_role** (NÃO a anon key). Obtida em Supabase → Settings → API.

### 5. Backend público
```
PUBLIC_BASE_URL=https://seu-app.up.railway.app
```
⚠️ Use a URL real do seu Railway (não hardcode).

### 6. Autenticação do /api/chat
```
AGENT_API_KEY=$(openssl rand -hex 32)
```
Use esta mesma key no frontend (Bearer token) e em variáveis do Vercel.

### 7. CORS (origens permitidas)
```
ALLOWED_ORIGINS=https://seu-frontend.vercel.app,https://www.seu-dominio.com.br
```
Pode listar múltiplos domínios separados por vírgula.

---

## Variáveis opcionais (com defaults)

### Banco Postgres (in-RAM store)
```
DATABASE_URL=postgresql://user:pass@host:5432/db
```
Se vazio, conversas ficam só em memória (perde no restart).

### Agente
```
AGENT_MODEL=meta/llama-3.1-8b-instruct
AGENT_MAX_TOKENS=1024
AGENT_MAX_ITERATIONS=6
AGENT_ENABLE_TOOLS=true
AGENT_ALLOWED_PERMS=READ,NETWORK,WHATSAPP
AGENT_TOOL_TIMEOUT_MS=15000
AGENT_MODEL_SUPPORTS_TOOLS=auto
```

### Grupo admin (notificações)
```
AGENT_ADMIN_GROUP_JID=120363xxxxxxxxx@g.us
```
JID do grupo WhatsApp que recebe notificações de reunião marcada.
Descubra abrindo o grupo no WhatsApp Web e olhando a URL.

### Worker de campanhas
```
CONSECOM_WORKER_TICK_MS=5000
```
Intervalo (ms) que o worker checa novos envios. 5s é razoável.

### Rate limit
```
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW=60
```

### Evolution (hardening)
```
EVOLUTION_ALLOWED_INSTANCES=
EVOLUTION_ALLOWED_GROUPS=
EVOLUTION_MENTION_ONLY=false
EVOLUTION_SENDTEXT_MAX_RETRIES=3
```

### Logs
```
LOG_LEVEL=info
SERVICE_NAME=agente-consecom
SERVICE_VERSION=0.1.0
PORT=3000
```

---

## Como gerar secrets

```bash
# WEBHOOK_SECRET (32 bytes hex)
openssl rand -hex 32

# AGENT_API_KEY (32 bytes hex)
openssl rand -hex 32
```

---

## Verificação pós-deploy

Após Railway deployar, teste:

```bash
# Health
curl https://seu-app.up.railway.app/health

# Status completo
curl https://seu-app.up.railway.app/api/status
# Espera: nvidiaApiKeyConfigured=true, evolutionConfigured=true, dbConnected=true

# Evolution health
curl https://seu-app.up.railway.app/api/evolution/health
# Espera: ok=true, instance="consecom"

# Chat API
curl -X POST https://seu-app.up.railway.app/api/chat \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"test-1","message":"oi"}'

# Webhook teste (simula Evolution)
curl -X POST https://seu-app.up.railway.app/webhook/evolution \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"event":"messages.upsert","instance":"consecom","data":{"key":{"remoteJid":"5511999999999@s.whatsapp.net","fromMe":false,"id":"t1"},"message":{"conversation":"oi"},"pushName":"T"}}'
```

Se algum retorno for 503, falta variável de ambiente.

---

## Ordem recomendada de setup

1. **Supabase** → aplicar `supabase-CONSOLIDADO.sql` no SQL Editor
2. **Evolution API** → criar conta/instância, obter URL e API key
3. **Railway** → criar service, conectar GitHub, colar variáveis acima
4. **Primeiro deploy** → Railway detecta Node.js e roda `npm run build` + `npm start`
5. **Evolution → Webhook** → apontar para `https://seu-app.up.railway.app/webhook/evolution`
6. **Vercel** → criar projeto, colar `NEXT_PUBLIC_API_URL=https://seu-app.up.railway.app`
7. **Teste E2E** → curl conforme seção acima
