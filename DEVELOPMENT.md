# Development Guide

## Backend module map

```text
backend/src/
  api/             Fastify app, request validation, HTTP status mapping, server startup
  application/     use cases, AgentEngine, capability/model planners, DAG executor, allowlisted Tool Manager, workflow-definition/run services, durable workflow runner, retry policy, monitor, verifier, repositories, and file/task ports
  auth/            password hashing and opaque-session lifecycle
  domain/          intent routing, task/workflow graph validation, SHA-256 evidence chain, state machine, driver registry, evidence verifier and AI Gateway port
  infrastructure/  PostgreSQL repositories/LISTEN-NOTIFY, durable workflow definitions/runs/steps/outboxes and graph/evidence/lease persistence, encrypted text-file storage/parser, Redis/BullMQ dispatchers, AI gateway profiles and driver composition
  workers/         asynchronous task and workflow-run processors/outbox publishers
  scripts/         SQL migration runner and one-time admin bootstrap
backend/test/      Node test-runner tests
backend/Dockerfile  non-root production API/worker image
ios/LazaynovaForFoundationModels/ Swift Package adapter for authenticated iOS 27/macOS 27 Foundation Models Chat
database/migrations/ PostgreSQL schema migration(s)
infrastructure/    local and private Compose definitions
```

The API layer depends on use-case and repository ports. PostgreSQL and queue details are isolated in infrastructure. Tests inject controlled test doubles; these exist only inside test code and are not production behavior.

## Commands

Run from `backend/`:

```bash
npm ci
npm run migrate
npm run start:api
npm run start:worker
npm run typecheck
npm test
npm run lint
npm run build
npm audit
```

`npm run migrate` applies ordered SQL files in `database/migrations/` and records them in `schema_migrations`. Apply schema changes as new migrations; do not edit an already released migration in a deployed environment.

## Adding a real capability driver

1. Implement `CapabilityDriver` for one capability, with `isReady()` checking actual required configuration/dependencies.
2. `execute()` must invoke a real engine and return result plus provenance/evidence; errors must be explicit and bounded.
3. Register the implementation in the shared `infrastructure/agent-composition.ts` only when secrets and runtime dependencies are configured. API and worker both use this composition function so readiness cannot drift.
4. Add evidence-generation and verifier tests, permission/readiness preflight tests, revocation/shutdown worker tests, and integration tests with the real adapter.
5. Run typecheck, test, lint, build, and dependency audit; update `PROGRESS.md` and API docs.

Do not add canned model output, timer-based progress, a fake queue, or a driver that reports ready without a live execution path. Chat is direct and synchronous; long-running work is only accepted after permission/readiness preflight and persisted transactionally.

## Current verification boundaries

The backend test suite covers Agent Engine planner/DAG/evidence-chain/retry/checkpoint behavior, owner-scoped task and workflow cancellation, workflow approval/rejection, capability/tool-grant rechecks, durable workflow run/step snapshots, run outbox idempotency, step retries and evidence verification, as well as tool-grant administration and quota decisions/SQL. It also covers domain/use-case/HTTP behavior, WebSocket task owner isolation, gateway-profile routing, OpenAI-compatible and native Anthropic/Gemini contract tests, authenticated model inventory, Writing/Research/File Analysis evidence, encrypted-file ownership/integrity, safe adapter errors, provider model pricing/token arithmetic, trusted usage attribution, Tavily accepted-request cost reporting, ledger idempotency/unpriced rows, and user/admin usage APIs. Workflow/provider accounting persistence uses SQL/query doubles; these are not live provider/database/Redis checks. Migrations `003_encrypted_text_files.sql` through `009_provider_usage_ledger.sql` have not been applied to PostgreSQL here. Docker Compose YAML can be syntax-checked, but Docker itself is unavailable, so container builds, PostgreSQL `LISTEN/NOTIFY`, BullMQ recovery, migration execution, and live inference remain unverified. Java/Gradle and Swift/Xcode are unavailable, so no Android or iOS/Swift package build is claimed; the iOS package specifically requires an iOS 27/macOS 27 SDK. Re-run the Commands above after changes and copy exact results into `PROGRESS.md`; do not count a unit test as live integration verification.
