CREATE TABLE interactive_option_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  format text NOT NULL CHECK (format IN ('buttons', 'list')),
  header text CHECK (header IS NULL OR char_length(header) <= 60),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1024),
  footer text CHECK (footer IS NULL OR char_length(footer) <= 60),
  button_text text CHECK (button_text IS NULL OR char_length(button_text) <= 20),
  section_title text CHECK (section_title IS NULL OR char_length(section_title) <= 24),
  options jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interactive_option_templates_organization_updated_idx
  ON interactive_option_templates (organization_id, updated_at DESC);
