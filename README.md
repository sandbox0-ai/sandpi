# Sandpi

Sandpi is a remote, multi-harness coding agent application built on Sandbox0. The root route is the product workspace itself—there is no marketing landing page.

This first slice is a Next.js full-stack interaction prototype. The UI and API routes use mock data, while the backend already imports the local [`sdk-js`](../sdk-js) package behind a server-only integration boundary.

Sandpi is an independent product with its own users, Teams, member Plan assignments, billing accounts and quotas. Sandpi does not include, resell or pay for model usage: provider billing and limits remain with the account authenticated through the native coding-agent harness.

## Local development

```bash
npm install
npm run dev -- --hostname 172.16.100.2 --port 3000
```

The mock UI does not require credentials. A Sandpi deployment selects its Sandbox0 control plane with server-side `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY` environment variables. These are operator configuration, never user Preferences or Environment settings. Legacy `SANDBOX0_BASE_URL`, `SANDBOX0_API_TOKEN` and `SANDBOX0_TOKEN` names remain accepted by the server-only adapter.

## Product model

- A **Team** is the only Sandpi tenant, resource-ownership and billing-attribution boundary. Every User belongs to at least one Team; signup atomically creates a one-member Team, Owner Membership and Free Plan assignment.
- A **Membership Plan** is scoped to one User-Team relationship. A Team can sponsor different Free, Pro or Max Plans for different members and receives their consolidated bill; the Team itself has no Plan.
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
- Team membership, per-member Plans, billing and quota state live at `/team` in the mock frontend.

The mock provisioning contract is implemented in `src/lib/environment-blueprint.ts` and exposed by `POST /api/sessions`.

## Harness integration boundary

- Shared code owns Environment and Session metadata, Sandbox lifecycle, Supervisor transport, durable sequence cursors, files, terminal, audit and metrics.
- `CodingSession.harnessState` is opaque to shared code. A thin dispatcher selects a complete harness-owned new-Session and conversation experience.
- Codex stores native app-server JSON-RPC notifications (`thread/*`, `turn/*`, `item/*`) and projects them only inside `src/harnesses/codex`.
- Production Codex protocol types must be generated from the exact pinned binary with `codex app-server generate-ts`; handwritten mock types are not a second protocol source of truth.
- Codex models come from native `model/list`. Slash commands, approvals and item renderers stay in the Codex module. A future harness implements its own equivalents rather than extending a shared catalog.

## Commercial boundary

- Sandpi owns its Plan-assignment, billing and quota ledger independently from Sandbox0. The current frontend uses mock Plan and usage data; billing is not connected yet.
- Free, Pro and Max are assigned to individual Team Memberships and funded by that Team's billing account. Paid assignments are billed monthly; every Membership has an independent weekly execution allowance plus its own concurrency and attributed snapshot limits.
- A User in multiple Teams can have a different Plan and quota in each Team. Entitlements never follow the global User across Team boundaries and cannot be combined between Teams.
- Runtime admission and usage records carry both `team_id` (payer and resource owner) and `membership_id` (Plan and quota consumer). Per-Turn attribution stays outside native coding-agent event payloads.
- Sandpi plans may charge for Sandpi-managed runtime, storage, networking and product services only. They must not bundle coding-agent model usage.
- Every provider account is authenticated through its native harness. Sandpi must not pool accounts, resell a consumer coding plan or present provider usage as Sandpi usage.
- Sandbox0 metering may supply infrastructure observations, but Sandpi's billing periods, Membership entitlements and admission decisions belong to the Sandpi backend.
- Self-hosted Sandpi uses the operator-selected Sandbox0 deployment. Sandbox0 and Sandpi remain separate products with separate identity and commercial boundaries.

## Identity and deployment boundary

- Sandpi Cloud uses a Sandpi-owned Auth0 tenant. It does not reuse Sandbox0 Cloud accounts, Auth0 applications, users or Teams.
- A private Sandpi deployment replaces the Cloud identity provider through Sandpi's OIDC contract. The required identity claims are `sub`, `email` and `email_verified`; `name`, `picture` and `groups` are optional inputs for profile and group-to-role mapping.
- OIDC identifies a Sandpi user. It never authenticates the deployment to Sandbox0 and never carries a Sandbox0 API key.
- `SANDBOX0_API_HOST` and `SANDBOX0_API_KEY` select one Sandbox0 deployment for the whole Sandpi backend. They are fixed at deployment time and are never configurable by a user or Team.
- Because a deployment API key does not identify a Sandpi Team, the Sandpi database is authoritative for Team ownership of every Environment, Sandbox, Volume and Session. The backend authorizes that ownership before making SDK calls.

## Mock API

- `GET /api/bootstrap`
- `GET|POST /api/environments`
- `GET|POST /api/sessions`
- `GET /api/teams`
- `PUT /api/teams/{teamId}/members/{membershipId}/plan`
- `GET /api/sessions/{sessionId}/events`
- `GET /api/sessions/{sessionId}/terminal`
- `GET /api/integrations/sandbox0/capabilities`
- `GET|PUT /api/preferences`

## Preferences and secrets

Preferences are split by ownership instead of putting every setting into one user record:

- Personal: language, time zone, send shortcut, appearance and notifications.
- Team: billing account, members, roles and per-Membership Plan assignments.
- Environment: coding agent, network policy, functions and sharing.
- Deployment administrator: Sandpi public URL, Cloud Auth0 or private OIDC, database, Sandbox0 API Host/API Key, secret delivery and observability.

Self-hosted Sandpi should inject Sandbox0 credentials through its deployment secret mechanism. Sandpi does not expose endpoint or credential overrides to end users, so all Sessions in one deployment use the operator-selected Sandbox0 control plane.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```
