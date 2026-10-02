# Backend API Contract (current implemented subset)

Base path: `/v1`. All HTTP endpoints except session creation and health/readiness require `Authorization: Bearer <session-token>`. JSON request bodies are strictly validated. The WebSocket task stream uses a short-lived one-time ticket instead of putting the long-lived session token in a URL. Error shape:

```json
{"error":{"code":"CAPABILITY_UNAVAILABLE","message":"No ready execution engine is configured for this capability."}}
```

## Sessions and identity

### `POST /v1/auth/sessions`

```json
{"email":"user@example.test","password":"..."}
```

Returns `201` with `{ "token": "...", "expiresAt": "...", "user": { "id": "...", "email": "...", "role": "ADMIN" } }`. The bearer token is returned once; only its SHA-256 digest is stored server-side. Invalid credentials return `401 INVALID_CREDENTIALS`.

### `DELETE /v1/auth/session`

Revokes the current session. Returns `204`.

### `POST /v1/auth/websocket-tickets`

Requires the regular bearer session. Returns `201` with a random 256-bit `ticket` and `expiresAt`. Tickets expire after 60 seconds, are stored only as SHA-256 hashes, and can be consumed once. The database consume operation is atomic and audited. Exchange the ticket immediately when opening a task stream; a ticket is consumed even if the requested task is not owned by that identity.

## AI model catalog (read-only)

Model endpoints, credentials, configured model IDs, provider protocol, and per-capability routing are server-side settings. Supported protocols are OpenAI-compatible `/models`, `/chat/completions`, and SSE Chat completions; Anthropic `/v1/models`, `/v1/messages`, and Messages SSE; and Gemini `models.list`, `generateContent`, and `streamGenerateContent?alt=sse`. There is no silent failover and clients cannot choose arbitrary model IDs for task execution. Chat, Writing, and other non-research drivers use text generation only. Web Research exposes one fixed provider-native `web_search` function and accepts exactly one call per task; adapters only translate provider protocol and never execute tools. The driver validates the function name, then invokes only the registered `web.search` through Tool Manager. That manager rechecks the owner's capability and separate tool grant, validates query/result bounds, reserves per-user quotas, enforces timeout, and audits status. Additional or unknown model-requested functions fail closed; no model can supply a server URL or choose another tool.

- `GET /v1/ai/models` requires authentication and reports only the selected model for each configured capability route, with an `available` flag based on the actual provider inventory. It does not reveal provider profile aliases, endpoint URLs, or credentials.
- `GET /v1/admin/ai/models` requires the ADMIN role, is rate-limited, and checks each configured provider's native model inventory API (`/models`). It reports the server-side profile alias, configured model ID, assigned routes, sanitized model IDs (at most 100; the configured model is retained at the cap), status (`AVAILABLE`, `CONFIGURED_MODEL_MISSING`, or `UNREACHABLE`), and check time. Provider URLs and API keys are never returned. Upstream calls time out after two seconds, reject redirects, cap the response body at 1 MiB, sanitize model IDs, and return a stable generic error on failure. Results are cached for 10 seconds; this is a discovery/health view, not a guarantee that a later generation request will succeed.
- Provider routing remains operator-controlled through `AI_GATEWAY_PROVIDERS`, profile environment settings, and `AI_*_PROVIDER` variables; there is no runtime route-edit endpoint. `GET /v1/agent/capabilities` remains the authoritative end-to-end readiness view because Research also needs its search provider and File Analysis needs encrypted storage, authorization, and a private model route.

## Per-user provider usage and estimated cost

