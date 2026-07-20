import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  buildMcpCredentialValueTemplate,
  EnvironmentMcpIntegrationStore,
  toManagedMcpCredentialBinding,
} from "./integration-store";

const SHA256 = "a".repeat(64);
const OTHER_SHA256 = "b".repeat(64);
const NOW = new Date("2026-07-20T00:00:00.000Z");

function integrationRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    environment_id: "environment_1",
    server_name: "github",
    preset_id: "github",
    auth_mode: "bearer",
    credential_source_ref: "source_github",
    credential_binding_ref: "binding_github",
    credential_header_name: "Authorization",
    credential_value_template: "Bearer {{ .token }}",
    binding_enabled: true,
    pending_credential_source_ref: null,
    pending_credential_binding_ref: null,
    pending_credential_header_name: null,
    pending_credential_value_template: null,
    retiring_credential_source_ref: null,
    oauth_config_fingerprint: null,
    version: 1,
    endpoint_fingerprint: SHA256,
    destination_domain: "api.githubcopilot.com",
    destination_path: "/mcp/",
    lifecycle_status: "active",
    credential_status: "configured",
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function oauthFlowRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "mcp_oauth_1",
    environment_id: "environment_1",
    server_name: "github",
    config_fingerprint: SHA256,
    endpoint_fingerprint: OTHER_SHA256,
    status: "awaiting_user",
    native_thread_id: null,
    native_runtime_generation: null,
    native_attempt_id: null,
    native_thread_cleanup_completed_at: null,
    error: null,
    cleanup_completed_at: null,
    expires_at: new Date("2026-07-20T00:10:00.000Z"),
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

test("bearer integration upsert persists only managed projection metadata", async () => {
  let queryValues: readonly unknown[] | undefined;
  const now = new Date("2026-07-20T00:00:00.000Z");
  const pool = {
    async query(_sql: string, values?: readonly unknown[]) {
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          {
            environment_id: values?.[1],
            server_name: values?.[2],
            preset_id: values?.[3],
            auth_mode: values?.[4],
            credential_source_ref: values?.[5],
            credential_binding_ref: values?.[6],
            credential_header_name: values?.[7],
            credential_value_template: values?.[8],
            binding_enabled: values?.[9],
            pending_credential_source_ref: null,
            pending_credential_binding_ref: null,
            pending_credential_header_name: null,
            pending_credential_value_template: null,
            retiring_credential_source_ref: null,
            oauth_config_fingerprint: null,
            version: 1,
            endpoint_fingerprint: values?.[10],
            destination_domain: values?.[11],
            destination_path: values?.[12],
            lifecycle_status: values?.[13],
            credential_status: values?.[14],
            last_error: values?.[15],
            created_at: now,
            updated_at: now,
          },
        ],
      };
    },
  } as unknown as Pool;

  const integration = await new EnvironmentMcpIntegrationStore(
    pool,
  ).upsertIntegration("user_1", {
    environmentId: "environment_1",
    serverName: "github",
    presetId: "github",
    authMode: "bearer",
    credentialSourceRef: "source_github",
    credentialBindingRef: "binding_github",
    endpointFingerprint: SHA256.toUpperCase(),
    destinationDomain: "API.GITHUBCOPILOT.COM.",
    destinationPath: "/mcp/",
  });

  assert.equal(queryValues?.[7], "Authorization");
  assert.equal(queryValues?.[8], "Bearer {{ .token }}");
  assert.equal(queryValues?.[9], true);
  assert.equal(integration.destinationDomain, "api.githubcopilot.com");
  assert.equal(integration.endpointFingerprint, SHA256);
  assert.equal(integration.credentialStatus, "configured");
  assert.deepEqual(toManagedMcpCredentialBinding(integration), {
    bindingRef: "binding_github",
    sourceRef: "source_github",
    destinationDomain: "api.githubcopilot.com",
    destinationPath: "/mcp/",
    credentialHeaderName: "Authorization",
    credentialValueTemplate: "Bearer {{ .token }}",
  });
  assert.doesNotMatch(
    JSON.stringify(integration),
    /ghp_|github_pat_|accessToken|apiKey/,
  );
});

