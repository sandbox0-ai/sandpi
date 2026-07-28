import { createMockCodexHarnessState } from "@/harnesses/codex/events";
import type { CodexSession } from "@/harnesses/codex/types";
import { DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS } from "@/lib/environment-lifecycle";
import { ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB } from "@/lib/environment-resources";
import { createId, randomToken } from "@/lib/id";
import { toUnixTimestamp, type UnixTimestamp } from "@/lib/time";
import type {
  Environment,
  EnvironmentMetrics,
  RuntimeMetricSeries,
  SandpiDeploymentSummary,
  SandpiBootstrap,
  SandpiPreferences,
  SandpiUser,
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
  descriptor: Omit<RuntimeMetricSeries, "segments" | "stepSeconds">,
): RuntimeMetricSeries {
  const start = timestamp("2026-07-12T08:30:00+08:00");
  const points = values.map((value, index) => ({
    at: start + index * 5 * 60,
    value,
  }));

  return {
    ...descriptor,
    stepSeconds: 5 * 60,
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

export const mockEnvironments: Environment[] = [
  {
    id: "env-default",
    ownerId: mockViewer.id,
    idlePauseTimeoutSeconds: DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
    sandboxMemoryMiB: ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
    workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
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
    ownerId: mockViewer.id,
    idlePauseTimeoutSeconds: DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
    sandboxMemoryMiB: ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
    workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
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
    ownerId: mockViewer.id,
    idlePauseTimeoutSeconds: DEFAULT_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS,
    sandboxMemoryMiB: ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
    workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
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
  {
    id: "env-personal",
    ownerId: mockViewer.id,
    idlePauseTimeoutSeconds: 0,
    sandboxMemoryMiB: ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB,
    workspaceBackup: { intervalSeconds: 0, retentionCount: 7 },
    name: "Personal scratchpad",
    description: "A scratch workspace for personal experiments.",
    color: "#46627f",
    status: "ready",
    revision: 2,
    templateId: "coding-agent",
    rootfsSnapshotId: "rootfs-snap-personal-r2",
    workspaceVolumeId: "vol-personal-seed",
    sandboxId: "sbx_env_personal",
    sandboxState: "paused",
    supervisorSessionId: "ses_env_personal_codex",
    workspaceRoot: "/workspace",
    credentialRevision: 1,
    codingAgent: {
      harness: "codex",
      label: "Codex",
      status: "connected",
      account: "yan@example.com",
      lastVerified: timestamp("2026-07-12T07:20:00+08:00"),
    },
    networkPolicy: {
      mode: "block-all",
      domainExceptions: ["github.com", "chatgpt.com"],
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
  memoryLimitBytes: ENVIRONMENT_SANDBOX_MEMORY_DEFAULT_MIB * 1024 * 1024,
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
  owner: mockViewer,
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
    owner: mockViewer,
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
  compactSession(
    "session-personal-notes",
    "env-personal",
    "Refine personal dotfiles",
    "waiting",
    timestamp("2026-07-12T06:50:00+08:00"),
    false,
  ),
];

export function getMockBootstrap(
  requestedEnvironmentId?: string,
): SandpiBootstrap {
  const selectedEnvironment =
    mockEnvironments.find(
      (environment) => environment.id === requestedEnvironmentId,
    ) ??
    mockEnvironments[0];
  const selectedSession = mockSessions.find(
    (session) => session.environmentId === selectedEnvironment.id && !session.archived,
  );

  return structuredClone({
    viewer: mockViewer,
    deployment: mockDeployment,
    environments: mockEnvironments,
    sessions: mockSessions,
    preferences: mockPreferences,
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
  name: string;
}): Environment {
  const idSuffix = randomToken(8);

  return {
    ...structuredClone(mockEnvironments[0]),
    id: `env-${idSuffix}`,
    ownerId: mockViewer.id,
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