- `GET /v1/usage` requires a bearer session and returns the authenticated user's all-time provider request, token, and estimated-cost aggregates. The owner ID is derived from the session; callers cannot query another user's summary.
- `GET /v1/admin/users/{userId}/usage` requires the ADMIN role, validates the UUID, and returns the same summary for the specified account.
- Response fields are decimal strings to avoid integer precision loss: `requestCount`, `reportedUsageCount`, `unreportedUsageCount`, `nonTokenRequestCount`, `pricedRequestCount`, `unpricedRequestCount`, `inputTokens`, `outputTokens`, and `costMicrousd`, plus `currency: "USD"` and distinct `pricingVersions`. Divide `costMicrousd` by 1,000,000 to display dollars. These are estimates based on operator-maintained rates, not a provider invoice or live billing balance.
- Model calls are priced only when exact `provider/model` input/output rates are configured in `AI_MODEL_PRICING_JSON`, using integer micro-USD per million tokens. Provider token counts are stored when supplied; missing usage and unknown prices remain visibly unreported/unpriced rather than fabricated. Cost uses the rates active at record time; historical summaries retain each pricing version hash.
- Accepted Tavily search API responses are recorded before source parsing, attributed to the trusted task/workflow owner, and deduplicated by provider request ID. `TAVILY_ESTIMATED_COST_MICRO_USD_PER_CALL` is an optional plan-specific operator estimate for the configured advanced-search request. Leave it unset if the actual plan tariff is unknown: requests remain counted as non-token and unpriced. This estimate is not authoritative provider billing and does not yet account for failed/non-accepted network attempts.
- The ledger stores provider/model/request identifiers, trusted owner/resource IDs, token counts/status, cost, and pricing version; it never stores prompts, completions, or search queries. Migration `009_provider_usage_ledger.sql` must be applied before live use. Durable recording is fail-closed on successful model completions and accepted Tavily responses; if accounting storage fails, the operation does not report success.

### `POST /v1/lazaynova/chat/stream`

Requires an authenticated bearer session and the user's `CHAT` capability grant. Request body is strictly `{ "prompt": "..." }` (1–20,000 characters) or `{ "messages": [{"role":"user|assistant","content":"..."}] }` for a bounded conversation (up to 40 alternating messages and 40,000 total characters, starting and ending with `user`); caller-supplied model IDs, `isOwner` flags, system messages, and other fields are rejected. The provider and model are selected only by the operator's server-side Chat route, and the call uses the same permission/readiness checks and real Chat driver as the existing assistant API.

The response is Server-Sent Events with `text/event-stream` content type. It emits `event: start`, one or more `event: delta` frames containing text deltas emitted by the configured provider, an `event: result` frame containing safe provider/model/request provenance and optional token usage, then `event: done` with `[DONE]`. The backend uses the provider's native streaming protocol; it does not split a completed response or synthesize token progress. A valid completion marker is required from the provider before the result/done events are sent; premature EOF is treated as failure. Application failures after the stream starts are returned as a safe `event: error` (and are never followed by `done`). Client disconnects propagate an abort signal to the provider adapter and cancel upstream stream consumption. No dedicated second queue/worker is created; durable non-chat tasks continue through the existing PostgreSQL outbox and BullMQ worker. Use the regular `/v1/auth/sessions` bearer token—there is no embedded app token or `X-Lazaynova-App-Token` authentication mode.

## Capability status

### `GET /v1/agent/capabilities`

Returns the caller's capability grant/readiness and `toolGrants` for the tool(s) mapped to that capability. Each tool grant includes a `usage` snapshot with `callsPerMinute`, `usedThisMinute`, `minuteResetAt`, `callsPerDay`, `usedToday`, `utcDayResetAt`, and `serverTime`. The usage snapshot is authenticated, user-scoped, read-only, and served with `Cache-Control: no-store`; counters are read from the current server-side minute and UTC-day buckets. Clients may estimate remaining calls as `max(limit - used, 0)`, and must label this estimate as snapshot-based because other sessions can consume calls later. It is separate from `/v1/usage`, which reports provider tokens and costs. For task capabilities, `ready` includes the registered driver and configured task planner profile when `AI_PLANNER_PROVIDER` is set. Tool-backed tasks also require the corresponding separate tool grant; `granted: true` and `ready: true` do not imply the tool grant exists.

### `GET /v1/agent/tools`

