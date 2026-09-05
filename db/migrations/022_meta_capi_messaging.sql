-- Attribution and a durable audit trail for server-side Meta conversion events.
-- The token itself is deliberately never stored in the database.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS meta_ctwa_clid text,
  ADD COLUMN IF NOT EXISTS meta_page_scoped_user_id text,
  ADD COLUMN IF NOT EXISTS meta_referral jsonb,
  ADD COLUMN IF NOT EXISTS meta_lead_submitted_at timestamptz;

CREATE TABLE IF NOT EXISTS meta_conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_name text NOT NULL CHECK (event_name IN ('LeadSubmitted', 'Purchase')),
  dedupe_key text NOT NULL,
  provider_event_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  response jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (organization_id, dedupe_key),
  UNIQUE (provider_event_id)
);

CREATE INDEX IF NOT EXISTS meta_conversion_events_conversation_idx
  ON meta_conversion_events (conversation_id, created_at DESC);
