import { SESSION_WORKSPACE_ROOT } from "@/lib/environment-blueprint";
import { createMockCodexHarnessState } from "@/harnesses/codex/events";
import {
  getDefaultMockCodexModel,
  getMockCodexModel,
} from "@/harnesses/codex/models";
import type { CodexSession } from "@/harnesses/codex/types";
import { createId, randomToken } from "@/lib/id";
import type {
  AuditEvent,
  Environment,
  RuntimeMetricSeries,
  SandpiDeploymentSummary,
  SandpiBootstrap,
  SandpiPreferences,
  SandpiUser,
  Team,
  TeamMember,
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

const auditEvents: AuditEvent[] = [
  {
    id: "audit-1",
    source: "sandbox0",
    category: "network",
    action: "egress.allowed",
    detail: "api.github.com:443 · TLS",
    outcome: "allowed",
    timestamp: "2026-07-12T09:24:18+08:00",
  },
  {
    id: "audit-2",
    source: "supervisor",
    category: "session",
    action: "session.input.accepted",
    detail: "seq 148 · 214 bytes",
    outcome: "success",
    timestamp: "2026-07-12T09:23:51+08:00",
  },
  {
    id: "audit-3",
    source: "sandbox0",
    category: "network",
    action: "egress.blocked",
    detail: "telemetry.example.dev:443 · not in policy",
    outcome: "blocked",
    timestamp: "2026-07-12T09:21:06+08:00",
  },
  {
    id: "audit-4",
    source: "supervisor",
    category: "session",
    action: "attempt.started",
    detail: "codex · attempt 1",
    outcome: "success",
    timestamp: "2026-07-12T09:18:12+08:00",
  },
  {
    id: "audit-5",
    source: "sandbox0",
    category: "lifecycle",
    action: "sandbox.resumed",
    detail: "runtime generation 3",
    outcome: "success",
    timestamp: "2026-07-12T09:17:58+08:00",
  },
];

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

export const mockTeams: Team[] = [
  {
    id: "team-sandpi-labs",
    name: "Sandpi Labs",
    slug: "sandpi-labs",
    color: "#315c4b",
    currentUserRole: "owner",
    memberCount: 5,
    subscription: {
      id: "sub-sandpi-labs",
      planId: "team",
      planName: "Sandpi Team",
      status: "active",
      billingCadence: "monthly",
      currentPeriodStartsAt: "2026-07-01T00:00:00Z",
      currentPeriodEndsAt: "2026-08-01T00:00:00Z",
      seats: { used: 5, included: 8 },
      quotas: {
        weeklyExecution: {
          used: 3_240,
          limit: 7_200,
          unit: "minute",
          window: "weekly",
          resetsAt: "2026-07-20T00:00:00Z",
        },
        concurrentSessions: {
          used: 3,
          limit: 12,
          unit: "session",
        },
        snapshotStorage: {
          used: 18.6,
          limit: 80,
          unit: "gibibyte",
        },
      },
    },
    createdAt: "2026-05-18T08:30:00Z",
  },
  {
    id: "team-side-projects",
    name: "Side Projects",
    slug: "side-projects",
    color: "#6b5478",
    currentUserRole: "owner",
    memberCount: 1,
    subscription: {
      id: "sub-side-projects",
      planId: "individual",
      planName: "Sandpi Individual",
      status: "active",
      billingCadence: "monthly",
      currentPeriodStartsAt: "2026-07-08T00:00:00Z",
      currentPeriodEndsAt: "2026-08-08T00:00:00Z",
      seats: { used: 1, included: 1 },
      quotas: {
        weeklyExecution: {
          used: 410,
          limit: 1_800,
          unit: "minute",
          window: "weekly",
          resetsAt: "2026-07-15T00:00:00Z",
        },
        concurrentSessions: {
          used: 1,
          limit: 3,
          unit: "session",
        },
        snapshotStorage: {
          used: 4.2,
          limit: 20,
          unit: "gibibyte",
        },
      },
    },
    createdAt: "2026-06-03T12:15:00Z",
  },
];

export const mockTeamMembers: TeamMember[] = [
  {
    id: "member-yan-labs",
    teamId: "team-sandpi-labs",
    user: mockViewer,
    role: "owner",
    status: "active",
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
    joinedAt: "2026-07-12T06:40:00Z",
  },
  {
    id: "member-yan-side-projects",
    teamId: "team-side-projects",
    user: mockViewer,
    role: "owner",
    status: "active",
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
  auditEvents,
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
  const selectedTeam =
    mockTeams.find((team) => team.id === requestedTeamId) ?? mockTeams[0];
  const selectedEnvironment =
    mockEnvironments.find((environment) => environment.teamId === selectedTeam.id) ??
    mockEnvironments[0];
  const selectedSession = mockSessions.find(
    (session) => session.environmentId === selectedEnvironment.id && !session.archived,
  );

  return structuredClone({
    viewer: mockViewer,
    teams: mockTeams,
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
