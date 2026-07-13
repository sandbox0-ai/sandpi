import { SESSION_WORKSPACE_ROOT } from "@/lib/environment-blueprint";
import { createMockCodexHarnessState } from "@/harnesses/codex/events";
import {
  getDefaultMockCodexModel,
  getMockCodexModel,
} from "@/harnesses/codex/models";
import type { CodexSession } from "@/harnesses/codex/types";
import { createId, randomToken } from "@/lib/id";
import type {
  Environment,
  MembershipPlanAssignment,
  RuntimeMetricSeries,
  SandpiPlan,
  SandpiDeploymentSummary,
  SandpiBootstrap,
  SandpiPreferences,
  SandpiUser,
  SessionAuditEvent,
  SessionAuditFeed,
  Team,
  TeamMembership,
  WorkspaceFile,
} from "@/lib/types";

function metricSeries(
  values: number[],
  descriptor: Omit<RuntimeMetricSeries, "segments">,
): RuntimeMetricSeries {
  const start = Date.parse("2026-07-12T08:30:00+08:00");
  const points = values.map((value, index) => ({
    at: new Date(start + index * 5 * 60 * 1_000).toISOString(),
    value,
  }));

  return {
    ...descriptor,
    // The split exercises the same no-join contract as sdk-js after a runtime restart.
    segments: [{ points: points.slice(0, 7) }, { points: points.slice(7) }],
  };
}

const workspaceFiles: WorkspaceFile[] = [
  {
    id: "workspace",
    name: "workspace",
    path: "/workspace",
    kind: "folder",
    children: [
      {
        id: "app",
        name: "app",
        path: "/workspace/app",
        kind: "folder",
        children: [
          {
            id: "api",
            name: "api",
            path: "/workspace/app/api",
            kind: "folder",
            children: [
              {
                id: "auth-callback",
                name: "auth-callback.ts",
                path: "/workspace/app/api/auth-callback.ts",
                kind: "file",
                language: "TypeScript",
                size: "3.2 KB",
                modifiedAt: "1 min ago",
                content: [
                  "export async function completeAuth(code: string) {",
                  "  const attempt = await authAttempts.consume(code);",
                  "",
                  "  if (!attempt) {",
                  "    throw new AuthError(\"invalid_or_expired_code\");",
                  "  }",
                  "",
                  "  return sessions.create({",
                  "    userId: attempt.userId,",
                  "    credentialVersion: attempt.credentialVersion,",
                  "  });",
                  "}",
                ].join("\n"),
              },
              {
                id: "session-store",
                name: "session-store.ts",
                path: "/workspace/app/api/session-store.ts",
                kind: "file",
                language: "TypeScript",
                size: "2.1 KB",
                modifiedAt: "8 min ago",
                content: [
                  "export const sessions = {",
                  "  async create(input: CreateSessionInput) {",
                  "    return database.session.create({ data: input });",
                  "  },",
                  "};",
                ].join("\n"),
              },
            ],
          },
          {
            id: "layout",
            name: "layout.tsx",
            path: "/workspace/app/layout.tsx",
            kind: "file",
            language: "TypeScript React",
            size: "1.4 KB",
            modifiedAt: "22 min ago",
            content: "export default function Layout({ children }: Props) {\n  return <main>{children}</main>;\n}",
          },
        ],
      },
      {
        id: "tests",
        name: "tests",
        path: "/workspace/tests",
        kind: "folder",
        children: [
          {
            id: "auth-test",
            name: "auth-callback.test.ts",
            path: "/workspace/tests/auth-callback.test.ts",
            kind: "file",
            language: "TypeScript",
            size: "4.7 KB",
            modifiedAt: "1 min ago",
            content: [
              "test(\"consumes an auth code once under contention\", async () => {",
              "  const results = await Promise.allSettled([",
              "    completeAuth(code),",
              "    completeAuth(code),",
              "  ]);",
              "",
              "  expect(successful(results)).toHaveLength(1);",
              "});",
            ].join("\n"),
          },
        ],
      },
      {
        id: "env-example",
        name: ".env.example",
        path: "/workspace/.env.example",
        kind: "file",
        language: "Environment",
        size: "282 B",
        modifiedAt: "2 days ago",
        content: "DATABASE_URL=\nAUTH_CALLBACK_URL=\n",
      },
      {
        id: "package-json",
        name: "package.json",
        path: "/workspace/package.json",
        kind: "file",
        language: "JSON",
        size: "1.1 KB",
        modifiedAt: "2 days ago",
        content: "{\n  \"name\": \"console\",\n  \"scripts\": {\n    \"test\": \"vitest run\"\n  }\n}\n",
      },
      {
        id: "readme",
        name: "README.md",
        path: "/workspace/README.md",
        kind: "file",
        language: "Markdown",
        size: "6.8 KB",
        modifiedAt: "3 days ago",
        content: "# Console\n\nInternal control plane for remote agent sessions.\n",
      },
    ],
  },
];

