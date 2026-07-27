import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureWorkspaceAgentsFile,
  WORKSPACE_AGENTS_PATH,
} from "./workspace-agents";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function agentsEntry(kind: "file" | "folder" = "file") {
  return {
    id: "agents",
    name: "AGENTS.md",
    path: WORKSPACE_AGENTS_PATH,
    kind,
  };
}

function directoryResponse(entries: ReturnType<typeof agentsEntry>[] = []) {
  return jsonResponse({
    data: {
      path: "/workspace",
      entries,
      refreshedAt: "2026-07-27T00:00:00.000Z",
    },
  });
}

async function withFetchResponses(
  responses: Response[],
  callback: (
    requests: Array<{ input: string; init?: RequestInit }>,
  ) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ input: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request.");
    return response;
  }) as typeof fetch;
  try {
    await callback(requests);
    assert.equal(responses.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("opens an existing Workspace AGENTS.md without creating it", async () => {
  await withFetchResponses(
    [directoryResponse([agentsEntry()])],
    async (requests) => {
      assert.equal(
        await ensureWorkspaceAgentsFile("environment one"),
        WORKSPACE_AGENTS_PATH,
      );
      assert.equal(requests.length, 1);
      assert.match(requests[0]?.input ?? "", /environment%20one\/files/);
    },
  );
});

test("creates a missing Workspace AGENTS.md", async () => {
  await withFetchResponses(
    [
      directoryResponse(),
      jsonResponse({ data: agentsEntry() }),
    ],
    async (requests) => {
      assert.equal(
        await ensureWorkspaceAgentsFile("environment"),
        WORKSPACE_AGENTS_PATH,
      );
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.init?.method, "POST");
      assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
        parentPath: "/workspace",
        name: "AGENTS.md",
        kind: "file",
      });
    },
  );
});

test("accepts a concurrent AGENTS.md create after verifying the file", async () => {
  await withFetchResponses(
    [
      directoryResponse(),
      jsonResponse(
        {
          error: {
            code: "workspace_entry_exists",
            message: "AGENTS.md already exists.",
          },
        },
        409,
      ),
      directoryResponse([agentsEntry()]),
    ],
    async () => {
      assert.equal(
        await ensureWorkspaceAgentsFile("environment"),
        WORKSPACE_AGENTS_PATH,
      );
    },
  );
});

test("rejects a folder occupying the Workspace AGENTS.md path", async () => {
  await withFetchResponses(
    [directoryResponse([agentsEntry("folder")])],
    async () => {
      await assert.rejects(
        ensureWorkspaceAgentsFile("environment"),
        /AGENTS\.md must be a file/,
      );
    },
  );
});
