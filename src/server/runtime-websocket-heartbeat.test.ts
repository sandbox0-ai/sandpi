import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeWebSocketHeartbeat } from "./runtime-websocket-heartbeat";

function fixture() {
  let now = 0;
  let tick: (() => void) | undefined;
  let pong: (() => void) | undefined;
  let cleared = 0;
  let pings = 0;
  let terminations = 0;
  const handle = { unref() {} } as NodeJS.Timeout;
  const socket = {
    ping() {
      pings += 1;
    },
    terminate() {
      terminations += 1;
    },
    on(event: "pong", listener: () => void) {
      assert.equal(event, "pong");
      pong = listener;
    },
    off(event: "pong", listener: () => void) {
      assert.equal(event, "pong");
      if (pong === listener) pong = undefined;
    },
  };
  const options = {
    now: () => now,
    setInterval: ((listener: () => void) => {
      tick = listener;
      return handle;
    }) as typeof setInterval,
    clearInterval: ((value: ReturnType<typeof setInterval>) => {
      assert.equal(value, handle);
      cleared += 1;
    }) as typeof clearInterval,
  };
  return {
    socket,
    options,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    tick() {
      assert.ok(tick);
      tick();
    },
    pong() {
      assert.ok(pong);
      pong();
    },
    counts: () => ({ cleared, pings, terminations }),
    hasPongListener: () => Boolean(pong),
  };
}

test("keeps protocol pongs lifecycle-neutral and records explicit activity at a bounded rate", async () => {
  const context = fixture();
  let touches = 0;
  const heartbeat = new RuntimeWebSocketHeartbeat(
    context.socket,
    async () => {
      touches += 1;
      return true;
    },
    {
      ...context.options,
      pingIntervalMs: 1_000,
      activityTouchIntervalMs: 5_000,
    },
  );

  heartbeat.start();
  context.tick();
  context.advance(4_000);
  context.pong();
  assert.equal(touches, 0);

  heartbeat.markActivity();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(touches, 1);

  context.tick();
  context.advance(1_000);
  context.pong();
  heartbeat.markActivity();
  assert.equal(touches, 1);

  context.tick();
  context.advance(4_000);
  context.pong();
  heartbeat.markActivity();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(touches, 2);

  context.tick();
  context.advance(1_000);
  context.pong();
  heartbeat.markActivity();
  assert.equal(touches, 2);

  heartbeat.stop();
  assert.deepEqual(context.counts(), {
    cleared: 1,
    pings: 4,
    terminations: 0,
  });
  assert.equal(context.hasPongListener(), false);
});

test("terminates a connection that misses its protocol pong", () => {
  const context = fixture();
  const heartbeat = new RuntimeWebSocketHeartbeat(
    context.socket,
    async () => true,
    context.options,
  );

  heartbeat.start();
  context.tick();
  context.tick();

  assert.deepEqual(context.counts(), {
    cleared: 1,
    pings: 1,
    terminations: 1,
  });
  assert.equal(context.hasPongListener(), false);
});

test("keeps one activity touch in flight and retries a skipped touch", async () => {
  const context = fixture();
  let resolveTouch: ((value: boolean) => void) | undefined;
  let touches = 0;
  const heartbeat = new RuntimeWebSocketHeartbeat(
    context.socket,
    () => {
      touches += 1;
      return new Promise<boolean>((resolve) => {
        resolveTouch = resolve;
      });
    },
    {
      ...context.options,
      activityTouchIntervalMs: 1,
    },
  );

  heartbeat.start();
  context.advance(1);
  heartbeat.markActivity();
  heartbeat.markActivity();
  assert.equal(touches, 1);

  resolveTouch?.(false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  heartbeat.markActivity();
  assert.equal(touches, 2);
  heartbeat.stop();
});
