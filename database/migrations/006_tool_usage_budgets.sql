CREATE TABLE IF NOT EXISTS user_tool_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (tool_name IN ('web.search', 'file.read_text')),
  minute_bucket timestamptz NOT NULL,
  minute_count integer NOT NULL CHECK (minute_count >= 0),
  day_bucket date NOT NULL,
  day_count integer NOT NULL CHECK (day_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tool_name)
);
