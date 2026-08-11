# RELATÓRIO CRÍTICO — Validação da IA Comercial (Consecom / "Alex")

**Data:** 11/08/2026
**Método:** Simulação real de conversa (lead "Ricardo", padaria de bairro) usando o **mesmo `runAgentLoop`** de produção (src/services/agent.service.ts), com tools desabilitadas (`enableTools:false`) para zero efeitos colaterais — mesma configuração do painel `/api/ai/chat`. Env real de produção (.env.local, 35 vars), banco Supabase real.
**Arquivos de teste:** src/test/simulate.lead.ts (harness) e src/test/.sim_state.json (histórico de 7 turnos).

---

## ⚠️ ACHADO MAIS GRAVE (ler antes de tudo)

**A IA NÃO APRENDEU NADA das suas conversas. A memória comercial está VAZIA.**

- Tabela `ai_memory_learnings`: **0 registros** (consulta real: `*/0`).
- Os dois ZIPs importados geraram `learnings_generated: 0` cada um.
- `loadCommercialMemoryForPrompt()` retorna `null` → o bloco "MEMÓRIA COMERCIAL" **NÃO existe no prompt** do agente.
- **Causa raiz:** bug de classificação de papéis. O nome do agente configurado é `"Alex"`, mas nas conversas reais o vendedor é **"Wesley"**. Em `memory.parse.ts:492`, a classificação só marca como `agente` se o remetente contiver o nome configurado. Resultado: **100% das mensagens importadas foram rotuladas como `lead`**, o prompt de análise tinha ZERO linhas "Agente:", e o modelo não tinha do que extrair comportamento → retornou lista vazia.

Consequência prática: **tudo o que a IA fez na simulação veio de (1) directivas genéricas, (2) autotraining genérico e (3) alucinação.** Nada veio de comportamento seu aprendido.

---

## A. Qualidade da escrita e tom

| Critério | Avaliação |
|---|---|
| Português | Correto, sem erros gramaticais. |
| Tom | Educado e profissional, mas **sem identidade**. Soa como "modelo de IA treinado em copywriting de vendas", não como o Wesley. |
| Empatia | Superficial e padronizada ("Entendo seu receio", "Entendo seu ponto" — repetido em turnos consecutivos). |
| Assinatura | Se apresenta como "Alex" — coerente com a directiva, mas o usuário real (Wesley) não assina como Alex nas conversas importadas. |

**Nota de escrita: 6/10.** Gramaticalmente impecável, mas clone genérico.

## B. Qualidade da argumentação comercial

**Ruim — e perigoso.** O pior momento da simulação:

> "Já ajudamos **mais de 120 padarias** a automatizar pedidos no WhatsApp, reduzindo perdas em até **90%** e aumentando a taxa de conversão em **30%**."

**Nenhum desses números existe.** Não estão nas directivas, nos learnings, na memória comercial (vazia) nem em nenhum lugar do código/banco. São **fabricados pelo modelo**. Pior: o lead é uma **padaria** e a IA inventou que já atendeu "120 padarias" — isso é uma **mentira apresentada como fato real** a um cliente, com risco jurídico e reputacional.

Sequência da negociação (turnos 3→6): a IA citou "R$ 3.000 a R$ 5.000", depois, ao ser pressionada pelo concorrente a R$ 900, **inventou um novo preço** "R$ 1.800 a R$ 2.200" — **se contradizendo** e inventando a tabela na hora, sem nenhuma política de preço real configurada.

**Nota de argumentação: 3/10.** A estrutura (perguntar dor → oferecer reunião) existe, mas a substância é inventada.

## C. Fidelidade ao manual / posicionamento

- A SAUDAÇÃO é reproduzida **quase verbatim** da directiva (`SAUDAÇÃO inicial`), incluindo "Vi o negócio de vocês e percebi algumas oportunidades na parte digital". Isso **não é pessoal** — é a template colada.
- O detalhe "Padaria do Bairro" na abertura **não veio da conversa**: veio do `leadContext` que o harness injetou (em produção, vem do registro do lead no banco, não de aprendizado). A IA apresentou isso como se fosse percepção própria.
- **Falha de posicionamento:** o lead expôs a dor real (pedidos no papel, sem cardápio visível, perda de pedidos) **duas vezes**, e a IA **nunca apresentou a solução** (site/catálogo/integração WhatsApp). Ficou só em perguntas. Um pré-vendedor real mostraria o que a empresa faz.