function mockAuditIntegrity(
  payloadDigit: string,
): SessionAuditEvent["integrity"] {
  return {
    algorithm: "ed25519-sha256-v1",
    payloadHash: payloadDigit.repeat(64),
    signature: `mock-signature-${payloadDigit}`,
    signingKeyId: "b".repeat(64),
    signatureStatus: "verified",
    eventIdConflict: false,
  };
}

const audit: SessionAuditFeed = {
  events: [
    {
      eventId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:24:18+08:00",
      ingestedAt: "2026-07-12T09:24:18.132+08:00",
      source: "netd",
      eventType: "network_audit",
      phase: "effect",
      outcome: "completed",
      actor: {
        kind: "sandbox_workload",
        id: "sbx_7f2a91",
        authMethod: "workload_token",
      },
      action: "network.connect",
      resource: { type: "sandbox_network", id: "sbx_7f2a91" },
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      producer: { service: "netd", instance: "netd-sg-runtime-a", sequence: 9412 },
      integrity: mockAuditIntegrity("1"),
      attributes: {
        flow_id: "flow-github-443",
        dest_ip: "20.205.243.166",
        dest_port: 443,
        transport: "tcp",
        protocol: "tls",
        host: "api.github.com",
        classifier_result: "tls_sni",
        action: "allow",
        outcome: "allowed",
        duration_ms: 92,
        egress_bytes: 18_432,
        ingress_bytes: 51_208,
      },
    },
    {
      eventId: "22222222-2222-4222-8222-222222222222",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:23:51+08:00",
      ingestedAt: "2026-07-12T09:23:51.084+08:00",
      source: "procd",
      eventType: "process",
      phase: "result",
      outcome: "completed",
      actor: { kind: "service", id: "procd", authMethod: "internal_token" },
      action: "process.exit",
      resource: {
        type: "process",
        id: "ctx_auth_test",
        subresource: "codex",
      },
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      producer: { service: "procd", instance: "sbx_7f2a91", sequence: 148 },
      integrity: mockAuditIntegrity("2"),
      attributes: {
        command: "npm test -- auth-callback.test.ts",
        exit_code: 0,
        duration_ms: 7_000,
      },
    },
    {
      eventId: "33333333-3333-4333-8333-333333333333",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:21:06+08:00",
      ingestedAt: "2026-07-12T09:21:06.106+08:00",
      source: "netd",
      eventType: "network_audit",
      phase: "effect",
      outcome: "denied",
      actor: {
        kind: "sandbox_workload",
        id: "sbx_7f2a91",
        authMethod: "workload_token",
      },
      action: "network.deny",
      resource: { type: "sandbox_network", id: "sbx_7f2a91" },
      operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      producer: { service: "netd", instance: "netd-sg-runtime-a", sequence: 9408 },
      integrity: mockAuditIntegrity("3"),
      attributes: {
        flow_id: "flow-telemetry-443",
        dest_ip: "203.0.113.44",
        dest_port: 443,
        transport: "tcp",
        protocol: "tls",
        host: "telemetry.example.dev",
        classifier_result: "tls_sni",
        action: "deny",
        reason: "not_in_policy",
        outcome: "denied",
        duration_ms: 4,
      },
    },
    {
      eventId: "44444444-4444-4444-8444-444444444444",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:17:57.800+08:00",
      ingestedAt: "2026-07-12T09:17:57.824+08:00",
      source: "cluster_gateway",
      eventType: "api_access",
      phase: "attempt",
      outcome: "accepted",
      actor: {
        kind: "api_key",
        id: "sandpi-deployment",
        apiKeyId: "key_sandpi_deployment",
        authMethod: "api_key",
      },
      action: "sandbox.resume",
      resource: { type: "sandbox", id: "sbx_7f2a91" },
      operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      producer: {
        service: "cluster-gateway",
        instance: "cluster-gateway-0",
        sequence: 7301,
      },
      request: {
        requestId: "req_resume_01",
        traceId: "trace_resume_01",
        sourceIp: "10.24.0.18",
        userAgent: "sandpi/0.1.0",
        httpMethod: "POST",
        route: "/api/v1/sandboxes/:id/resume",
      },
      integrity: mockAuditIntegrity("4"),
      attributes: { requested_state: "running" },
    },
    {
      eventId: "55555555-5555-4555-8555-555555555555",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:17:58+08:00",
      ingestedAt: "2026-07-12T09:17:58.041+08:00",
      source: "cluster_gateway",
      eventType: "api_access",
      phase: "result",
      outcome: "succeeded",
      actor: {
        kind: "api_key",
        id: "sandpi-deployment",
        apiKeyId: "key_sandpi_deployment",
        authMethod: "api_key",
      },
      action: "sandbox.resume",
      resource: { type: "sandbox", id: "sbx_7f2a91" },
      operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      parentEventId: "44444444-4444-4444-8444-444444444444",
      producer: {
        service: "cluster-gateway",
        instance: "cluster-gateway-0",
        sequence: 7302,
      },
      request: {
        requestId: "req_resume_01",
        traceId: "trace_resume_01",
        sourceIp: "10.24.0.18",
        userAgent: "sandpi/0.1.0",
        httpMethod: "POST",
        route: "/api/v1/sandboxes/:id/resume",
        statusCode: 200,
      },
      integrity: mockAuditIntegrity("5"),
      attributes: { operation_executed: true },
    },
    {
      eventId: "66666666-6666-4666-8666-666666666666",
      schemaVersion: 2,
      teamId: "team-sandpi-labs",
      sandboxId: "sbx_7f2a91",
      regionId: "ap-southeast-1",
      clusterId: "sg-runtime-a",
      occurredAt: "2026-07-12T09:17:58.200+08:00",
      ingestedAt: "2026-07-12T09:17:58.286+08:00",
      source: "manager",
      eventType: "lifecycle",
      phase: "effect",
      outcome: "completed",
      actor: { kind: "service", id: "manager", authMethod: "internal_token" },
      action: "sandbox.resume",
      resource: { type: "sandbox", id: "sbx_7f2a91" },
      operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      parentEventId: "55555555-5555-4555-8555-555555555555",
      producer: { service: "manager", instance: "manager-0", sequence: 318 },
      integrity: mockAuditIntegrity("6"),
      attributes: { runtime_generation: 3, template_id: "coding-agent" },
    },
  ],
  nextCursor: "mock-history-cursor",
  watermark: "2026-07-12T09:24:18.132+08:00",
};

