# Local Setup

## Requirements

- Node.js 22 or newer and npm 10 or newer for the backend.
- Docker Compose for PostgreSQL 17 and Redis 7.
- An initial Android chat client exists under `android/` but is not compiled or device-verified. Android Studio, Java/JDK, Gradle, and an Android SDK are required for that milestone.

## Start dependencies

From the repository root:

```bash
docker compose -f infrastructure/compose.yaml up -d
docker compose -f infrastructure/compose.yaml ps
```

The Compose file binds database ports to `127.0.0.1` for local development. The default PostgreSQL password is a development-only value. Do not reuse it outside a local machine.

## Configure and migrate

```bash
cd backend
cp .env.example .env
npm ci
npm run migrate
```

The sample `.env` connects to the local Compose database and Redis. Keep populated `.env` files out of Git. For a non-default database password, update both the Compose environment (`POSTGRES_PASSWORD`) and `DATABASE_URL` consistently. The migration runner applies ordered migrations through `010_task_artifacts.sql`. Migrations `004`–`006` add durable Agent Engine checkpoints, separate audited tool grants, and per-user/per-tool invocation counters. Migration `006` stores one counter row per user/tool and atomically reserves calls against minute and UTC-day limits; these count calls, not monetary spend. Migration `007` stores owner-scoped immutable workflow definitions. Migration `008` adds durable cross-capability workflow run/step checkpoints, a workflow queue outbox, leases, output bounds, approval decisions, and cancellation state. Migration `009` adds a content-free, owner-attributed provider usage/cost ledger with request-ID deduplication. `AI_MODEL_PRICING_JSON` optionally configures exact provider/model token rates in integer micro-USD per million tokens; `TAVILY_ESTIMATED_COST_MICRO_USD_PER_CALL` optionally sets a plan-specific search request estimate. Do not guess rates: missing rates are reported as unpriced. These values are estimates, not invoices or spend limits. Migration `010` stores owner-scoped artifact metadata and object keys only; task result bytes stay outside PostgreSQL JSONB. Migrations `004`–`010` have not been applied to a live database in this environment.

## Bootstrap the first administrator

