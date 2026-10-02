# Lazaynova Architecture

**Product:** Lazaynova
**Company:** ZAYED AI
**Tagline:** Private. Autonomous. Yours.

## 1. Repository audit (2026-09-29)

At the initial 2026-09-29 repository audit, the checkout contained only `.gitignore`, `LICENSE`, and a short `README.md`; there was no Android project, backend, database schema, infrastructure, or test suite. No Java, Gradle, Kotlin, Docker, or Android SDK executable was available, while Node.js 22 and npm 10 were available. The previously asserted 28-test run could not be verified from that initial checkout.

## 2. Architectural decisions

### Backend: TypeScript, Node.js, Fastify

Use a supported Node.js LTS runtime with TypeScript and Fastify. This gives the API a typed domain boundary, a small HTTP surface, schema-driven validation, and a straightforward path to background workers without coupling the Android client to an AI vendor. HTTP handlers, use cases, repositories, adapters, and worker processes remain separate modules.

### Persistence and jobs

- PostgreSQL is the source of truth for users, sessions, expiring/revocable capability and tool grants, tasks, steps, logs, verification, and audit records.
- Redis and BullMQ provide asynchronous job delivery; task state is never inferred from Redis alone.
- Persist task creation and an outbox event in one PostgreSQL transaction, then dispatch the outbox to BullMQ. This avoids losing accepted work if the API process exits between database commit and queue publication.
- Workers re-check authorization and capability readiness before execution. A task that becomes ineligible after enqueue is failed with a stable error code and an audit record.

### AI, agent, file, and storage boundaries

- An AI Gateway interface isolates model selection, credentials, and provider-specific request/response formats. The server-side OpenAI-compatible, Anthropic, and Gemini adapters support named profiles and per-capability routing for Chat, Writing, Research, File Analysis, and Model Analysis. The Anthropic adapter speaks Messages/Models; Gemini uses generateContent/Models and sends credentials in `x-goog-api-key`, not the URL. A read-only model catalog probes each configured profile's native model inventory and exposes routed model names to authenticated users and sanitized inventories to admins; URLs and credentials stay private. These adapters have contract tests using fetch doubles; no live provider has been configured or verified. No provider key belongs in Android, migration/bootstrap containers, or source control. Cross-provider fallback is intentionally disabled unless a future, explicit privacy policy enables it.
- Agent registration is capability-based. Phase 2 implements the planner, DAG executor, execution monitor, verifier integration, durable graph repository, and a restricted Tool Manager wired into production Web Research/File Analysis drivers. Phase 3 adds independent grants, grant-management APIs, and atomic durable per-user/per-tool call quotas (20/minute and 200/UTC day for `web.search`; 30/minute and 500/UTC day for `file.read_text`). These quotas measure invocations, not monetary spend. Separate per-user model-token and accepted Tavily request cost estimates now use migration `009`, operator-maintained rates, request-ID deduplication, and user/admin summary APIs; that migration is not live-verified, unknown prices remain unpriced, and no monetary spend cap is enforced. Large-result artifact storage, broader tool catalog, and workflow-controlled tool selection also remain future work.
- Current file intake supports only authenticated UTF-8 TXT/Markdown/log and CSV uploads up to 32 KiB. PostgreSQL stores AES-256-GCM ciphertext with per-file data keys wrapped by a server-only `FILE_ENCRYPTION_KEY`; parsing validates UTF-8, hashes content, scopes reads to the owner, and records upload/delete audit events. The S3-compatible storage and broader parser ports remain future extensions; PDF/Office/archive/image parsing is not enabled.
- Memory stores have distinct conversation, short-term, long-term, project, and knowledge interfaces. Sensitive retention requires explicit policy/consent; no implicit long-term memory is assumed.

### Android

An initial native Kotlin/Jetpack Compose client now exists in `android/` at `com.zayedai.lazaynova`: Arabic RTL sign-in/chat UI, StateFlow ViewModel, authenticated HTTPS session/chat requests, real SSE delta parsing/cancellation, and AES-GCM bearer-token storage using a non-exportable Android Keystore key. It communicates only with the Lazaynova API; model routing and credentials stay server-side. Java/Gradle/Android SDK are unavailable here, so this source has not been compiled or tested. No device-control permission/driver is included; this remains a chat client, not a phone automation app.

## 3. Request and execution contract

