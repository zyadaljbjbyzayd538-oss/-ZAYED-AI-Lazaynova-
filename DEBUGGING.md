# Diagnostics and owner-authorized safe repair

This project includes a local diagnostics runner. It does **not** make arbitrary shell commands available to the API or modify business logic using an AI model.

## Local checks

From `backend/`, install the locked dependencies once, then run:

```bash
npm ci
npm run diagnose
```

The command checks migration filename ordering, TypeScript types, ESLint, the backend test suite, and the TypeScript build. It uses fixed repository scripts, does not contact model providers, does not apply migrations, and does not upload source or reports.

## Explicit owner repair command

Only run this after reviewing the repository and while acting as its trusted owner/operator:

```bash
npm run diagnose:repair -- --confirm-owner
```

The confirmation flag is mandatory. The only automatic modification is ESLint's safe `--fix` pass (for findings ESLint knows how to repair without changing application behavior). The command then re-runs typecheck, lint, tests, and build. It **will not** rewrite code to satisfy failing tests, change model/provider settings, install or update packages, execute migrations, alter application data, restart production services, or infer a code fix. If another check fails, the command records a redacted diagnosis and exits nonzero for an owner/developer to review.

Review source changes before deploying:

```bash
git diff
```

## Explicit live dependency checks

When private services are provisioned, the operator may run:

```bash
npm run diagnose:live
```

This runs all local checks, then performs only bounded probes for configured services:

- PostgreSQL: `SELECT 1`, checks that migration records through `010_task_artifacts.sql` exist, and confirms the artifact table is queryable. It does not apply or roll back migrations.
- Redis/BullMQ: opens a temporary diagnostic queue connection and sends `PING`; it does not enqueue a task.
- S3-compatible storage: checks bucket access, writes a small random diagnostic object under a random task/artifact key, reads it byte-for-byte, then deletes it. This is a real storage write/delete and may incur provider request costs. It does not create application metadata.
- Configured model providers: queries their bounded model inventories only. It does not submit prompts or generate tokens, so it is not an inference/billing test.
- Docker/gVisor: checks Docker runtime and pinned local image readiness only. It does not launch a container or execute untrusted code.

Unconfigured services are reported as `SKIP`, not as passing live tests. Any failed probe is reported without endpoint credentials or raw provider diagnostics. A passing readiness probe does not certify production, migration rollback, billing, model inference quality, concurrency, or disaster recovery.

## Report and privacy

The most recent run is written to the ignored local file `backend/.diagnostics/latest-report.json` with bounded, credential-redacted output and restrictive file permissions. Do not manually remove the redaction, publish the report, or paste secrets into chat. The API does not expose this report or a remote repair endpoint; repairs require the owner to run the local command in a trusted checkout.

## Current environment status

No live database, Redis, S3 credentials, provider profile, Docker/gVisor runtime, or model weights are bundled in the repository. The absence of those services is reported as `SKIP` by live checks. Coding remains unavailable until its isolated runtime and workspace integration have been safely verified. AI model adapters do not make provider credentials, model weights, or inference available by themselves.
