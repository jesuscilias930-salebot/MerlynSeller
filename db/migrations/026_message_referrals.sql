ALTER TABLE messages
  ADD COLUMN referral jsonb;

CREATE INDEX messages_referral_source_idx
  ON messages ((referral->>'sourceId'))
  WHERE referral IS NOT NULL;
