# Lazaynova Build Roadmap

The historical capability implementation phases 0–6 below record what has been built; they are **not** the current execution gate. The user's latest requested production sequence is **Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 1 last**. A phase is marked complete only when implementation and relevant verification are recorded in `PROGRESS.md`; unit tests do not count as live database/provider integration tests.

## Active reordered execution plan (2026-10-01)

1. **Phase 2 — execution safety and reliability (active):** implement isolated code execution with no network by default; SSRF-safe behavior; bounded parallel workflow execution and real progress reporting; durable external artifact storage; and per-user monetary API cost tracking. An adapter-level Docker/gVisor design and bounded workflow parallelism/status SSE now exist. Per-user model-token and accepted Tavily-request usage/cost estimates, operator-maintained rates, idempotency, and user/admin summary APIs are implemented and locally tested; migration `009` and live provider/database verification remain pending, and estimates are not spend limits. Sandbox-to-workspace wiring/live runtime and persistent external artifacts remain incomplete. No container or code was actually run.
2. **Phase 3 — memory, files, RAG and S3-compatible storage:** implement only with real stores, owner isolation, consent/retention and source-attributed retrieval; test persistence and deletion. Not started for this reordered plan.
3. **Phase 4 — Android:** build and test the native Android client on an actual JDK/Gradle/SDK/device toolchain. Existing chat source is not a compiled release. Not started for this reordered plan.
4. **Phase 5 — production hardening:** load/security/recovery/backup/monitoring/deployment checks after features are implemented. Not started for this reordered plan.
5. **Phase 1 — live infrastructure (final):** provision a staging Docker/PostgreSQL/Redis/BullMQ/provider environment via secure configuration; run migrations and real end-to-end/recovery tests only after Phases 2–5. This is deliberately postponed, not a blocker to local code work.

**Phase 2 accounting status:** model-token and accepted Tavily-request usage are attributed to trusted users/resources and summarized at `GET /v1/usage` plus the admin endpoint. Rates are operator-maintained; missing rates remain unpriced. Migration `009` is not live-verified, and no provider invoice or spend cap is claimed.

## Phase 0 — repository audit (complete)

- [x] Inspect the repository, technology, existing implementation, available tools, and actual test coverage.
- [x] Record architecture and progress without repeating unverified completion/security claims.

## Phase 1 — backend foundation and current capabilities (implemented; live integration pending)

- [x] TypeScript/Fastify API, PostgreSQL repositories/migrations, authenticated sessions, admin and per-capability grants.
- [x] Transactional task/outbox acceptance, BullMQ worker boundary, state tracking, audit and safe errors.
- [x] Deterministic intent routing and direct Chat boundary; real server-side OpenAI-compatible adapter with explicit provider profiles.
- [x] Read-only server-side model inventory: authenticated user route discovery plus admin live `/models` inventory; endpoints, API keys, and arbitrary client-selected model IDs remain server-side.
- [x] Add native server-side Anthropic Messages/Models and Google Gemini generateContent/Models adapters with credential headers, bounded responses, safe errors, usage/provenance, and native model discovery; verify contracts with fetch doubles (live accounts remain unverified).
- [x] Writing, Web Research and limited encrypted TXT/Markdown/log/CSV File Analysis paths with capability-specific evidence.
- [x] Owner-scoped task polling/WebSocket status; API checks grants/readiness and workers re-check before execution.
- [ ] Run migrations, PostgreSQL/Redis/BullMQ, live model/search and recovery integration tests in a provisioned environment.

## Phase 2 — Agent Engine (implementation present; integration validation pending)

- [x] Validated, bounded same-capability task DAG model with dependency ordering and cycle/escalation rejection.
- [x] Deterministic offline planner; optional model planner only through an explicitly selected `AI_PLANNER_PROVIDER` profile.
- [x] DAG executor, prerequisite context, per-node result/attempt checkpoints, progress monitor and existing capability verifier integration.
- [x] Restricted Tool Manager for real `web.search` and owner-scoped `file.read_text`; every call checks the owner's capability grant, validates typed inputs/outputs, enforces a bounded timeout, and audits without storing content.
- [x] Up to three attempts for allowlisted transient planner/agent upstream failures; tool deadlines fail safely, with no retries for arbitrary/permanent errors.
- [x] Database task leases (60-second expiry, five-second heartbeat) and completed-node resume after worker loss/redelivery.
- [x] Owner-scoped task cancellation with transactional audit/status notification and worker `AbortSignal` propagation to active adapters.
- [x] SHA-256 evidence chain, integrity validation, persistence and task result exposure.
- [ ] Apply migration `004_agent_execution_engine.sql` to PostgreSQL and test plan/node/evidence persistence, concurrent claims, lease expiry, BullMQ redelivery and shutdown recovery.
- [ ] Verify against real configured providers; none are available in the current environment.

**Phase 2 boundary:** the offline plan is intentionally one capability node. A model planner may make up to six same-capability `RUN_CAPABILITY` nodes; current Web Research and File Analysis are constrained to one node. Production drivers call only the fixed `web.search` and owner-scoped `file.read_text` tools, with both capability and distinct tool-grant checks, bounded deadlines and auditing. Planner-selected tools, cross-capability orchestration, arbitrary browser automation, shell and side-effecting actions remain disabled. The SHA-256 chain is tamper-evident bookkeeping, not a cryptographic signature against a privileged database writer.

## Phase 3 — Tool Manager expansion and controlled tools (partial implementation)