test("custom header integration rejects executable credential templates", async () => {
  let queried = false;
  const pool = {
    async query() {
      queried = true;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);

  await assert.rejects(
    store.upsertIntegration("user_1", {
      environmentId: "environment_1",
      serverName: "custom",
      authMode: "header",
      credentialHeaderName: "X-API-Key",
      credentialValueTemplate: "{{ range .tokens }}{{ . }}{{ end }}",
      endpointFingerprint: SHA256,
      destinationDomain: "mcp.example.com",
      destinationPath: "/mcp",
    }),
    /managed token template/,
  );
  assert.equal(queried, false);
});

test("runtime composition retains a static binding while it is updating", async () => {
  const now = new Date("2026-07-20T00:00:00.000Z");
  const pool = {
    async query(sql: string) {
      assert.match(sql, /lifecycle_status <> 'deleting'/);
      assert.match(sql, /binding_enabled = TRUE/);
      return {
        rowCount: 1,
        rows: [
          {
            environment_id: "environment_1",
            server_name: "github",
            preset_id: "github",
            auth_mode: "bearer",
            credential_source_ref: "source_github",
            credential_binding_ref: "binding_github",
            credential_header_name: "Authorization",
            credential_value_template: "Bearer {{ .token }}",
            binding_enabled: true,
            pending_credential_source_ref: null,
            pending_credential_binding_ref: null,
            pending_credential_header_name: null,
            pending_credential_value_template: null,
            retiring_credential_source_ref: null,
            oauth_config_fingerprint: null,
            version: 4,
            endpoint_fingerprint: SHA256,
            destination_domain: "api.githubcopilot.com",
            destination_path: "/mcp/",
            lifecycle_status: "updating",
            credential_status: "configured",
            last_error: null,
            created_at: now,
            updated_at: now,
          },
        ],
      };
    },
  } as unknown as Pool;

  const integrations =
    await new EnvironmentMcpIntegrationStore(
      pool,
    ).listActiveStaticIntegrationsForRuntime("environment_1");

  assert.equal(integrations.length, 1);
  assert.equal(integrations[0]?.lifecycleStatus, "updating");
});

test("credential value template builder accepts only a bounded scheme prefix", () => {
  assert.equal(buildMcpCredentialValueTemplate(), "{{ .token }}");
  assert.equal(
    buildMcpCredentialValueTemplate("Token"),
    "Token {{ .token }}",
  );
  assert.throws(
    () => buildMcpCredentialValueTemplate("{{ .attacker }}"),
    /prefix is invalid/,
  );
});

test("static credential saga methods use lifecycle and version CAS", async () => {
  const mutations: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let version = 1;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      if (/SELECT environment\.id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: "environment_1" }] };
      }
      mutations.push({ sql, values });
      version += 1;
      return {
        rowCount: 1,
        rows: [integrationRow({ version })],
      };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);

  const pending = await store.beginStaticCredentialPending(
    "user_1",
    "environment_1",
    "github",
    {
      expectedVersion: 1,
      expectedEndpointFingerprint: SHA256,
      expectedCurrentSourceRef: "source_github",
      pendingSourceRef: "source_github_2",
      pendingBindingRef: "binding_github_2",
      credentialHeaderName: "Authorization",
      credentialValueTemplate: "Bearer {{ .token }}",
    },
  );
  assert.equal(pending.version, 2);
  await store.promoteStaticCredentialPending(
    "user_1",
    "environment_1",
    "github",
    {
      expectedVersion: 2,
      expectedEndpointFingerprint: SHA256,
      expectedPendingSourceRef: "source_github_2",
      bindingEnabled: false,
    },
  );
  await store.finishStaticCredentialRetirement(
    "user_1",
    "environment_1",
    "github",
    {
      expectedVersion: 3,
      expectedRetiringSourceRef: "source_github",
    },
  );
  const binding = await store.setBindingEnabled(
    "user_1",
    "environment_1",
    "github",
    {
      expectedVersion: 4,
      expectedEndpointFingerprint: SHA256,
      expectedSourceRef: "source_github_2",
      enabled: false,
    },
  );
  assert.equal(binding.version, 5);
  await store.abortStaticCredentialPendingForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 5,
      expectedPendingSourceRef: "source_github_3",
    },
  );
  await store.finishStaticCredentialRetirementForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 6,
      expectedRetiringSourceRef: "source_github",
    },
  );
  const active = await store.markStaticCredentialActiveForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 7,
      expectedEndpointFingerprint: SHA256,
      expectedSourceRef: "source_github_2",
      expectedBindingEnabled: false,
    },
  );
  assert.equal(active?.version, 8);

  assert.match(mutations[0]?.sql ?? "", /JOIN environment_runtime runtime/);
  assert.match(
    mutations[0]?.sql ?? "",
    /runtime\.desired_state <> 'terminated'/,
  );
  assert.match(
    mutations[0]?.sql ?? "",
    /integration\.lifecycle_status = 'active'/,
  );
  assert.match(mutations[0]?.sql ?? "", /integration\.version = \$4/);
  assert.match(
    mutations[1]?.sql ?? "",
    /retiring_credential_source_ref = credential_source_ref/,
  );
  assert.match(mutations[1]?.sql ?? "", /binding_enabled = \$7/);
  assert.equal(mutations[1]?.values?.[6], false);
  assert.match(
    mutations[1]?.sql ?? "",
    /lifecycle_status = 'updating'/,
  );
  assert.match(
    mutations[1]?.sql ?? "",
    /runtime\.desired_state <> 'terminated'/,
  );
  assert.match(
    mutations[2]?.sql ?? "",
    /retiring_credential_source_ref = NULL/,
  );
  assert.match(mutations[3]?.sql ?? "", /binding_enabled = \$7/);
  assert.match(
    mutations[3]?.sql ?? "",
    /lifecycle_status = 'updating'/,
  );
  assert.match(
    mutations[4]?.sql ?? "",
    /pending_credential_source_ref = \$4/,
  );
  assert.match(
    mutations[5]?.sql ?? "",
    /retiring_credential_source_ref = \$4/,
  );
  assert.match(
    mutations[6]?.sql ?? "",
    /credential_source_ref IS NOT DISTINCT FROM \$5/,
  );
});

