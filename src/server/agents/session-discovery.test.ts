import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NATIVE_SESSION_DISCOVERY_SCRIPT,
  nativeSessionCommand,
  nativeSessionDiscoverySchema,
} from "./session-discovery";

const id = "12345678-1234-4234-8234-123456789abc";
for (const agent of ["codex", "claude-code", "pi"] as const) {
  test(`discovers ${agent} history without exposing messages or following symlinks`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "sandpi-index-"));
    try {
      const dir = path.join(
        root,
        agent === "claude-code" ? "projects" : "sessions",
      );
      mkdirSync(dir);
      const rows =
        agent === "codex"
          ? [
              { type: "session_meta", payload: { id } },
              {
                type: "response_item",
                payload: {
                  role: "user",
                  content: [{ type: "input_text", text: "Build sidebar" }],
                },
              },
              {
                type: "response_item",
                payload: {
                  role: "assistant",
                  content: [
                    { type: "output_text", text: "private assistant text" },
                  ],
                },
              },
            ]
          : agent === "pi"
            ? [
                { type: "session", id },
                {
                  type: "message",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "Build sidebar" }],
                  },
                },
                { type: "session_info", name: "Named task" },
              ]
            : [
                {
                  type: "user",
                  sessionId: id,
                  message: { role: "user", content: "Build sidebar" },
                },
                {
                  type: "custom-title",
                  sessionId: id,
                  customTitle: "Named task",
                },
              ];
      writeFileSync(
        path.join(dir, "history.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n{partial",
      );
      writeFileSync(
        path.join(root, "secret.jsonl"),
        JSON.stringify({
          type: "session",
          id: "aaaaaaaa-1234-4234-8234-123456789abc",
        }),
      );
      symlinkSync(
        path.join(root, "secret.jsonl"),
        path.join(dir, "linked.jsonl"),
      );
      const result = nativeSessionDiscoverySchema.parse(
        JSON.parse(
          execFileSync(
            process.execPath,
            ["-e", NATIVE_SESSION_DISCOVERY_SCRIPT, root, agent],
            { encoding: "utf8" },
          ),
        ),
      );
      assert.equal(result.sessions.length, 1);
      assert.equal(result.sessions[0].id, id);
      assert.equal(
        result.sessions[0].title,
        agent === "codex" ? "Build sidebar" : "Named task",
      );
      assert.ok(!JSON.stringify(result).includes("private assistant text"));
      assert.equal(result.partial, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test("resume commands preserve native flags and validate opaque IDs and Pi paths", () => {
  assert.deepEqual(nativeSessionCommand("codex", id).slice(-2), ["resume", id]);
  assert.deepEqual(nativeSessionCommand("claude-code", id).slice(-2), [
    "--resume",
    id,
  ]);
  assert.throws(() => nativeSessionCommand("codex", "--last"));
  assert.throws(() => nativeSessionCommand("pi", id, "/tmp/secret.jsonl"));
  assert.throws(() =>
    nativeSessionCommand(
      "pi",
      id,
      "/workspace/.pi/agent/sessions/../secret.jsonl",
    ),
  );
});
