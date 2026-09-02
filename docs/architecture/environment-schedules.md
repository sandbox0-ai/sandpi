# Legacy v1 Environment Schedules

> **Retired in Sandpi v2.** Schedule workers no longer start, the UI no longer
> exposes Schedule configuration, and execution-producing API mutations return
> HTTP 410. Read and cleanup endpoints remain temporarily available for
> migration. Future automation requires an explicit headless adapter and must
> not inject keystrokes into a human-operated TUI.

Environment Schedules are Sandpi-owned Automation. They trigger native coding
agent Turns for one Environment, but they are not timers running inside its
Sandbox and they are not a second conversation system.

## Ownership and truth

```text
user definition
      |
      v
Sandpi PostgreSQL schedule + occurrence ledger
      |
      v
native Codex Turn in the Environment Sandbox
      |
      v
native Thread remains conversation authority
```

- A Schedule belongs to one Environment and is authorized through that
  Environment's immutable user owner.
- PostgreSQL stores the Schedule name, prompt, timing, target and enabled state.
  The prompt is future user-authored input, so deployments must protect database
  access as they would protect source code or agent instructions.
- Claiming an occurrence copies its delivery configuration into an immutable run
  row. An edit can affect only later occurrences; it cannot change an already
  claimed input.
- Native Thread history remains authoritative after delivery. The run ledger
  stores status and native identifiers for recovery and audit, not a copy of the
  native response, reasoning, tool calls or transcript.
- Deleting a Schedule deletes its completed run history. Archiving or deleting
  a fixed target Session disables the Schedule instead of silently retargeting
  it. Unarchiving does not silently re-enable Automation.

## Timing contract

A Schedule uses one of two timing forms:

- `once`: one absolute future timestamp;
- `cron`: a deterministic five-field cron expression plus an IANA time zone.

Macros, a seconds field and hashed `H` fields are rejected. Cron calculation
uses the configured wall-clock time zone, including daylight-saving changes.

The Environment Settings UI presents common hourly, daily, weekday, weekly and
monthly recurrences as structured controls. It compiles those controls into the
same five-field cron contract and previews upcoming occurrences with the same
parser used by the server. Expressions that cannot be represented losslessly by
the structured editor remain available unchanged through Advanced mode. The UI
rule is not a second persisted scheduling model.

`next_run_at` is the earliest occurrence that has not yet been processed. When
Sandpi was unavailable across multiple cron intervals, startup reconciliation
claims only the latest missed occurrence and advances directly to the first
future occurrence. It does not replay every missed interval. A one-time
occurrence remains due until one server claims it.

The clock result is persisted before Sandpi contacts the Sandbox. Every server
replica may scan due rows, but a row lock, Schedule revision and the unique
`(schedule_id, scheduled_for)` key allow only one occurrence record to win.

## Targets and overlap

The default target is a newly reserved product Session for each run. Its product
Session id and native `threadSource` are deterministic for the run, so losing a
`thread/start` response reconciles the existing native Thread instead of
creating another one.

A Schedule may instead target one existing, non-archived Session in the same
Environment. This is useful for recurring work that needs native conversation
context.

The only overlap policy is `skip`:

- one Schedule never has two active runs;
- if the previous occurrence is still claimed or running, the new occurrence is
  persisted immediately with `skipped`;
- if a fixed target Session has another Turn in progress, that occurrence is
  also persisted as `skipped`;
- the running Turn is never interrupted merely because another interval became
  due.

The next future occurrence remains eligible after the active run finishes.

## Crash-safe delivery

Each run reserves stable coordinates before native delivery:

```text
run id
├── product Session id when target=newSession
├── JSON-RPC request id
├── Codex clientUserMessageId
└── Sandbox Supervisor stable input id
```

The worker then follows this order:

1. claim the occurrence and its short PostgreSQL lease;
2. ensure or reconcile the deterministic native Session;
3. read the native Thread for the stable client message id;
4. if already running or terminal, project that state into the run ledger;
5. otherwise persist the pending delivery coordinates and submit `turn/start`;
6. keep polling native Turn state until it is terminal.

A lease token fences every state transition. If a server stops, another replica
can claim the run only after the lease expires. A stale worker cannot later
finish it.

An ambiguous `turn/start` response is not permission to replay. While the same
Sandbox/Codex runtime epoch exists, Sandpi keeps reconciling native state. It
may retry the exact stable delivery only after that runtime epoch was replaced
and a native `thread/read` proves the client message absent. If the message is
present, its existing Turn is adopted. This avoids duplicate native inputs while
still recovering input that was lost with the failed runtime.

This is a durable delivery protocol, not a claim that arbitrary external side
effects are exactly once. Prompts should still make irreversible operations
idempotent or explicitly verified.

## Server and Sandbox lifecycle

The Schedule worker lives in the Sandpi server:

- pausing or replacing the Environment Sandbox does not remove definitions or
  run state;
- a due run can wake the normal Environment runtime path;
- a Sandpi server outage leaves due timestamps and active leases in PostgreSQL;
- startup scans expired active runs before claiming newer due occurrences;
- a Codex process or Sandbox runtime replacement uses the same native Session
  and Turn recovery evidence as an interactive request.

The API and Environment Settings UI expose Schedule CRUD and recent run history:

```text
GET/POST /api/v1/environments/{environmentId}/schedules
PUT/DELETE /api/v1/environments/{environmentId}/schedules/{scheduleId}
GET /api/v1/environments/{environmentId}/schedules/{scheduleId}/runs
```

All responses are owner-scoped and sent with `Cache-Control: no-store`.
