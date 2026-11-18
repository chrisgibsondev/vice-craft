-- VICE CRAFT initial schema
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  banned_until TIMESTAMPTZ,
  ban_reason TEXT,
  presence_visibility TEXT NOT NULL DEFAULT 'friends',
  invite_policy TEXT NOT NULL DEFAULT 'friends',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE friend_requests (
  from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX friend_requests_to ON friend_requests(to_id);

CREATE TABLE friendships (
  a_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (a_id, b_id),
  CHECK (a_id < b_id)
);
CREATE INDEX friendships_b ON friendships(b_id);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash BIGINT NOT NULL DEFAULT 0 CHECK (cash >= 0),
  rep INTEGER NOT NULL DEFAULT 0,
  completed JSONB NOT NULL DEFAULT '{}',
  unlocks JSONB NOT NULL DEFAULT '[]',
  preps JSONB NOT NULL DEFAULT '{}',
  checkpoints JSONB NOT NULL DEFAULT '{}',
  inventory JSONB NOT NULL DEFAULT '{}',
  outfit INTEGER NOT NULL DEFAULT 16740185,
  pos JSONB,
  settings JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  color INTEGER NOT NULL,
  health INTEGER NOT NULL,
  upgrades JSONB NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'stored',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX vehicles_owner ON vehicles(owner_id);

CREATE TABLE activity_runs (
  id TEXT PRIMARY KEY,
  activity TEXT NOT NULL,
  kind TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  roster JSONB NOT NULL,
  terms JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  checkpoint INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX activity_runs_status ON activity_runs(status);

CREATE TABLE reward_grants (
  run_id TEXT NOT NULL REFERENCES activity_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cash BIGINT NOT NULL,
  rep INTEGER NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, user_id)
);

CREATE TABLE personal_bests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity TEXT NOT NULL,
  value_ms INTEGER NOT NULL,
  run_id TEXT,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, activity)
);

CREATE TABLE ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount BIGINT NOT NULL,
  balance BIGINT NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ledger_user ON ledger(user_id, created_at);

CREATE TABLE reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE parties (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
