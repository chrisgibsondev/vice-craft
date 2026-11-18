-- In-game web (phone browser): owned properties, spawn choice, bank transfers.
CREATE TABLE properties (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  bought_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, property_id)
);

ALTER TABLE profiles ADD COLUMN spawn_property TEXT;

CREATE TABLE transfers (
  id BIGSERIAL PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX transfers_from ON transfers(from_id, created_at);