Returns only tools that are configured and for which the caller has both the matching capability grant and the distinct tool grant. The response is `{ "tools": [{ "name": "web.search", "description": "..." }] }`; a missing Tool Manager returns `501 TOOL_MANAGER_UNAVAILABLE`.

## Owner-scoped workflows: definitions and durable runs

Workflow definitions are private, versioned DAG specifications; workflow runs execute those stored steps using the existing capability drivers. All endpoints require an authenticated session and scope reads, approvals, and cancellation to the authenticated owner. Definitions may contain 1–12 steps using only `WRITING`, `WEB_RESEARCH`, `FILE_ANALYSIS`, or `MODEL_ANALYSIS`, with bounded prompts, explicit dependencies, and `approvalRequired`. No shell commands, arbitrary tools, file references, model IDs, or provider credentials are accepted.

Definition prompts are stored as JSONB and are not additionally encrypted; do not place secrets in them. Run creation snapshots the selected immutable definition version, while the run input and step outputs are stored in PostgreSQL. Audit events contain IDs, step counts, statuses, and safe error codes—not prompts, queries, or file contents. Run submission checks every distinct capability grant, associated independent tool grant, registered driver readiness, and any owner-scoped file before it commits a run and outbox entry. The worker repeats capability/tool-grant/readiness checks before each step.

- `POST /v1/workflows` creates version 1. Body: `{ "name": "weekly-research", "steps": [{ "id": "research", "capability": "WEB_RESEARCH", "prompt": "Find primary sources.", "dependsOn": [], "approvalRequired": true }] }`. Names are owner-unique lowercase slugs. Returns `201` with the created definition and version.
- `GET /v1/workflows` lists only the caller's definitions and latest version numbers.
- `GET /v1/workflows/{workflowId}` returns the caller's latest version; `GET /v1/workflows/{workflowId}/versions/{version}` reads a specific historical version.
- `POST /v1/workflows/{workflowId}/versions` appends a new immutable API version. Body: `{ "steps": [...] }`; version numbers are assigned transactionally and cannot be caller-selected.
- `POST /v1/workflows/{workflowId}/runs` starts a run from the latest or a requested immutable version. Body: `{ "prompt": "Research this topic.", "version": 2, "attachments": [] }`; `version` and `attachments` are optional. Returns `202` with a run ID and initial step states after durable run/outbox commit.
- `GET /v1/workflow-runs/{runId}` returns the owner-scoped status, completed step outputs, result and evidence count. It does not return the original prompt or stored step prompts.
- `GET /v1/workflow-runs/{runId}/stream` returns an authenticated, owner-scoped SSE stream with status-only progress snapshots (step IDs/capabilities/status/attempt counts and safe error codes). The server re-reads durable workflow state once per second, emits only changed snapshots plus keep-alives, and closes on a terminal run; it never includes prompts or step output content. The connection is capped at 15 minutes and the client can reconnect. This is database-backed polling over SSE, not PostgreSQL push notification; progress/recovery still depends on the workflow status repository.
- `POST /v1/workflow-runs/{runId}/steps/{stepId}/approval` body: `{ "decision": "APPROVE" }` or `{ "decision": "REJECT" }`. Only the run owner can decide a step currently waiting for approval. Approval durably queues resumption; rejection fails the run and blocks remaining steps.
- `POST /v1/workflow-runs/{runId}/cancel` cancels an active/queued/waiting run. An active model/tool operation receives cooperative abort through its lease heartbeat.

Runs execute topological layers with at most four independent steps concurrently and pass dependency outputs as untrusted context. If an owner-approval step is ready, it pauses the whole ready layer before any sibling starts; after approval, independent siblings can run concurrently and dependents start only after their prerequisites are durably checkpointed. Every step rechecks its capability grant, separate grants for any required fixed Tool Manager operation, driver readiness, and owner-scoped file access; outputs are size-bounded and verified against that capability's evidence contract. Transient provider failures receive at most three attempts, each completed step is checkpointed, and the final evidence is SHA-256 chained. Workflow progress is available by polling or the status-only SSE endpoint above. This parallel execution and stream implementation has unit/HTTP test coverage only; PostgreSQL, queue races, cancellation under concurrency, and live recovery still require integration tests.