test("static credential saga reports a stable conflict on CAS failure", async () => {
  const pool = {
    async query(sql: string) {
      if (/SELECT environment\.id/.test(sql)) {
        return { rowCount: 1, rows: [{ id: "environment_1" }] };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;

  await assert.rejects(
    new EnvironmentMcpIntegrationStore(pool).abortStaticCredentialPending(
      "user_1",
      "environment_1",
      "github",
      {
        expectedVersion: 9,
        expectedPendingSourceRef: "source_github_2",
      },
    ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 409 &&
          "code" in error &&
          error.code === "mcp_integration_changed",
      ),
  );
});

test("generic runtime readiness cannot overwrite a non-active static saga", async () => {
  let querySql = "";
  const pool = {
    async query(sql: string) {
      querySql = sql;
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;

  const result = await new EnvironmentMcpIntegrationStore(
    pool,
  ).markIntegrationForRuntime("environment_1", "github", {
    lifecycleStatus: "active",
    lastError: null,
  });

  assert.equal(result, undefined);
  assert.match(querySql, /auth_mode NOT IN \('bearer', 'header'\)/);
  assert.match(querySql, /OR lifecycle_status = 'active'/);
});

test("runtime recovery can activate an error-state static binding with exact CAS", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          integrationRow({
            binding_enabled: false,
            lifecycle_status: "active",
            version: 12,
          }),
        ],
      };
    },
  } as unknown as Pool;

  const result = await new EnvironmentMcpIntegrationStore(
    pool,
  ).markStaticCredentialActiveForRuntime("environment_1", "github", {
    expectedVersion: 11,
    expectedEndpointFingerprint: SHA256,
    expectedSourceRef: "source_github",
    expectedBindingEnabled: false,
  });

  assert.equal(result?.version, 12);
  assert.deepEqual(queryValues, [
    "environment_1",
    "github",
    11,
    SHA256,
    "source_github",
    false,
  ]);
  assert.match(
    querySql,
    /lifecycle_status IN \('updating', 'error'\)/,
  );
  assert.match(querySql, /integration\.binding_enabled = \$6/);
});

test("runtime deletion cleanup journals each immutable source with version CAS", async () => {
  const mutations: Array<{ sql: string; values?: readonly unknown[] }> = [];
  let version = 20;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      mutations.push({ sql, values });
      version += 1;
      return {
        rowCount: 1,
        rows: [
          integrationRow({
            binding_enabled: false,
            lifecycle_status: version === 24 ? "active" : "deleting",
            version,
          }),
        ],
      };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);

  await store.clearPendingStaticCredentialForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 20,
      expectedPendingSourceRef: "source_pending",
    },
  );
  await store.clearRetiringStaticCredentialForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 21,
      expectedRetiringSourceRef: "source_retiring",
    },
  );
  await store.clearStaticCredentialForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 22,
      expectedSourceRef: "source_current",
    },
  );
  const finished = await store.finishStaticCredentialDeletionForRuntime(
    "environment_1",
    "github",
    {
      expectedVersion: 23,
      expectedEndpointFingerprint: SHA256,
    },
  );

  assert.equal(finished?.version, 24);
  for (const mutation of mutations) {
    assert.match(mutation.sql, /lifecycle_status = 'deleting'/);
    assert.match(mutation.sql, /version = integration\.version \+ 1/);
  }
  assert.match(
    mutations[0]?.sql ?? "",
    /pending_credential_source_ref = \$4/,
  );
  assert.match(
    mutations[1]?.sql ?? "",
    /retiring_credential_source_ref = \$4/,
  );
  assert.match(
    mutations[2]?.sql ?? "",
    /credential_source_ref = \$4/,
  );
  assert.match(
    mutations[3]?.sql ?? "",
    /integration\.endpoint_fingerprint = \$4/,
  );
});

