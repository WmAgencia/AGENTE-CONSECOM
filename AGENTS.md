# AGENTS.md

## Workflow obrigatório

Após qualquer mudança no projeto, SEMPRE:

1. Rodar typecheck (`npx tsc --noEmit -p tsconfig.json`) quando mexer no backend.
2. Commit + push para `main`.
3. Fazer deploy na Vercel do frontend, rodando da raiz do repo:
   `vercel --prod --yes --project frontend`

O deploy da Vercel usa o projeto `frontend` (rootDirectory = `frontend`). O alias de produção é
`https://frontend-consecom.vercel.app`. NUNCA rodar `vercel` de dentro de `frontend/` (o CLI duplica o
path). O backend fica na Railway (`consecom-backend`) e deploya automaticamente no push para `main`.

## Notas de ambiente

- Backend Railway: projeto `AGENTE CLOUD CONSECOM`, serviço `consecom-backend`.
- Evolution API: `https://evolution-api-production-f7e8.up.railway.app`.
- Webhooks da Evolution precisam de `?secret=consecom_webhook_secret_local` na URL.