Set these values in `backend/.env` before running the command:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=admin@example.test
BOOTSTRAP_ADMIN_PASSWORD=use-a-unique-secret-of-at-least-14-characters
```

Then run `npm run admin:bootstrap` once. Bootstrap deliberately refuses to create a second administrator. Sign in through `POST /v1/auth/sessions`. An administrator can create user accounts and manage explicit capability/tool grants through the admin endpoints in [API.md](API.md).

Tool-backed capabilities require both grants. For Web Research, grant `WEB_RESEARCH` and then `web.search`; for File Analysis, grant `FILE_ANALYSIS` and then `file.read_text`. For example, after creating a user, send authenticated admin requests to `PUT /v1/admin/users/{userId}/capabilities/WEB_RESEARCH` and `PUT /v1/admin/users/{userId}/tools/web.search`, each with `{ "enabled": true }`. Existing capability grants are not silently upgraded by migration `005`; select users explicitly. Once migration `006` is applied, each user/tool pair is subject to the defaults documented in [API.md](API.md); the limits count calls, not currency or provider tokens.

A grant does not make an engine available. AI capabilities require the server-side gateway configuration below; other capabilities remain unavailable until their real drivers exist.

## Optional real AI gateway (Chat, Writing and Model Analysis)

The backend supports explicit per-capability profiles for OpenAI-compatible endpoints, Anthropic Claude's native Messages/Models API, and Google's Gemini generateContent/Models API. Profiles and credentials stay on the server; Android never receives provider credentials. The OpenAI-compatible protocol remains the default when `AI_GATEWAY_<PROFILE>_PROTOCOL` is omitted.

The existing single-profile configuration remains supported:

```dotenv
AI_GATEWAY_BASE_URL=https://your-private-gateway.example/v1
AI_GATEWAY_MODEL=the-exact-model-id-returned-by-the-gateway
AI_GATEWAY_API_KEY=your-secret-from-local-secret-management
AI_GATEWAY_TIMEOUT_MS=30000
```

To configure separate local and enterprise profiles, list both and explicitly route each capability:

```dotenv
AI_GATEWAY_PROVIDERS=local,cloud
AI_GATEWAY_LOCAL_BASE_URL=http://ollama:11434/v1
AI_GATEWAY_LOCAL_MODEL=qwen2.5:7b
AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP=true
AI_GATEWAY_CLOUD_BASE_URL=https://your-enterprise-gateway.example/v1
AI_GATEWAY_CLOUD_MODEL=approved-enterprise-model
AI_GATEWAY_CLOUD_API_KEY=inject-through-a-secret-manager
AI_CHAT_PROVIDER=local
AI_WRITING_PROVIDER=local
AI_MODEL_ANALYSIS_PROVIDER=cloud
```

To route separate native Anthropic and Gemini providers, use their protocol names and inject each key from a server-side secret manager. Their public base URLs are supplied automatically; optional `AI_GATEWAY_<PROFILE>_BASE_URL` overrides must be reviewed and use HTTPS:

```dotenv
AI_GATEWAY_PROVIDERS=claude,gemini
AI_GATEWAY_CLAUDE_PROTOCOL=anthropic
AI_GATEWAY_CLAUDE_MODEL=<model-id-enabled-for-your-account>
AI_GATEWAY_CLAUDE_API_KEY=<inject-through-a-secret-manager>
AI_GATEWAY_GEMINI_PROTOCOL=gemini
AI_GATEWAY_GEMINI_MODEL=<model-id-enabled-for-your-project>
AI_GATEWAY_GEMINI_API_KEY=<inject-through-a-secret-manager>
AI_CHAT_PROVIDER=claude
AI_MODEL_ANALYSIS_PROVIDER=gemini
```

Anthropic credentials use `x-api-key` and the required version header; Gemini credentials use `x-goog-api-key` rather than a URL query parameter. See the [Anthropic Messages API](https://docs.anthropic.com/en/api/messages), [Anthropic Models API](https://docs.anthropic.com/en/api/models), [Gemini generateContent API](https://ai.google.dev/api/generate-content), [Gemini models.list API](https://ai.google.dev/api/rest/v1beta/models/list), and [Gemini API-key guidance](https://ai.google.dev/gemini-api/docs/api-key). These integrations have contract tests with fetch doubles only; no live account or inference request has been verified. Web Research uses native provider function-calling to request exactly one `web_search` call; adapters only translate requests/results, and the driver maps only that declared name to the registered `web.search` Tool Manager operation. The Tool Manager independently rechecks the user's capability and tool grant and applies its input/output bounds, quota, timeout, and audit rules. Unknown, missing, or additional calls fail closed. Other drivers do not expose model-directed tools; there is no general tool execution. See [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling), [Anthropic tool use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview), and [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling).

Remote endpoints must use HTTPS. HTTP requires loopback or an explicit `<PROFILE>_ALLOW_INSECURE_HTTP=true` opt-in and should only be used on a trusted, isolated private container network. Do not use that option for public endpoints. There is deliberately no silent failover between model providers; choose each capability's provider explicitly so sensitive input cannot unexpectedly cross a privacy boundary. Each adapter checks the provider's native model inventory with a 2-second timeout, rejects redirects, and bounds inventory JSON to 1 MiB. If a native list is paginated and omits the selected ID, a bounded exact-model lookup (up to one additional second) confirms that ID before readiness. It then calls the configured protocol's real generation endpoint and returns request/model plus SHA-256 input/output provenance. Generation responses are capped at 4 MiB. No model ID is accepted from an API client. Keys are never included in results or Android configuration. After configuring a profile, administrators can inspect real inventories through `GET /v1/admin/ai/models`; signed-in users can view only routed model names through `GET /v1/ai/models`. These endpoints never expose provider URLs or keys. Routing remains environment-controlled, and model inventory discovery does not replace `GET /v1/agent/capabilities` readiness. Unit tests use fetch doubles; they do not verify a live model server.

### Optional model-backed task planner

If `AI_PLANNER_PROVIDER` is unset, the backend uses an offline deterministic planner that creates one real capability-driver node; it does not invent results. If set, it must name a configured profile. The user's task text (bounded to 8,000 characters) and attachment count are sent to that profile during planning, so set this only after approving that data route. The response is strictly validated and limited to one-to-six `RUN_CAPABILITY` nodes of the already authorized capability; File Analysis and Web Research are one-node plans. The planner cannot call tools or escalate privileges. Planner profile readiness is part of task preflight; an unavailable selected profile fails closed. Use the model provider routing above and never put its key in an Android client.

### Optional Web Research provider

The Web Research driver uses the allowlisted `web.search` Tool Manager operation for Tavily retrieval and the configured `AI_RESEARCH_PROVIDER` model profile for synthesis. Configure `TAVILY_API_KEY` and set `AI_RESEARCH_PROVIDER` to one of the configured model profile names. This sends the search query and returned source content to Tavily; do not enable it for data that must remain on-premise. It is not configured by default. Each tool call re-checks the user's `WEB_RESEARCH` grant, uses a bounded timeout, and records tool status without logging the query. Results require HTTPS source URLs and captured page content; missing source material fails closed. The provider is tested with HTTP test doubles only, not a live Tavily account.

### Optional external task-artifact storage

Large task and graph-node results are externalized only when every server-side S3-compatible setting is present. Configure `ARTIFACT_S3_BUCKET`, `ARTIFACT_S3_REGION`, `ARTIFACT_S3_ACCESS_KEY_ID`, and `ARTIFACT_S3_SECRET_ACCESS_KEY` through your secret manager. Optional `ARTIFACT_S3_ENDPOINT` must be HTTPS; `ARTIFACT_S3_FORCE_PATH_STYLE` accepts only `true` or `false`. AWS endpoints or a private S3-compatible service can be used. The adapter performs a bucket readiness check, verifies upload length/SHA-256, requests SSE-S3 (`AES256`), and uses random artifact IDs under task-scoped keys. PostgreSQL stores owner-scoped metadata and object keys, not result bytes.

Apply migration `010_task_artifacts.sql` before deploying the API/worker. If the store is unset, small results can complete inline, but any result over 64 KiB fails safely; it is never written as oversized JSONB. The owner can retrieve a result via `GET /v1/artifacts/{artifactId}/content` and delete it via `DELETE /v1/artifacts/{artifactId}`. API and worker must receive the same credentials and bucket configuration. Storage policy, versioning, retention, backups, and encryption-key lifecycle are operator responsibilities; no live S3-compatible service has been verified in this environment.

### Optional encrypted TXT/CSV File Analysis

The backend currently accepts only UTF-8 `.txt`, `.md`, `.log`, and `.csv` files up to 32 KiB; PDF, Office documents, archives, images, audio, and video remain unsupported. Set a stable 32-byte encryption key in your secret manager/private server environment and explicitly route this sensitive capability, even when you have only one model profile:

```dotenv
FILE_ENCRYPTION_KEY=<output-of-openssl-rand-hex-32>
AI_FILE_ANALYSIS_PROVIDER=local
```

Generate a key with `openssl rand -hex 32` outside the repository. Keep a secure backup and use the same key in API and worker. Losing/changing it prevents existing files from being decrypted; automated key rotation is not implemented. Upload requires the authenticated user's `FILE_ANALYSIS` grant; an owner can still delete a file after that grant is revoked. Upload via `POST /v1/files` as base64 JSON; use the returned `fileId` in an assistant request or `FILE_ANALYSIS` task. File content is decrypted only by the owner-scoped `file.read_text` Tool Manager operation during an authorized task, then sent to the explicitly selected model—use an approved private model route if content must remain on-premise. Each tool call re-checks the user's `FILE_ANALYSIS` grant, audits status without content, and has a bounded deadline. PostgreSQL stores AES-GCM ciphertext with per-file data keys; file upload/analysis is unavailable unless storage key and model route are both ready.

## Private server deployment (Docker Compose)

A production-oriented private stack definition is provided in `infrastructure/compose.private.yaml`. It builds the API and worker images, applies SQL migrations, and runs PostgreSQL and password-protected Redis on a private data network. Database/cache ports are not published. The API binds to loopback by default so a host-managed TLS reverse proxy can front it.

```bash
cp infrastructure/private.env.example infrastructure/private.env
# Replace both placeholders with different URL-safe secrets, for example:
openssl rand -hex 32
openssl rand -hex 32
# Edit infrastructure/private.env, then:
docker compose --env-file infrastructure/private.env -f infrastructure/compose.private.yaml --profile local-ai up -d --build
# Pull the configured local model explicitly; model weights are not bundled:
docker compose --env-file infrastructure/private.env -f infrastructure/compose.private.yaml --profile local-ai exec ollama ollama pull qwen2.5:7b
# Create the first administrator once; remove its password from the env file afterward:
docker compose --env-file infrastructure/private.env -f infrastructure/compose.private.yaml --profile bootstrap run --rm admin-bootstrap
```

The `local-ai` profile starts an internal Ollama service without publishing its port. The example runs inference on CPU unless a reviewed GPU-specific Compose override and compatible host runtime are supplied; size model choice to available hardware. No model weights are committed. Pin the Ollama image to a reviewed version or digest before production, configure TLS at the reverse proxy, firewall the host, protect the private env file, and back up the database/model volumes. The compose configuration is a deployment starting point, not a live-tested production certification; Docker was unavailable in the code environment.

After signing in as an administrator, grant only intended capabilities through `PUT /v1/admin/users/{user.id}/capabilities/{capability}` with `{ "enabled": true }`. Direct `CHAT` calls the configured model synchronously; `WRITING` is asynchronous text-only output; `MODEL_ANALYSIS` is asynchronous model-backed analysis; and `FILE_ANALYSIS` accepts only the encrypted, limited UTF-8 text/CSV files described above. File Analysis requires the `FILE_ANALYSIS` capability grant plus `file.read_text` tool grant, an encryption key, and an explicit model profile.

## Run services

In separate terminals, from `backend/`:

```bash
npm run start:api
npm run start:worker
```

- Liveness: `GET http://localhost:8080/health`
- Readiness (PostgreSQL + Redis + task-event listener): `GET http://localhost:8080/ready`

`registeredDrivers` counts registered capability adapters, not model readiness. Model readiness checks the exact selected endpoint and model ID separately; configure `CHAT` grants only for intended accounts.

## Verify

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm audit
```

The automated suite covers routing, request preflight, worker re-checks, state transitions, evidence rules, and HTTP status contracts. It does not replace a live database/Redis integration test. Shut down local dependencies with `docker compose -f infrastructure/compose.yaml down`; add `-v` only if you intentionally want to delete local database/cache data.