- [x] Phase 2 delivered the first allowlisted tools (`web.search`, `file.read_text`) with per-call capability re-check, typed validation, timeouts, safe failure and content-free audit.
- [x] Add distinct revocable per-user grants for the two tools, expiry-aware storage/queries, administrator grant/revoke/list endpoints, user-visible available-tool discovery, and preflight before task persistence.
- [x] Re-check the separate tool grant on every invocation; persist grant changes and denials in the audit log without query/file content.
- [x] Add durable per-user/per-tool call-volume quotas with atomic PostgreSQL reservation and safe exhaustion behavior. Defaults: `web.search` 20/minute and 200/UTC day; `file.read_text` 30/minute and 500/UTC day. These limits count calls only and do not constitute cost budgets; migration `006_tool_usage_budgets.sql` and live concurrency behavior still need PostgreSQL verification.
- [ ] Add enforceable monetary spend budgets only after provider pricing/tariffs, reset periods, alerting, and failure semantics are agreed. Cost tracking is implemented separately in migration `009` with unit-tested estimates, but no spend cap is enforced and live database/billing reconciliation is still pending.
- [ ] Add further tools one at a time behind real adapters; no Android/client API keys.
- [x] Web Research now uses provider-native function calling for exactly one declared `web_search` call per task, mapped only to `web.search` through Tool Manager with owner grant checks, schema/result bounds, durable quotas, timeout, and content-free audit. Round-trip context is preserved for Anthropic and Gemini; no adapter executes tools.
- [ ] Expand model-directed function calling beyond Web Research only after a separate allowlist, privacy, permission, output-bound, rate-limit, and audit review; arbitrary URLs, shell, side effects, and model-selected plans remain disabled.
- [x] Expose no arbitrary shell, unrestricted URL fetch, filesystem, or unreviewed browser automation.
- [ ] Test SSRF boundaries for future network tools and abuse/rate-limit behavior; broader catalog and live PostgreSQL grant/revocation integration remain pending.

## Phase 4 — Workflows and isolated Coding/Sandbox (workflow runtime implemented; live persistence unverified)

- [x] Add owner-scoped, append-only workflow definition versions, strict bounded cross-capability DAG validation, historical reads, and transactional content-free audit records.
- [x] Add durable workflow-run and step states, a dedicated transactional outbox/worker queue, lease-based recovery, topological checkpoints with up to four independent steps in parallel, bounded retries/output, owner-scoped polling and cancellation.
- [x] Enforce `approvalRequired` as a real owner decision gate; approvals resume durably, rejection fails closed, and cancellation aborts in-flight work cooperatively. Pending approval gates the entire ready layer before sibling side effects begin.
- [x] Add owner-scoped status-only workflow progress over SSE; it emits changed durable snapshots and closes at terminal state. The current SSE adapter polls the repository once per second rather than using push notifications.
- [x] Recheck each capability/tool grant and driver readiness before execution, verify per-step capability evidence, and seal final evidence in a SHA-256 chain.
- [ ] Apply migrations `007_workflow_definitions.sql` and `008_workflow_runs.sql`; verify owner isolation, run/approval races, atomic outbox/audit behavior, lease expiry, redelivery, and cancellation on PostgreSQL/Redis.
- [ ] Wire the Docker/gVisor adapter to an owner-scoped workspace/archive manager; provision and verify a digest-pinned image/runtime with no host secrets, hard workspace storage quotas, network denial, CPU/memory/time/output limits, disposable cleanup and real test reports. The adapter is not connected to a Coding driver and Coding remains unavailable.
- [ ] Add external artifact/object storage and retention policies; current workflow outputs are bounded JSONB, not external artifacts.

## Phase 5 — Memory, RAG and object storage (not implemented)

- [ ] Add explicit short-term, project and long-term memory policies, user consent, retention/deletion/export, owner isolation and encryption.
- [ ] Add retrieval with source attribution and verifier support; do not fabricate retrieved passages.
- [ ] Add S3-compatible object storage only with authenticated access, key/retention policy, malware/parser review and tested backup/restore.
- [ ] Expand beyond the currently supported 32 KiB UTF-8 TXT/Markdown/log/CSV formats only after real parsers and security limits are reviewed.

## Phase 6 — Android application (initial authenticated chat client source added; verification pending)

- [x] Add a native Kotlin/Jetpack Compose app at `com.zayedai.lazaynova` with an Arabic RTL sign-in/chat interface, MVVM/StateFlow, HTTPS-only API origin validation, and an explicit cancel-stream action.
- [x] Connect login to the real session API and Chat to the real SSE route; consume actual deltas, require result plus `[DONE]`, and show incomplete streams as incomplete. The server retains model routing authority.
- [x] Encrypt the local bearer session with AES-GCM using a non-exportable Android Keystore key; do not persist passwords, disable Android backup, and request no device-control permissions.
- [ ] Build, test, lint and run on a provisioned Android SDK/JDK/Gradle toolchain. The current environment has none of these tools, so source-level Android changes remain uncompiled.
- [ ] Add device-control capabilities only as separate reviewed features with OS-granted scoped permissions, visible/foreground operation, user cancellation, and explicit confirmation for sensitive actions; no arbitrary/background control.
- [ ] From-scratch model training is deferred. Provision an actual license-reviewed Llama 3/Qwen open-weight model and private inference runtime; pin weight versions/checksums and complete quality, Arabic, security, privacy and load tests before enabling it. No weights/runtime are currently available.

## Separate gated work — device control / ZAYED OS

- Device control is not enabled and is not an implied part of Phases 2–6. See [`docs/DEVICE_CONTROL_PLAN.md`](docs/DEVICE_CONTROL_PLAN.md).
- Start only after a real native app can display and capture approval for typed actions, with scoped OS permissions and a reviewed driver.
- Exclude root/sudo, arbitrary shell, stealth persistence, continuous screenshot/UI harvesting, and unattended sensitive actions.
