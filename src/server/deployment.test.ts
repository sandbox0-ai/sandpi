import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function deploymentFile(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../deploy/kubernetes/${relativePath}`, import.meta.url),
    "utf8",
  );
}

test("the production workload keeps one hardened Sandpi worker", async () => {
  const manifest = await deploymentFile("app/sandpi.yaml");

  assert.match(manifest, /kind: Deployment[\s\S]*?replicas: 1/);
  assert.match(manifest, /strategy:\n    type: Recreate/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /runAsNonRoot: true/);
  assert.match(manifest, /path: \/health\/ready/);
  assert.equal(
    manifest.match(/ghcr\.io\/sandbox0-ai\/sandpi:main/g)?.length,
    1,
  );
});

test("PostgreSQL uses retained DigitalOcean block storage", async () => {
  const manifest = await deploymentFile("app/postgres.yaml");

  assert.match(manifest, /kind: StatefulSet/);
  assert.match(manifest, /replicas: 1/);
  assert.match(manifest, /storageClassName: do-block-storage-retain/);
  assert.match(manifest, /storage: 10Gi/);
  assert.match(manifest, /name: sandpi-postgres/);
});

test("the ingress preserves native streaming without claiming unrelated TLS", async () => {
  const manifest = await deploymentFile("app/ingress.yaml");

  assert.match(manifest, /host: sandpi\.ai/);
  assert.match(
    manifest,
    /nginx\.ingress\.kubernetes\.io\/proxy-buffering: "off"/,
  );
  assert.match(
    manifest,
    /nginx\.ingress\.kubernetes\.io\/proxy-read-timeout: "3600"/,
  );
  assert.doesNotMatch(manifest, /^\s+tls:/m);
  assert.doesNotMatch(manifest, /sandbox0-ai-wildcard-tls/);
});

test("the CI identity cannot manage cluster-scoped or unrelated secrets", async () => {
  const bootstrap = await deploymentFile("bootstrap.yaml");

  assert.match(
    bootstrap,
    /resourceNames:\n      - sandpi-postgres\n      - sandpi-runtime\n    resources:\n      - secrets/,
  );
  assert.doesNotMatch(bootstrap, /kind: ClusterRole/);
  assert.doesNotMatch(bootstrap, /resources:\n\s+- namespaces/);
  assert.doesNotMatch(bootstrap, /\n\s+- delete\n/);
});
