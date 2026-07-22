import assert from "node:assert/strict";
import test from "node:test";

import {
  codexRolloutActivityFailed,
  summarizeCodexRolloutActivity,
} from "./rollout-activity-summary";
import type { CodexRolloutToolActivity } from "./rollout-activity";

function rollout(
  input: Partial<CodexRolloutToolActivity> = {},
): CodexRolloutToolActivity {
  return {
    kind: "rolloutToolCall",
    id: "rollout:turn-1:custom:call-1",
    turnId: "turn-1",
    createdAt: 1,
    completedAt: 2,
    durationMs: 1_000,
    status: "completed",
    callId: "call-1",
    callType: "custom_tool_call",
    name: "exec",
    namespace: null,
    nativeStatus: "completed",
    callPayload: {
      type: "custom_tool_call",
      call_id: "call-1",
      name: "exec",
      input: "",
    },
    outputs: [],
    codeModeTools: [],
    payloadTruncated: false,
    ...input,
  };
}

test("summarizes a code-mode command without evaluating its JavaScript", () => {
  const activity = rollout({
    codeModeTools: ["exec_command"],
    callPayload: {
      input:
        'const r = await tools.exec_command({"cmd":"npx tsc --noEmit && printf \'$(safe)\'","workdir":"/workspace"}); text(`\\nexit=${r.exit_code}`);',
    },
    outputs: [
      {
        outputType: "custom_tool_call_output",
        createdAt: 2,
        nativeStatus: null,
        payload: {
          output: [{ type: "input_text", text: "Type error\nexit=1" }],
        },
      },
    ],
  });

  assert.deepEqual(summarizeCodexRolloutActivity(activity), {
    kind: "command",
    toolName: "exec_command",
    subject: "npx tsc --noEmit && printf '$(safe)'",
    detail: "/workspace",
    command: "npx tsc --noEmit && printf '$(safe)'",
    cwd: "/workspace",
    output: "Type error\nexit=1",
    exitCode: 1,
    filePaths: [],
    external: false,
    startsBackgroundHandle: null,
    followsBackgroundHandle: null,
  });
  assert.equal(codexRolloutActivityFailed(activity), true);
});

test("summarizes current Codex JavaScript object-literal arguments", () => {
  const activity = rollout({
    codeModeTools: ["exec_command"],
    callPayload: {
      input:
        'const r = await tools.exec_command({cmd:"npm run build",workdir:\'/workspace\',"yield_time_ms":30000,tty:true}); text(JSON.stringify(r));',
    },
  });

  const summary = summarizeCodexRolloutActivity(activity);
  assert.equal(summary.kind, "command");
  assert.equal(summary.subject, "npm run build");
  assert.equal(summary.command, "npm run build");
  assert.equal(summary.cwd, "/workspace");
});

test("does not infer failure from an incidental exit trailer in program output", () => {
  const activity = rollout({
    codeModeTools: ["exec_command"],
    callPayload: {
      input: "tools.exec_command({\"cmd\":\"printf 'exit=1\\\\n'\"});",
    },
    outputs: [
      {
        outputType: "custom_tool_call_output",
        createdAt: 2,
        nativeStatus: null,
        payload: { output: "Script completed\nOutput:\nexit=1" },
      },
    ],
  });

  assert.equal(summarizeCodexRolloutActivity(activity).exitCode, null);
  assert.equal(codexRolloutActivityFailed(activity), false);
});

test("keeps one outer record as one action when it invokes multiple tools", () => {
  const summary = summarizeCodexRolloutActivity(
    rollout({
      codeModeTools: ["exec_command", "mcp__github__search_code"],
      callPayload: {
        input:
          'tools.exec_command({"cmd":"pwd"}); tools.mcp__github__search_code({"query":"sandpi"});',
      },
    }),
  );

  assert.equal(summary.kind, "tool");
  assert.equal(summary.command, null);
  assert.equal(
    summary.subject,
    "exec_command · mcp__github__search_code",
  );
  assert.equal(summary.external, true);
});

test("falls back safely for non-JSON code-mode arguments", () => {
  globalThis.__sandpiActivityParserExecuted = false;
  const activity = rollout({
    codeModeTools: ["exec_command"],
    callPayload: {
      input:
        "tools.exec_command((globalThis.__sandpiActivityParserExecuted = true, {cmd: 'unsafe'}));",
    },
  });

  const summary = summarizeCodexRolloutActivity(activity);
  assert.equal(summary.subject, "exec_command");
  assert.equal(summary.command, null);
  assert.equal(globalThis.__sandpiActivityParserExecuted, false);
  delete globalThis.__sandpiActivityParserExecuted;
});

