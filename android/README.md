# Lazaynova Android client

Native Kotlin/Jetpack Compose client for the authenticated Lazaynova API, with explicit `live` and `mock` product flavors. The client provides an Arabic RTL adaptive workspace, three local color themes, authenticated HTTPS/SSE in live mode, and a local-only repository in mock mode. The live usage dashboard separates provider token/cost data from user-scoped tool-call counters returned by `/v1/agent/capabilities`; the client derives only an approximate remaining-call estimate from those counters and server UTC reset times. The server selects the model; the app contains no provider key, model override, user ID, or owner flag. See [`docs/ANDROID_UI_ARCHITECTURE_AR.md`](../docs/ANDROID_UI_ARCHITECTURE_AR.md) and [`docs/ANDROID_MOCK_PREVIEW_RUNBOOK_AR.md`](../docs/ANDROID_MOCK_PREVIEW_RUNBOOK_AR.md).

## Build prerequisites

- Android Studio with JDK 17
- Android SDK Platform 37 and Build Tools 36.0.0
- Android Gradle Plugin 9.2.0 / Gradle 9.4.1

From the repository root, run `scripts/build-android.sh` to execute ktlint, detekt, `testMockDebugUnitTest`, and `assembleMockDebug`, then copy the mock APK to `artifacts/android/Lazaynova-mock-debug.apk`. The script uses `android/gradlew` when present, otherwise a system `gradle`; it fails clearly if neither is installed. The CI workflow generates a Gradle 9.4.1 wrapper for that run because this checkout does not include wrapper files, then runs style/static analysis, `assembleDebug`, and `testMockDebugUnitTest`.

- `mockDebug` (`USE_MOCK_DATA=true`, app ID suffix `.mock`) uses local synthetic fixtures only. It does not make HTTP calls or store credentials. Every mock state is visibly labelled; never treat a mock APK or fixture as a real account check.
- `liveDebug` (`USE_MOCK_DATA=false`) calls the backend selected by the HTTPS origin entered at sign-in. The live app reads bearer-authenticated capabilities/tool grants and quota snapshots. No URL/password/token is baked into build config.
- For an operator-built live debug APK, use `gradle -p android :app:assembleLiveDebug`; for release signing, configure signing through a local secret manager/CI secrets, never commit signing keys or credentials.

The Arena environment currently lacks Java/Gradle/Android SDK executables, so Android compilation, unit tests, lint, Preview rendering, install, and device/API checks remain **not run here**. Do not distribute until CI succeeds and live/device integration is tested.

## Current functional boundary

1. Live mode signs in through `POST /v1/auth/sessions`; only the bearer token and HTTPS origin are stored encrypted. The password is not saved, and backup is disabled.
2. Live mode reads `/v1/agent/capabilities` for server-authenticated capability grants, separate tool grants, readiness, and current tool usage buckets. The client estimates remaining calls as `max(limit - used, 0)` and resets the estimate at the server-provided UTC boundary; concurrent sessions can make the snapshot stale.
3. Live chat sends a bounded user/assistant transcript to `POST /v1/lazaynova/chat/stream`. Actual provider deltas appear incrementally; incomplete SSE is not presented as successful. Cancellation cancels the OkHttp call. Chat messages stay in memory only.
4. Mock mode uses `MockLazaynovaRepository`; credentials/prompts stay local and the sample Chat response is labelled. Mock token/cost/quota values are synthetic and do not represent account state.

This client does **not** yet perform phone-control actions, accessibility automation, contact/media access, file/PPT upload/generation, background monitoring, or model training. Unsupported task tiles are informational only and do not trigger Android permissions. No proprietary model weights, training corpus, GPU cluster, or live backend/provider configuration are bundled.
