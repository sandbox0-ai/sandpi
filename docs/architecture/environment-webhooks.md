# Environment Webhooks

Environment Webhooks are Sandpi-owned Automation ingress. They let an external
system trigger a native coding-agent Turn without exposing a Sandbox process or
using Sandbox Functions as an HTTP control plane.

## Data flow and authority

```text
external event source
      |
      v
public Sandpi endpoint + bearer-token authentication
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

The endpoint is public only with respect to Sandpi's browser login. Every
request must still pass the Webhook's own bearer-token check.
The encrypted secret, definition, delivery ledger, cooldown buckets and run
ledger stay in Sandpi PostgreSQL. A Sandbox does not receive database or
Webhook credentials.

The run ledger stores delivery and recovery coordinates, not the resulting
conversation transcript. After a Turn is accepted, the native coding-agent
Thread remains the source of truth for messages, tool calls, reasoning and
output, just as it does for Schedules and interactive input.

## Request authentication and event envelope

Environment Webhooks are a generic ingress rather than provider integrations.
They accept JSON, form or text payloads authenticated with `Authorization:
Bearer <token>`. The `?token=` fallback exists for senders that cannot configure
headers, but query strings may be retained by upstream access logs.

Each accepted request is normalized into one internal event model:

- `X-Sandpi-Event`, then top-level `type`, `event` or `kind`, names the event;
- `Idempotency-Key`, `X-Sandpi-Delivery` or `X-Request-ID` identifies a delivery;
- when no stable identifier is supplied, Sandpi derives one from the body within
  a five-minute retry window;
- the default group is `default`; `groupKeyPath` can select a payload-specific
  value;
- the original parsed payload remains available under `/payload`.

GitHub Apps, Slack Apps and other installation-based products require a
separate account connection and resource-binding model. They must not be
represented as protocol options on a generic Webhook definition.

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
active runs for new-Session targets; a fixed Session is always limited to one
because the native harness admits only one active Turn per Session.

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
```

Each definition receives one unguessable ingress URL:

```text
POST /api/v1/webhooks/{endpointId}
```

Creating a Webhook without a supplied secret returns a generated bearer token
once. Supplied secrets must contain at least 16 characters. Secrets are
encrypted with `SANDPI_SECRET_KEY`; creating or rotating a Webhook fails closed
when credential encryption is not configured.

The Environment Settings UI provides generic sender instructions, one-time
token copying, trigger and cooldown editors, run admission controls, and recent
delivery and run history.