**Nota: 4/10.** Cola a template, mas não vende.

## D. Velocidade de resposta

| Turno | Latência |
|---|---|
| 1 | 7,6 s |
| 2 | 7,8 s |
| 3 | 7,3 s |
| 4 | 3,7 s |
| 5 | 1,4 s |
| 6 | 2,4 s |
| 7 | 4,9 s |

Média ~5 s, com picos de ~7,8 s. **Aceitável para o fluxo manual**, mas vai frustrar em escala se o agente operar sozinho. O gargalo é a chamada à NVIDIA (modelo `openai/gpt-oss-20b`).

## E. Sinais de IA genérica

1. **Canned greeting** — abertura idêntica ao template da directiva, sem variação.
2. **Closing copiado e colado** — "Você teria disponibilidade hoje às 14h, amanhã às 10h ou 15h?" apareceu **duas vezes, byte a byte** (turnos 6 e 7). Isso é padrão memorizado, não conversa real.
3. **Pergunta após pergunta** — 4 dos 5 primeiros turnos da IA foram perguntas. Padrão típico de IA de vendas treinada com playbook (questionar antes de propor), sem discernimento de quando já há dor explícita para vender.
4. **Números redondos fabricados** — "120 padarias / 90% / 30% / R$3-5k / R$1,8-2,2k". IA generativa preenche lacunas com plausibilidade, não com verdade.

## F. Sinais de interação humana

- **Quase nenhum.** Sem memória de conversas passadas, sem referência a detalhes específicos, sem toque pessoal.
- O único "personalizado" (nome do negócio na abertura) veio de injeção de contexto de banco, não de leitura da conversa.
- **Não é o Wesley conversando. É um assistente de vendas genérico usando a marca Consecom.**

## G. Resultado final da conversa

O lead de teste (Ricardo) terminou com **2 propostas de reunião idênticas coladas** e **nenhuma proposta concreta** do que a Consecom faria. Em produção com tools habilitadas, o marcador `<!--INTENT:reuniao-->` (turnos 6-7) dispararia o agendamento da reunião — ou seja, **a IA agendaria reuniões com base em números e cases que ela mesma inventou**. O risco não é só "não fechar"; é **fechar prometendo métricas falsas** que a Consecom não consegue entregar.

## H. Sinais de que a IA NÃO usa a memória comercial

1. **Prova objetiva:** `ai_memory_learnings` = 0 registros. Nada para usar.
2. **Prova comportamental:** a IA não conhece seus formatos reais de negociação, seus valores praticados, seus cases reais, seu jeito de quebrar objeção. Tudo que ela disse poderia ser dito por qualquer agente com as mesmas directivas.
3. **Prova de prompt:** o harness confirmou `COMMERCIAL MEMORY = (VAZIO / null)` no contexto enviado ao modelo.
4. **Contaminação cruzada:** os learnings que a IA REALMENTE usa vêm da tabela `agent_learning` (autotraining genérico) — e contêm **resquícios de outro projeto**: "Reunião de apresentação da solução **WMAgência**" (3x) e uma entrada em inglês "Lead interested in paid traffic". São de 07–10/08/2026, anteriores ao seu negócio atual.

## I. Falsificação de dados (cases/métricas)

- "mais de 120 padarias" — **fabricado**.
- "reduzindo perdas em até 90%" — **fabricado**.
- "aumentando a taxa de conversão em 30%" — **fabricado**.
- "site institucional entre R$ 3.000 e R$ 5.000" — **fabricado** (nenhuma política de preço existe no código).
- "site enxuto por R$ 1.800 a R$ 2.200" — **fabricado e contraditório** com o valor anterior.

**Veredito parcial: INAPTO a operar sozinho.** Enquanto não houver memória comercial real (com seus cases e valores) injetada no prompt, a IA vai continuar inventando.

