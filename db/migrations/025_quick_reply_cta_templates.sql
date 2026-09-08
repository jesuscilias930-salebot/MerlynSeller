ALTER TABLE quick_replies
  ADD COLUMN kind text NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'cta_url')),
  ADD COLUMN cta_url_template_id uuid
    REFERENCES cta_url_templates(id) ON DELETE RESTRICT;

ALTER TABLE quick_replies
  ADD CONSTRAINT quick_replies_cta_template_required
  CHECK (
    (kind = 'text' AND cta_url_template_id IS NULL)
    OR (kind = 'cta_url' AND cta_url_template_id IS NOT NULL)
  );

CREATE INDEX quick_replies_cta_url_template_idx
  ON quick_replies (cta_url_template_id)
  WHERE cta_url_template_id IS NOT NULL;
