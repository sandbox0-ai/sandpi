# Environment Webhooks

Environment Webhooks let an external system trigger a native coding-agent Turn
without exposing a Sandbox process or using Sandbox Functions as an HTTP
control plane.

## Data flow and authority

```text
external event source
      |
      v
GitHub App signature or custom bearer-token authentication
      |
      v
PostgreSQL delivery ledger -> immediate run or fixed batch window
      |
      v
durable Automation run -> native Codex Turn
      |
      v
native Thread remains conversation authority
```

A custom request must pass its Webhook's bearer-token check. A GitHub request
must pass the deployment GitHub App's raw-body HMAC verification before Sandpi
acknowledges it. Definitions, encrypted custom secrets, source bindings,
deliveries, open batches and runs stay in Sandpi PostgreSQL. A Sandbox never
receives database, Webhook or GitHub App credentials.

The run ledger stores delivery and recovery coordinates, not the resulting
conversation transcript. After a Turn is accepted, the native coding-agent
Thread remains the source of truth for messages, tool calls, reasoning and
output, just as it does for Schedules and interactive input.

## Configuration model

A Webhook has four user-facing decisions:

1. **Event source** is either GitHub or a Custom URL.
2. **Prompt** tells Codex what to do with the received event.
3. **Delivery batching** either runs every delivery immediately or combines a
   fixed window into one run.
4. **Run destination** creates a Session per run, reuses a GitHub thread
   Session, or targets an existing Session.

There is no generic trigger-policy language. Custom URLs accept every
authenticated request. GitHub Webhooks accept only the event actions selected
inside their GitHub source configuration. Payload conditions, JSON Pointer
state tracking, custom grouping, throttle/debounce combinations, suppression
behavior and configurable run-admission limits are intentionally not part of
the contract.

`0063_simplify_environment_webhooks.sql` deletes the unreleased definitions and
their policy state before removing the old schema. It does not translate or
preserve the earlier experimental configuration model.

## Webhook sources

The source is immutable after creation because changing it would also change
the authentication and resource authority of the definition.

### GitHub App

GitHub is a direct source, not a protocol option on the Custom URL. Each GitHub
Webhook selects one connection, 1-100 repositories and at least one supported
event action. Unselected events do not create a per-Webhook delivery or run.

A Sandpi deployment owns one GitHub App configuration. A signed-in user starts
an installation with a short-lived, hashed `state`. GitHub returns an OAuth
authorization code and installation id. Sandpi exchanges the code, verifies
that the authorizing GitHub user can access that exact installation, imports
its repository inventory, and discards the user access token. No GitHub token
is persisted or projected into an Environment.

GitHub Apps expose one deployment-level event URL. Sandpi verifies and durably
records a global receipt before responding, then asynchronously routes the
event by installation and repository. The GitHub delivery id is idempotent
globally; the Environment Webhook delivery ledger is idempotent per Webhook.
Installation suspension or deletion disables bound definitions. An explicit
Sandpi disconnect stays disconnected until the user reconnects.

The supported events cover pull requests, pull-request reviews and review
comments, issues, and issue/PR comments. The GitHub App needs read-only
**Pull requests** and **Issues** repository permissions, plus the mandatory
read-only Metadata permission. Subscribe it to Pull request, Pull request
review, Pull request review comment, Issues and Issue comment events.

Configure these deployment values together:

```text
SANDPI_GITHUB_APP_SLUG
SANDPI_GITHUB_CLIENT_ID
SANDPI_GITHUB_CLIENT_SECRET
SANDPI_GITHUB_WEBHOOK_SECRET
```

The callback URL is
`https://<sandpi-host>/api/v1/webhook-sources/github/callback`; enable “Request
user authorization (OAuth) during installation.” The active Webhook URL is
`https://<sandpi-host>/api/v1/webhook-sources/github/events`, configured with
the same webhook secret. Partial deployment configuration fails startup.

This connection authorizes Webhook delivery only. It does not grant the coding
agent GitHub API or repository-clone credentials. Those remain separate
Environment credential and network-policy decisions.

### Custom URL

The Custom URL accepts every JSON, form or text request authenticated with
`Authorization: Bearer <token>`. The `?token=` fallback exists for senders that
cannot configure headers, but query strings may be retained by upstream access
logs.

`X-Sandpi-Event`, then a top-level `type`, `event` or `kind`, names the event in
history and in the agent prompt. It does not filter the request.
`Idempotency-Key`, `X-Sandpi-Delivery` or `X-Request-ID` identifies a delivery.
When none is supplied, Sandpi derives an id from the body within a five-minute
retry window.

## Delivery batching

`batchWindowSeconds` has one meaning:

- `0` creates one queued run for every accepted delivery;
- a positive value starts a fixed window with the first delivery and creates
  one run containing all deliveries accepted before that deadline.

GitHub events are batched separately per pull request, issue, or repository.
All requests to one Custom URL share its batch. A batch retains at most the 50
most recent payloads while preserving the total event count.

An open batch snapshots its execution configuration and deadline. Editing the
Webhook does not move that deadline or change the prompt and destination used
when the batch becomes a run. New groups use the new definition immediately.
Every generated prompt wraps event-source content as untrusted external data.

## Run admission and recovery

Run admission is deliberately fixed instead of user-configurable:

- one run per Webhook may be claimed or running at a time;
- at most 100 queued, active, or batch-reserved runs may be pending;
- busy target Sessions queue and retry rather than dropping the event.

A GitHub Webhook can use `sourceThread` to map each pull request or issue to one
durable product Session. Comments, reviews and updates for that thread reuse
the Session. Archiving or deleting it removes the binding, so the next event
creates a fresh native Session. Archiving or deleting a fixed target disables
the Webhook; Sandpi never silently retargets it.

Deleting a Webhook disables ingress and cancels unopened batches and queued
runs. A claimed or running run may reconcile its native Turn before the deleted
definition and history are removed.

Each run reserves a Session id and stable native request, client-message and
Sandbox input ids before delivery. The shared Automation executor reads native
state before submitting, leases every transition and reconciles ambiguous
acceptance after a server or Sandbox restart. This provides durable,
deduplicated input delivery, not exactly-once guarantees for arbitrary side
effects performed by the agent.

## API

Management endpoints are Environment-owner scoped:

```text
GET/POST /api/v1/environments/{environmentId}/webhooks
PUT/DELETE /api/v1/environments/{environmentId}/webhooks/{webhookId}
PUT /api/v1/environments/{environmentId}/webhooks/{webhookId}/secret
GET /api/v1/environments/{environmentId}/webhooks/{webhookId}/runs
GET /api/v1/environments/{environmentId}/webhooks/{webhookId}/deliveries
GET /api/v1/environments/{environmentId}/webhook-sources/github
POST /api/v1/environments/{environmentId}/webhook-sources/github/install
DELETE /api/v1/environments/{environmentId}/webhook-sources/github/connections/{connectionId}
```

Each Custom URL receives one unguessable ingress endpoint:

```text
POST /api/v1/webhooks/{endpointId}
```

Creating a Custom URL without a supplied secret returns a generated bearer
token once. Supplied secrets must contain at least 16 characters. Secrets are
encrypted with `SANDPI_SECRET_KEY`; creation and rotation fail closed when
credential encryption is not configured.

GitHub uses these public deployment endpoints instead:

```text
GET  /api/v1/webhook-sources/github/callback
POST /api/v1/webhook-sources/github/events
```
