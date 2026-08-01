# Environment Webhooks

Environment Webhooks are Sandpi-owned Automation ingress. They let an external
system trigger a native coding-agent Turn without exposing a Sandbox process or
using Sandbox Functions as an HTTP control plane.

## Data flow and authority

```text
external provider
      |
      v
public Sandpi endpoint + provider signature verification
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
request must still pass the Webhook's own cryptographic or bearer-token check.
The encrypted secret, definition, delivery ledger, cooldown buckets and run
ledger stay in Sandpi PostgreSQL. A Sandbox does not receive database or
provider credentials.

The run ledger stores delivery and recovery coordinates, not the resulting
conversation transcript. After a Turn is accepted, the native coding-agent
Thread remains the source of truth for messages, tool calls, reasoning and
output, just as it does for Schedules and interactive input.

## Provider adapters

One internal normalized event model lets policies work consistently while each
provider keeps its native authentication and event vocabulary:

| Provider | Verification | Normalized event type | Default grouping |
| --- | --- | --- | --- |
| GitHub | `X-Hub-Signature-256` HMAC-SHA256 over the raw body | `X-GitHub-Event`, with `.action` when present, such as `issues.opened` | repository plus issue, pull request, ref or event |
| Alertmanager | `Authorization: Bearer` or `?token=` | top-level `status`, normally `firing` or `resolved` | Alertmanager `groupKey` |
| Slack | `X-Slack-Signature` HMAC-SHA256 plus a five-minute timestamp window | Events API event type or `slash_command` | team, channel and thread or actor |
| Custom | `Authorization: Bearer` or `?token=` | `X-Sandpi-Event`, then `type`, `event` or `kind` | `custom`, unless a policy overrides it |

GitHub uses `X-GitHub-Delivery` for deduplication. Slack uses `event_id` or
`trigger_id`. Alertmanager and Custom accept `Idempotency-Key` or provider
request identifiers. When a source has no stable identifier, Sandpi derives one
from the body within a five-minute retry window. Slack URL verification is
answered synchronously after signature validation.

Bearer authorization is preferred for Alertmanager and Custom integrations;
the query-token fallback exists for senders that cannot configure headers, but
query strings may be retained by upstream access logs.

The built-in adapters intentionally stop at webhook setup. They do not require
a Sandpi-owned GitHub App or Slack OAuth installation. Providers not listed
above use Custom and may name an event with `X-Sandpi-Event`.

## Trigger policy

Trigger policy is evaluated only after verification and deduplication:

- `eventTypes` is an allowlist; an empty list accepts every normalized type;
- `conditions` compare normalized event fields through JSON Pointer with
  `equals`, `notEquals`, `contains` or `exists`;
- `mode=every` accepts every matching delivery;
- `mode=stateChange` accepts a group only when the configured state value
  differs from its last observed value;
- `groupKeyPath` and `statePath` may override provider defaults by reading the
  normalized envelope, including `/payload/...` paths.

State comparisons are durable and scoped by Webhook plus group key. Filtered
deliveries remain visible in the delivery ledger so a policy can be debugged
without storing anything in conversation history. Changing the provider or
trigger policy resets the saved comparison state atomically, so the revised
policy evaluates its first matching delivery from a clean baseline.

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
bucket closes. Every generated prompt clearly wraps provider content as
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

Creating GitHub, Alertmanager or Custom Webhooks without a supplied secret
returns a generated setup secret once. Slack requires the App signing secret.
Supplied secrets must contain at least 16 characters. Secrets are encrypted
with `SANDPI_SECRET_KEY`; creating or rotating a Webhook fails closed when
credential encryption is not configured.

The Environment Settings UI provides provider instructions, one-time secret
copying, trigger and cooldown editors, run admission controls, and recent
delivery and run history.
