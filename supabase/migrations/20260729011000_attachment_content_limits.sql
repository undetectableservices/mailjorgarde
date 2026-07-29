-- Match the self-hosted attachment storage contract used by the inbound edge.
-- Runtime limits are stricter; this is the supported absolute database ceiling
-- (25 MiB before base64 encoding).

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS content_base64 TEXT,
  ADD COLUMN IF NOT EXISTS content_disposition TEXT,
  ADD COLUMN IF NOT EXISTS content_id TEXT;

ALTER TABLE public.attachments
  DROP CONSTRAINT IF EXISTS attachments_content_base64_size_chk,
  ADD CONSTRAINT attachments_content_base64_size_chk
    CHECK (content_base64 IS NULL OR octet_length(content_base64) <= 34952536),
  DROP CONSTRAINT IF EXISTS attachments_content_disposition_chk,
  ADD CONSTRAINT attachments_content_disposition_chk
    CHECK (content_disposition IS NULL OR content_disposition IN ('attachment', 'inline'));
