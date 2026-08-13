-- Migration v22: identify the WhatsApp alias that sent campaign messages.
-- Execute after v21 in the Supabase SQL Editor.

ALTER TABLE public.consecom_conversations
  ADD COLUMN IF NOT EXISTS sender_display_name TEXT;

NOTIFY pgrst, 'reload schema';
