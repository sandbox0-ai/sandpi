# Sandpi

Sandpi is a remote, multi-harness coding agent application built on Sandbox0. The root route is the product workspace itself—there is no marketing landing page.

This first slice is a Next.js full-stack interaction prototype. The UI and API routes use mock data, while the backend already imports the local [`sdk-js`](../sdk-js) package behind a server-only integration boundary.

## Local development

```bash
npm install
npm run dev -- --hostname 172.16.100.2 --port 3000
```

The mock UI does not require credentials. For the bootstrap connection in a private Sandpi deployment, copy `.env.example` to `.env.local` and set `SANDBOX0_API_HOST` plus `SANDBOX0_API_KEY`. Legacy `SANDBOX0_BASE_URL`, `SANDBOX0_API_TOKEN` and `SANDBOX0_TOKEN` names remain accepted by the server-only adapter.

## Product model

- An **Environment** is a versioned baseline: rootfs snapshot, seed `/workspace` Volume, credential revision, initialization and network policy.
- A named **Sandbox0 connection** contains an API Host and a server-held API Key. An Environment binds one connection at creation, so all of its Sandboxes, Volumes and Sessions stay in the same Sandbox0 control plane. Rotating a key does not change that binding.
- A **Session** gets an isolated Sandbox and a private fork of the Environment workspace Volume.
- Starting a new Session opens an empty conversation immediately; the first instruction triggers the Environment fork and Supervisor Session creation.
- The native coding-agent harness runs as a Sandbox0 Supervisor Session. Durable events allow the browser to disconnect and resume from a cursor.
- The native coding-agent harness and its official authentication are bound to an Environment. Sessions cannot switch harnesses. Codex is the first implementation; Claude Code, OpenCode and Pi are future Environment types.
- Session Sandboxes have a fixed 30-day hard TTL.
- A Web Terminal connects to the same Sandbox Supervisor boundary and spans the conversation plus inspector width.

The mock provisioning contract is implemented in `src/lib/environment-blueprint.ts` and exposed by `POST /api/sessions`.

## Mock API

- `GET /api/bootstrap`
- `GET|POST /api/environments`
- `GET|POST /api/sessions`
- `GET /api/sessions/{sessionId}/events`
- `GET /api/sessions/{sessionId}/terminal`
- `GET /api/integrations/sandbox0/capabilities`
- `GET|PUT /api/preferences`
- `POST /api/preferences/sandbox0-connections`
- `POST /api/preferences/sandbox0-connections/test`

## Preferences and secrets

Preferences are split by ownership instead of putting every setting into one user record:

- Personal: language, time zone, send shortcut, appearance and notifications.
- Team/control plane: named Sandbox0 connections and the connection used by new Environments.
- Environment: coding agent, initialization, network policy, functions and sharing.
- Deployment administrator: Sandpi public URL, SSO, database, secret backend, encryption keys and the allowlist used by connection probes.

The current connection routes are mock contracts. They validate API Host input and only return API-key status plus the last four characters; no plaintext key enters bootstrap data or browser storage. Production persistence must replace the mock response with a server-side secret reference protected by envelope encryption or a KMS. A live “Test connection” implementation must run in a restricted server-side probe service with redirect blocking, timeouts, response limits and deployment-level host/CIDR policy to avoid SSRF. Private address ranges cannot simply be rejected because self-hosted Sandbox0 is a supported use case.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
