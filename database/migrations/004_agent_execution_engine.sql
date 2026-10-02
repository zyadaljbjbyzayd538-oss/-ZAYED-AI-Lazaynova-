ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS execution_lease_owner uuid,
  ADD COLUMN IF NOT EXISTS execution_lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS tasks_execution_lease_idx
  ON tasks (execution_lease_expires_at)
  WHERE status IN ('PLANNING', 'RUNNING', 'WAITING', 'VERIFYING');

CREATE TABLE IF NOT EXISTS task_execution_plans (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  plan jsonb NOT NULL,
  plan_hash char(64) NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_graph_nodes (
  task_id uuid NOT NULL REFERENCES task_execution_plans(task_id) ON DELETE CASCADE,
  node_id varchar(48) NOT NULL,
  capability text NOT NULL CHECK (capability IN ('WRITING', 'WEB_RESEARCH', 'FILE_ANALYSIS', 'CODING', 'PROJECT', 'MODEL_ANALYSIS')),
  operation text NOT NULL CHECK (operation = 'RUN_CAPABILITY'),
  goal varchar(500) NOT NULL DEFAULT '',
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(depends_on) = 'array'),
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  result jsonb,
  last_error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, node_id)
);

CREATE INDEX IF NOT EXISTS task_graph_nodes_status_idx
  ON task_graph_nodes (task_id, status);

CREATE TABLE IF NOT EXISTS task_evidence_chain (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  kind varchar(64) NOT NULL,
  evidence jsonb NOT NULL,
  previous_hash char(64),
  item_hash char(64),
  chain_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, sequence),
  CHECK (previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$'),
  CHECK (item_hash IS NULL OR item_hash ~ '^[a-f0-9]{64}$'),
  CHECK (chain_hash IS NULL OR chain_hash ~ '^[a-f0-9]{64}$')
);
