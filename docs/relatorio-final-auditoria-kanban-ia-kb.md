# RELATÓRIO FINAL — Auditoria 26 pontos (Kanban IA + Base de Conhecimento + E2E real)

**Data:** 20/08/2026
**Escopo:** Itens 13, 18, 25 e adjacentes da especificação de 26 pontos — movimentação do Kanban com IA, prioridade da Base de Conhecimento sobre estratégia/playbook herdados, e validação real ponta a ponta (Evolution → webhook → agente → Supabase).

---

## 1. BUG CRÍTICO ENCONTRADO E CORRIGIDO: `leads_status_check` rejeitava `ia` e `necessita_humano`

### Sintoma
Durante o primeiro e2e ao vivo (cliente real respondeu 5x, 00:51–00:53), o lead **nunca** saiu da coluna "Enviados". O histórico `lead_status_history` registrava 5 linhas com status `ia`, mas `leads.status` permanecia `enviado` — um registro **falso**.

### Causa raiz (confirmada empiricamente)
- O CHECK `leads_status_check` em produção (última definição na migration v24, `supabase-migration-v24-follow-ups.sql:7-14`) **não inclui** `'ia'` nem `'necessita_humano'`.
- O webhook (`src/routes/webhook.ts`) chama `updateLeadStatus(lead.id, 'ia')` / `'necessita_humano'`; o PATCH REST era **rejeitado com HTTP 400, código `23514`** (constraint violation).
- `updateLeadStatus` (`src/services/supabase.leads.ts:277`) **não verificava `res.ok`** → a falha era silenciosa e o POST em `lead_status_history` (tabela sem CHECK) gravava a linha mesmo assim.
- Consequência: o movimento "Enviados → IA" (item 18) e o handoff "→ Necessita de Humano" **nunca persistiram no Kanban**, inclusive o DnD manual do operador.

### Correção
1. **`supabase-migration-v39-kanban-ia-status.sql`** — estende o CHECK com `'ia'` e `'necessita_humano'`. Aplicada na produção via conexão direta (`db.nzexythhastovjwuedsh.supabase.co`). Verificado:
   `status IN (…'para_ligacao','responder_depois','ia','necessita_humano')`.
2. **`supabase-CONSOLIDADO.sql`** — mesmo fix para re-aplicações.
3. **`updateLeadStatus` endurecido** (`dc926de`): verifica `res.ok`; em falha loga warning com corpo do Supabase e **não grava histórico falso** (retorna `false`).
4. Testes novos em `src/test/kanban.movement.test.ts`: PATCH rejeitado → sem histórico; status permitido → grava status + histórico.

---

## 2. CORREÇÃO: Base de Conhecimento prevalece sobre estratégia herdada

### Sintoma
O lead real Wesley tinha `strategy_id` da campanha antiga **"Teste ia"** (já deletada), cuja estratégia era de **pastelaria**. O agente injetava o bloco `ESTRATÉGIA DE ABORDAGEM` de pastelaria no prompt e **ignorava a KB de psicólogos** — respostas genéricas/fora de contexto ("Como você costuma atrair clientes atualmente?"), confundindo o cliente ("Oxii, você que me chamou").

### Causa raiz (confirmada com teste direto no modelo real `openai/gpt-oss-20b`)
Com `strategyDirective` (pastelaria) + KB carregada, o modelo segue a estratégia. Após limpar `strategy_id` e reforçar o bloco KB, o modelo respondeu corretamente (psicólogos/Consecom).

### Correção
1. **`src/services/agent.service.ts`** (`f5c88da`): o bloco KB agora instrui explicitamente — "SE a ESTRATÉGIA DE ABORDAGEM ou o SALES PLAYBOOK citar um negócio diferente do que a BASE define, IGNORE essas instruções de negócio".
2. **`strategy_id` limpo** no lead `cb9c28cd` (PATCH 204).
3. README da KB (`kb_files/8311c4f3`) atualizado com a linha do spec: "Esta campanha vende exclusivamente a solução da Consecom para psicólogos."

---

## 3. VALIDAÇÃO E2E REAL (ponta a ponta)

