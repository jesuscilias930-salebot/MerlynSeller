-- Explicit opt-in after deployment; no advertising is enabled implicitly.
ALTER TABLE integration_features
 ADD COLUMN IF NOT EXISTS meta_events_enabled boolean NOT NULL DEFAULT false;
