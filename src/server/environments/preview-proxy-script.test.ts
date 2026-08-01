import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import { connect, type AddressInfo } from "node:net";
import test from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { ENVIRONMENT_PREVIEW_PROXY_SCRIPT } from "./preview-proxy-script";

const APPLICATION_TOKEN = "application-token";

test("the Sandbox Preview proxy carries HTTP and WebSocket traffic without leaking credentials", async () => {
  let receivedHeaders: IncomingHttpHeaders | undefined;
  let receivedWebSocketHeaders: IncomingHttpHeaders | undefined;
  const application = createServer(async (request, response) => {
    receivedHeaders = request.headers;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
        host: request.headers.host,
      }),
    );
  });
  const sockets = new WebSocketServer({ server: application });
  sockets.on("connection", (socket, request) => {
    receivedWebSocketHeaders = request.headers;
    socket.on("message", (message, isBinary) => {
      socket.send(message, { binary: isBinary });
    });
  });

  await listen(application);
  const applicationPort = serverPort(application);
  const proxyPort = await unusedPort();
  const proxy = spawn(process.execPath, ["-e", ENVIRONMENT_PREVIEW_PROXY_SCRIPT], {
    env: {
      ...process.env,
      SANDPI_PREVIEW_PROXY_PORT: String(proxyPort),
      SANDPI_PREVIEW_PROXY_TOKEN: APPLICATION_TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  try {
    await waitForPort(proxy, proxyPort);
    const denied = await proxyHttp(proxyPort, applicationPort, {
      token: "wrong-token",
    });
    assert.equal(denied.statusCode, 403);

    const accepted = await proxyHttp(proxyPort, applicationPort, {
      token: APPLICATION_TOKEN,
      method: "POST",
      path: "/echo?value=one",
      body: "preview-body",
      ingressToken: "ingress-token",
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(JSON.parse(accepted.body), {
      method: "POST",
      url: "/echo?value=one",
      body: "preview-body",
      host: `localhost:${applicationPort}`,
    });
    assert.equal(receivedHeaders?.["x-sandpi-preview-appservice"], undefined);
    assert.equal(receivedHeaders?.["x-sandpi-preview-proxy"], undefined);
    assert.equal(receivedHeaders?.["x-sandpi-preview-target-host"], undefined);
    assert.equal(receivedHeaders?.["x-sandpi-preview-target-port"], undefined);

    const socket = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`, {
      headers: previewHeaders(applicationPort, APPLICATION_TOKEN),
    });
    await once(socket, "open");
    socket.send("preview-websocket");
    const [message] = (await once(socket, "message")) as [Buffer];
    assert.equal(message.toString("utf8"), "preview-websocket");
    for (const name of [
      "x-sandpi-preview-appservice",
      "x-sandpi-preview-proxy",
      "x-sandpi-preview-target-host",
      "x-sandpi-preview-target-port",
    ]) {
      assert.equal(receivedWebSocketHeaders?.[name], undefined);
    }
    socket.close();
    await once(socket, "close");
  } finally {
    proxy.kill("SIGTERM");
    await Promise.race([
      once(proxy, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    sockets.close();
    await close(application);
  }
});

function previewHeaders(port: number, token: string) {
  return {
    "X-Sandpi-Preview-AppService": "ingress-token",
    "X-Sandpi-Preview-Proxy": token,
    "X-Sandpi-Preview-Target-Host": "localhost",
    "X-Sandpi-Preview-Target-Port": String(port),
  };
}

function proxyHttp(
  proxyPort: number,
  targetPort: number,
  options: {
    token: string;
    method?: string;
    path?: string;
    body?: string;
    ingressToken?: string;
  },
) {
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: proxyPort,
        method: options.method ?? "GET",
        path: options.path ?? "/",
        headers: {
          ...previewHeaders(targetPort, options.token),
          ...(options.ingressToken
            ? { "X-Sandpi-Preview-AppService": options.ingressToken }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

async function unusedPort() {
  const server = createServer();
  await listen(server);
  const port = serverPort(server);
  await close(server);
  return port;
}

async function waitForPort(process: ChildProcess, port: number) {
  let stderr = "";
  process.stderr?.setEncoding("utf8");
  process.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error(`Preview proxy exited during startup: ${stderr}`);
    }
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Preview proxy did not listen: ${stderr}`);
}

function canConnect(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  return once(server, "listening");
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverPort(server: Server) {
  return (server.address() as AddressInfo).port;
}