### Fase 1 — Cliente real (00:50–00:53)
- Campanha dedicada **"TESTE E2E PSICOLOGOS"** (`c7da686a…`, modo inteligente, `ai_enabled`, KB `180d5ee7…`, conexão `29c80dc6…` / instância `-2`).
- `send_run` `63c407f8…` → done, abordagem real entregue via Evolution (success_count=1).
- Cliente Wesley respondeu 5x em tempo real; a IA respondeu a cada vez (`consecom_conversations` registrado). O lead **não** mudou de coluna — revelou o bug da Seção 1.

### Fase 2 — Validação controlada (fake number, sem incomodar o cliente)
Lead de teste com número inválido-corrigido (`15998887777`, telefone válido — o primeiro usado, `159988887777`, é INVALIDO pela regra de normalização e nunca era localizado pelo índice de leads) + `send_run` done. Mensagens simuladas via webhook real:

| Mensagem | Lead.status | Histórico | needs_attention | Resposta da IA (conversation) |
|---|---|---|---|---|
| "Oi… gestão para psicólogos" | `ia` | `ia` | false | "Sou Alex Monteiro, da Consecom… Como você organiza os agendamentos e o controle das consultas?" — **baseada na KB**, sem pastelaria |
| "Quero contratar…" | `necessita_humano` | `necessita_humano` \| "intenção explícita de compra" | **true** | "Vou encaminhar sua solicitação para a equipe responsável…" |
| "Não tenho interesse agora" | `sem_interesse` | `sem_interesse` \| "não tem interesse agora" | true | "Entendido. Se no futuro surgir interesse, estarei à disposição…" |

- `no_interest_until` bloqueado em **6 meses** (2027-02-20).
- Score refletiu os sinais (50 → 57 → 77 → 52).
- Dados de teste removidos após a validação (204). Lead real Wesley movido para `ia` (PATCH 204 — confirma o fix na produção real).

**Status do item 18 e do e2e: VALIDADO.**

---

## 4. ACHADOS ADICIONAIS (produção, fora do escopo do e2e)

### Remarketing falhando em massa (404)
O send-worker de remarketing está falhando para **dezenas de leads**:
`sendText non-OK 404 endpoint="…/message/sendText/consecom-user-9a6d110f-9a7"`.
A env `EVOLUTION_INSTANCE_NAME` de produção é `consecom-user-9a6d110f-9a7` (sem `-2`), instância que não existe na Evolution de cópia (`evolution-api-copy-production-…`). Os sends da IA (instância `-2`) funcionam; os do remarketing, não. **Requer revisão da config de instância do remarketing.**

### Pendência de design
`fireCampaign` não reseta send_runs com status `done` — re-disparar uma campanha pode não reenviar para leads já concluídos.

---

## 5. Arquivos alterados nesta auditoria

- `src/services/agent.service.ts` — bloco KB override (`f5c88da`).
- `src/services/supabase.leads.ts` — `updateLeadStatus` checa `res.ok`, não grava histórico falso (`dc926de`).
- `src/test/kanban.movement.test.ts` — testes do PATCH rejeitado/permitido (`dc926de`).
- `supabase-migration-v39-kanban-ia-status.sql` — novo (`dc926de`).
- `supabase-CONSOLIDADO.sql` — CHECK estendido (`dc926de`).
- `kb_files/8311c4f3` (banco) — README da KB com a linha do spec.

## 6. Verificação

- Typecheck backend: OK. Typecheck/build frontend: OK.
- Testes: **254/254 passando** (incluindo os novos).
- Deploys: Railway (backend, `dc926de`) ativo — health 200, uptime ok. Vercel prod aliased `https://vyntra.consecom.com.br`.

## 7. Recomendações

1. Corrigir o 404 do remarketing (Seção 4) — impacto em produção imediato.
2. Revisar `fireCampaign` para resetar runs `done` em re-disparos.
3. Validar o fluxo de "responder_depois" (follow-up da IA) em e2e dedicado — mecanismo presente (cria `follow_ups` + move para `responder_depois`), ainda sem teste ao vivo.