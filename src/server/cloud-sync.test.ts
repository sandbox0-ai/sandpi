import assert from "node:assert/strict";
import test from "node:test";

import type { SandpiCloudSnapshot } from "@/lib/types";
import {
  cloudSnapshotEtag,
  requestEtagMatches,
} from "@/server/cloud-sync";

const snapshot = {
  environments: [],
  sessions: [],
  preferences: {
    general: {
      language: "en",
      timeZone: "UTC",
      sendShortcut: "enter",
    },
    appearance: {
      theme: "system",
      density: "comfortable",
    },
  },
} satisfies SandpiCloudSnapshot;

test("cloud snapshot ETags are stable and content-addressed", () => {
  const etag = cloudSnapshotEtag(snapshot);
  assert.equal(etag, cloudSnapshotEtag(structuredClone(snapshot)));
  assert.notEqual(
    etag,
    cloudSnapshotEtag({
      ...snapshot,
      preferences: {
        ...snapshot.preferences,
        appearance: {
          ...snapshot.preferences.appearance,
          theme: "dark",
        },
      },
    }),
  );
});

test("conditional cloud sync accepts exact, listed, and wildcard ETags", () => {
  const etag = cloudSnapshotEtag(snapshot);
  assert.equal(requestEtagMatches(etag, etag), true);
  assert.equal(requestEtagMatches(`"old", ${etag}`, etag), true);
  assert.equal(requestEtagMatches(`W/${etag}`, etag), true);
  assert.equal(requestEtagMatches("*", etag), true);
  assert.equal(requestEtagMatches('"old"', etag), false);
  assert.equal(requestEtagMatches(undefined, etag), false);
});
