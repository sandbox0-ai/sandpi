# Sandpi

Sandpi is a remote, multi-harness coding agent application built on Sandbox0. The root route is the product workspace itself—there is no marketing landing page.

This first slice is a Next.js full-stack interaction prototype. The UI and API routes use mock data, while the backend already imports the local [`sdk-js`](../sdk-js) package behind a server-only integration boundary.

The MVP is a free public beta. It has no Sandpi subscription, pricing or product-usage quota. Sandpi does not include, resell or pay for model usage now or in future plans: users connect their own provider account through the native coding-agent harness, and provider billing and limits remain between that user and the provider.

## Local development

```bash
npm install
npm run dev -- --hostname 172.16.100.2 --port 3000
```

The mock UI does not require credentials. A Sandpi deployment selects its Sandbox0 control plane with server-side `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY` environment variables. These are operator configuration, never user Preferences or Environment settings. Legacy `SANDBOX0_BASE_URL`, `SANDBOX0_API_TOKEN` and `SANDBOX0_TOKEN` names remain accepted by the server-only adapter.

## Product model

- An **Environment** groups Sessions and binds a coding-agent harness, official agent authentication, Sandbox template and network policy.
- A **Session** gets an isolated Sandbox and a private fork of the Environment workspace Volume.
- `/workspace` is an arbitrary directory, not an implicit Git repository. It may contain zero, one or multiple repositories, which are discovered as nested workspace context rather than stored as Session-level branch state.
- Starting a new Session opens an empty conversation immediately; the first instruction triggers the Environment fork and Supervisor Session creation.
- The native coding-agent harness runs as a Sandbox0 Supervisor Session. Durable events allow the browser to disconnect and resume from a cursor.
- The native coding-agent harness and its official authentication are bound to an Environment. Sessions cannot switch harnesses. Codex is the first implementation; Claude Code, OpenCode and Pi are future Environment types.
- Sandpi standardizes the runtime plane, not the interaction plane. Conversation rendering, native items/tool calls, approvals, composer behavior, slash commands and model controls belong to each harness integration and are not normalized across agents.
- An Environment stores a reference to its harness authentication state, not provider secrets inside its rootfs or workspace baseline. Session and Turn snapshots must never copy harness credentials.
- Session Sandboxes have a fixed 30-day hard TTL.
- Sessions can be renamed, archived or pinned to the top of their own Environment group.
- Sessions can be searched across titles, Environments and coding agents from the Sidebar or with `Cmd/Ctrl+K`.
- A Web Terminal connects to the same Sandbox Supervisor boundary and spans the conversation plus inspector width.
- Personal Preferences live at `/preferences` as a standalone page.

The mock provisioning contract is implemented in `src/lib/environment-blueprint.ts` and exposed by `POST /api/sessions`.

## Harness integration boundary

- Shared code owns Environment and Session metadata, Sandbox lifecycle, Supervisor transport, durable sequence cursors, files, terminal, audit and metrics.
- `CodingSession.harnessState` is opaque to shared code. A thin dispatcher selects a complete harness-owned new-Session and conversation experience.
- Codex stores native app-server JSON-RPC notifications (`thread/*`, `turn/*`, `item/*`) and projects them only inside `src/harnesses/codex`.
- Production Codex protocol types must be generated from the exact pinned binary with `codex app-server generate-ts`; handwritten mock types are not a second protocol source of truth.
- Codex models come from native `model/list`. Slash commands, approvals and item renderers stay in the Codex module. A future harness implements its own equivalents rather than extending a shared catalog.

## Commercial boundary

- Self-hosted Sandpi is free and uses the operator-selected Sandbox0 deployment.
- The MVP Cloud public beta is free and deliberately has no subscription, price catalog or allowance ledger.
- A future paid Sandpi Cloud plan may charge for Sandpi-managed runtime, storage, networking and product services only. It must not bundle coding-agent model usage.
- Every provider account is authenticated through its native harness. Sandpi must not pool accounts, resell a consumer coding plan or present provider usage as Sandpi usage.
- Sandbox0 remains the infrastructure usage-truth layer. Any future Sandpi Cloud service entitlement belongs in the cloud backend rather than the open-source Sandbox0 metering ledger.

## Mock API

- `GET /api/bootstrap`
- `GET|POST /api/environments`
- `GET|POST /api/sessions`
- `GET /api/sessions/{sessionId}/events`
- `GET /api/sessions/{sessionId}/terminal`
- `GET /api/integrations/sandbox0/capabilities`
- `GET|PUT /api/preferences`

## Preferences and secrets

Preferences are split by ownership instead of putting every setting into one user record:

- Personal: language, time zone, send shortcut, appearance and notifications.
- Environment: coding agent, network policy, functions and sharing.
- Deployment administrator: Sandpi public URL, SSO, database, Sandbox0 API Host/API Key, secret delivery and observability.

Self-hosted Sandpi should inject Sandbox0 credentials through its deployment secret mechanism. Sandpi does not expose endpoint or credential overrides to end users, so all Sessions in one deployment use the operator-selected Sandbox0 control plane.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
