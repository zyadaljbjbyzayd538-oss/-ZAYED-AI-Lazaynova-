CREATE TABLE IF NOT EXISTS task_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  artifact_kind text NOT NULL CHECK (artifact_kind IN ('TASK_RESULT', 'GRAPH_NODE_RESULT')),
  filename text NOT NULL CHECK (filename ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$'),
  content_type text NOT NULL CHECK (content_type = 'application/json'),
  byte_length bigint NOT NULL CHECK (byte_length BETWEEN 1 AND 26214400),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  object_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'DELETING')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (object_key ~ '^tasks/[0-9a-fA-F-]{36}/artifacts/[0-9a-fA-F-]{36}$')
);

CREATE INDEX IF NOT EXISTS task_artifacts_owner_task
  ON task_artifacts (user_id, task_id, created_at DESC)
  WHERE status = 'READY';
CREATE INDEX IF NOT EXISTS task_artifacts_delete_recovery
  ON task_artifacts (created_at)
  WHERE status = 'DELETING';
