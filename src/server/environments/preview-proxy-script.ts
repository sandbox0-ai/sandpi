/**
 * Dependency-free HTTP/WebSocket proxy installed as a lazy Sandbox0
 * AppService. It can only connect to IPv4 loopback and requires the
 * server-held proxy credential on every request.
 */
export const ENVIRONMENT_PREVIEW_PROXY_SCRIPT = String.raw`
"use strict";
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");

const listenPort = Number(process.env.SANDPI_PREVIEW_PROXY_PORT || "43420");
const expectedToken = Buffer.from(process.env.SANDPI_PREVIEW_PROXY_TOKEN || "");
const internalHeaders = new Set([
  "x-sandpi-preview-appservice",
  "x-sandpi-preview-proxy",
  "x-sandpi-preview-target-host",
  "x-sandpi-preview-target-port",
]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function authorized(request) {
  const presented = Buffer.from(String(request.headers["x-sandpi-preview-proxy"] || ""));
  return expectedToken.length > 0 &&
    presented.length === expectedToken.length &&
    crypto.timingSafeEqual(presented, expectedToken);
}

function target(request) {
  if (!authorized(request)) return undefined;
  const host = String(request.headers["x-sandpi-preview-target-host"] || "").toLowerCase();
  const port = Number(request.headers["x-sandpi-preview-target-port"]);
  if ((host !== "localhost" && host !== "127.0.0.1") ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  return { host, port };
}

function connectionHeaderNames(request) {
  return new Set(String(request.headers.connection || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean));
}

function httpHeaders(request, destination) {
  const headers = {};
  const connectionHeaders = connectionHeaderNames(request);
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === "host" || internalHeaders.has(lower) ||
        hopByHopHeaders.has(lower) || connectionHeaders.has(lower)) continue;
    headers[name] = value;
  }
  headers.host = destination.host + ":" + destination.port;
  return headers;
}

function reject(response, statusCode, message) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(message);
}

const server = http.createServer((request, response) => {
  const destination = target(request);
  if (!destination) {
    reject(response, 403, "Invalid Sandpi Preview target.\n");
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: destination.port,
    method: request.method,
    path: request.url,
    headers: httpHeaders(request, destination),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) reject(response, 502, "The local Preview service is unavailable.\n");
    else response.destroy();
  });
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

server.on("upgrade", (request, client, head) => {
  const destination = target(request);
  if (!destination) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.connect({ host: "127.0.0.1", port: destination.port });
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    const lines = [String(request.method || "GET") + " " + request.url + " HTTP/1.1"];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      const lower = name.toLowerCase();
      if (lower === "host" || internalHeaders.has(lower) || lower === "proxy-connection") continue;
      lines.push(name + ": " + value);
    }
    lines.push("Host: " + destination.host + ":" + destination.port, "", "");
    upstream.write(lines.join("\r\n"));
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.once("error", () => {
    if (!connected) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    else client.destroy();
  });
  client.once("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
});

server.listen(listenPort, "0.0.0.0");
`;
