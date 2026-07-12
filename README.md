# Sandpi

Sandpi is a remote, multi-harness coding agent application built on Sandbox0. The root route is the product workspace itself—there is no marketing landing page.

This first slice is a Next.js full-stack interaction prototype. The UI and API routes use mock data, while the backend already imports the local [`sdk-js`](../sdk-js) package behind a server-only integration boundary.

## Local development

```bash
npm install
npm run dev -- --hostname 172.16.100.2 --port 3000
```

The mock UI does not require credentials. A Sandpi deployment selects its Sandbox0 control plane with server-side `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY` environment variables. These are operator configuration, never user Preferences or Environment settings. Legacy `SANDBOX0_BASE_URL`, `SANDBOX0_API_TOKEN` and `SANDBOX0_TOKEN` names remain accepted by the server-only adapter.

## Product model

- An **Environment** groups Sessions and binds a coding-agent harness, official agent authentication, Sandbox template and network policy.
- A **Session** gets an isolated Sandbox and a private fork of the Environment workspace Volume.
- Starting a new Session opens an empty conversation immediately; the first instruction triggers the Environment fork and Supervisor Session creation.
- The native coding-agent harness runs as a Sandbox0 Supervisor Session. Durable events allow the browser to disconnect and resume from a cursor.
- The native coding-agent harness and its official authentication are bound to an Environment. Sessions cannot switch harnesses. Codex is the first implementation; Claude Code, OpenCode and Pi are future Environment types.
- Session Sandboxes have a fixed 30-day hard TTL.
- Sessions can be renamed, archived or pinned to the top of their own Environment group.
- A Web Terminal connects to the same Sandbox Supervisor boundary and spans the conversation plus inspector width.
- Personal Preferences live at `/preferences` as a standalone page.

The mock provisioning contract is implemented in `src/lib/environment-blueprint.ts` and exposed by `POST /api/sessions`.

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
