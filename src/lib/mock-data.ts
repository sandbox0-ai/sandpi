import { createMockCodexHarnessState } from "@/harnesses/codex/events";
import type { CodexSession } from "@/harnesses/codex/types";
import { createId, randomToken } from "@/lib/id";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";
import type {
  Environment,
  EnvironmentMetrics,
  MembershipPlanAssignment,
  RuntimeMetricSeries,
  SandpiPlan,
  SandpiDeploymentSummary,
  SandpiBootstrap,
  SandpiPreferences,
  SandpiUser,
  Team,
  TeamMembership,
} from "@/lib/types";

function timestamp(value: string) {
  return toUnixTimestamp(new Date(value));
}

// Test-fixture values only. Production model pickers always consume the bound
// coding agent's native model-list API and never read this mock data module.
const mockCodexModelIds = [
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
] as const;
const defaultMockCodexModelId = mockCodexModelIds[0];

function mockCodexModelId(modelId: string) {
  return mockCodexModelIds.some((candidate) => candidate === modelId)
    ? modelId
    : defaultMockCodexModelId;
}

function metricSeries(
  values: number[],
  descriptor: Omit<RuntimeMetricSeries, "segments">,
): RuntimeMetricSeries {
  const start = timestamp("2026-07-12T08:30:00+08:00");
  const points = values.map((value, index) => ({
    at: start + index * 5 * 60,
    value,
  }));

  return {
    ...descriptor,
    // The split exercises the same no-join contract as sdk-js after a runtime restart.
    segments: [{ points: points.slice(0, 7) }, { points: points.slice(7) }],
  };
}

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
  resetsAt: UnixTimestamp;
  periodStartsAt: UnixTimestamp;
  periodEndsAt: UnixTimestamp;
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
      currentPeriodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      currentPeriodEndsAt: timestamp("2026-08-01T00:00:00Z"),
    },
    createdAt: timestamp("2026-05-18T08:30:00Z"),
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
      currentPeriodStartsAt: timestamp("2026-07-08T00:00:00Z"),
      currentPeriodEndsAt: timestamp("2026-08-08T00:00:00Z"),
    },
    createdAt: timestamp("2026-06-03T12:15:00Z"),
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
      resetsAt: timestamp("2026-07-20T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-01T00:00:00Z"),
    }),
    joinedAt: timestamp("2026-05-18T08:30:00Z"),
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
      resetsAt: timestamp("2026-07-20T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-01T00:00:00Z"),
    }),
    joinedAt: timestamp("2026-05-20T10:00:00Z"),
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
      resetsAt: timestamp("2026-07-20T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-01T00:00:00Z"),
    }),
    joinedAt: timestamp("2026-06-02T09:20:00Z"),
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
      resetsAt: timestamp("2026-07-20T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-01T00:00:00Z"),
    }),
    joinedAt: timestamp("2026-06-12T14:10:00Z"),
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
      resetsAt: timestamp("2026-07-20T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-01T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-01T00:00:00Z"),
      status: "pending",
    }),
    joinedAt: timestamp("2026-07-12T06:40:00Z"),
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
      resetsAt: timestamp("2026-07-15T00:00:00Z"),
      periodStartsAt: timestamp("2026-07-08T00:00:00Z"),
      periodEndsAt: timestamp("2026-08-08T00:00:00Z"),
    }),
    joinedAt: timestamp("2026-06-03T12:15:00Z"),
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
    sandboxId: "sbx_7f2a91",
    sandboxState: "running",
    supervisorSessionId: "ses_cdx_01J2",
    workspaceRoot: "/workspace",
    credentialRevision: 4,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "dev@sandbox0.ai",
      lastVerified: timestamp("2026-07-12T09:13:00+08:00"),
    },
    networkPolicy: {
      mode: "block-all",
      domainExceptions: [
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "chatgpt.com",
      ],
    },
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
    sandboxId: "sbx_env_release",
    sandboxState: "running",
    supervisorSessionId: "ses_env_release_codex",
    workspaceRoot: "/workspace",
    credentialRevision: 2,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "release@sandbox0.ai",
      lastVerified: timestamp("2026-07-11T09:25:00+08:00"),
    },
    networkPolicy: {
      mode: "block-all",
      domainExceptions: ["github.com", "registry.npmjs.org", "chatgpt.com"],
    },
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
    sandboxId: "sbx_env_experiments",
    sandboxState: "running",
    supervisorSessionId: "ses_env_experiments_codex",
    workspaceRoot: "/workspace",
    credentialRevision: 2,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "yan@example.com",
      lastVerified: timestamp("2026-07-12T07:25:00+08:00"),
    },
    networkPolicy: {
      mode: "block-all",
      domainExceptions: ["github.com", "api.github.com", "chatgpt.com"],
    },
  },
];

