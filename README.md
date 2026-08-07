# AgenteProspector (ex-Consecom)

CRM de prospecção comercial inteligente com IA, integrado ao Google Maps (extensão Chrome), WhatsApp (Evolution API), Supabase e painel web.

## Arquitetura

| Componente | Stack | Onde roda |
|------------|-------|-----------|
| Backend (este repo) | Node.js + Fastify + TypeScript | Railway |
| Frontend | React + TS + Vite + Tailwind | Vercel |
| Banco | PostgreSQL | Supabase |
| WhatsApp | Evolution API v2 | Railway |
| Extensão | Chrome Extension (Manifest V3) | Chrome Web Store / side-load |

## Estrutura

```
agenteprospector/
├── src/              # Backend Fastify
│   ├── routes/       # health, status, agent, webhook, evolution, connections, ui
│   ├── services/     # agent, db, evolution, send.worker, supabase.leads
│   ├── tools/        # marcar.reuniao, finalizar.sem.interesse, notify.admin
│   ├── config/       # env validation
│   └── types/        # zod schemas
├── frontend/         # React app (Vite)
├── extension/        # Chrome extension (Google Maps)
├── supabase-schema.sql          # Schema inicial (tabelas + RLS + storage)
├── supabase-migration-v3.sql    # Funil completo + agent_settings + agent_learning
├── supabase-migration-v4.sql    # WhatsApp connections + notification_groups
└── supabase-migration-v5.sql    # SECURITY: remove DELETE anonimo + cleanup
```

## Setup do Supabase (aplicar nesta ordem)

1. **Schema inicial** → `supabase-schema.sql`
2. **Funil completo + aprendizados** → `supabase-migration-v3.sql`
3. **Conexões WhatsApp + notificações** → `supabase-migration-v4.sql`
4. **Segurança + cleanup** → `supabase-migration-v5.sql` (NOVO)

Todos os arquivos são idempotentes (podem ser rodados multiplas vezes).

Copie o conteudo de cada arquivo → Supabase Dashboard → SQL Editor → New query → Run.

## Variaveis de ambiente

Veja `.env.example` para a lista completa. Minimo para produção:

```bash
NVIDIA_API_KEY=nvapi-xxx              # https://build.nvidia.com
EVOLUTION_API_URL=https://...         # URL publica da Evolution API
EVOLUTION_API_KEY=xxx                 # API key da Evolution
EVOLUTION_INSTANCE_NAME=consecom      # nome da instancia
WEBHOOK_SECRET=xxx                    # segredo do webhook (gerado por voce)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...   # service_role (NAO anon)
PUBLIC_BASE_URL=https://seu-railway.app   # usado para registrar webhook
AGENT_API_KEY=xxx                     # token Bearer para /api/chat
ALLOWED_ORIGINS=https://seu-vercel.app
DATABASE_URL=postgres://...           # conexao Postgres (opcional, p/ in-RAM store)
AGENT_ADMIN_GROUP_JID=120363xxx@g.us  # grupo admin (notificacoes)
AGENT_ENABLE_TOOLS=true
AGENT_ALLOWED_PERMS=READ,NETWORK,WHATSAPP
```

## Fluxo de uso

1. **Importar leads** → Extensão Chrome → Guia Leads
2. **Enviar para campanha** → Selecionar leads → Criar campanha → Definir sequencia
3. **Iniciar campanha** → Worker dispara mensagens com delay configurado
4. **Lead responde** → Webhook → IA assume (NVIDIA) → Persistencia Supabase
5. **IA marca reunião** → Tool `marcar_reuniao` → RPC `consecom_marcar_reuniao`
6. **Lead não responde** → Após delay → Tool `finalizar_sem_interesse` ou remarketing automatico

## Endpoints

| Metodo | Rota | Função |
|--------|------|--------|
| GET | `/health` | Railway probe |
| GET | `/api/status` | status geral |
| POST | `/api/chat` | chat IA (Bearer `AGENT_API_KEY`) |
| POST | `/webhook/evolution` | recebe mensagens WhatsApp |
| GET | `/api/evolution/health` | verifica Evolution |
| GET | `/api/connections/whatsapp` | status da conexão |
| POST | `/api/connections/whatsapp/connect` | criar instancia + QR |
| POST | `/api/connections/whatsapp/qr` | regenerar QR |
| DELETE | `/api/connections/whatsapp` | desconectar |
| GET | `/api/connections/groups` | grupos para notificação |
| POST | `/api/connections/groups/test` | mensagem de teste |

## Desenvolvimento

```bash
# Backend
npm install
npm run dev          # tsx watch
npm run build        # tsc
npm run typecheck

# Frontend
cd frontend
npm install
npm run dev

# Extensão Chrome
cd extension
npm install
npm run build        # gera dist/ para carregar em chrome://extensions
```

## Segurança

- Backend usa `service_role` (bypassa RLS) para escritas sensiveis
- `AGENT_API_KEY` valida chamadas ao `/api/chat`
- `WEBHOOK_SECRET` valida chamadas ao `/webhook/evolution`
- RLS ativo em todas as tabelas
- Migration v5 removeu DELETE anonimo em `leads` (critico)
- Pino redact remove chaves de logs
