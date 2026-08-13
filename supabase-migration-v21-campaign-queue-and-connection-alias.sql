-- Migration v21: deterministic campaign queue order and WhatsApp aliases.
-- Execute in the Supabase SQL Editor.

ALTER TABLE public.send_runs
  ADD COLUMN IF NOT EXISTS position INTEGER;

ALTER TABLE public.whatsapp_connections
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Preserve the existing insertion order for runs already in the database.
WITH numbered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY campaign_id
           ORDER BY created_at ASC, id ASC
         ) - 1 AS next_position
  FROM public.send_runs
)
UPDATE public.send_runs sr
SET position = numbered.next_position
FROM numbered
WHERE sr.id = numbered.id;

CREATE OR REPLACE FUNCTION public.consecom_assign_send_run_position()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.position IS NULL THEN
    -- Serialize allocation per campaign so concurrent imports cannot receive
    -- the same queue position.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.campaign_id::TEXT, 0));
    SELECT COALESCE(MAX(position), -1) + 1
      INTO NEW.position
      FROM public.send_runs
     WHERE campaign_id = NEW.campaign_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS send_runs_assign_position ON public.send_runs;
CREATE TRIGGER send_runs_assign_position
BEFORE INSERT ON public.send_runs
FOR EACH ROW
EXECUTE FUNCTION public.consecom_assign_send_run_position();

CREATE INDEX IF NOT EXISTS send_runs_campaign_position_idx
  ON public.send_runs (campaign_id, position, created_at, id);

NOTIFY pgrst, 'reload schema';
