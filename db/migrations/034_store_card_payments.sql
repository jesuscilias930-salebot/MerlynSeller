-- Preserve the existing checkout behavior until an administrator switches it off.
ALTER TABLE integration_features
 ADD COLUMN IF NOT EXISTS card_payments_enabled boolean NOT NULL DEFAULT true;
