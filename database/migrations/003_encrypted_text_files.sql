CREATE TABLE IF NOT EXISTS user_files (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL CHECK (octet_length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (content_type IN ('text/plain', 'text/csv')),
  byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 32768),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  key_version smallint NOT NULL CHECK (key_version = 1),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) = byte_length),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  wrapped_key bytea NOT NULL CHECK (octet_length(wrapped_key) = 32),
  wrap_nonce bytea NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrap_auth_tag bytea NOT NULL CHECK (octet_length(wrap_auth_tag) = 16),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_files_owner_recent ON user_files(user_id, created_at DESC);
