# LazaynovaForFoundationModels

A Swift Package that adapts Lazaynova's authenticated Chat API to Apple's Foundation Models `LanguageModel` / `LanguageModelExecutor` interfaces (iOS 27 and macOS 27 SDKs). The API server performs the actual inference through its operator-configured Chat provider; this package contains no model weights or provider API keys.

## Use

Add this local package to an app target in Xcode, then construct the model after the user signs in and the app retrieves the returned bearer session token from its secure session store (for example, Keychain):

```swift
import Foundation
import FoundationModels
import LazaynovaForFoundationModels

let model = try LazaynovaLanguageModel(
    baseURL: URL(string: "https://your-configured-lazaynova-api.example")!,
    bearerSessionToken: sessionTokenFromKeychain
)
let session = LanguageModelSession(model: model)
let response = try await session.respond(to: "اكتب لي تطبيق Swift لقائمة المهام.")
print(response.content)
```

The base URL must be HTTPS and contain no path, credentials, query, or fragment. The token must be a user session returned by the backend login flow; do not hardcode it, ship an app-wide secret, or place it in a URL. The host app is responsible for securely storing, refreshing, and revoking user sessions. The server selects the Chat provider/model from operator configuration; there are no client-side `coderPro`/`searchV1` aliases or model overrides.

## Current support boundaries

- Text chat only. Tools, attachments, structured/guided generation, and multimodal transcript segments fail closed.
- User/assistant history is sent as a bounded conversation (up to 40 messages and 40,000 characters). Client-side Foundation Models instructions are not forwarded; server-side Chat instructions stay authoritative.
- The endpoint uses the configured provider's native SSE streaming protocol. Foundation Models receives real text deltas as they arrive; no completed answer is split into synthetic token chunks. The adapter requires provider completion, backend provenance, and the final `[DONE]` event before returning successfully.
- The package does not contain an API/app token or a private server deployment. Configure a real Chat provider on the backend and provision an authenticated user with the `CHAT` capability before use.

## Verification

The repository's current environment has no Swift/Xcode toolchain or iOS 27 SDK, so this package has not been compiled or tested here. Build it with Xcode and an iOS 27/macOS 27 SDK before distributing it.