1. Authenticate the caller and validate the request.
2. Route the input to a direct chat intent or a task capability. Simple chat is not sent to the task queue. When a real gateway/model is configured, Chat calls it directly; otherwise it returns `501 CAPABILITY_UNAVAILABLE`. It never fabricates an answer.
3. For task capabilities, check the caller's `user_capability_grants` and agent/engine readiness before accepting work. Missing permission returns HTTP `403 CAPABILITY_PERMISSION_REQUIRED`; a missing engine returns HTTP `501 CAPABILITY_UNAVAILABLE`. Neither response creates a task or queue entry.
4. Insert the task and durable queue-outbox record in PostgreSQL. Return `202` only after the durable acceptance transaction succeeds.
5. Dispatch the outbox event to BullMQ. The worker re-checks authorization and engine readiness to defend against revocation and engine shutdown after acceptance.
6. Run an agent only through a registered real driver. The verifier requires capability-specific evidence before a task can become `COMPLETED`; missing evidence yields `FAILED` / `VERIFICATION_EVIDENCE_REQUIRED`, with provenance and audit details retained.

Task lifecycle: `QUEUED`, `PLANNING`, `RUNNING`, `WAITING`, `VERIFYING`, `COMPLETED`, `FAILED`, `CANCELLED`. State transitions are persisted and timestamped. Task owners can cancel any active task through the authenticated cancellation endpoint; the transaction clears its lease, audits the action, and publishes terminal status. A worker listener aborts in-flight `AbortSignal`-aware model/tool calls, with lease renewal detecting missed notifications. Clients can poll task status or open an owner-scoped WebSocket stream. The stream uses one-time short-lived tickets and status-only PostgreSQL `LISTEN/NOTIFY`; polling is the fallback because notifications are not replayed.

### Phase 2 Agent Engine (implemented foundation)

- `AgentEngine` loads or creates a validated task plan, hashes and persists it before execution, runs the graph executor, seals evidence, and calls the capability-specific verifier. The offline planner creates a truthful one-node plan. An optional model planner is enabled only by explicitly setting `AI_PLANNER_PROVIDER`; its prompt is sent to that selected server-side profile, and its output is strictly limited to up to six same-capability `RUN_CAPABILITY` nodes. `FILE_ANALYSIS` and `WEB_RESEARCH` are constrained to one node because their current registered drivers already perform their internal workflows.
- DAG nodes are topologically ordered and must converge to one final node; dependency outputs are passed as untrusted context. The executor routes actual work only through the capability driver. Production Research and File Analysis drivers call the allowlisted `web.search` and `file.read_text` Tool Manager adapters, respectively; each call re-checks both the task owner's capability grant and distinct tool grant, validates inputs/outputs, enforces a deadline, and writes content-free audit events. A per-task PostgreSQL plan, per-node state/attempt/result checkpoints, and content-free execution logs support status inspection and resumption.
- Each active worker owns a 60-second database lease refreshed every five seconds. The worker also listens for task-status notifications and aborts when its owner cancels; the shorter lease refresh detects a missed notification and stops the task on the next check. An expired lease can be reclaimed after worker loss. Completed graph nodes resume from their stored checkpoint. Planner and node calls get up to three attempts only for allowlisted transient upstream failures; other errors fail closed. Live Redis/BullMQ + PostgreSQL cancellation/recovery has not yet been integration-tested.
- Evidence items are SHA-256 chained with sequence, previous hash, item hash, and root marker; the verifier rejects an invalid chain. The chain and root are persisted with the task. This is tamper-evident bookkeeping, not a signature or protection against an administrator who can rewrite the database.
- Current Phase 2 does not include cross-capability planning, arbitrary browser automation, shell, or side-effecting actions. The only production tools are allowlisted read/search operations; every call requires the matching capability grant and separate tool grant. The Phase 3 expansion beyond these tools and monetary budgets remain later work. Phase 4 now includes a durable workflow-run path for validated versions: sequential topological step execution through existing capability drivers, per-step owner/grant/readiness rechecks, checkpoints, bounded retries, evidence verification, owner approval gates, cancellation, leases, and a dedicated outbox. It does not enable arbitrary workflow tools or shell.

### Phase 4: versioned workflow definitions and durable execution

