# ZAYED OS Device-Control Plan

**Product:** Lazaynova / ZAYED AI

**Tagline:** Private. Autonomous. Yours.

**Status:** Design and safety gates only; no Android or desktop control driver is enabled.

This plan maps the proposed Omnipotent Agent Core onto the existing Lazaynova backend while retaining user consent, least privilege, and a truthful unavailable state. It is not an authorization to create unattended, covert, or unrestricted operating-system control.

## Current implementation map

| Plan item | Repository status |
|---|---|
| Fastify API + PostgreSQL + Redis/BullMQ | Implemented as the general backend/task foundation. |
| HTTP capability permission and engine preflight | Implemented: missing grant returns `403`; absent/unready driver returns `501` before task creation. |
| Worker re-check, task state, verifier and audit | Implemented for registered task drivers; no device driver is registered. |
| Authenticated WebSocket status events | Implemented with one-time tickets, owner-scoped status-only events, PostgreSQL `LISTEN/NOTIFY`, and polling fallback; live database/reconnect validation remains pending. |
| LLM intent router and action DAG | Not implemented. Current router is deterministic capability classification, not an LLM planner. |
| Android Accessibility/Contacts/MediaStore/ADB | No native phone-control driver is implemented. An initial authenticated Compose chat client now exists under `android/`, but it is uncompiled; Java/Gradle/Android SDK toolchains are absent. |
| Desktop UI automation or elevated service | Not implemented. |
| Screen capture/OCR/coordinate mapping and OS input | Not implemented. |

## Mandatory operating boundaries

1. **Device ownership and consent:** pair only a device the signed-in user owns or administers. A device owner explicitly enables and can revoke each integration through the OS settings. No stealth persistence or permission bypass.
2. **Visible, user-controlled sessions:** automation runs only in a foreground, user-visible session. The user reviews the proposed action plan and confirms consequential actions before execution. The user can stop a run at any time.
3. **Least privilege:** request Android runtime permissions only for a capability the user enables. Do not request broad storage access when Android Photo Picker/MediaStore scoped access suffices. Contact access is opt-in and separate from UI automation.
4. **No ambient surveillance:** no continuous 200–500 ms screenshot loop or background UI-tree harvesting. Capture a screen only when a user-approved task needs it; minimize retention, redact sensitive surfaces, and never collect passwords, OTPs, payment details, or unrelated app content.
5. **No privilege escalation:** no root, `sudo`, administrator service, arbitrary shell, or silent ADB control. Development ADB pairing must use Android's standard user-mediated pairing flow on an owned device; it is not a production privilege bypass.
6. **Narrow actions:** use typed, allowlisted operations rather than arbitrary coordinates or commands. Launching an app is allowed only by explicit user request; do not force-close other apps. Never auto-dismiss ads, permission dialogs, security prompts, or purchase/financial confirmations. UI recovery may retry only an idempotent action after re-checking the visible screen and must stop for ambiguous state.
7. **Evidence and privacy:** keep task provenance and minimal execution logs. Screenshots are opt-in evidence, scoped to the task, access-controlled, and retention-limited. No screenshot or UI evidence means the task must not claim visual completion.

## Staged implementation

### Control Gateway (backend)

- Reuse the existing Fastify/PostgreSQL/Redis/BullMQ services; do not add a parallel Express server or console-log repository.
- Add authenticated device registration/revocation, device-scoped capability grants, and expiring user approvals bound to an exact proposed action plan.
- Re-check account grant, device grant, approval expiry, driver readiness, and action allowlist synchronously before durable task acceptance; repeat authorization and readiness checks in the worker.
- Add authenticated WebSocket task-status events only after defining an owner-scoped subscription protocol; preserve task polling as the fallback.
- Use an action audit trail that records actor, device, capability, plan digest, approval, timestamps, evidence references, and terminal result without recording secrets or unrelated screen contents.

### Android first

- Build and verify the initial native Compose/Kotlin module at `android/`; the current client only supports authenticated server Chat and requests no device-control permission.
- Prefer direct, scoped platform APIs for Contacts and MediaStore/Photo Picker. App launch uses explicit Android intents.
- If Accessibility is later approved, show an in-app disclosure and require the user to enable the service in system settings. Restrict it to user-approved foreground tasks and typed actions. Do not implement a background screen crawler.
- Do not build a general-purpose in-app ADB command executor. ADB remains a user-controlled development/debugging tool, not the production automation backend.

### Desktop later

- Start with standard-user, per-application allowlisted automation and a visible approval prompt.
- Use documented platform accessibility APIs; do not install a privileged daemon, request `sudo`/Administrator, or execute arbitrary shell commands.
- Require platform-specific opt-in and stop safely when the UI state is ambiguous or a security-sensitive prompt appears.

### Planner, perception and verification

- Introduce an LLM planner only behind the existing provider-neutral AI Gateway. It produces a reviewable, typed action DAG; it cannot invoke OS controls directly.
- Prefer semantic platform APIs and accessibility labels over OCR/coordinates. A vision/OCR adapter, if added, processes only task-scoped user-approved captures.
- Verify each operation against a result specific to that action. A plausible screenshot alone is not proof of a contact write, file save, or successful app operation.
- Keep popup handling limited to safe, reversible states in the user's own foreground workflow; stop rather than dismiss ads, permission prompts, or security confirmations.

## Readiness gates before any native-control task can be enabled

- Android/Desktop client shows the complete proposed action plan and explicit approval UI.
- Capability and device grants are revocable and expire; API and worker both enforce them.
- Tests cover authorization denial, expired/revoked approval, driver loss, task cancellation, sensitive-surface rejection, replay/idempotency, audit evidence, and recovery from stale UI.
- A real driver is registered and readiness reflects its live permissions and connection state; environment flags alone never claim readiness.
- Threat-model/privacy review and platform permission disclosures are complete. Until then, OS-control capabilities remain unavailable (`501 CAPABILITY_UNAVAILABLE`).
