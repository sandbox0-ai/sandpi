# Environment Webhooks

Environment Webhooks are Sandpi-owned Automation ingress. They let an external
system trigger a native coding-agent Turn without exposing a Sandbox process or
using Sandbox Functions as an HTTP control plane.

## Data flow and authority

```text
external event source
      |
      v
GitHub App signature or custom bearer-token authentication
      |
      v
PostgreSQL delivery ledger -> trigger policy -> cooldown bucket
      |
      v
durable Automation run -> native Codex Turn
      |
      v
native Thread remains conversation authority
```

Ingress endpoints are public only with respect to Sandpi's browser login. A
custom request must pass its Webhook's bearer-token check. A GitHub request must
pass the deployment GitHub App's raw-body HMAC verification before it is
acknowledged. The encrypted custom secret, source binding, definition, delivery
ledger, cooldown buckets and run ledger stay in Sandpi PostgreSQL. A Sandbox
does not receive database, Webhook or GitHub App credentials.

The run ledger stores delivery and recovery coordinates, not the resulting
conversation transcript. After a Turn is accepted, the native coding-agent
Thread remains the source of truth for messages, tool calls, reasoning and
output, just as it does for Schedules and interactive input.

## Webhook sources

The Webhook product owns two source types. The source is immutable after
creation because changing it would also change the authentication and resource
authority of the definition.

### GitHub App

GitHub is a direct Webhook source, not a protocol option applied to a generic
payload. A Sandpi deployment owns one GitHub App configuration. A signed-in
Sandpi user starts an installation with a short-lived, hashed `state`. GitHub
returns an OAuth authorization code and installation id. Sandpi exchanges the
code, verifies that the authorizing GitHub user can access that exact
installation, imports its current repository inventory, and discards the user
access token. No GitHub token is persisted or projected into an Environment.

GitHub Apps expose one deployment-level event URL rather than a URL per
repository. Sandpi therefore verifies and durably records a global receipt
before responding, then asynchronously fans the event out by installation and
repository to enabled Environment Webhooks. The GitHub delivery id is
idempotent globally, while the existing delivery ledger remains idempotent per
Webhook. Installation suspension/deletion disables bound definitions; an
explicit Sandpi disconnect remains disconnected until the user reconnects.
Repository-access events refresh metadata only for repositories that the user
already proved accessible through OAuth and remove revoked bindings. They never
expand another user's selectable inventory; newly added repositories require
the user to reconnect and prove access.

Each GitHub Webhook selects one connection, 1-100 repositories and an explicit
event allowlist. The initial supported events cover pull requests, pull-request
reviews and review comments, issues, and issue/PR comments. The GitHub App needs
read-only **Pull requests** and **Issues** repository permissions (plus the
mandatory read-only Metadata permission) and subscriptions for Pull request,
Pull request review, Pull request review comment, Issues and Issue comment.

Configure these deployment values together:

```text
SANDPI_GITHUB_APP_SLUG
SANDPI_GITHUB_CLIENT_ID
SANDPI_GITHUB_CLIENT_SECRET
SANDPI_GITHUB_WEBHOOK_SECRET
```

The GitHub App callback URL is
`https://<sandpi-host>/api/v1/webhook-sources/github/callback`; enable “Request
user authorization (OAuth) during installation.” Its active Webhook URL is
`https://<sandpi-host>/api/v1/webhook-sources/github/events`, configured with
the same webhook secret. Partial deployment configuration fails startup.

This connection authorizes Webhook delivery only. It does not grant the coding
agent GitHub API or repository-clone credentials. Those remain separate
Environment credential and network-policy decisions.

### Custom URL

The custom source accepts JSON, form or text payloads authenticated with
`Authorization: Bearer <token>`. The `?token=` fallback exists for senders that
cannot configure headers, but query strings may be retained by upstream access
logs.

## Normalized event envelope

Each accepted request is normalized into one internal event model:

- `X-Sandpi-Event`, then top-level `type`, `event` or `kind`, names the event;
- `Idempotency-Key`, `X-Sandpi-Delivery` or `X-Request-ID` identifies a delivery;
- when no stable identifier is supplied, Sandpi derives one from the body within
  a five-minute retry window;