Invalid definitions return `400 INVALID_REQUEST`; invalid run input returns `400 INVALID_WORKFLOW_RUN`; missing grants return `403`; unavailable drivers or storage return stable `501` codes; unknown/non-owned resources return `404`; non-pending approvals or terminal-run cancellation return `409`. Migrations `007_workflow_definitions.sql` and `008_workflow_runs.sql`, PostgreSQL lease recovery, and live Redis/BullMQ behavior still require provisioned integration verification.

## Owner-scoped encrypted text files

### `POST /v1/files`

Requires an authenticated session and the user's `FILE_ANALYSIS` capability grant. Uploads are base64 JSON so the request has a strict small payload limit:

```json
{"filename":"report.txt","contentType":"text/plain","contentBase64":"UXVhcnRlcmx5IHJldmVudWUu"}
```

Only UTF-8 `.txt`, `.md`, `.log` (`text/plain`) and `.csv` (`text/csv`) are accepted, up to 32 KiB decoded. The API validates the extension/media type, canonical base64, UTF-8, control characters, and non-empty text. The response is `201` with `{fileId, filename, contentType, byteLength, sha256, createdAt}`; file bytes are never returned. Upload and delete metadata are audited without logging file contents or filenames.

The service is unavailable until the operator supplies a stable, server-only 32-byte hex `FILE_ENCRYPTION_KEY`. Each file gets a random data-encryption key; AES-256-GCM encrypts the content and wraps that key. PostgreSQL contains ciphertext, nonce/tag and wrapped key, not clear text. Changing or losing the operator key makes existing files unreadable; key backup/rotation must be managed securely.

### `GET /v1/files/{fileId}` and `DELETE /v1/files/{fileId}`

Both require authentication and enforce owner scoping; unknown and other-user IDs return `404 FILE_NOT_FOUND`. `GET` returns metadata only. `DELETE` hard-deletes the database record and returns `204`; files have no automatic expiry yet, and deletion does not guarantee physical erasure from backups or database storage media.

### File-analysis privacy route

A file is sent to a model only as part of an authorized `FILE_ANALYSIS` task. Set `AI_FILE_ANALYSIS_PROVIDER` explicitly to the approved model profile, even if only one profile exists; there is no implicit model route for file content. The file capability remains unavailable unless encrypted file storage and the selected model are both ready. PDF, Office, archive, image, audio, and video parsing are not supported. `CHAT`, `WRITING`, `WEB_RESEARCH`, and `MODEL_ANALYSIS` continue to reject attachments.

## Isolated code execution status

`CodeExecutionSandbox` has a Docker/gVisor (`runsc`) adapter that requires a digest-pinned local image, a pre-provisioned workspace directory under `<workspaceRoot>/<userId UUID>/<projectId UUID>/<workspaceArchiveKey UUID>`, disabled networking, a read-only container root, dropped capabilities, non-root container UID/GID, CPU/memory/time/output bounds, and cleanup confirmation. It rejects `ALLOWLIST` network requests rather than relaxing policy. The adapter is not yet wired to a workspace archive manager or Coding driver, no sandbox image/runtime is provisioned, and no live Docker execution has been tested; therefore Coding remains unavailable. Do not configure it as production-ready based on its injected-runner unit tests. No source URL is fetched by the sandbox, so the sandbox has no SSRF-capable egress path. Tavily remains a separate outbound research provider with its existing fixed HTTPS endpoint/redirect policy.

## Assistant request (synchronous preflight + direct chat/task split)

### `POST /v1/assistant/requests`

```json
{"input":"ابحث عن ...","attachments":[]}
```

