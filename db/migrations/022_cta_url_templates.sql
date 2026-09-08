CREATE TABLE cta_url_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  header text CHECK (header IS NULL OR char_length(header) <= 60),
  header_image_url text CHECK (header_image_url IS NULL OR char_length(header_image_url) <= 2000),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1024),
  footer text CHECK (footer IS NULL OR char_length(footer) <= 60),
  button_text text NOT NULL CHECK (char_length(button_text) BETWEEN 1 AND 20),
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cta_url_templates_organization_updated_idx
  ON cta_url_templates (organization_id, updated_at DESC);
