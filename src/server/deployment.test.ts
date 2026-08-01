import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function repositoryFile(relativePath: string): Promise<string> {
  return readFile(
    new URL(`../../${relativePath}`, import.meta.url),
    "utf8",
  );
}

function deploymentFile(relativePath: string): Promise<string> {
  return repositoryFile(`deploy/kubernetes/${relativePath}`);
}

test("the production workload rolls one hardened Sandpi worker without downtime", async () => {
  const manifest = await deploymentFile("app/sandpi.yaml");

  assert.match(manifest, /kind: Deployment[\s\S]*?replicas: 1/);
  assert.match(manifest, /minReadySeconds: 5/);
  assert.match(
    manifest,
    /strategy:\n    type: RollingUpdate\n    rollingUpdate:\n      maxUnavailable: 0\n      maxSurge: 1/,
  );
  assert.doesNotMatch(manifest, /type: Recreate/);
  assert.match(manifest, /automountServiceAccountToken: false/);
  assert.match(manifest, /readOnlyRootFilesystem: true/);
  assert.match(manifest, /runAsNonRoot: true/);
  assert.match(manifest, /path: \/health\/ready/);
  assert.match(
    manifest,
    /requests:\n              cpu: 40m\n              memory: 256Mi/,
  );
  assert.equal(
    manifest.match(/ghcr\.io\/sandbox0-ai\/sandpi:main/g)?.length,
    1,
  );
});

test("PostgreSQL uses retained DigitalOcean block storage", async () => {
  const manifest = await deploymentFile("app/postgres.yaml");

  assert.match(manifest, /kind: StatefulSet/);
  assert.match(manifest, /replicas: 1/);
  assert.match(
    manifest,
    /requests:\n              cpu: 50m\n              memory: 256Mi/,
  );
  assert.match(manifest, /storageClassName: do-block-storage-retain/);
  assert.match(manifest, /storage: 10Gi/);
  assert.match(manifest, /name: sandpi-postgres/);
});

test("the ingress preserves streaming and terminates Sandpi TLS", async () => {
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
  assert.match(
    manifest,
    /tls:\n    - hosts:\n        - sandpi\.ai\n      secretName: sandpi-tls/,
  );
  assert.match(manifest, /- "\*\.preview\.sandpi\.ai"/);
  assert.match(manifest, /secretName: sandpi-preview-tls/);
  assert.match(manifest, /host: "\*\.preview\.sandpi\.ai"/);
  assert.match(
    manifest,
    /nginx\.ingress\.kubernetes\.io\/proxy-request-buffering: "off"/,
  );
  assert.match(
    manifest,
    /nginx\.ingress\.kubernetes\.io\/ssl-redirect: "true"/,
  );
  assert.doesNotMatch(manifest, /sandbox0-ai-wildcard-tls/);
});

test("Sandpi certificates use namespaced HTTP and DNS ACME issuers", async () => {
  const manifest = await deploymentFile("app/tls.yaml");

  assert.match(manifest, /kind: Issuer/);
  assert.doesNotMatch(manifest, /kind: ClusterIssuer/);
  assert.match(
    manifest,
    /server: https:\/\/acme-v02\.api\.letsencrypt\.org\/directory/,
  );
  assert.match(manifest, /ingressClassName: nginx/);
  assert.match(manifest, /serviceType: ClusterIP/);
  assert.match(manifest, /dnsNames:\n    - sandpi\.ai/);
  assert.match(manifest, /algorithm: ECDSA/);
  assert.match(manifest, /rotationPolicy: Always/);
  assert.match(manifest, /secretName: sandpi-tls/);
  assert.match(manifest, /name: letsencrypt-dns/);
  assert.match(
    manifest,
    /dns01:\n          digitalocean:\n            tokenSecretRef:\n              key: access-token\n              name: sandpi-dns/,
  );
  assert.match(manifest, /dnsNames:\n    - "\*\.preview\.sandpi\.ai"/);
  assert.match(manifest, /secretName: sandpi-preview-tls/);
});

test("the shared certificate controller has bounded bootstrap resources", async () => {
  const values = await deploymentFile("cert-manager-values.yaml");

  assert.match(values, /crds:\n  enabled: true/);
  assert.match(values, /prometheus:\n  enabled: false/);
  assert.equal(values.match(/cpu: 10m/g)?.length, 4);
  assert.match(values, /memory: 16Mi/);
});

test("the CI identity cannot manage cluster-scoped or unrelated secrets", async () => {
  const bootstrap = await deploymentFile("bootstrap.yaml");

  assert.match(
    bootstrap,
    /resourceNames:\n      - sandpi-postgres\n      - sandpi-dns\n      - sandpi-runtime\n    resources:\n      - secrets/,
  );
  assert.match(
    bootstrap,
    /apiGroups:\n      - cert-manager\.io\n    resources:\n      - certificates\n      - issuers/,
  );
  assert.doesNotMatch(bootstrap, /kind: ClusterRole/);
  assert.doesNotMatch(bootstrap, /resources:\n\s+- namespaces/);
  assert.doesNotMatch(bootstrap, /\n\s+- delete\n/);
});

test("the deploy workflow checks kubectl's native authorization result", async () => {
  const workflow = await repositoryFile(".github/workflows/deploy.yml");

  assert.match(
    workflow,
    /can-i patch secret\/sandpi-runtime[\s\S]*?\| grep -Fx yes/,
  );
  assert.match(
    workflow,
    /can-i patch secret\/sandpi-postgres[\s\S]*?\| grep -Fx yes/,
  );
  assert.match(
    workflow,
    /can-i patch secret\/sandpi-dns[\s\S]*?\| grep -Fx yes/,
  );
  assert.doesNotMatch(workflow, /can-i .*\| grep -Fx true/);
  assert.match(
    workflow,
    /--for=condition=Ready[\s\S]*certificate\/sandpi certificate\/sandpi-preview/,
  );
  assert.match(
    workflow,
    /--resolve "sandpi\.ai:443:\$\{SANDPI_INGRESS_IP\}"/,
  );
  assert.match(
    workflow,
    /--resolve "p3000-00000000000000000000\.preview\.sandpi\.ai:443:\$\{SANDPI_INGRESS_IP\}"/,
  );
  assert.match(workflow, /SANDPI_PREVIEW_URL/);
});
