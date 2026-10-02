CREATE TABLE IF NOT EXISTS workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,63}$'),
  latest_version integer NOT NULL CHECK (latest_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);
CREATE INDEX IF NOT EXISTS workflow_definitions_owner_updated
  ON workflow_definitions (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_definition_versions (
  workflow_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (
    jsonb_typeof(definition) = 'object' AND jsonb_typeof(definition -> 'steps') = 'array'
  ),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, version)
);
