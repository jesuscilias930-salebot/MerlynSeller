ALTER TABLE automation_scenarios
  ADD COLUMN ai_description text,
  ADD COLUMN priority integer NOT NULL DEFAULT 0,
  ADD COLUMN can_interrupt boolean NOT NULL DEFAULT true;

CREATE INDEX automation_scenarios_priority_idx ON automation_scenarios (organization_id, is_active, priority DESC);