export const mockViewer: SandpiUser = {
  id: "user-yan",
  name: "Yan Assistant",
  email: "yan@sandpi.dev",
  avatarInitials: "YA",
};

export const mockDeployment: SandpiDeploymentSummary = {
  mode: "cloud",
  identity: {
    protocol: "oidc",
    provider: "sandpi-auth0",
    label: "Sandpi Account",
    managedBy: "sandpi",
  },
  runtime: {
    provider: "sandbox0",
    status: "mock",
    configurationScope: "deployment",
  },
};

/** Mock catalog only. Production clients load effective Plan definitions from Sandpi. */
export const mockSandpiPlans: SandpiPlan[] = [
  {
    id: "free",
    name: "Free",
    execution: {
      weeklyLimitMinutes: 600,
      concurrentSessionLimit: 1,
    },
    storage: { snapshotLimitGiB: 5 },
  },
  {
    id: "pro",
    name: "Pro",
    execution: {
      weeklyLimitMinutes: 1_800,
      concurrentSessionLimit: 3,
    },
    storage: { snapshotLimitGiB: 20 },
  },
  {
    id: "max",
    name: "Max",
    execution: {
      weeklyLimitMinutes: 7_200,
      concurrentSessionLimit: 12,
    },
    storage: { snapshotLimitGiB: 80 },
  },
];

