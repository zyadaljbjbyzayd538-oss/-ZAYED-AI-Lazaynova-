# Lazaynova Android client

Native Kotlin/Jetpack Compose client for the existing authenticated Lazaynova API. This first vertical slice provides an Arabic RTL sign-in and chat interface, encrypted local session storage using a non-exportable Android Keystore AES-GCM key, authenticated HTTPS requests, incremental SSE deltas, backend completion/provenance handling, and user-visible stream cancellation. The server selects the model; the Android app contains no provider key, model override, user ID, or owner flag.

## Build prerequisites

- Android Studio with JDK 17
- Android SDK Platform 36 and Build Tools 36.0.0
- Android Gradle Plugin 9.2.0 / Gradle 9.4.1

Open this `android/` directory as a Gradle project. In a provisioned environment, run `gradle -p android :app:assembleDebug`, `gradle -p android :app:testDebugUnitTest`, and `gradle -p android :app:lint`, then install and exercise it on a real device/emulator. The current Arena environment does not have Java, Gradle, Kotlin, or Android SDK executables, so the app has **not** been compiled, installed, or tested here. Do not distribute it until those checks pass.

## Current functional boundary

1. Enter the HTTPS origin of a configured Lazaynova backend and sign in through `POST /v1/auth/sessions`.
2. The bearer session token is stored encrypted at rest. The password is not saved. Android backup is disabled so the ciphertext is not restored without its Keystore key.
3. Send a bounded user/assistant transcript to `POST /v1/lazaynova/chat/stream`. Actual provider deltas appear incrementally; an incomplete SSE stream is shown as incomplete, not presented as a successful answer. Cancelling the flow cancels the OkHttp call.
4. Chat messages are kept in memory only and limited to the backend's message/character bounds. Signing out clears the local encrypted session.

This client does **not** yet perform phone-control actions, accessibility automation, contact/media access, file/PPT generation, background monitoring, or model training. No proprietary model weights, training corpus, GPU cluster, or live backend/provider configuration are available in this repository/environment. Those capabilities must remain unavailable until real implementations, ownership/licensing, authorization, consent UX, and platform/integration tests exist.