`input` must be 1–20,000 characters. `attachments` is an optional list of UUID references; when present, assistant requests route to `FILE_ANALYSIS` and require exactly one existing file ID created by `POST /v1/files`. Multiple-file analysis and attachments for other task capabilities are rejected.

- Direct-chat intents such as greetings and simple informational questions bypass PostgreSQL tasks and BullMQ. If an authorized, ready `CHAT` driver exists, the API returns `200` with real model output, request/model provenance, and gateway execution evidence. Configure the legacy `AI_GATEWAY_BASE_URL`/`AI_GATEWAY_MODEL` pair or named profiles using `AI_GATEWAY_PROVIDERS`, `AI_GATEWAY_<PROFILE>_BASE_URL`, and `AI_GATEWAY_<PROFILE>_MODEL`, then route capabilities with `AI_CHAT_PROVIDER`, `AI_WRITING_PROVIDER`, `AI_MODEL_ANALYSIS_PROVIDER`, `AI_RESEARCH_PROVIDER`, and `AI_FILE_ANALYSIS_PROVIDER`. The Writing driver handles plain text. Web Research requires `TAVILY_API_KEY` and its model route; the query and retrieved page content go to Tavily, so do not enable it for data that must remain fully on-premise. File Analysis is limited to encrypted TXT/Markdown/log/CSV uploads and requires `FILE_ENCRYPTION_KEY` plus an explicit model route. Chat, Writing, Web Research, and Model Analysis reject attachments. There is no implicit model failover; direct Chat gateway failures return safe `503 AI_GATEWAY_REQUEST_FAILED`.
- Routed tasks (`WRITING`, `WEB_RESEARCH`, `FILE_ANALYSIS`, `CODING`, `PROJECT`, `MODEL_ANALYSIS`) check the caller's explicit capability grant, then the registered driver and optional planner readiness. `WEB_RESEARCH` and `FILE_ANALYSIS` additionally require their distinct `web.search` / `file.read_text` tool grant before task creation. Missing capability returns `403 CAPABILITY_PERMISSION_REQUIRED`; missing tool grant returns `403 TOOL_PERMISSION_DENIED`; missing/unready driver or planner returns `501 CAPABILITY_UNAVAILABLE`. None of these preflight failures creates a task or queue entry.

### `POST /v1/tasks/execute` (explicit capability contract)

```json
{"capability":"FILE_ANALYSIS","prompt":"Summarize this report","attachments":["cdb77fc1-3fc2-4776-a28d-d93098559f67"]}
```

Accepts `WRITING`, `WEB_RESEARCH`, `FILE_ANALYSIS`, `CODING`, `PROJECT`, or `MODEL_ANALYSIS`; `CHAT` is rejected because it must not enter the queue. Optional `attachments` is accepted only for `FILE_ANALYSIS` and must contain exactly one owned uploaded file UUID. The server derives `userId` from the authenticated session (never from a caller-supplied `x-user-id`). It uses the same grant/readiness preflight and transactional PostgreSQL outbox path as inferred task requests. `params` is stored with the task input. `FILE_ANALYSIS` checks file ownership before acceptance and the worker decrypts, re-hashes, parses, and sends the text to its explicitly routed model. `MODEL_ANALYSIS` uses the configured server-side gateway and verifies model/request identity plus input/output hashes; it remains unavailable without a live matching model.
- If checks pass, PostgreSQL atomically stores the task, first step, audit record, and queue-outbox event; response is `202` with task ID and `QUEUED` status. The outbox dispatcher publishes to BullMQ with a stable job id.

## Tasks

### `GET /v1/tasks/{taskId}`

Returns a task only to its owner; unknown and other-user tasks both return `404 TASK_NOT_FOUND`. The task includes `id`, `userId`, type, status, priority, lifecycle timestamps, input, steps, logs, result, error, and verification. Once planned it also includes `executionPlan` and `graphNodes` (`id`, status and persisted attempt count); after verification it includes the `evidenceChainRoot`. A successful result preserves `output`, provenance, and the verification evidence record. Polling remains supported and is the recovery path after a disconnected stream.