test("OAuth expiry turns active flows into durable cancelled cleanup work", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      if (/^SELECT \*/.test(sql.trim())) {
        return { rowCount: 1, rows: [oauthFlowRow({ status: "cancelled" })] };
      }
      return { rowCount: 1, rows: [oauthFlowRow({ status: "expired" })] };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);

  const blocking =
    await store.findBlockingOAuthFlowForRuntime("environment_1");
  assert.equal(blocking?.status, "cancelled");
  await store.expireOAuthFlows("environment_1");

  assert.deepEqual(queries[0]?.values?.[1], [
    "starting",
    "awaiting_user",
    "cancelled",
  ]);
  assert.deepEqual(queries[1]?.values?.[0], [
    "starting",
    "awaiting_user",
  ]);
  assert.match(queries[1]?.sql ?? "", /SET status = 'cancelled'/);
  assert.match(
    queries[1]?.sql ?? "",
    /cleanup_completed_at IS NOT NULL/,
  );
  assert.match(queries[1]?.sql ?? "", /version = integration\.version \+ 1/);
});

test("OAuth replay lookup returns the latest flow regardless of status", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [oauthFlowRow({ status: "completed" })],
      };
    },
  } as unknown as Pool;

  const flow = await new EnvironmentMcpIntegrationStore(
    pool,
  ).findLatestOAuthFlowForRuntime("environment_1", "github");

  assert.equal(flow?.status, "completed");
  assert.deepEqual(queryValues, ["environment_1", "github"]);
  assert.match(querySql, /ORDER BY created_at DESC, id DESC/);
  assert.doesNotMatch(querySql, /status =|expires_at/);
});

test("OAuth native thread lookup is exact and status-independent", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          oauthFlowRow({
            status: "failed",
            native_thread_id: "native-oauth-thread-1",
            native_runtime_generation: 7,
            native_attempt_id: "attempt-7",
          }),
        ],
      };
    },
  } as unknown as Pool;

  const flow = await new EnvironmentMcpIntegrationStore(
    pool,
  ).findOAuthFlowByNativeThreadForRuntime(
    "environment_1",
    "github",
    "native-oauth-thread-1",
  );

  assert.equal(flow?.status, "failed");
  assert.equal(flow.nativeThreadId, "native-oauth-thread-1");
  assert.deepEqual(flow.nativeRuntime, {
    runtimeGeneration: 7,
    attemptId: "attempt-7",
  });
  assert.deepEqual(queryValues, [
    "environment_1",
    "github",
    "native-oauth-thread-1",
  ]);
  assert.match(querySql, /native_thread_id = \$3/);
  assert.match(querySql, /ORDER BY created_at DESC, id DESC/);
  assert.doesNotMatch(querySql, /status =|expires_at/);
});

