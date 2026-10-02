# Test Layout

Backend automated tests currently live in `backend/test/` beside the TypeScript package and run with `cd backend && npm test`. They cover routing, API boundaries, preflight ordering, worker re-checks, task state, and evidence verification.

This top-level test location is reserved for future cross-module/API contract tests (for example Android-client/backend contract tests). No Android project or live PostgreSQL/Redis integration test exists yet; do not treat the unit suite as end-to-end verification.