function mockPlanAssignment(input: {
  id: string;
  planId: MembershipPlanAssignment["planId"];
  usedMinutes: number;
  runningSessions: number;
  snapshotStorageGiB: number;
  resetsAt: string;
  periodStartsAt: string;
  periodEndsAt: string;
  status?: MembershipPlanAssignment["status"];
}): MembershipPlanAssignment {
  const plan = mockSandpiPlans.find((candidate) => candidate.id === input.planId);
  if (!plan) {
    throw new Error(`Mock Sandpi Plan ${input.planId} is not available.`);
  }

  return {
    id: input.id,
    planId: input.planId,
    status: input.status ?? "active",
    currentPeriodStartsAt: input.periodStartsAt,
    currentPeriodEndsAt: input.periodEndsAt,
    quotas: {
      weeklyExecution: {
        used: input.usedMinutes,
        limit: plan.execution.weeklyLimitMinutes,
        unit: "minute",
        window: "weekly",
        resetsAt: input.resetsAt,
      },
      concurrentSessions: {
        used: input.runningSessions,
        limit: plan.execution.concurrentSessionLimit,
        unit: "session",
      },
      snapshotStorage: {
        used: input.snapshotStorageGiB,
        limit: plan.storage.snapshotLimitGiB,
        unit: "gibibyte",
      },
    },
  };
}

export const mockTeams: Team[] = [
  {
    id: "team-sandpi-labs",
    name: "Sandpi Labs",
    slug: "sandpi-labs",
    color: "#315c4b",
    memberCount: 5,
    billingAccount: {
      id: "billing-sandpi-labs",
      status: "public-beta",
      billingCadence: "monthly",
      billingEmail: "billing@sandpi.dev",
      currentPeriodStartsAt: "2026-07-01T00:00:00Z",
      currentPeriodEndsAt: "2026-08-01T00:00:00Z",
    },
    createdAt: "2026-05-18T08:30:00Z",
  },
  {
    id: "team-side-projects",
    name: "Side Projects",
    slug: "side-projects",
    color: "#6b5478",
    memberCount: 1,
    billingAccount: {
      id: "billing-side-projects",
      status: "public-beta",
      billingCadence: "monthly",
      billingEmail: "yan@sandpi.dev",
      currentPeriodStartsAt: "2026-07-08T00:00:00Z",
      currentPeriodEndsAt: "2026-08-08T00:00:00Z",
    },
    createdAt: "2026-06-03T12:15:00Z",
  },
];