test("OAuth thread cleanup is listed and completed with exact correlation CAS", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const cleanupCompletedAt = new Date("2026-07-20T00:02:00.000Z");
  let call = 0;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      call += 1;
      return {
        rowCount: 1,
        rows: [
          oauthFlowRow({
            status: "completed",
            native_thread_id: "native-oauth-thread-1",
            native_runtime_generation: 7,
            native_attempt_id: "attempt-7",
            native_thread_cleanup_completed_at:
              call === 1 ? null : cleanupCompletedAt,
          }),
        ],
      };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);

  const pending =
    await store.listOAuthThreadCleanupForRuntime("environment_1");
  const completed = await store.markOAuthThreadCleanupCompletedForRuntime(
    "environment_1",
    "github",
    {
      flowId: "mcp_oauth_1",
      nativeThreadId: "native-oauth-thread-1",
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );

  assert.equal(pending[0]?.nativeThreadCleanupCompletedAt, undefined);
  assert.equal(
    completed?.nativeThreadCleanupCompletedAt,
    cleanupCompletedAt,
  );
  assert.deepEqual(queries[0]?.values, [
    ["completed", "failed", "cancelled", "expired"],
    "environment_1",
  ]);
  assert.match(
    queries[0]?.sql ?? "",
    /native_thread_id IS NOT NULL[\s\S]+native_thread_cleanup_completed_at IS NULL/,
  );
  assert.match(queries[0]?.sql ?? "", /status = ANY\(\$1::TEXT\[\]\)/);
  assert.deepEqual(queries[1]?.values, [
    "environment_1",
    "github",
    "mcp_oauth_1",
    "native-oauth-thread-1",
    SHA256,
    OTHER_SHA256,
    ["completed", "failed", "cancelled", "expired"],
  ]);
  assert.match(
    queries[1]?.sql ?? "",
    /SET native_thread_cleanup_completed_at = NOW\(\)/,
  );
  assert.match(
    queries[1]?.sql ?? "",
    /flow\.id = \$3[\s\S]+flow\.native_thread_id = \$4[\s\S]+flow\.config_fingerprint = \$5[\s\S]+flow\.endpoint_fingerprint = \$6/,
  );
});

test("cancelled OAuth reconciliation lists live tombstones without deleting them", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [oauthFlowRow({ status: "cancelled" })],
      };
    },
  } as unknown as Pool;

  const flows = await new EnvironmentMcpIntegrationStore(
    pool,
  ).listCancelledOAuthFlowsForRuntime("environment_1");

  assert.equal(flows[0]?.status, "cancelled");
  assert.deepEqual(queryValues, ["environment_1"]);
  assert.match(querySql, /status IN \('cancelled', 'expired'\)/);
  assert.match(querySql, /cleanup_completed_at IS NULL/);
  assert.doesNotMatch(querySql, /DELETE/);
});

test("OAuth cleanup completion keeps quarantine until TTL and journals discard", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          oauthFlowRow({
            status: "cancelled",
            cleanup_completed_at: NOW,
          }),
        ],
      };
    },
  } as unknown as Pool;

  const flow = await new EnvironmentMcpIntegrationStore(
    pool,
  ).markOAuthFlowCleanupCompletedForRuntime(
    "environment_1",
    "github",
    {
      flowId: "mcp_oauth_1",
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );

  assert.equal(flow?.cleanupCompletedAt, NOW);
  assert.deepEqual(queryValues, [
    "environment_1",
    "github",
    "mcp_oauth_1",
    SHA256,
    OTHER_SHA256,
  ]);
  assert.match(querySql, /cleanup_completed_at = NOW\(\)/);
  assert.match(
    querySql,
    /WHEN target\.expires_at <= NOW\(\) THEN 'expired'/,
  );
  assert.match(querySql, /ELSE 'cancelled'/);
  assert.match(
    querySql,
    /WHEN integration\.lifecycle_status = 'deleting'\s+THEN 'deleting'/,
  );
});

test("OAuth runtime completion CASes auth mode and both fingerprints", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [oauthFlowRow({ status: "completed" })],
      };
    },
  } as unknown as Pool;

  const flow = await new EnvironmentMcpIntegrationStore(
    pool,
  ).markOAuthFlowForRuntime("environment_1", "github", {
    status: "completed",
    error: null,
    expectedConfigFingerprint: SHA256,
    expectedEndpointFingerprint: OTHER_SHA256,
  });

  assert.equal(flow?.status, "completed");
  assert.equal(queryValues?.[6], SHA256);
  assert.equal(queryValues?.[7], OTHER_SHA256);
  assert.match(querySql, /integration\.auth_mode = 'oauth'/);
  assert.match(
    querySql,
    /integration\.oauth_config_fingerprint =\s+flow\.config_fingerprint/,
  );
  assert.match(
    querySql,
    /integration\.endpoint_fingerprint =\s+flow\.endpoint_fingerprint/,
  );
  assert.match(querySql, /version = integration\.version \+ 1/);
});

