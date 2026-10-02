# Lazaynova

**ZAYED AI · Private. Autonomous. Yours.**

Lazaynova is the Arabic-first AI platform owned by ZAYED AI. The backend includes authenticated task execution, a durable Agent Engine with validated task graphs, a restricted Tool Manager, owner-scoped versioned workflow definitions and durable workflow runs, per-node recovery checkpoints, owner-controlled task/workflow cancellation, evidence verification/chaining, owner-scoped task status, and configurable server-side OpenAI-compatible, Anthropic Claude, and Google Gemini model profiles for Chat, Writing, Model Analysis, Web Research, and narrowly scoped encrypted text-file analysis. Direct Chat is also available through an authenticated SSE endpoint; configured gateways stream real provider text deltas followed by safe provenance and completion events (never synthetic chunks). The authenticated model catalog checks each configured provider's real model inventory without exposing provider URLs or credentials. Admins can inspect inventories at `GET /v1/admin/ai/models`; signed-in users see only their routed model names at `GET /v1/ai/models`.

> **Honest capability status:** server-side adapters now cover OpenAI-compatible gateways, Anthropic Messages/Models, and Gemini generateContent/Models, with real Chat, text-only Writing, and Model Analysis drivers; no provider endpoints, credentials, or model weights are configured by default. Web Research can request exactly one provider-native `web_search` call; the application accepts no other model-selected tool and routes it through the Tool Manager, which rechecks user grants, validates bounded arguments/results, enforces quotas and timeouts, and audits the invocation. Other drivers do not expose model-directed tools. The catalog uses each configured provider's native model-list API. Anthropic/Gemini adapters are covered by HTTP test doubles only; no live provider account or credentials are configured or verified. A limited File Analysis driver handles only owner-uploaded UTF-8 TXT/Markdown/log/CSV files up to 32 KiB, encrypted in PostgreSQL with per-file AES-256-GCM keys. Uploads require `FILE_ENCRYPTION_KEY`; sending file content to a model additionally requires an explicit `AI_FILE_ANALYSIS_PROVIDER` route and a user-approved `FILE_ANALYSIS` task. The earlier capability-build Phase 2 added a truthful offline single-node planner plus an optional explicitly routed model planner, durable DAG/node checkpoints, bounded retries, expiring worker leases, cooperative owner cancellation, and a SHA-256 evidence chain. That historical numbering is separate from the current reordered execution plan (Phase 2 → 3 → 4 → 5 → Phase 1 last) in `ROADMAP.md`. The earlier capability-build Phase 3 adds distinct administrator-managed grants and durable per-user/per-tool call-volume quotas for the only two fixed Tool Manager calls (`web.search`, `file.read_text`), in addition to existing capability grants. Defaults are 20 search calls/minute and 200/UTC day, and 30 file-read calls/minute and 500/UTC day; these are invocation limits, not monetary budgets. The quota tests use PostgreSQL query doubles; no live database/migration, Redis/BullMQ recovery, or deployment test has occurred. Web Research requires an explicitly configured Tavily credential and sends queries/source text to that provider. Owner-scoped workflow definitions have durable checkpoints, bounded retries, evidence verification, owner approval/rejection gates, and cancellation. Independent ready steps now run up to four at a time; status is available by polling or an owner-scoped progress SSE endpoint. Run/approval/outbox recovery uses migration `008` and is not live-verified against PostgreSQL/Redis. A Docker/gVisor sandbox adapter is present but is not wired to a workspace manager or Coding driver; no sandbox was run and Coding remains unavailable. PDF/Office/image processing, enforceable monetary spend limits, projects, long-term memory/RAG, Android build/device verification, and desktop control remain unavailable. A bounded S3-compatible adapter now externalizes oversized task and graph-node results, but no bucket is configured or live-verified; oversized results fail safely when object storage is absent. Per-user model-token and accepted Tavily request usage/cost estimates now have a PostgreSQL ledger, operator-configured pricing, and authenticated user/admin summaries; migration `009` is not applied or live-tested here, unknown rates remain unpriced, and these estimates are not invoices. Cross-capability plans, arbitrary tool calls, and side-effecting operations remain disabled. The API does not generate canned answers or pretend to execute work.

## What's in the repository