When a successful result exceeds the 64 KiB inline JSONB threshold, `result.output` is an artifact reference (`{ "artifact": { "artifactId", "taskId", "kind", "filename", "contentType", "byteLength", "sha256", "createdAt", "downloadPath" } }`) rather than embedded result bytes. Large graph-node checkpoints use the same external store and are hydrated by the worker when resuming. The reference remains owner-scoped; bytes are not exposed by task polling. This requires S3-compatible storage configured on both API and worker plus migration `010_task_artifacts.sql`. Without storage, oversized results fail safely rather than falling back to JSONB.

### `GET /v1/artifacts/{artifactId}/content` and `DELETE /v1/artifacts/{artifactId}`

Both routes require a bearer session and use the authenticated owner ID; another user's artifact is indistinguishable from a missing artifact (`404 ARTIFACT_NOT_FOUND`). Content retrieval verifies the stored byte length and SHA-256 before returning JSON as a non-cacheable attachment. Deletion first marks metadata unavailable, removes the external object, then deletes metadata; interrupted deletion fails closed and may be retried. A missing object-store configuration returns `501 ARTIFACT_STORAGE_UNAVAILABLE`. These routes do not issue public or presigned URLs. External storage uses explicit server-side credentials, HTTPS-only custom endpoints, and requests SSE-S3 encryption.

### `POST /v1/tasks/{taskId}/cancel`

Requires the task owner's authenticated bearer session; the request has no body. The API transactionally changes an active task (`QUEUED`, `PLANNING`, `RUNNING`, `WAITING`, or `VERIFYING`) to `CANCELLED`, clears any worker lease, writes a content-free audit/task-log record, and publishes the status event. Returns `200` with `{ "taskId": "...", "status": "CANCELLED" }`. Repeating cancellation for an already-cancelled task returns the same response. Unknown and non-owned tasks both return `404 TASK_NOT_FOUND`; completed or failed tasks return `409 TASK_NOT_CANCELLABLE`.

The worker subscribes to PostgreSQL status notifications and aborts the task's `AbortSignal` so active model/search/tool adapters can stop cooperatively. A five-second lease-renewal check is the fallback if a notification is missed; queued BullMQ deliveries for cancelled tasks are ignored. This is cooperative cancellation, not process termination: any future adapter that does not honor `AbortSignal` must be isolated or bounded separately.

### `GET /v1/tasks/{taskId}/events` (WebSocket upgrade)

1. Use the authenticated `POST /v1/auth/websocket-tickets` endpoint to obtain a single-use ticket.
2. Open `wss://<api-host>/v1/tasks/{taskId}/events?ticket=<ticket>` promptly. TLS is required outside local development. The request URL is redacted from application request logs.
3. The ticket is atomically consumed, then the API verifies that the ticket identity owns the task. Invalid tickets return `401`; unknown and non-owned task IDs both return `404 TASK_NOT_FOUND`.
4. On connection, the server sends a `TASK_SNAPSHOT` with status and lifecycle timestamps (no task result), followed by `TASK_STATUS` messages containing status, change timestamp, and optional safe error code. The stream is read-only and closes after a terminal state.

Status notifications are emitted transactionally alongside PostgreSQL task changes and delivered through one `LISTEN/NOTIFY` connection per API process. Messages are filtered by both task ID and owner identity. Results/evidence remain available only from the owner-authenticated polling endpoint; the stream does not persist or replay messages, so clients must poll after reconnecting and request a new ticket. Live PostgreSQL integration and reconnect behavior require deployment-level verification.

Task statuses: `QUEUED`, `PLANNING`, `RUNNING`, `WAITING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`.

### Agent Engine and evidence chain

