-- =============================================================
-- VYNTRA — Migration v28 (Cota por importação)
-- Idempotente.
--
-- O consumo do plano passa a ser contado pelos LEADS IMPORTADOS
-- (tabela leads.tenant_id), controlado no backend em
-- /api/extension/import-leads e /api/extension/plan.
--
-- Removemos o trigger que BLOQUEAVA envios (enforce_credit_limit
-- em send_runs): enviar para leads já importados não deve ser
-- bloqueado pela cota. A auditoria log_lead_consumed é mantida.
-- =============================================================

DROP TRIGGER IF EXISTS trg_send_runs_credit ON public.send_runs;

NOTIFY pgrst, 'reload schema';