export const mockTeamMemberships: TeamMembership[] = [
  {
    id: "member-yan-labs",
    teamId: "team-sandpi-labs",
    user: mockViewer,
    role: "owner",
    status: "active",
    planAssignment: mockPlanAssignment({
      id: "plan-yan-labs",
      planId: "max",
      usedMinutes: 3_240,
      runningSessions: 3,
      snapshotStorageGiB: 18.6,
      resetsAt: "2026-07-20T00:00:00Z",
      periodStartsAt: "2026-07-01T00:00:00Z",
      periodEndsAt: "2026-08-01T00:00:00Z",
    }),
    joinedAt: "2026-05-18T08:30:00Z",
  },
  {
    id: "member-mira-labs",
    teamId: "team-sandpi-labs",
    user: {
      id: "user-mira",
      name: "Mira Chen",
      email: "mira@sandpi.dev",
      avatarInitials: "MC",
    },
    role: "admin",
    status: "active",
    planAssignment: mockPlanAssignment({
      id: "plan-mira-labs",
      planId: "pro",
      usedMinutes: 820,
      runningSessions: 1,
      snapshotStorageGiB: 5.8,
      resetsAt: "2026-07-20T00:00:00Z",
      periodStartsAt: "2026-07-01T00:00:00Z",
      periodEndsAt: "2026-08-01T00:00:00Z",
    }),
    joinedAt: "2026-05-20T10:00:00Z",
  },
  {
    id: "member-leo-labs",
    teamId: "team-sandpi-labs",
    user: {
      id: "user-leo",
      name: "Leo Wang",
      email: "leo@sandpi.dev",
      avatarInitials: "LW",
    },
    role: "member",
    status: "active",
    planAssignment: mockPlanAssignment({
      id: "plan-leo-labs",
      planId: "pro",
      usedMinutes: 530,
      runningSessions: 0,
      snapshotStorageGiB: 3.2,
      resetsAt: "2026-07-20T00:00:00Z",
      periodStartsAt: "2026-07-01T00:00:00Z",
      periodEndsAt: "2026-08-01T00:00:00Z",
    }),
    joinedAt: "2026-06-02T09:20:00Z",
  },
  {
    id: "member-ada-labs",
    teamId: "team-sandpi-labs",
    user: {
      id: "user-ada",
      name: "Ada Lin",
      email: "ada@sandpi.dev",
      avatarInitials: "AL",
    },
    role: "member",
    status: "active",
    planAssignment: mockPlanAssignment({
      id: "plan-ada-labs",
      planId: "free",
      usedMinutes: 160,
      runningSessions: 0,
      snapshotStorageGiB: 1.1,
      resetsAt: "2026-07-20T00:00:00Z",
      periodStartsAt: "2026-07-01T00:00:00Z",
      periodEndsAt: "2026-08-01T00:00:00Z",
    }),
    joinedAt: "2026-06-12T14:10:00Z",
  },
  {
    id: "member-noah-labs",
    teamId: "team-sandpi-labs",
    user: {
      id: "user-noah",
      name: "Noah Patel",
      email: "noah@sandpi.dev",
      avatarInitials: "NP",
    },
    role: "member",
    status: "invited",
    planAssignment: mockPlanAssignment({
      id: "plan-noah-labs",
      planId: "free",
      usedMinutes: 0,
      runningSessions: 0,
      snapshotStorageGiB: 0,
      resetsAt: "2026-07-20T00:00:00Z",
      periodStartsAt: "2026-07-01T00:00:00Z",
      periodEndsAt: "2026-08-01T00:00:00Z",
      status: "pending",
    }),
    joinedAt: "2026-07-12T06:40:00Z",
  },
  {
    id: "member-yan-side-projects",
    teamId: "team-side-projects",
    user: mockViewer,
    role: "owner",
    status: "active",
    planAssignment: mockPlanAssignment({
      id: "plan-yan-side-projects",
      planId: "pro",
      usedMinutes: 410,
      runningSessions: 1,
      snapshotStorageGiB: 4.2,
      resetsAt: "2026-07-15T00:00:00Z",
      periodStartsAt: "2026-07-08T00:00:00Z",
      periodEndsAt: "2026-08-08T00:00:00Z",
    }),
    joinedAt: "2026-06-03T12:15:00Z",
  },
];