Plans are persisted before graph execution and are scoped to one already-authorized capability. The offline planner creates one node. Optional `AI_PLANNER_PROVIDER` receives task text (up to 8,000 characters) and attachment count; it may return one-to-six `RUN_CAPABILITY` nodes of that same capability. `WEB_RESEARCH` and `FILE_ANALYSIS` remain single-node plans. The only production tools are fixed `web.search` and owner-scoped `file.read_text`, called by their capability drivers; model plans cannot select arbitrary tools or cross capabilities. Every invocation re-checks both the owner's capability grant and separate per-tool grant, validates input/output, reserves a durable per-user/per-tool call quota atomically, has a bounded deadline, and writes content-free audit events. Defaults are 20 `web.search` calls/minute and 200/UTC day; 30 `file.read_text` calls/minute and 500/UTC day. Exceeding a limit raises the Tool Manager's coded `429 TOOL_BUDGET_EXHAUSTED` failure and audits the tool/window without input content. Since tools run inside durable asynchronous tasks rather than a direct tool HTTP route, the task is marked `FAILED` and task polling exposes that safe error code; task submission itself is not retroactively returned as HTTP 429. These limits count calls only, not provider tokens, prices, or monetary spend. Usage accounting is unit-tested with PostgreSQL query doubles, not a live database. Transient planner/driver upstream errors get up to three attempts; worker leases and completed-node checkpoints allow resume after an expired lease. These behaviors have unit tests but have not been tested against live PostgreSQL/Redis/BullMQ.

Verification evidence is SHA-256 hash-chained in order with a root marker, then persisted with the task and in the evidence-chain table. This detects ordinary item/link/root changes when revalidated; it is not a digital signature or protection against a privileged database operator rewriting the full chain.

### Evidence strictness on completion

- `WEB_RESEARCH`: a cited source with HTTP(S) URL/title/excerpt and a fetch record with fetched URLs, ISO timestamp, and SHA-256 hash of raw source material.
- `FILE_ANALYSIS`: a file ID, non-empty extractor version, positive parsed-page count, extracted excerpt, SHA-256 hash of the decrypted source file, and model/request identity plus input/output hashes.
- `CODING`: a safe workspace-relative artifact path and SHA-256 digest, successful sandbox run ID/exit code/stdout/test results, and a passing test report naming the command.
- `PROJECT`: a digested project manifest, artifact reference, 40- or 64-character workspace commit hash, and a passing validation command report.
- `MODEL_ANALYSIS`: provider/model/version/request identity plus SHA-256 digests of input and output.
- `WRITING`: a non-empty text result.

Missing or malformed evidence fails closed as `FAILED` with `error.code = VERIFICATION_EVIDENCE_REQUIRED`; evidence issues and verification time are stored on the task. These shape checks do not replace provenance authenticity: real drivers must tie evidence to authorized source data, sandbox artifacts, and actual command execution.

## Administration (ADMIN role)

### `POST /v1/admin/users`

Creates a normal user with a password of at least 14 characters. Example: `{ "email":"person@example.test", "password":"..." }`. Returns `201`.

### `PUT /v1/admin/users/{userId}/capabilities/{capability}`

Body: `{ "enabled": true }` to grant or `{ "enabled": false }` to revoke. Capability names are `CHAT`, `WRITING`, `WEB_RESEARCH`, `FILE_ANALYSIS`, `CODING`, `PROJECT`, and `MODEL_ANALYSIS`. Returns `204`.

### `GET /v1/admin/tools`

Lists only reviewed server-side tools with their required capability, durable call-volume budget, and whether the configured adapter is ready. The current catalog is `web.search` → `WEB_RESEARCH` (20 calls/minute, 200 calls per UTC day) and `file.read_text` → `FILE_ANALYSIS` (30 calls/minute, 500 calls per UTC day). These are the fixed code-defined per-user/per-tool invocation limits; no runtime/API budget-edit endpoint is provided. They are not monetary spending limits. Usage is reserved atomically before each tool execution; failed executions still consume a call.

### `GET /v1/admin/users/{userId}/tools`

Lists active, non-expired tool grants for a user. It returns identifiers and grant timestamps only.

### `PUT /v1/admin/users/{userId}/tools/{toolName}`

