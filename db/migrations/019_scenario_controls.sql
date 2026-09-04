ALTER TABLE conversations ADD COLUMN scenario_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE automation_scenarios ADD COLUMN position integer NOT NULL DEFAULT 0;
UPDATE automation_scenarios s SET position = ranked.position FROM (SELECT id, row_number() OVER (PARTITION BY organization_id ORDER BY priority DESC, created_at) - 1 AS position FROM automation_scenarios) ranked WHERE ranked.id=s.id;
CREATE INDEX automation_scenarios_position_idx ON automation_scenarios (organization_id, position);
