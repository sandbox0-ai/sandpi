import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import SwaggerParser from "@apidevtools/swagger-parser";
import type { OpenAPIV3 } from "openapi-types";

import { buildOpenApi } from "./build";

const builtOpenApi = buildOpenApi();

test("committed OpenAPI is valid and generated without drift", async () => {
  const [{ document, yaml }, committed] = await Promise.all([
    builtOpenApi,
    readFile(new URL("../../../openapi.yaml", import.meta.url), "utf8"),
  ]);

  assert.equal(committed, yaml);
  await SwaggerParser.validate(document);
});

test("OpenAPI publishes every supported operation with a unique id", async () => {
  const { document } = await builtOpenApi;
  const operations = allOperations(document);
  const operationIds = operations.map((operation) => operation.operationId);

  assert.equal(operations.length, 125);
  assert.ok(operationIds.every(Boolean));
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.ok(Object.keys(document.paths).every((path) => !path.includes(":")));
  assert.ok(Object.keys(document.paths).every((path) => !path.includes("*")));

  for (const [path, operationId] of [
    [
      "/api/v1/environments/{environmentId}/sandbox/pause",
      "pauseEnvironmentSandbox",
    ],
    [
      "/api/v1/environments/{environmentId}/sandbox/restart",
      "restartEnvironmentSandbox",
    ],
    [
      "/api/v1/environments/{environmentId}/webhooks/{webhookId}/secret",
      "rotateEnvironmentWebhookSecret",
    ],
  ] as const) {
    assert.equal(operation(document, path, "put").operationId, operationId);
  }
  assert.deepEqual(
    operation(document, "/api/v1/webhooks/{endpointId}", "post").security,
    [],
  );
  assert.deepEqual(
    operation(document, "/api/v1/webhook-sources/github/events", "post")
      .security,
    [],
  );
  assert.deepEqual(
    operation(document, "/api/v1/webhook-sources/github/callback", "get")
      .security,
    [],
  );
  const webhookRequestBody = operation(
    document,
    "/api/v1/webhooks/{endpointId}",
    "post",
  ).requestBody;
  assert.ok(webhookRequestBody && !("$ref" in webhookRequestBody));
  assert.deepEqual(Object.keys(webhookRequestBody.content), [
    "application/json",
    "application/x-www-form-urlencoded",
    "text/plain",
  ]);
});

test("OpenAPI preserves the shared Browser and streaming semantics", async () => {
  const { document } = await builtOpenApi;
  const cloudSync = operation(document, "/api/v1/sync", "get");
  assert.equal(cloudSync.responses["304"] !== undefined, true);
  assert.match(cloudSync.description ?? "", /database-only/i);

  const browserOpen = operation(
    document,
    "/api/v1/environments/{environmentId}/browser/open",
    "post",
  );
  assert.equal(browserOpen["x-sandpi-shared-browser"], true);
  assert.match(browserOpen.description ?? "", /human and the agent/i);
  assert.match(browserOpen.description ?? "", /sign-in/i);
  assert.match(browserOpen.description ?? "", /inside the Environment sandbox/i);

  for (const [path, method] of [
    ["/api/v1/environments/{environmentId}/browser/session", "post"],
    ["/api/v1/sessions/{sessionId}/review", "post"],
    ["/api/v1/sessions/{sessionId}/fork", "post"],
    [
      "/api/v1/sessions/{sessionId}/turns/{nativeTurnId}/fork",
      "post",
    ],
  ] as const) {
    const requestBody = operation(document, path, method).requestBody;
    assert.ok(requestBody && !("$ref" in requestBody));
    assert.equal(requestBody.required, false);
  }

  const sessionEvents = operation(
    document,
    "/api/v1/sessions/{sessionId}/events",
    "get",
  );
  assert.ok(sessionEvents["x-sandpi-sse"]);
  const eventResponse = sessionEvents.responses["200"];
  assert.ok(eventResponse && !("$ref" in eventResponse));
  assert.ok(eventResponse.content?.["text/event-stream"]);

  for (const path of [
    "/api/v1/environments/{environmentId}/ide/events",
    "/api/v1/environments/{environmentId}/browser/ws/{dashboardSocketId}",
    "/api/v1/environments/{environmentId}/terminal",
  ]) {
    assert.ok(operation(document, path, "get")["x-sandpi-websocket"]);
  }
  const ideClientMessages = (
    operation(
      document,
      "/api/v1/environments/{environmentId}/ide/events",
      "get",
    )["x-sandpi-websocket"] as {
      clientMessages?: OpenAPIV3.SchemaObject;
    }
  ).clientMessages;
  assert.ok(ideClientMessages);
  assert.deepEqual(ideClientMessages.required, ["type", "paths"]);
  assert.deepEqual(ideClientMessages.properties?.type, {
    type: "string",
    enum: ["subscribe"],
  });
  assert.equal(
    (ideClientMessages.properties?.paths as OpenAPIV3.ArraySchemaObject)
      .maxItems,
    64,
  );
});

test("OpenAPI publishes resource-level CLI operations", async () => {
  const { document } = await builtOpenApi;
  for (const [path, method, operationId] of [
    [
      "/api/v1/environments/{environmentId}",
      "get",
      "getEnvironment",
    ],
    [
      "/api/v1/environments/{environmentId}/egress-credentials/{credentialId}",
      "get",
      "getEnvironmentEgressCredential",
    ],
    [
      "/api/v1/environments/{environmentId}/harnesses/codex/skills/{name}",
      "put",
      "putEnvironmentCodexSkill",
    ],
    [
      "/api/v1/environments/{environmentId}/harnesses/codex/skills/{name}",
      "delete",
      "deleteEnvironmentCodexSkill",
    ],
    [
      "/api/v1/environments/{environmentId}/harnesses/codex/mcp-servers/{name}",
      "put",
      "putEnvironmentCodexMcpServer",
    ],
    [
      "/api/v1/environments/{environmentId}/harnesses/codex/mcp-servers/{name}",
      "delete",
      "deleteEnvironmentCodexMcpServer",
    ],
  ] as const) {
    assert.equal(operation(document, path, method).operationId, operationId);
  }
});

function allOperations(document: OpenAPIV3.Document) {
  const methods = ["get", "post", "put", "delete", "patch"] as const;
  return Object.values(document.paths).flatMap((path) =>
    methods.flatMap((method) => {
      const operation = path?.[method];
      return operation ? [operation] : [];
    }),
  );
}

function operation(
  document: OpenAPIV3.Document,
  path: string,
  method: "get" | "post" | "put" | "delete" | "patch",
) {
  const result = document.paths[path]?.[method];
  assert.ok(result, `${method.toUpperCase()} ${path} is missing`);
  return result as OpenAPIV3.OperationObject & Record<string, unknown>;
}
