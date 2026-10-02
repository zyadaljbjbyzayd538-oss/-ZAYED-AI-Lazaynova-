CREATE TABLE IF NOT EXISTS user_tool_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (tool_name IN ('web.search', 'file.read_text')),
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (user_id, tool_name)
);

CREATE INDEX IF NOT EXISTS user_tool_grants_active_lookup
  ON user_tool_grants (user_id, tool_name, expires_at)
  WHERE revoked_at IS NULL;
