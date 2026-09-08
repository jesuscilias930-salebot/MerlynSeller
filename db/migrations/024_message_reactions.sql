CREATE TABLE IF NOT EXISTS message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  target_provider_message_id text NOT NULL,
  actor_direction text NOT NULL CHECK (actor_direction IN ('inbound', 'outbound')),
  emoji text NOT NULL,
  provider_message_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, conversation_id, target_provider_message_id, actor_direction)
);

CREATE INDEX IF NOT EXISTS message_reactions_target_idx
  ON message_reactions (organization_id, conversation_id, target_provider_message_id);
