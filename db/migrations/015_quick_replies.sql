CREATE TABLE quick_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shortcut text NOT NULL CHECK (shortcut ~ '^/[a-z0-9_]{1,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, shortcut)
);

CREATE INDEX quick_replies_organization_shortcut_idx
  ON quick_replies (organization_id, shortcut);
