import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";

import fastifyCookie from "@fastify/cookie";
import fastifyRawBody from "fastify-raw-body";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";

import type { EnvironmentRuntimeAccessService } from "./runtime-access-service";
import {
  environmentPreviewHostConstraint,
  EnvironmentPreviewService,
  previewSigningKey,
} from "./preview-service";
import type { RuntimeAdapter } from "@/server/runtime/types";
import {
  registerEnvironmentPreviewRoutes,
  rewriteEnvironmentPreviewUrl,
} from "@/server/server";

test("the isolated Preview host exchanges a ticket and streams an HTTP request", async () => {
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, {
      "content-type": "application/json",
      "x-preview-target": String(
        request.headers["x-sandpi-preview-target-port"],
      ),
    });
    response.end(
      JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");

  const runtimeRecord = {
    id: "environment-one",
    sandboxId: "sandbox-one",
    workspaceVolumeId: "volume-one",
    runtimeGeneration: 1,
    decoder: { carry: "", insideString: false, escapeNext: false, depth: 0 },
  };
  const runtimeAccess = {
    withRuntimeAccess: async (
      _userId: string,
      _environmentId: string,
      operation: (runtime: typeof runtimeRecord) => Promise<unknown>,
    ) => operation(runtimeRecord),
    async touchRunningRuntimeActivity() {},
  } as unknown as EnvironmentRuntimeAccessService;
  const runtime = {
    async ensureEnvironmentPreviewProxy() {
      return {
        publicUrl: `http://127.0.0.1:${serverPort(upstream)}/`,
        requestHeaders: { "X-Sandpi-Preview-Proxy": "server-token" },
      };
    },
  } as unknown as RuntimeAdapter;
  const preview = new EnvironmentPreviewService(runtimeAccess, runtime, {
    publicUrl: new URL("http://preview.localhost:3000"),
    signingKey: previewSigningKey("test-key-with-at-least-32-characters"),
  });
  const app = Fastify({
    logger: false,
    rewriteUrl: (request) =>
      rewriteEnvironmentPreviewUrl(
        environmentPreviewHostConstraint(
          new URL("http://preview.localhost:3000"),
        ),
        request.headers.host,
        request.url ?? "/",
      ),
  });
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket);
  await app.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });
  app.get("/api/v1/auth/me", async () => ({ data: "main-api" }));
  registerEnvironmentPreviewRoutes(app, preview, runtimeAccess);
  await app.ready();

  try {
    const created = await preview.createSession(
      "user-one",
      "environment-one",
      "http://localhost:4173/app?from=preview",
    );
    const ticketUrl = new URL(created.url);
    const exchange = await app.inject({
      method: "GET",
      url: `${ticketUrl.pathname}${ticketUrl.search}`,
      headers: { host: ticketUrl.host },
    });
    assert.equal(exchange.statusCode, 302);
    assert.equal(exchange.headers.location, "/app?from=preview");
    const setCookieHeader = exchange.headers["set-cookie"];
    const setCookie = Array.isArray(setCookieHeader)
      ? (setCookieHeader[0] ?? "")
      : (setCookieHeader ?? "");
    assert.match(setCookie, /sandpi_preview=/);
    assert.doesNotMatch(exchange.headers.location ?? "", /__sandpi_ticket/);

    const cookie = setCookie.split(";", 1)[0];
    const response = await app.inject({
      method: "POST",
      url: "/echo?stream=one",
      headers: {
        host: ticketUrl.host,
        cookie,
        "content-type": "text/plain",
      },
      payload: Buffer.from("preview-body"),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-preview-target"], "4173");
    assert.deepEqual(response.json(), {
      method: "POST",
      url: "/echo?stream=one",
      body: "preview-body",
    });

    const conflictingPath = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { host: ticketUrl.host, cookie },
    });
    assert.equal(conflictingPath.statusCode, 200);
    assert.deepEqual(conflictingPath.json(), {
      method: "GET",
      url: "/api/v1/auth/me",
      body: "",
    });

    const mainApi = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { host: "sandpi.localhost:3000" },
    });
    assert.equal(mainApi.statusCode, 200);
    assert.deepEqual(mainApi.json(), { data: "main-api" });

    const wrongHost = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "preview.localhost:3000" },
    });
    assert.equal(wrongHost.statusCode, 404);
  } finally {
    await app.close();
    await close(upstream);
  }
});

function serverPort(server: Server) {
  return (server.address() as AddressInfo).port;
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