test("OAuth correlation writes an immutable native thread under exact CAS", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      return {
        rowCount: 1,
        rows: [
          oauthFlowRow({
            status: "starting",
            native_thread_id: "native-oauth-thread-1",
            native_runtime_generation: 7,
            native_attempt_id: "",
          }),
        ],
      };
    },
  } as unknown as Pool;

  const store = new EnvironmentMcpIntegrationStore(pool);
  const flow = await store.markOAuthFlowCorrelation(
    "user_1",
    "environment_1",
    "mcp_oauth_1",
    {
      nativeThreadId: "native-oauth-thread-1",
      runtime: { runtimeGeneration: 7 },
      expiresAt,
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );
  const runtimeFlow = await store.markOAuthFlowCorrelationForRuntime(
    "environment_1",
    "github",
    {
      flowId: "mcp_oauth_1",
      nativeThreadId: "native-oauth-thread-1",
      runtime: { runtimeGeneration: 7 },
      expiresAt,
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );

  assert.equal(flow.nativeThreadId, "native-oauth-thread-1");
  assert.deepEqual(flow.nativeRuntime, {
    runtimeGeneration: 7,
    attemptId: "",
  });
  assert.equal(runtimeFlow?.nativeThreadId, "native-oauth-thread-1");
  assert.deepEqual(queries[0]?.values, [
    "user_1",
    "environment_1",
    "mcp_oauth_1",
    "native-oauth-thread-1",
    SHA256,
    OTHER_SHA256,
    expiresAt,
    7,
    "",
  ]);
  assert.match(
    queries[0]?.sql ?? "",
    /flow\.status = 'starting'/,
  );
  assert.match(
    queries[0]?.sql ?? "",
    /flow\.native_thread_id IS NULL[\s\S]+flow\.native_thread_id = \$4/,
  );
  assert.match(
    queries[0]?.sql ?? "",
    /flow\.native_runtime_generation IS NULL[\s\S]+flow\.native_attempt_id IS NULL/,
  );
  assert.match(
    queries[0]?.sql ?? "",
    /flow\.native_runtime_generation = \$8[\s\S]+flow\.native_attempt_id = \$9/,
  );
  assert.match(queries[0]?.sql ?? "", /expires_at = \$7/);
  assert.match(
    queries[0]?.sql ?? "",
    /flow\.config_fingerprint = \$5[\s\S]+flow\.endpoint_fingerprint = \$6/,
  );
  assert.match(
    queries[0]?.sql ?? "",
    /runtime\.desired_state <> 'terminated'/,
  );
  assert.match(
    queries[0]?.sql ?? "",
    /runtime\.runtime_generation = \$8[\s\S]+COALESCE\(runtime\.attempt_id, ''\) = \$9/,
  );
  assert.match(
    queries[1]?.sql ?? "",
    /integration\.oauth_config_fingerprint =\s+flow\.config_fingerprint/,
  );
  assert.match(
    queries[1]?.sql ?? "",
    /JOIN environment_runtime runtime[\s\S]+runtime\.desired_state <> 'terminated'[\s\S]+runtime\.runtime_generation = \$8[\s\S]+COALESCE\(runtime\.attempt_id, ''\) = \$9/,
  );
});

test("OAuth event journal normalizes an absent attempt id", async () => {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const occurredAt = new Date("2026-07-20T00:01:00.000Z");
  let call = 0;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values });
      call += 1;
      return call === 1
        ? { rowCount: 1, rows: [{ "?column?": 1 }] }
        : { rowCount: 1, rows: [{ environment_id: "environment_1" }] };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);
  const event = {
    runtimeGeneration: 4,
    supervisorSequence: 18,
    recordIndex: 1,
  };

  assert.equal(
    await store.hasOAuthNativeEventForRuntime("environment_1", event),
    true,
  );
  assert.equal(
    await store.recordOAuthNativeEventForRuntime(
      "environment_1",
      "github",
      {
        event,
        occurredAt,
        success: true,
        disposition: "stale-discarded",
      },
    ),
    "recorded",
  );

  assert.deepEqual(queries[0]?.values, ["environment_1", 4, 18, 1, ""]);
  assert.deepEqual(queries[1]?.values, [
    "environment_1",
    4,
    18,
    1,
    "",
    "github",
    true,
    "stale-discarded",
    occurredAt,
  ]);
  assert.match(
    queries[1]?.sql ?? "",
    /ON CONFLICT \(\s*environment_id, runtime_generation, supervisor_sequence,\s*record_index, attempt_id\s*\) DO NOTHING/,
  );
});