test("does not evaluate expressions inside object-literal arguments", () => {
  globalThis.__sandpiActivityParserExecuted = false;
  const activity = rollout({
    codeModeTools: ["exec_command"],
    callPayload: {
      input:
        'tools.exec_command({cmd:(globalThis.__sandpiActivityParserExecuted = true, "unsafe")});',
    },
  });

  const summary = summarizeCodexRolloutActivity(activity);
  assert.equal(summary.subject, "exec_command");
  assert.equal(summary.command, null);
  assert.equal(globalThis.__sandpiActivityParserExecuted, false);
  delete globalThis.__sandpiActivityParserExecuted;
});

test("extracts patch paths from a static patch variable", () => {
  const activity = rollout({
    codeModeTools: ["apply_patch"],
    callPayload: {
      input:
        'const patch = "*** Begin Patch\\n*** Update File: /workspace/app/page.tsx\\n*** Move to: /workspace/app/home.tsx\\n*** Add File: /workspace/app/new.tsx\\n*** End Patch"; tools.apply_patch(patch);',
    },
  });

  const summary = summarizeCodexRolloutActivity(activity);
  assert.equal(summary.kind, "fileChange");
  assert.deepEqual(summary.filePaths, [
    "/workspace/app/page.tsx",
    "/workspace/app/home.tsx",
    "/workspace/app/new.tsx",
  ]);
  assert.equal(
    summary.subject,
    "/workspace/app/page.tsx, /workspace/app/home.tsx",
  );
});

test("links background command, wait, and terminal updates by native handles", () => {
  const command = summarizeCodexRolloutActivity(
    rollout({
      codeModeTools: ["exec_command"],
      callPayload: {
        input:
          'tools.exec_command({cmd:"npm run build",workdir:"/workspace"});',
      },
      outputs: [
        {
          outputType: "custom_tool_call_output",
          createdAt: 2,
          nativeStatus: null,
          payload: { output: "Script running with cell ID 6" },
        },
      ],
    }),
  );
  const wait = summarizeCodexRolloutActivity(
    rollout({
      callType: "function_call",
      name: "wait",
      callPayload: { arguments: '{"cell_id":"6","yield_time_ms":20000}' },
    }),
  );
  const terminal = summarizeCodexRolloutActivity(
    rollout({
      codeModeTools: ["write_stdin"],
      callPayload: {
        input: 'tools.write_stdin({session_id:79113,chars:"\\u0003"});',
      },
    }),
  );

  assert.equal(command.startsBackgroundHandle, "cell:6");
  assert.equal(wait.kind, "backgroundWait");
  assert.equal(wait.followsBackgroundHandle, "cell:6");
  assert.equal(terminal.kind, "backgroundInput");
  assert.equal(terminal.detail, "Ctrl-C");
  assert.equal(terminal.followsBackgroundHandle, "session:79113");
});

test("does not derive a background handle from arbitrary command output", () => {
  const summary = summarizeCodexRolloutActivity(
    rollout({
      codeModeTools: ["exec_command"],
      callPayload: {
        input: 'tools.exec_command({"cmd":"rg session_id logs"});',
      },
      outputs: [
        {
          outputType: "custom_tool_call_output",
          createdAt: 2,
          nativeStatus: null,
          payload: {
            output:
              "request failed: session_id: 79113\nScript running with cell ID 7 in a quoted log",
          },
        },
      ],
    }),
  );

  assert.equal(summary.startsBackgroundHandle, null);
});

test("summarizes structured local shell and web-search calls", () => {
  const shell = summarizeCodexRolloutActivity(
    rollout({
      callType: "local_shell_call",
      name: "local_shell",
      callPayload: {
        action: {
          type: "exec",
          command: ["git", "status", "--short"],
          working_directory: "/workspace",
        },
      },
    }),
  );
  const web = summarizeCodexRolloutActivity(
    rollout({
      callType: "web_search_call",
      name: "web_search",
      callPayload: {
        action: {
          type: "search",
          queries: ["sandpi release", "sandbox0 release"],
        },
      },
    }),
  );

  assert.equal(shell.subject, "git status --short");
  assert.equal(shell.kind, "command");
  assert.equal(web.kind, "web");
  assert.equal(web.subject, "sandpi release +1");
  assert.equal(web.external, true);
});

declare global {
  // Test sentinel proving arbitrary code-mode input is never evaluated.
  var __sandpiActivityParserExecuted: boolean | undefined;
}
