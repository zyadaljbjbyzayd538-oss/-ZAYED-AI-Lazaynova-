CREATE TABLE IF NOT EXISTS websocket_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS websocket_tickets_active_lookup
  ON websocket_tickets(token_hash, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS websocket_tickets_expiry ON websocket_tickets(expires_at);
