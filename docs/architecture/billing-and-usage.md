# Billing and Sandbox0 usage boundary

Sandpi and Sandbox0 are independent products. Sandpi may use Sandbox0 data only
through a released official SDK contract. It must not receive a Sandbox0
PostgreSQL DSN, ClickHouse DSN, internal metering credential, or direct
`/internal/v1/metering/*` access.

## Authority

| State | Authority | Sandpi storage |
| --- | --- | --- |
| Sandbox lifecycle and allocated memory | Sandbox0 | Current Environment runtime coordinates |
| Raw usage events and closed usage windows | Sandbox0 | Imported consumer projection only |
| Sandbox-to-user attribution | Sandpi | Immutable Sandbox, Environment and user mapping |
| User plan and entitlement | Sandpi | Subscription projection and quota anchor |
| Price, payment and invoice | Stripe | Stripe ids and webhook projection |
| Coding-provider rate limits | Native agent harness | Not persisted as Sandpi quota |

Sandbox0 PostgreSQL is the producer-side metering projection and transactional
outbox. ClickHouse is its asynchronous query read model. Sandpi sees neither
store. Its deployment key calls `client.usage.listWindows()` in `sdk-js`; the
gateway derives the team from authentication and never accepts a caller-supplied
team id.

## Usage flow

```text
Sandbox0 lifecycle
  -> PostgreSQL metering projection/outbox
  -> ClickHouse usage windows
  -> public team-scoped SDK cursor
  -> Sandpi attributed closed-window projection
Sandbox0 current Sandbox lifecycle + claimedAt
  -> public Sandbox SDK resource
  -> Sandpi ephemeral open-allocation projection
closed windows + open allocations
  -> user entitlement admission
```

Sandpi imports only closed `sandbox.runtime_mib_milliseconds` windows. The
cursor and window ids are durable and idempotent. A window is stored only when
its Sandbox id has a Sandpi attribution, which excludes short-lived Codex
device-login runners and unrelated Sandboxes sharing the deployment team.

Closed windows are eventually consistent. For timely admission, Sandpi combines
the imported closed windows with an ephemeral observation of each currently
`running` or `provisioning` Sandbox allocation. The open interval begins at the
latest of the entitlement-period start, Sandbox0 `claimedAt`, and that
Sandbox's latest imported window end. The final boundary prevents overlap when
a closed window lands after a live observation or the Environment memory
allocation changes. For a quota period:

```text
used = imported closed Sandbox0 windows + current open Sandbox0 allocations
```

Sandpi does not persist a second set of local runtime segments. Live
observations are cached for at most five seconds per user and are discarded on
restart. Sandbox0 remains the lifecycle and usage authority. An active Sandbox
without a valid `claimedAt` fails admission closed instead of silently
under-counting usage.

## Entitlement periods

- Free: one account-anchored month, one runtime hour on one fixed 4 GiB
  Sandbox (4 GiB-hours), and one Environment.
- Plus: $99 billed annually, fixed seven-day periods from first paid
  activation, 250 GiB-hours per period, one Environment.
- Pro: $199 billed annually, fixed seven-day periods from first paid
  activation, 500 GiB-hours per period, ten Environments.
- Ultra: $499 billed annually, fixed seven-day periods from first paid
  activation, 1,250 GiB-hours per period, 25 Environments.
- Disabled billing: unlimited deployment entitlement with no usage polling.

The conversion is exact:

```text
1 GiB-hour = 1024 MiB * 60 * 60 * 1000
           = 3,686,400,000 MiB-milliseconds
```

Free month boundaries preserve the account creation time and clamp dates such
as the 31st to the target month's last day. Paid weekly periods do not reset on
process restart or invoice webhook timing.

## Admission and enforcement

Environment creation holds a user-scoped PostgreSQL advisory transaction lock,
recounts non-archived Environments and inserts only when the plan still permits
it. This prevents concurrent requests from exceeding the count.

Free Environment creation writes the fixed 4 GiB allocation explicitly. The
usage worker also reconciles existing or downgraded Free Environments under the
Environment lifecycle lock, applying the Sandbox0 memory update before saving
the new desired allocation.

The runtime entitlement gate is shared by:

- initial Environment provisioning and provisioning retry
- Workspace and Terminal runtime access
- Codex Session and Turn admission
- runtime repair and startup recovery

An over-limit operation cannot wake or allocate a Sandbox. The usage worker
also scans current Sandbox lifecycle projections on every enforcement tick,
including ticks where no new closed window was imported. It pauses violations
under the Environment lifecycle lock and records `quota` as a separate pause
reason. A later period reset does not eagerly resume anything; the next
authorized user operation uses Sandbox0's native auto-resume path.

Quota and plan blocks apply to compute, Agent, Terminal and Workspace writes,
but they do not make durable data look lost. File listing, preview and download
fall back to the Environment's persistent Sandbox0 Volume without resuming its
Sandbox. The Web IDE shows the block reason, usage and reset time, disables
edits, and links to plan management plus Environment data and backup controls.

## Stripe projection

The browser can request only a server-known `plus`, `pro` or `ultra` plan.
Stripe Price ids stay in deployment configuration and each maps to one annual
recurring Price. Checkout creation, subscription changes and Customer Portal
sessions are server-side operations. A non-Stripe manual entitlement may start
a fresh Checkout; it is never sent to Stripe as a subscription id.

Webhook events are signature-verified from the raw body and a minimal receipt
(event/type/object ids plus delivery metadata) is persisted before processing;
Sandpi does not retain the full Stripe payload. Event ids make retries
idempotent. Subscription events are re-retrieved from Stripe before projection
so a delayed event cannot overwrite newer state.

Upgrades to a higher paid tier request immediate invoicing and receive the new
entitlement only when Stripe reports the new Price. Downgrades to any lower
tier change the next billed Price without proration while Sandpi saves the old
entitlement until the current annual subscription period ends. The saved
effective time changes entitlement even if a renewal webhook is delayed.
`past_due` retains paid entitlement for 72 hours; afterward the user falls back
to Free.

## Failure behavior

- Missing SDK capability: Stripe mode refuses to start until a released
  `sandbox0` package exposes `client.usage.listWindows()`; no raw HTTP fallback
  exists.
- SDK usage temporarily unavailable after startup: the durable cursor is not
  advanced; current Sandbox observations still protect admission and the
  worker retries the closed-window import.
- Active Sandbox without a valid allocation start: runtime admission fails
  closed with an upstream projection error, preventing an unmetered wake-up.
- ClickHouse unavailable: Sandbox0 returns usage unavailable; Sandpi never
  bypasses the SDK to reach another store.
- Stripe unavailable: existing projected entitlement remains; Checkout and
  Portal calls fail without mutating it.
- Webhook processing failure: the event remains unprocessed with an attempt
  count and error for Stripe retry.
- Quota pause failure: observed runtime remains running and eligible for the
  next worker retry.

This separation lets Sandpi enforce its own product plans without turning
Sandbox0's operational Team Quota or metering internals into a second billing
model.
