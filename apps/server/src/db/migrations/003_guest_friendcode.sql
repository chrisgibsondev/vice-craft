-- Guest accounts assigned by network address (no login needed) and 5-digit friend codes.
ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN ip_key TEXT;
ALTER TABLE users ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX users_friend_code ON users(friend_code);
CREATE INDEX users_ip_key ON users(ip_key);
