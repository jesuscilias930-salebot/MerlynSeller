CREATE TABLE content_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('organic', 'ads')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 160),
  script text NOT NULL DEFAULT '' CHECK (char_length(script) <= 20000),
  shots text NOT NULL DEFAULT '' CHECK (char_length(shots) <= 10000),
  prompts text NOT NULL DEFAULT '' CHECK (char_length(prompts) <= 20000),
  recording_date date,
  publishing_date date,
  is_published boolean NOT NULL DEFAULT false,
  result_notes text NOT NULL DEFAULT '' CHECK (char_length(result_notes) <= 10000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX content_videos_organization_plan_idx
  ON content_videos (organization_id, channel, is_published, publishing_date, created_at DESC, id);
