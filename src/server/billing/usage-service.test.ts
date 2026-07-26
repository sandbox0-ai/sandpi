import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAdapter } from "@/server/runtime/types";

import type { BillingQuotaService } from "./quota-service";
import type {
  BillingRepository,
  UsageWindowImport,
} from "./repository";
import { SandboxUsageService } from "./usage-service";

const logger = {
  info() {},
  warn() {},
};

test("imports attributed Sandbox0 windows through the runtime SDK and enforces quota", async () => {
  const calls: {
    cursors: Array<string | undefined>;
    imports: Array<{
      source: string;
      cursor: string;
      windows: readonly UsageWindowImport[];
    }>;
    pauses: string[];
  } = {
    cursors: [],
    imports: [],
    pauses: [],
  };
  const repository = {
    async usageCursor(source: string) {
      assert.equal(source, "sandbox0");
      return "cursor-before";
    },
    async importUsageWindows(
      source: string,
      cursor: string,
      windows: readonly UsageWindowImport[],
    ) {
      calls.imports.push({ source, cursor, windows });
    },
  } as unknown as BillingRepository;
  const runtime = {
    mode: "sandbox0",
    async listUsageWindows(options?: { cursor?: string }) {
      calls.cursors.push(options?.cursor);
      if (options?.cursor === "cursor-before") {
        return {
          windows: [
            {
              windowId: "window-one",
              windowType: "sandbox.runtime_mib_milliseconds",
              sandboxId: "sandbox-one",
              windowStart: new Date("2026-07-26T00:00:00.000Z"),
              windowEnd: new Date("2026-07-26T01:00:00.000Z"),
              value: 3_686_400_000,
              unit: "mib_milliseconds",
              recordedAt: new Date("2026-07-26T01:00:01.000Z"),
            },
            {
              windowId: "window-wrong-type",
              windowType: "sandbox.runtime_milliseconds",
              sandboxId: "sandbox-one",
              windowStart: new Date("2026-07-26T00:00:00.000Z"),
              windowEnd: new Date("2026-07-26T01:00:00.000Z"),
              value: 1,
              unit: "milliseconds",
              recordedAt: new Date("2026-07-26T01:00:01.000Z"),
            },
          ],
          nextCursor: "cursor-after",
        };
      }
      return { windows: [], nextCursor: "" };
    },
  } as unknown as RuntimeAdapter;
  const quota = {
    async runningEnvironmentViolations() {
      return ["environment-one"];
    },
  } as unknown as BillingQuotaService;
  const service = new SandboxUsageService(
    repository,
    quota,
    runtime,
    logger,
    15_000,
  );
  service.setPauseForQuota(async (environmentId) => {
    calls.pauses.push(environmentId);
  });

  await service.runOnce();

  assert.deepEqual(calls.cursors, ["cursor-before", "cursor-after"]);
  assert.equal(calls.imports.length, 1);
  assert.equal(calls.imports[0]?.source, "sandbox0");
  assert.equal(calls.imports[0]?.cursor, "cursor-after");
  assert.deepEqual(
    calls.imports[0]?.windows.map((window) => window.windowId),
    ["window-one"],
  );
  assert.deepEqual(calls.pauses, ["environment-one"]);
});

test("does not query usage when the Sandbox0 runtime SDK is unconfigured", async () => {
  let listed = false;
  const repository = {
    async usageCursor() {
      assert.fail("unconfigured runtime must not advance an import cursor");
    },
  } as unknown as BillingRepository;
  const runtime = {
    mode: "unconfigured",
    async listUsageWindows() {
      listed = true;
      throw new Error("must not be called");
    },
  } as unknown as RuntimeAdapter;
  const quota = {
    async runningEnvironmentViolations() {
      return [];
    },
  } as unknown as BillingQuotaService;
  const service = new SandboxUsageService(
    repository,
    quota,
    runtime,
    logger,
    15_000,
  );

  await service.runOnce();

  assert.equal(listed, false);
});

test("still enforces projected usage while the SDK query is unavailable", async () => {
  const pauses: string[] = [];
  const repository = {
    async usageCursor() {
      return "";
    },
  } as unknown as BillingRepository;
  const runtime = {
    mode: "sandbox0",
    async listUsageWindows() {
      throw new Error("usage backend unavailable");
    },
  } as unknown as RuntimeAdapter;
  const quota = {
    async runningEnvironmentViolations() {
      return ["environment-one"];
    },
  } as unknown as BillingQuotaService;
  const service = new SandboxUsageService(
    repository,
    quota,
    runtime,
    logger,
    15_000,
  );
  service.setPauseForQuota(async (environmentId) => {
    pauses.push(environmentId);
  });

  await assert.rejects(service.runOnce(), /usage backend unavailable/);

  assert.deepEqual(pauses, ["environment-one"]);
});