- `backend/` — TypeScript + Fastify API, authentication, domain/use-case boundaries, PostgreSQL and BullMQ adapters, workers, and tests.
- `android/` — Native Kotlin/Jetpack Compose client with explicit live/mock flavors, local-only mock fixtures, adaptive previews, authenticated capability/tool-quota snapshots, and HTTPS/SSE chat. Android build/device verification is pending because this environment lacks Android toolchains.
- `ios/LazaynovaForFoundationModels/` — iOS 27/macOS 27 Foundation Models adapter package for authenticated Chat (not compiled here because the Apple toolchain is unavailable).
- `database/migrations/` — PostgreSQL schema for accounts, sessions, capability and per-tool grants, durable per-user/per-tool invocation counters, owner-scoped workflow-definition versions and run/step checkpoints, task and workflow outboxes, audit, encrypted text-file records, durable Agent Engine plans, graph-node checkpoints, worker leases, evidence-chain rows, and the per-user provider-usage ledger (`009`).
- Task clients can poll task state or subscribe to owner-scoped status-only WebSocket events; ticket issuance, migration, and reconnect behavior are documented in [API.md](API.md).
- `infrastructure/compose.yaml` — local PostgreSQL and Redis services.
- `infrastructure/compose.private.yaml` — private deployment stack for API, worker, migrations, one-time admin bootstrap, PostgreSQL, protected Redis, and optional local Ollama inference; `infrastructure/compose.gpu.yaml` is an optional NVIDIA GPU override. `scripts/bootstrap-lazaynova.sh` performs owner-run startup, bounded local inference smoke testing, and live service checks. See [SETUP.md](SETUP.md) before deployment.
- `ARCHITECTURE.md` — stack decisions and execution contract.
- `PROGRESS.md` — current phase, blockers, next steps, and verification.
- `DEBUGGING.md` — owner-run diagnostics, explicit safe repair command, and live service probes.
- `SETUP.md`, `API.md`, `SECURITY.md`, `DEVELOPMENT.md`, `ROADMAP.md` — implementation and operations notes.

## Backend quick start

Prerequisites: Node.js 22+, npm 10+, and Docker Compose.

```bash
# Create an ignored, owner-only local database secret and start PostgreSQL/Redis
umask 077
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
printf 'POSTGRES_PASSWORD=%s\n' "$POSTGRES_PASSWORD" > .env
docker compose --env-file .env -f infrastructure/compose.yaml up -d

cd backend
sed "s|^DATABASE_URL=.*|DATABASE_URL=postgres://lazaynova:${POSTGRES_PASSWORD}@localhost:5432/lazaynova|" .env.example > .env
chmod 600 .env
npm ci
npm run migrate
unset POSTGRES_PASSWORD
```

Set `BOOTSTRAP_ADMIN_EMAIL` and a unique `BOOTSTRAP_ADMIN_PASSWORD` of at least 14 characters in `backend/.env`, then run `npm run admin:bootstrap` once. Start the API and worker in separate terminals:

```bash
npm run start:api
npm run start:worker
```

The API listens on `0.0.0.0:8080` by default. See [SETUP.md](SETUP.md) for account provisioning and local verification.

## Verify the backend

From `backend/`:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm audit
npm run diagnose
# Owner-triggered, safe ESLint fixes only (requires explicit confirmation):
npm run diagnose:repair -- --confirm-owner
# Live probes only after services and server-side secrets are provisioned:
npm run diagnose:live
```

The unit and HTTP-boundary tests use controlled test doubles; PostgreSQL/Redis end-to-end verification requires Docker services and is tracked separately. Check [PROGRESS.md](PROGRESS.md) for the most recent actual results.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Setup](SETUP.md)
- [API contract](API.md)
- [Security](SECURITY.md)
- [Development](DEVELOPMENT.md)
- [Roadmap](ROADMAP.md)
- [Progress](PROGRESS.md)
- [Arabic detailed project status map](docs/PROJECT_STATUS_MAP_AR.md)
- [Android responsive UI architecture (Arabic)](docs/ANDROID_UI_ARCHITECTURE_AR.md)
- [Android Mock & Preview runbook (Arabic)](docs/ANDROID_MOCK_PREVIEW_RUNBOOK_AR.md)
- [ZAYED OS device-control plan](docs/DEVICE_CONTROL_PLAN.md)
- [ZAYED AI project profile and business vision](ZAYED_AI_Project_Profile.md)
