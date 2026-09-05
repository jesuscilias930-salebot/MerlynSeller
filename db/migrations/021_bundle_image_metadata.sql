-- Links a reusable image group to an inventory bundle without creating a
-- database dependency between SalesBot and the separate Sock Control service.
ALTER TABLE entrepreneur_packages
  ADD COLUMN IF NOT EXISTS control_bundle_id integer,
  ADD COLUMN IF NOT EXISTS bundle_type text;

CREATE INDEX IF NOT EXISTS entrepreneur_packages_bundle_lookup_idx
  ON entrepreneur_packages (organization_id, bundle_type, control_bundle_id);

CREATE UNIQUE INDEX IF NOT EXISTS entrepreneur_packages_control_bundle_unique_idx
  ON entrepreneur_packages (organization_id, control_bundle_id)
  WHERE control_bundle_id IS NOT NULL;
