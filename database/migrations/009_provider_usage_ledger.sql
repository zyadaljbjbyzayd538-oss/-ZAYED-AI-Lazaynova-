CREATE TABLE IF NOT EXISTS provider_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('CHAT', 'TASK', 'WORKFLOW_RUN')),
  resource_id uuid,
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  provider_request_id text,
  usage_status text NOT NULL CHECK (usage_status IN ('REPORTED', 'UNREPORTED', 'REQUEST_ONLY')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_microusd bigint CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  pricing_version char(64) NOT NULL CHECK (pricing_version ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_request_id),
  CHECK (
    (usage_status = 'REPORTED' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
    OR (usage_status IN ('UNREPORTED', 'REQUEST_ONLY') AND input_tokens IS NULL AND output_tokens IS NULL)
  ),
  CHECK (cost_microusd IS NULL OR usage_status IN ('REPORTED', 'REQUEST_ONLY'))
);

CREATE INDEX IF NOT EXISTS provider_usage_owner_time
  ON provider_usage_ledger (user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS provider_usage_resource
  ON provider_usage_ledger (resource_type, resource_id)
  WHERE resource_id IS NOT NULL;