test("OAuth native terminal event atomically CASes, mutates, and journals", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const occurredAt = new Date("2020-07-20T00:05:00.000Z");
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          {
            disposition: "applied",
            flow: oauthFlowRow({
              status: "completed",
              native_thread_id: "native-oauth-thread-1",
              native_runtime_generation: 7,
              native_attempt_id: "attempt-7",
              expires_at: "2020-07-20T00:10:00.000Z",
              created_at: "2020-07-20T00:00:00.000Z",
              updated_at: "2020-07-20T00:01:00.000Z",
            }),
          },
        ],
      };
    },
  } as unknown as Pool;

  const result = await new EnvironmentMcpIntegrationStore(
    pool,
  ).applyOAuthNativeTerminalEventForRuntime(
    "environment_1",
    "github",
    {
      event: {
        runtimeGeneration: 7,
        supervisorSequence: 22,
        recordIndex: 1,
        attemptId: "attempt-7",
      },
      occurredAt,
      nativeThreadId: "native-oauth-thread-1",
      success: true,
      error: null,
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );

  assert.equal(result.disposition, "applied");
  assert.equal(
    result.disposition === "applied"
      ? result.flow.nativeThreadId
      : undefined,
    "native-oauth-thread-1",
  );
  assert.deepEqual(queryValues, [
    "environment_1",
    "github",
    7,
    22,
    1,
    "attempt-7",
    "native-oauth-thread-1",
    occurredAt,
    "completed",
    true,
    null,
    SHA256,
    OTHER_SHA256,
    ["starting", "awaiting_user"],
  ]);
  assert.match(
    querySql,
    /flow\.status = ANY\(\$14::TEXT\[\]\)/,
  );
  assert.match(querySql, /\$8 <= flow\.expires_at/);
  assert.doesNotMatch(querySql, /flow\.expires_at > NOW\(\)/);
  assert.match(querySql, /flow\.native_thread_id = \$7/);
  assert.match(querySql, /flow\.native_runtime_generation = \$3/);
  assert.match(querySql, /flow\.native_attempt_id = \$6/);
  assert.match(
    querySql,
    /flow\.config_fingerprint = \$12[\s\S]+flow\.endpoint_fingerprint = \$13/,
  );
  assert.match(querySql, /INSERT INTO environment_mcp_oauth_events/);
  assert.match(
    querySql,
    /updated_integration AS \([\s\S]+version = integration\.version \+ 1/,
  );
  assert.match(
    querySql,
    /updated_flow AS \([\s\S]+SET status = \$9/,
  );
  assert.match(
    querySql,
    /WHEN EXISTS \(SELECT 1 FROM existing_event\) THEN 'duplicate'/,
  );
});

test("OAuth terminal event after the flow expiry is stale", async () => {
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(_sql: string, values?: readonly unknown[]) {
      queryValues = values;
      return { rowCount: 1, rows: [{ disposition: "stale", flow: null }] };
    },
  } as unknown as Pool;
  const occurredAt = new Date("2026-07-20T00:11:00.000Z");

  const result = await new EnvironmentMcpIntegrationStore(
    pool,
  ).applyOAuthNativeTerminalEventForRuntime(
    "environment_1",
    "github",
    {
      event: {
        runtimeGeneration: 7,
        supervisorSequence: 23,
        recordIndex: 0,
        attemptId: "attempt-7",
      },
      occurredAt,
      nativeThreadId: "native-oauth-thread-1",
      success: true,
      expectedConfigFingerprint: SHA256,
      expectedEndpointFingerprint: OTHER_SHA256,
    },
  );

  assert.deepEqual(result, { disposition: "stale" });
  assert.equal(queryValues?.[7], occurredAt);
});

test("OAuth native terminal event distinguishes duplicate and stale outcomes", async () => {
  const outcomes = ["duplicate", "stale"] as const;
  let call = 0;
  const pool = {
    async query() {
      const disposition = outcomes[call];
      call += 1;
      return { rowCount: 1, rows: [{ disposition, flow: null }] };
    },
  } as unknown as Pool;
  const store = new EnvironmentMcpIntegrationStore(pool);
  const input = {
    event: {
      runtimeGeneration: 7,
      supervisorSequence: 22,
      recordIndex: 1,
      attemptId: "attempt-7",
    },
    occurredAt: new Date("2026-07-20T00:05:00.000Z"),
    nativeThreadId: "native-oauth-thread-1",
    success: false,
    expectedConfigFingerprint: SHA256,
    expectedEndpointFingerprint: OTHER_SHA256,
  };

  assert.deepEqual(
    await store.applyOAuthNativeTerminalEventForRuntime(
      "environment_1",
      "github",
      input,
    ),
    { disposition: "duplicate" },
  );
  assert.deepEqual(
    await store.applyOAuthNativeTerminalEventForRuntime(
      "environment_1",
      "github",
      input,
    ),
    { disposition: "stale" },
  );
});