## J. Vazamento de informações

- **Vazamento interno entre projetos:** os learnings injetados citam "WMAgência" (empresa/produto antigo) ao cliente atual da Consecom. Um lead que perceba isso vê inconsistência de marca.
- **Sem vazamento de credenciais/segredos** observado nas respostas.
- **Risco de vazamento de tabela de preços:** a IA inventa preços publicamente na conversa; se um valor inventado for menor que o praticado, o vendedor humano chega desvalorizado.

## K. O que precisa ser corrigido (prioridade)

1. **[P0] Corrigir o importador de memória.** O bug está em `memory.parse.ts:492` (classificação por nome do agente). O nome real do vendedor ("Wesley") precisa ser usado (configurável), ou a classificação precisa detectar o remetente vendedor de outra forma (ex.: remetente = dono do número exportado). **Sem isso, NENHUM ZIP vai gerar aprendizado.**
2. **[P0] Reimportar as conversas após o fix.** Rodar novamente a importação dos ZIPs e validar `learnings_generated > 0` e que `ai_memory_learnings` ganhou linhas.
3. **[P0] Bloquear alucinação de fatos.** Não há tabela de cases/referências/preços no prompt. Ou o sistema injeta uma lista real de cases/valores, ou a directiva proíbe explicitamente citar números/cases não fornecidos ("Nunca invente quantidades, casos ou métricas; responda que verá com o comercial").
4. **[P1] Limpar `agent_learning`.** Remover as 3 entradas "WMAgência" e a entrada em inglês — estão vazando para o cliente da Consecom.
5. **[P1] Deixar a memória comercial visível no prompt** mesmo vazia, com fallback explícito ("MEMÓRIA COMERCIAL: (vazia — aguarde dados reais)").
6. **[P1] Condicionar `INTENT:reuniao`** a não disparar antes de apresentar a solução (ou com a tabela de preços real no contexto).
7. **[P2] Variação de respostas** — proibir colagem exata do closing e da saudação (ex.: 3 templates rotativos).

## L. Veredito final

**REPROVADO para operação autônoma.** A validação respondeu à pergunta central: **não, a IA não está usando sua memória comercial — porque ela não existe no banco.** O agente atual é um vendedor genérico que (a) cola templates, (b) pergunta demais e vende de menos, e (c) **inventa métricas e preços falsos para o cliente**. A boa notícia: o pipeline técnico funciona (loop, directivas, autotraining, marcador de intenção). Falta **uma linha de código certa no importador** e **dados reais** para a IA virar "você". Recomendo corrigir P0 e reimportar antes de qualquer nova avaliação.

---

## Referências

[1] src/services/memory.parse.ts:492 — classificação de papel por nome do agente (bug raiz: "Wesley" ≠ "Alex" → tudo vira `lead`).
[2] src/services/memory.parse.ts:509 — fallback de classificação (`SELF_LABELS`).
[3] src/services/memory.service.ts — `loadCommercialMemoryForPrompt` retorna `null` com memória vazia.
[4] src/services/agent.learning.ts:121-133 — carrega `agent_learning` (autotraining) para o prompt; inclui linhas "WMAgência" e em inglês.
[5] src/services/agent.service.ts:145 — regra do marcador `<!--INTENT:-->` no prompt.
[6] src/services/intent.classifier.ts:6 — marcador removido antes do envio (comportamento correto).
[7] src/config/env.ts:16-18 — `NVIDIA_API_KEY` (e variável de ambiente Windows `NVIDIA_API_KEY=test_key` que **sombreava** a chave real ao rodar scripts locais; resolvido com `override:true` no harness).
[8] src/test/simulate.lead.ts — harness de simulação (runAgentLoop real, tools off).
[9] src/test/.sim_state.json — transcrição completa dos 7 turnos simulados.
[10] Banco real — `ai_memory_learnings`: 0 registros; `agent_learning`: 10 registros (07–10/08/2026).
[11] Evidência direta — teste HTTP à NVIDIA com a chave real: `200 OK` (chave válida; 401 no harness era a variável do Windows).