Body: `{ "enabled": true }` to grant or `{ "enabled": false }` to revoke. `toolName` must be in the reviewed catalog. A grant can be created only after the matching capability grant is active; otherwise the API returns `409 TOOL_REQUIRES_CAPABILITY_GRANT`. Grant/revoke actions are transactionally audited. Existing capability grants do not automatically create tool grants—administrators must grant both explicitly.

## Contract error table

| Condition | HTTP/status | Code |
|---|---:|---|
| Invalid/expired session | 401 | `AUTHENTICATION_REQUIRED` / `INVALID_SESSION` |
| Missing capability grant | 403 | `CAPABILITY_PERMISSION_REQUIRED` |
| Capability driver missing or unready before acceptance | 501 | `CAPABILITY_UNAVAILABLE` |
| Non-File Analysis capability receives an attachment | 400 | `ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS` |
| File-analysis task has no uploaded file | 400 | `FILE_REQUIRED` |
| File storage encryption key is missing | 501 | `FILE_SERVICE_UNAVAILABLE` |
| File is missing/not owned on metadata lookup or task preflight | 404 | `FILE_NOT_FOUND` |
| File is deleted after task acceptance | task `FAILED` | `FILE_NOT_FOUND` |
| Allowed text media type does not match the supported filename extension | 415 | `UNSUPPORTED_FILE_TYPE` |
| Request specifies an unsupported content type | 400 | `INVALID_REQUEST` |
| Uploaded text exceeds 32 KiB | 413 | `FILE_TOO_LARGE` |
| Content is malformed base64 or invalid UTF-8 | 400 | `INVALID_FILE_ENCODING` |
| Stored encrypted file fails integrity check | task `FAILED` | `FILE_INTEGRITY_CHECK_FAILED` |
| Configured model gateway fails during direct Chat | 503 | `AI_GATEWAY_REQUEST_FAILED` |
| Usage/cost ledger cannot durably record a completed model response or accepted Tavily request | direct response `503` or task `FAILED` | `AI_USAGE_ACCOUNTING_FAILED` |
| Configured provider fails after a task is accepted | task `FAILED` | `AI_GATEWAY_REQUEST_FAILED` / `RESEARCH_PROVIDER_REQUEST_FAILED` |
| Search provider returns no captured HTTPS source content | task `FAILED` | `RESEARCH_NO_VERIFIABLE_SOURCES` |
| Required tool grant is missing before task acceptance | 403 | `TOOL_PERMISSION_DENIED` |
| Tool or capability permission is revoked during execution | task `FAILED` | `TOOL_PERMISSION_DENIED` / `CAPABILITY_PERMISSION_REQUIRED` |
| Per-user/per-tool minute or UTC-day call quota is exhausted during task execution | task `FAILED` | `TOOL_BUDGET_EXHAUSTED` (Tool Manager internal error is coded 429; task polling reports the task error) |
| Admin grants a tool without its matching capability | 409 | `TOOL_REQUIRES_CAPABILITY_GRANT` |
| Allowlisted tool exceeds its timeout | task `FAILED` | `TOOL_TIMEOUT` |
| Tool input/output does not pass validation | task `FAILED` | `TOOL_INPUT_INVALID` / `TOOL_OUTPUT_INVALID` |
| Invalid request body | 400 | `INVALID_REQUEST` |
| Task result missing required evidence | task `FAILED` | `VERIFICATION_EVIDENCE_REQUIRED` |
| Unauthorized or unknown task ID | 404 | `TASK_NOT_FOUND` |
| Attempt to cancel a completed or failed task | 409 | `TASK_NOT_CANCELLABLE` |
| Expired, consumed, or invalid WebSocket ticket | 401 | `INVALID_WEBSOCKET_TICKET` |
| WebSocket event source not configured | 503 | `TASK_EVENTS_UNAVAILABLE` |

A worker repeats grant and readiness checks after dequeue. Revocation/readiness loss after acceptance fails the task and records an audit event. There is no pretend completion result.