export const mockEnvironments: Environment[] = [
  {
    id: "env-default",
    teamId: "team-sandpi-labs",
    name: "Development",
    description: "The fast path for everyday coding sessions.",
    color: "#151515",
    status: "ready",
    revision: 12,
    templateId: "coding-agent",
    rootfsSnapshotId: "rootfs-snap-default-r12",
    workspaceVolumeId: "vol-default-seed",
    credentialRevision: 4,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "dev@sandbox0.ai",
      lastVerified: "12 min ago",
    },
    networkPolicy: {
      mode: "restricted",
      allowedDomains: [
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "chatgpt.com",
      ],
      logDeniedRequests: true,
    },
    functions: [
      {
        id: "git-prewarm",
        name: "Git prewarm",
        description: "Warm repository objects and dependency caches after a Git push.",
        kind: "webhook",
        status: "active",
        lastRun: "18 min ago",
      },
      {
        id: "scheduled-refresh",
        name: "Scheduled maintenance",
        description: "Run an Environment maintenance function on a recurring schedule.",
        kind: "cron",
        status: "coming-soon",
      },
    ],
  },
  {
    id: "env-release",
    teamId: "team-sandpi-labs",
    name: "Release lab",
    description: "Pinned release tooling and stricter outbound access.",
    color: "#8c5b28",
    status: "ready",
    revision: 7,
    templateId: "coding-agent",
    rootfsSnapshotId: "rootfs-snap-release-r7",
    workspaceVolumeId: "vol-release-seed",
    credentialRevision: 2,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "release@sandbox0.ai",
      lastVerified: "Yesterday",
    },
    networkPolicy: {
      mode: "restricted",
      allowedDomains: ["github.com", "registry.npmjs.org", "chatgpt.com"],
      logDeniedRequests: true,
    },
    functions: [
      {
        id: "git-prewarm-release",
        name: "Git prewarm",
        description: "Refresh the release workspace from GitHub pushes.",
        kind: "webhook",
        status: "disabled",
      },
    ],
  },
  {
    id: "env-side-projects",
    teamId: "team-side-projects",
    name: "Experiments",
    description: "Small prototypes and weekend projects.",
    color: "#6b5478",
    status: "ready",
    revision: 3,
    templateId: "coding-agent",
    rootfsSnapshotId: "rootfs-snap-experiments-r3",
    workspaceVolumeId: "vol-experiments-seed",
    credentialRevision: 2,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "yan@example.com",
      lastVerified: "2 hours ago",
    },
    networkPolicy: {
      mode: "restricted",
      allowedDomains: ["github.com", "api.github.com", "chatgpt.com"],
      logDeniedRequests: true,
    },
    functions: [],
  },
];

export const mockPreferences: SandpiPreferences = {
  general: {
    language: "en",
    timeZone: "Asia/Shanghai",
    sendShortcut: "enter",
  },
  appearance: {
    theme: "system",
    density: "comfortable",
  },
  notifications: {
    sessionCompleted: true,
    needsAttention: true,
  },
};