export const mockPreferences: SandpiPreferences = {
  general: {
    language: "en",
    timeZone: "auto",
    sendShortcut: "enter",
  },
  appearance: {
    theme: "system",
    density: "comfortable",
  },
};

export const mockEnvironmentMetrics: EnvironmentMetrics = {
  window: {
    startedAt: timestamp("2026-07-12T08:30:00+08:00"),
    endedAt: timestamp("2026-07-12T09:30:00+08:00"),
  },
  pauseIntervals: [
    {
      startedAt: timestamp("2026-07-12T09:01:00+08:00"),
      endedAt: timestamp("2026-07-12T09:04:00+08:00"),
      reason: "idle",
    },
  ],
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
    defaultMockCodexModelId,
    {
      content:
        "There is an intermittent double-login after the OAuth callback. Find the race, fix it, and add a regression test.",
      assistantText:
        "I traced the callback through the attempt store and found a read-then-delete race. Two requests can validate the same code before either one deletes it. I changed consumption to an atomic operation and covered the concurrent path.",
      createdAt: timestamp("2026-07-12T09:18:01+08:00"),
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
  createdAt: timestamp("2026-07-12T09:17:41+08:00"),
  updatedAt: timestamp("2026-07-12T09:25:03+08:00"),
  environmentRevision: 12,
};

function compactSession(
  id: string,
  environmentId: string,
  title: string,
  status: CodexSession["status"],
  updatedAt: UnixTimestamp,
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
    environmentRevision: environment.revision,
    harnessState: createMockCodexHarnessState(
      `thr_${id.slice(-12)}`,
      defaultMockCodexModelId,
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
    timestamp("2026-07-12T08:42:00+08:00"),
    true,
  ),
  compactSession(
    "session-settings",
    "env-default",
    "Polish environment settings",
    "paused",
    timestamp("2026-07-11T18:12:00+08:00"),
    false,
  ),
  compactSession(
    "session-sdk-release",
    "env-release",
    "Prepare sdk-js release",
    "completed",
    timestamp("2026-07-11T15:34:00+08:00"),
    true,
  ),
  compactSession(
    "session-harmony-shell",
    "env-side-projects",
    "Prototype HarmonyOS shell",
    "waiting",
    timestamp("2026-07-12T07:26:00+08:00"),
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
  const now = toUnixTimestamp(new Date());
  const threadId = `thr_${randomToken(10)}`;
  const modelId = mockCodexModelId(input.modelId ?? "");

  return {
    ...structuredClone(primarySession),
    id,
    environmentId: environment.id,
    title: input.title,
    status: "running",
    unread: false,
    harness: "codex",
    harnessLabel: environment.codingAgent.label,
    harnessState: createMockCodexHarnessState(threadId, modelId, {
      content: input.prompt,
      assistantText: `I’m connected to a new ${environment.codingAgent.label} thread in the shared ${environment.name} workspace and will start by inspecting it.`,
      createdAt: now,
    }),
    createdAt: now,
    updatedAt: now,
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
      lastVerified: toUnixTimestamp(new Date()),
    },
  };
}