test("deleting an OAuth flow preserves pending native thread cleanup", async () => {
  let querySql = "";
  const pool = {
    async query(sql: string) {
      querySql = sql;
      return {
        rowCount: 1,
        rows: [
          oauthFlowRow({
            status: "completed",
            native_thread_id: "native-oauth-thread-1",
            native_runtime_generation: 7,
            native_attempt_id: "attempt-7",
            native_thread_cleanup_completed_at: NOW,
          }),
        ],
      };
    },
  } as unknown as Pool;

  await new EnvironmentMcpIntegrationStore(pool).deleteOAuthFlow(
    "user_1",
    "environment_1",
    "mcp_oauth_1",
  );

  assert.match(
    querySql,
    /flow\.native_thread_id IS NULL[\s\S]+flow\.native_thread_cleanup_completed_at IS NOT NULL/,
  );
});

test("deleting an integration rejects outstanding credential references", async () => {
  let call = 0;
  const pool = {
    async query() {
      call += 1;
      if (call === 1) return { rowCount: 0, rows: [] };
      if (call === 2) {
        return { rowCount: 1, rows: [{ id: "environment_1" }] };
      }
      return {
        rowCount: 1,
        rows: [
          {
            credential_cleanup_required: true,
            blocking_oauth_flow: false,
          },
        ],
      };
    },
  } as unknown as Pool;

  await assert.rejects(
    new EnvironmentMcpIntegrationStore(pool).deleteIntegration(
      "user_1",
      "environment_1",
      "github",
    ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "mcp_integration_cleanup_required",
      ),
  );
});

test("deleting an integration preserves an unexpired OAuth tombstone", async () => {
  const queries: string[] = [];
  let call = 0;
  const pool = {
    async query(sql: string) {
      queries.push(sql);
      call += 1;
      if (call === 1) return { rowCount: 0, rows: [] };
      if (call === 2) {
        return { rowCount: 1, rows: [{ id: "environment_1" }] };
      }
      return {
        rowCount: 1,
        rows: [
          {
            credential_cleanup_required: false,
            blocking_oauth_flow: true,
          },
        ],
      };
    },
  } as unknown as Pool;

  await assert.rejects(
    new EnvironmentMcpIntegrationStore(pool).deleteIntegration(
      "user_1",
      "environment_1",
      "github",
    ),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "mcp_oauth_flow_blocking",
      ),
  );
  assert.match(
    queries[0] ?? "",
    /status IN \('starting', 'awaiting_user', 'cancelled'\)/,
  );
  assert.match(
    queries[0] ?? "",
    /flow\.status = 'expired'[\s\S]+flow\.cleanup_completed_at IS NULL/,
  );
  assert.match(
    queries[0] ?? "",
    /flow\.native_thread_id IS NOT NULL[\s\S]+flow\.native_thread_cleanup_completed_at IS NULL/,
  );
  assert.match(
    queries[0] ?? "",
    /flow\.server_name = integration\.server_name/,
  );
});

test("runtime deletion uses exact CAS and preserves blocking OAuth flows", async () => {
  let querySql = "";
  let queryValues: readonly unknown[] | undefined;
  const pool = {
    async query(sql: string, values?: readonly unknown[]) {
      querySql = sql;
      queryValues = values;
      return {
        rowCount: 1,
        rows: [
          integrationRow({
            lifecycle_status: "deleting",
            credential_source_ref: null,
            credential_binding_ref: null,
            binding_enabled: false,
            credential_status: "missing",
            version: 18,
          }),
        ],
      };
    },
  } as unknown as Pool;

  const deleted = await new EnvironmentMcpIntegrationStore(
    pool,
  ).deleteIntegrationForRuntimeIfUnreferenced(
    "environment_1",
    "github",
    {
      expectedVersion: 18,
      expectedEndpointFingerprint: SHA256.toUpperCase(),
    },
  );

  assert.equal(deleted?.serverName, "github");
  assert.deepEqual(queryValues, [
    "environment_1",
    "github",
    18,
    SHA256,
  ]);
  assert.match(querySql, /integration\.lifecycle_status = 'deleting'/);
  assert.match(querySql, /integration\.version = \$3/);
  assert.match(querySql, /integration\.endpoint_fingerprint = \$4/);
  assert.match(
    querySql,
    /flow\.server_name = integration\.server_name/,
  );
  assert.match(
    querySql,
    /flow\.status = 'expired'[\s\S]+flow\.cleanup_completed_at IS NULL/,
  );
  assert.match(
    querySql,
    /flow\.native_thread_id IS NOT NULL[\s\S]+flow\.native_thread_cleanup_completed_at IS NULL/,
  );
});