- the default group is `default`; `groupKeyPath` can select a payload-specific
  value;
- the original parsed payload remains available under `/payload`.

Provider metadata is retained in the normalized source envelope for prompts and
conditions without leaking provider credentials.

## Trigger policy

Trigger policy is evaluated only after verification and deduplication:

- `eventTypes` is an allowlist; an empty list accepts every normalized type;
- `conditions` compare normalized event fields through JSON Pointer with
  `equals`, `notEquals`, `contains` or `exists`;
- `mode=every` accepts every matching delivery;
- `mode=stateChange` accepts a group only when the configured state value
  differs from its last observed value;
- `groupKeyPath` and `statePath` may override envelope defaults by reading the
  normalized envelope, including `/payload/...` paths.

State comparisons are durable and scoped by Webhook plus group key. Filtered
deliveries remain visible in the delivery ledger so a policy can be debugged
without storing anything in conversation history. Changing the trigger policy
resets the saved comparison state atomically, so the revised policy evaluates
its first matching delivery from a clean baseline.

## Cooldown policy

Trigger and cooldown are separate. A matching delivery first passes the
trigger policy, then enters one of these modes:

- `none`: create one run immediately;
- `throttle`: create the first run immediately, then hold a fixed window;
- `debounce`: wait until no event has arrived for the configured duration;
- `batch`: collect events in a fixed window before creating one run.

Events arriving in an open window use one behavior:

- `suppress`: record the delivery but do not add it to a later run;
- `latest`: retain only the most recent payload;
- `merge`: retain up to 50 recent payloads and preserve the total event count.

A bucket snapshots its mode, duration, behavior and execution configuration.
New deliveries still pass the current trigger policy before joining an open
bucket, but edits cannot move its deadline or change how its accepted input will
run. The revised cooldown and execution settings take full effect after that
bucket closes. Every generated prompt clearly wraps event-source content as
untrusted external data rather than instructions.

## Run admission and recovery

`maxPendingRuns` bounds queued, claimed and running work, including a run slot
already reserved by a non-empty cooldown bucket. `maxConcurrentRuns` bounds
active runs for new-Session and source-thread targets; a fixed Session is always
limited to one because the native harness admits only one active Turn per
Session.

A GitHub definition can use `sourceThread` to map every pull request or issue to
one durable product Session. Comments, reviews and updates for the same thread
reuse that Session, while unrelated repositories and thread numbers remain
isolated. Archiving or deleting the Session removes the binding, so the next
event creates a fresh native Session rather than targeting archived state.

When a fixed target is busy, `overlapPolicy=queue` keeps the run durable and
retries it, while `skip` records a terminal skipped run. Archiving or deleting a
fixed target disables the Webhook. It is never silently retargeted.

Deleting a Webhook disables ingress and cancels unopened cooldown buckets and
queued runs. A run already claimed or running is allowed to reconcile its
native Turn before the deleted definition and its history are removed.

Each run reserves a product Session id when required and stable native request,
client-message and Sandbox input ids before delivery. The shared Automation
executor reads native state before submitting, leases every transition and
reconciles ambiguous acceptance after a server or Sandbox restart. It provides
durable, deduplicated input delivery, not exactly-once guarantees for arbitrary
side effects performed by the agent.

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

Each custom definition receives one unguessable ingress URL:

```text
POST /api/v1/webhooks/{endpointId}
```

Creating a Webhook without a supplied secret returns a generated bearer token
once. Supplied secrets must contain at least 16 characters. Secrets are
encrypted with `SANDPI_SECRET_KEY`; creating or rotating a Webhook fails closed
when credential encryption is not configured.

GitHub uses these two public deployment endpoints instead:

```text
GET  /api/v1/webhook-sources/github/callback
POST /api/v1/webhook-sources/github/events
```

The Environment Settings UI provides GitHub installation, repository and event
selection, custom sender instructions and one-time token copying, trigger and
cooldown editors, run admission controls, and recent delivery and run history.