const primarySession: CodexSession = {
  id: "session-auth-race",
  environmentId: "env-default",
  title: "Fix auth callback race",
  status: "running",
  unread: false,
  pinned: false,
  archived: false,
  harness: "codex",
  harnessLabel: "Codex",
  harnessState: createMockCodexHarnessState(
    "thr_mock_auth_race",
    getDefaultMockCodexModel().id,
    {
      content:
        "There is an intermittent double-login after the OAuth callback. Find the race, fix it, and add a regression test.",
      assistantText:
        "I traced the callback through the attempt store and found a read-then-delete race. Two requests can validate the same code before either one deletes it. I changed consumption to an atomic operation and covered the concurrent path.",
      createdAt: "2026-07-12T09:18:01+08:00",
      commands: [
        {
          command: "rg -n \"authAttempts|completeAuth\" app tests",
          output: "8 matching files",
          durationMs: 34_000,
        },
        {
          command: "npm test -- auth-callback.test.ts",
          output: "12 passed",
          durationMs: 7_000,
        },
      ],
      changes: [
        {
          path: "app/api/auth-callback.ts",
          kind: { type: "update", move_path: null },
          diff: [
            "- const attempt = await authAttempts.find(code);",
            "- await authAttempts.delete(code);",
            "+ const attempt = await authAttempts.consume(code);",
            "+ if (!attempt) {",
            "+   throw new AuthError(\"invalid_or_expired_code\");",
            "+ }",
          ].join("\n"),
        },
      ],
    },
  ),
  createdAt: "2026-07-12T09:17:41+08:00",
  updatedAt: "2026-07-12T09:25:03+08:00",
  hardExpiresAt: "2026-08-11T09:17:41+08:00",
  sandboxId: "sbx_7f2a91",
  supervisorSessionId: "ses_cdx_01J2",
  workspaceRoot: SESSION_WORKSPACE_ROOT,
  workspaceVolumeId: "vol_session_7f2a91",
  environmentRevision: 12,
  files: workspaceFiles,
  audit,
  metrics: {
    cpuUtilization: metricSeries(
      [0.04, 0.08, 0.07, 0.12, 0.19, 0.38, 0.27, 0.21, 0.32, 0.18, 0.16, 0.14],
      {
        metric: "sandbox.cpu.utilization",
        unit: "ratio",
        statistic: "average",
      },
    ),
    memoryWorkingSet: metricSeries(
      [382, 388, 401, 418, 446, 472, 486, 492, 516, 508, 512, 508].map(
        (value) => value * 1024 * 1024,
      ),
      {
        metric: "sandbox.memory.working_set",
        unit: "bytes",
        statistic: "average",
      },
    ),
    memoryLimitBytes: 2048 * 1024 * 1024,
    networkReceive: metricSeries(
      [96, 144, 208, 352, 680, 1210, 940, 520, 860, 1320, 780, 612].map(
        (value) => value * 1024,
      ),
      {
        metric: "sandbox.network.io",
        unit: "bytes_per_second",
        statistic: "rate",
        dimensions: { direction: "receive" },
      },
    ),
    networkTransmit: metricSeries(
      [42, 58, 92, 134, 310, 540, 410, 248, 390, 620, 356, 284].map(
        (value) => value * 1024,
      ),
      {
        metric: "sandbox.network.io",
        unit: "bytes_per_second",
        statistic: "rate",
        dimensions: { direction: "transmit" },
      },
    ),
  },
};

function compactSession(
  id: string,
  environmentId: string,
  title: string,
  status: CodexSession["status"],
  updatedAt: string,
  unread: boolean,
): CodexSession {
  const environment = mockEnvironments.find(
    (candidate) => candidate.id === environmentId,
  );

  if (!environment) {
    throw new Error(`Environment ${environmentId} is not available.`);
  }

  return {
    ...primarySession,
    id,
    environmentId,
    title,
    status,
    unread,
    updatedAt,
    sandboxId: `sbx_${id.slice(-6)}`,
    supervisorSessionId: `ses_${id.slice(-6)}`,
    workspaceVolumeId: `vol_${id.slice(-6)}`,
    audit: { events: [] },
    environmentRevision: environment.revision,
    harnessState: createMockCodexHarnessState(
      `thr_${id.slice(-12)}`,
      getDefaultMockCodexModel().id,
      {
        content: title,
        assistantText: "This mock Codex turn is ready to resume from its durable event cursor.",
        createdAt: updatedAt,
      },
    ),
  };
}

export const mockSessions: CodexSession[] = [
  primarySession,
  compactSession(
    "session-stream-events",
    "env-default",
    "Make event stream resumable",
    "waiting",
    "2026-07-12T08:42:00+08:00",
    true,
  ),
  compactSession(
    "session-settings",
    "env-default",
    "Polish environment settings",
    "paused",
    "2026-07-11T18:12:00+08:00",
    false,
  ),
  compactSession(
    "session-sdk-release",
    "env-release",
    "Prepare sdk-js release",
    "completed",
    "2026-07-11T15:34:00+08:00",
    true,
  ),
  compactSession(
    "session-harmony-shell",
    "env-side-projects",
    "Prototype HarmonyOS shell",
    "waiting",
    "2026-07-12T07:26:00+08:00",
    false,
  ),
];

