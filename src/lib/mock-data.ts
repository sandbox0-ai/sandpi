import { SESSION_WORKSPACE_ROOT } from "@/lib/environment-blueprint";
import {
  getDefaultMockCodingAgentModel,
  getMockCodingAgentModels,
} from "@/lib/coding-agent-models";
import { createId, randomToken } from "@/lib/id";
import type {
  AuditEvent,
  CodingSession,
  Environment,
  MetricPoint,
  SandpiBootstrap,
  SandpiPreferences,
  WorkspaceFile,
} from "@/lib/types";

function metricSeries(values: number[]): MetricPoint[] {
  return values.map((value, index) => ({
    at: `2026-07-12T09:${String(index * 5).padStart(2, "0")}:00+08:00`,
    value,
  }));
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

export const mockEnvironments: Environment[] = [
  {
    id: "env-default",
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

const primarySession: CodingSession = {
  id: "session-auth-race",
  environmentId: "env-default",
  title: "Fix auth callback race",
  status: "running",
  unread: false,
  pinned: false,
  archived: false,
  harness: "codex",
  harnessLabel: "Codex",
  modelLabel: "GPT-5.2 Codex",
  createdAt: "2026-07-12T09:17:41+08:00",
  updatedAt: "2026-07-12T09:25:03+08:00",
  hardExpiresAt: "2026-08-11T09:17:41+08:00",
  sandboxId: "sbx_7f2a91",
  supervisorSessionId: "ses_cdx_01J2",
  workspaceRoot: SESSION_WORKSPACE_ROOT,
  workspaceVolumeId: "vol_session_7f2a91",
  environmentRevision: 12,
  messages: [
    {
      id: "message-1",
      role: "user",
      content:
        "There is an intermittent double-login after the OAuth callback. Find the race, fix it, and add a regression test.",
      createdAt: "2026-07-12T09:18:01+08:00",
    },
    {
      id: "message-2",
      role: "assistant",
      content:
        "I traced the callback through the attempt store and found a read-then-delete race. Two requests can validate the same code before either one deletes it. I changed consumption to an atomic operation and covered the concurrent path.",
      createdAt: "2026-07-12T09:24:48+08:00",
      activities: [
        {
          id: "activity-1",
          label: "Inspected auth flow",
          detail: "8 files · callback, store and session paths",
          status: "completed",
          duration: "34s",
        },
        {
          id: "activity-2",
          label: "Applied fix",
          detail: "Atomic code consumption inside one transaction",
          status: "completed",
          duration: "18s",
        },
        {
          id: "activity-3",
          label: "Ran focused tests",
          detail: "12 passed · auth-callback.test.ts",
          status: "completed",
          duration: "7s",
        },
      ],
      diff: {
        file: "app/api/auth-callback.ts",
        additions: 8,
        deletions: 5,
        lines: [
          "- const attempt = await authAttempts.find(code);",
          "- await authAttempts.delete(code);",
          "+ const attempt = await authAttempts.consume(code);",
          "+ if (!attempt) {",
          "+   throw new AuthError(\"invalid_or_expired_code\");",
          "+ }",
        ],
      },
    },
  ],
  files: workspaceFiles,
  auditEvents,
  metrics: {
    cpuPercent: metricSeries([4, 8, 7, 12, 19, 38, 27, 21, 32, 18, 16, 14]),
    memoryMiB: metricSeries([382, 388, 401, 418, 446, 472, 486, 492, 516, 508, 512, 508]),
    currentCpuPercent: 14,
    currentMemoryMiB: 508,
    memoryLimitMiB: 2048,
  },
};

function compactSession(
  id: string,
  environmentId: string,
  title: string,
  status: CodingSession["status"],
  updatedAt: string,
  unread: boolean,
): CodingSession {
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
    messages: [
      {
        id: `${id}-message`,
        role: "user",
        content: title,
        createdAt: updatedAt,
      },
    ],
  };
}

export const mockSessions: CodingSession[] = [
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
];

export function getMockBootstrap(): SandpiBootstrap {
  return structuredClone({
    environments: mockEnvironments,
    sessions: mockSessions,
    preferences: mockPreferences,
    selectedEnvironmentId: "env-default",
    selectedSessionId: "session-auth-race",
  });
}

export function createMockSession(
  environment: Environment,
  input: { title: string; prompt: string; modelLabel?: string },
): CodingSession {
  const id = createId("session", 8);
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return {
    ...structuredClone(primarySession),
    id,
    environmentId: environment.id,
    title: input.title,
    status: "running",
    unread: false,
    harness: environment.codingAgent.harness,
    harnessLabel: environment.codingAgent.label,
    modelLabel:
      getMockCodingAgentModels(environment.codingAgent.harness).find(
        (model) => model.label === input.modelLabel,
      )?.label ??
      getDefaultMockCodingAgentModel(environment.codingAgent.harness).label,
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
    messages: [
      {
        id: createId("message", 8),
        role: "user",
        content: input.prompt,
        createdAt: now.toISOString(),
      },
      {
        id: createId("message", 8),
        role: "assistant",
        content:
          "The Environment fork is ready. I’m connected to the new Codex session and will start by inspecting the workspace.",
        createdAt: now.toISOString(),
        activities: [
          {
            id: "fork-environment",
            label: `Forked ${environment.name} · r${environment.revision}`,
            detail: "Rootfs snapshot, private /workspace volume and network policy",
            status: "completed",
            duration: "1.2s",
          },
        ],
      },
    ],
  };
}

export function createMockEnvironment(input: { name: string }): Environment {
  const idSuffix = randomToken(8);

  return {
    ...structuredClone(mockEnvironments[0]),
    id: `env-${idSuffix}`,
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