The API stores owner-scoped workflow definitions as append-only versions, validates a bounded cross-capability DAG, and records content-free audit events transactionally. A run snapshots one immutable version and owner input, then writes run/step rows and an outbox event in one transaction. A separate worker queue claims a database lease, executes steps sequentially in stable topological order through existing capability drivers, rechecks grants/readiness/file ownership before each step, bounds transient retries and serialized outputs, verifies each step's capability evidence, and checkpoints each result before proceeding. `approvalRequired` pauses the run until the owner explicitly approves or rejects; cancellation is owner-scoped and cooperative through a five-second lease heartbeat. Polling is available through owner-scoped run APIs; a workflow WebSocket stream and parallel step execution are not implemented. Migration `008_workflow_runs.sql`, live PostgreSQL transactions, Redis/BullMQ delivery, worker recovery, and cancellation behavior remain unverified in this environment.

## 4. Security and operational boundaries

Authentication uses server-issued, expiring opaque sessions whose SHA-256 hashes (not bearer tokens) are stored in PostgreSQL; authorization is role-, capability-, and tool-grant-based. WebSocket handshakes use separately hashed, audited 60-second single-use tickets; the API checks task ownership before upgrade, redacts request URLs from logs, and emits status only. Requests are schema validated and rate-limited per IP in each API process. A distributed rate-limit store is a production scaling TODO. Security-sensitive session, grant, task, and file upload/delete events are audit logged. Secrets are injected through deployment configuration/secret management, never checked into Git. Production should use least-privilege database roles and TLS. The narrow text upload path validates media type, filename, UTF-8, control characters, and size; broader document types remain disabled until parsers/scanners and archive limits are reviewed. No sandbox execution is enabled until an isolated runtime and resource limits exist.

## 5. Initial scope and deferred work

The repository contains PostgreSQL migrations, local PostgreSQL/Redis Compose configuration, authenticated API/session boundaries, capability preflight, a transactional task outbox, a BullMQ worker, evidence verification, owner-scoped WebSocket task status, and unit/HTTP/WebSocket-contract tests. The stream is backed by a per-process PostgreSQL listener, emits no task results, uses one-time ticket authentication, and has polling as the reconnect fallback; live PostgreSQL delivery remains unverified. Phase 2 adds a durable, validated DAG foundation, optional explicitly routed model planning, topological execution, per-node checkpoints, worker leases/recovery, owner cancellation, bounded transient retries, and a SHA-256 evidence chain. The first Phase 3 increment adds separate grants for the two existing read/search tools. The default planner intentionally emits one capability node; planner-selected tool calls and cross-capability plans are disabled. Web Research alone exposes one model-requested native `web_search` function, mapped through the Tool Manager's fixed allowlist with the task owner's grant rechecked; other drivers receive no model-directed tools. Real OpenAI-compatible, Anthropic, and Gemini adapters, Chat and Model Analysis drivers, and a text-only Writing task driver are implemented; native-provider contract behavior is tested with fetch doubles only. Operators can configure separately routed private/local and enterprise profiles; no live provider credentials or model weights are included or verified. A private Docker deployment definition now composes API, worker, migrations, one-time admin bootstrap, protected PostgreSQL/Redis, and optional local Ollama runtime, but it has not been built or tested with Docker in this environment. Web Research has an opt-in Tavily adapter but no live key or result validation. A limited File Analysis driver handles authenticated, owner-scoped UTF-8 TXT/Markdown/log/CSV files (maximum 32 KiB) stored as AES-GCM ciphertext in PostgreSQL; it requires an operator key plus an explicit model route, and has no live database/model validation. PDF/Office/image parsing, S3 storage, Coding, Project, native phone control, long-term memory, and sandbox execution remain unavailable. An initial Android authenticated Chat client is source-only and unverified; no model weights or from-scratch training resources are configured. Chat, Writing, and Web Research still refuse attachments.

## 6. Planned repository layout

```text
android/                 Native Android Chat client (source added, build verification pending)
backend/                 API, domain, infrastructure adapters, worker
infrastructure/          Local/deployment service configuration
database/                 PostgreSQL migrations and schema
docs/                     Operational and product documentation
tests/                    Cross-module/contract tests where appropriate
ARCHITECTURE.md
PROGRESS.md
```

The first backend milestone may keep backend-specific tests alongside `backend` until shared integration tests are introduced. Documentation is updated as scope and verification change.