export function getMockBootstrap(requestedTeamId?: string): SandpiBootstrap {
  const viewerMemberships = mockTeamMemberships.filter(
    (membership) => membership.user.id === mockViewer.id,
  );
  const viewerTeamIds = new Set(
    viewerMemberships.map((membership) => membership.teamId),
  );
  const teams = mockTeams.filter((team) => viewerTeamIds.has(team.id));
  const selectedTeam =
    teams.find((team) => team.id === requestedTeamId) ?? teams[0];
  if (!selectedTeam) {
    // Signup creates a one-member Team and Free assignment atomically, so production should
    // never render an authenticated account without at least one Team Membership.
    throw new Error("The mock viewer must belong to at least one Team.");
  }
  const selectedEnvironment =
    mockEnvironments.find((environment) => environment.teamId === selectedTeam.id) ??
    mockEnvironments[0];
  const selectedSession = mockSessions.find(
    (session) => session.environmentId === selectedEnvironment.id && !session.archived,
  );

  return structuredClone({
    viewer: mockViewer,
    teams,
    viewerMemberships,
    teamMemberships: mockTeamMemberships.filter((membership) =>
      viewerTeamIds.has(membership.teamId),
    ),
    plans: mockSandpiPlans,
    deployment: mockDeployment,
    environments: mockEnvironments,
    sessions: mockSessions,
    preferences: mockPreferences,
    selectedTeamId: selectedTeam.id,
    selectedEnvironmentId: selectedEnvironment.id,
    selectedSessionId: selectedSession?.id ?? "",
  });
}

export function createMockSession(
  environment: Environment,
  input: { title: string; prompt: string; modelId?: string },
): CodexSession {
  if (environment.codingAgent.harness !== "codex") {
    throw new Error(`The ${environment.codingAgent.harness} harness is not implemented.`);
  }
  const id = createId("session", 8);
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const threadId = `thr_${randomToken(10)}`;
  const model = getMockCodexModel(input.modelId ?? "");

  return {
    ...structuredClone(primarySession),
    id,
    environmentId: environment.id,
    title: input.title,
    status: "running",
    unread: false,
    harness: "codex",
    harnessLabel: environment.codingAgent.label,
    harnessState: createMockCodexHarnessState(threadId, model.id, {
      content: input.prompt,
      assistantText: `The Environment fork is ready. I’m connected to the new ${environment.codingAgent.label} thread and will start by inspecting the workspace.`,
      createdAt: now.toISOString(),
    }),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    hardExpiresAt: expires.toISOString(),
    sandboxId: `sbx_${randomToken(6)}`,
    supervisorSessionId: `ses_${randomToken(8)}`,
    workspaceRoot: SESSION_WORKSPACE_ROOT,
    workspaceVolumeId: `vol_${randomToken(8)}`,
    environmentRevision: environment.revision,
    audit: { events: [] },
    origin: {
      kind: "environment",
      label: environment.name,
    },
  };
}

export function createMockEnvironment(input: {
  teamId: string;
  name: string;
}): Environment {
  const idSuffix = randomToken(8);
  if (!mockTeams.some((team) => team.id === input.teamId)) {
    throw new Error(`Team ${input.teamId} is not available.`);
  }

  return {
    ...structuredClone(mockEnvironments[0]),
    id: `env-${idSuffix}`,
    teamId: input.teamId,
    name: input.name,
    description: "A versioned coding environment ready for isolated sessions.",
    color: "#405f78",
    revision: 1,
    rootfsSnapshotId: `rootfs-snap-${idSuffix}-r1`,
    workspaceVolumeId: `vol-${idSuffix}-seed`,
    credentialRevision: 1,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "dev@sandbox0.ai",
      lastVerified: "Just now",
    },
    functions: [],
  };
}
