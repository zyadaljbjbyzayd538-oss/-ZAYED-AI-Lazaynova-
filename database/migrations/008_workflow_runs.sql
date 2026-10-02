CREATE TABLE IF NOT EXISTS workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL,
  definition_version integer NOT NULL CHECK (definition_version > 0),
  workflow_name text NOT NULL CHECK (length(workflow_name) BETWEEN 1 AND 64),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object' AND jsonb_typeof(input -> 'attachments') = 'array'),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED')),
  result jsonb,
  evidence jsonb,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  cancel_requested_at timestamptz,
  lease_owner uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, definition_version)
    REFERENCES workflow_definition_versions(workflow_id, version) ON DELETE RESTRICT,
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (result IS NULL OR octet_length(result::text) <= 1048576),
  CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 4194304))
);
CREATE INDEX IF NOT EXISTS workflow_runs_owner_created ON workflow_runs(owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow_created ON workflow_runs(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_recovery ON workflow_runs(status, lease_expires_at) WHERE status IN ('QUEUED', 'RUNNING');

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id text NOT NULL CHECK (step_id ~ '^[a-z][a-z0-9-]{0,31}$'),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 11),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  approval_required boolean NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'WAITING_APPROVAL', 'APPROVED', 'RUNNING', 'COMPLETED', 'FAILED', 'REJECTED', 'BLOCKED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  result jsonb,
  evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 1048576)),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_run_id, step_id),
  UNIQUE (workflow_run_id, ordinal),
  CHECK (result IS NULL OR octet_length(result::text) <= 1048576),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (status <> 'WAITING_APPROVAL' OR approval_required),
  CHECK (status NOT IN ('APPROVED', 'RUNNING', 'COMPLETED', 'FAILED', 'REJECTED') OR NOT approval_required OR approved_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS workflow_run_steps_status ON workflow_run_steps(workflow_run_id, ordinal, status);

CREATE TABLE IF NOT EXISTS workflow_run_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHING', 'PUBLISHED')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_run_outbox_dispatch ON workflow_run_outbox(status, available_at, locked_until, created_at);
