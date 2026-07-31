import { z } from "zod";

import {
  SANDPI_PAID_PLAN_IDS,
  SANDPI_PLAN_IDS,
  type SandpiBillingSummary,
  type SandpiCheckoutResult,
} from "@/lib/billing";
import type { EnvironmentEgressCredential } from "@/lib/environment-credentials";
import type {
  CodingSession,
  Environment,
  EnvironmentCloudState,
  EnvironmentMetrics,
  EnvironmentResourceMetrics,
  EnvironmentSchedule,
  EnvironmentScheduleRun,
  EnvironmentWorkspaceBackup,
  SandpiBootstrap,
  SandpiCloudSnapshot,
  SandpiDeploymentSummary,
  SandpiPreferences,
  SandpiUser,
  WorkspaceDirectoryListing,
  WorkspaceFile,
  WorkspaceFileSearchResult,
  WorkspaceGitState,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
  WorkspaceIdeWatchSubscription,
} from "@/lib/types";
import type {
  CodexAccountRateLimits,
  CodexAccountSummary,
  CodexMcpInventory,
  CodexMcpOAuthLogin,
  CodexRateLimitResetResult,
  CodexSkillsInventory,
} from "@/harnesses/codex/environment-tools";
import type {
  CodexBackgroundTerminals,
  CodexHooksInventory,
  CodexMemoriesSettings,
  CodexPersonalitySettings,
  CodexTokenUsage,
} from "@/harnesses/codex/native-capabilities";
import type {
  CodexAgentThreads,
  CodexComposerUpload,
  CodexThread,
} from "@/harnesses/codex/types";
import { WORKSPACE_ROOT } from "@/lib/workspace-path-policy";
import {
  preferencesSchema,
  terminalInputSchema,
  workspaceIdeWatchSubscriptionSchema as workspaceIdeWatchSubscriptionInputSchema,
} from "@/server/api-schemas";
import type { PublicCodexDeviceAuthFlow } from "@/server/harnesses/codex/auth-store";

function component<T extends z.ZodType>(id: string, schema: T): T {
  z.globalRegistry.add(schema, { id });
  return schema;
}

export const unixTimestampSchema = z
  .number()
  .finite()
  .describe("Unix time in seconds; fractional values preserve milliseconds.");

export const errorSchema = component(
  "Error",
  z.object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string(),
      details: z.unknown().optional(),
      loginUrl: z.string().optional(),
    }),
  }),
);

export const principalSchema = component(
  "Principal",
  z.object({
    userId: z.string(),
    subject: z.string(),
    email: z.string(),
    name: z.string(),
    kind: z.enum(["builtin-admin", "oidc-session", "bearer"]),
  }),
);

export const sandpiUserSchema = component(
  "SandpiUser",
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    avatarInitials: z.string(),
  }),
);

export const deploymentSummarySchema = component(
  "SandpiDeploymentSummary",
  z.object({
    mode: z.enum(["cloud", "self-hosted"]),
    identity: z.object({
      protocol: z.enum(["builtin", "oidc"]),
      provider: z.enum([
        "builtin-admin",
        "sandpi-auth0",
        "deployment-oidc",
      ]),
      label: z.string(),
      managedBy: z.enum(["sandpi", "deployment"]),
    }),
    runtime: z.object({
      provider: z.literal("sandbox0"),
      status: z.enum(["configured", "mock", "unconfigured"]),
      configurationScope: z.literal("deployment"),
    }),
  }),
);

const harnessAccountSchema = z.object({
  harness: z.enum(["codex", "claude-code", "opencode", "pi"]),
  label: z.string(),
  status: z.enum(["connected", "not-connected", "coming-soon"]),
  account: z.string().optional(),
  lastVerified: unixTimestampSchema.optional(),
});

const networkPolicySchema = z.object({
  mode: z.enum(["allow-all", "block-all"]),
  domainExceptions: z.array(z.string()),
});

const workspaceBackupPolicySchema = z.object({
  intervalSeconds: z.number().int().nonnegative(),
  retentionCount: z.number().int().nonnegative(),
  nextBackupAt: unixTimestampSchema.optional(),
  lastBackupAt: unixTimestampSchema.optional(),
  lastError: z.string().optional(),
});

export const environmentSchema = component(
  "Environment",
  z.object({
    id: z.string(),
    ownerId: z.string(),
    idlePauseTimeoutSeconds: z.number().int().nonnegative(),
    sandboxMemoryMiB: z.number().int().positive(),
    workspaceBackup: workspaceBackupPolicySchema,
    name: z.string(),
    description: z.string(),
    color: z.string(),
    status: z.enum(["ready", "updating", "error"]),
    revision: z.number().int().nonnegative(),
    templateId: z.string(),
    rootfsSnapshotId: z.string(),
    workspaceVolumeId: z.string(),
    sandboxId: z.string(),
    sandboxState: z.enum([
      "pending",
      "provisioning",
      "running",
      "paused",
      "terminated",
      "failed",
    ]),
    supervisorSessionId: z.string(),
    workspaceRoot: z.literal(WORKSPACE_ROOT),
    provisioningError: z.string().optional(),
    credentialRevision: z.number().int().nonnegative(),
    codingAgent: harnessAccountSchema,
    networkPolicy: networkPolicySchema,
  }),
);

export const environmentCloudStateSchema = component(
  "EnvironmentCloudState",
  environmentSchema.omit({ sandboxState: true }),
);

export const workspaceBackupSchema = component(
  "EnvironmentWorkspaceBackup",
  z.object({
    id: z.string(),
    environmentId: z.string(),
    name: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    kind: z.enum(["automatic", "manual"]),
    createdAt: unixTimestampSchema,
  }),
);

const scheduleTimingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    runAt: unixTimestampSchema,
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string(),
    timeZone: z.string(),
  }),
]);

const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("newSession") }),
  z.object({ kind: z.literal("session"), sessionId: z.string() }),
]);

const scheduleRunStatusSchema = z.enum([
  "claimed",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const environmentScheduleSchema = component(
  "EnvironmentSchedule",
  z.object({
    id: z.string(),
    environmentId: z.string(),
    name: z.string(),
    prompt: z.string(),
    timing: scheduleTimingSchema,
    target: scheduleTargetSchema,
    overlapPolicy: z.literal("skip"),
    enabled: z.boolean(),
    title: z.string().optional(),
    modelId: z.string().optional(),
    reasoningEffort: z.string().optional(),
    collaborationMode: z.literal("plan").optional(),
    serviceTier: z.string().optional(),
    nextRunAt: unixTimestampSchema.optional(),
    lastScheduledFor: unixTimestampSchema.optional(),
    lastRunStatus: scheduleRunStatusSchema.optional(),
    lastError: z.string().optional(),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  }),
);

export const environmentScheduleRunSchema = component(
  "EnvironmentScheduleRun",
  z.object({
    id: z.string(),
    scheduleId: z.string(),
    scheduledFor: unixTimestampSchema,
    status: scheduleRunStatusSchema,
    sessionId: z.string().optional(),
    nativeTurnId: z.string().optional(),
    error: z.string().optional(),
    startedAt: unixTimestampSchema.optional(),
    finishedAt: unixTimestampSchema.optional(),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  }),
);

const codexHarnessStateSchema = z.object({
  protocol: z.literal("codex-app-server"),
  threadId: z.string(),
  modelId: z.string(),
  reasoningEffort: z.string().optional(),
  harnessVersion: z.string(),
  protocolVersion: z.literal("v2"),
  historyRevision: z.number().int().nonnegative(),
});

const sessionOriginSchema = z.object({
  kind: z.enum(["environment", "session", "turn"]),
  label: z.string(),
  sourceSessionId: z.string().optional(),
  sourceNativeItemId: z.string().optional(),
});

export const codingSessionSchema = component(
  "CodingSession",
  z.object({
    id: z.string(),
    environmentId: z.string(),
    owner: sandpiUserSchema.nullable(),
    title: z.string(),
    status: z.enum(["running", "waiting", "paused", "completed", "failed"]),
    unread: z.boolean(),
    pinned: z.boolean(),
    completed: z
      .boolean()
      .describe(
        "User-managed completion state. A later native Turn automatically resets it to false.",
      ),
    archived: z.boolean(),
    harness: z.enum(["codex", "claude-code", "opencode", "pi"]),
    harnessLabel: z.string(),
    harnessState: z.union([
      codexHarnessStateSchema,
      z.record(z.string(), z.unknown()),
    ]),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
    environmentRevision: z.number().int().nonnegative(),
    origin: sessionOriginSchema.optional(),
  }),
);

export const sandpiPreferencesSchema = component(
  "SandpiPreferences",
  preferencesSchema,
);

export const cloudSnapshotSchema = component(
  "SandpiCloudSnapshot",
  z.object({
    environments: z.array(environmentCloudStateSchema),
    sessions: z.array(codingSessionSchema),
    preferences: sandpiPreferencesSchema,
  }),
);

export const bootstrapSchema = component(
  "SandpiBootstrap",
  z.object({
    viewer: sandpiUserSchema,
    deployment: deploymentSummarySchema,
    environments: z.array(environmentSchema),
    sessions: z.array(codingSessionSchema),
    preferences: sandpiPreferencesSchema,
    selectedEnvironmentId: z.string(),
    selectedSessionId: z.string(),
  }),
);

const accountPlanSchema = z.object({
  id: z.enum(SANDPI_PLAN_IDS),
  name: z.string(),
  annualPriceUsd: z.number().nullable(),
  environmentLimit: z.number().int().nullable(),
  memoryConfigurable: z.boolean(),
  runtimeQuotaGiBHours: z.number().nullable(),
  quotaPeriod: z.enum(["account-month", "fixed-week", "unlimited"]),
});

export const billingSummarySchema = component(
  "SandpiBillingSummary",
  z.object({
    billingEnabled: z.boolean(),
    plan: accountPlanSchema,
    availablePlans: z.array(accountPlanSchema),
    subscription: z
      .object({
        status: z.enum([
          "incomplete",
          "incomplete_expired",
          "trialing",
          "active",
          "past_due",
          "canceled",
          "unpaid",
          "paused",
        ]),
        cancelAtPeriodEnd: z.boolean(),
        currentPeriodEndsAt: unixTimestampSchema.optional(),
        graceEndsAt: unixTimestampSchema.optional(),
        pendingPlanId: z.enum(SANDPI_PAID_PLAN_IDS).optional(),
        pendingEffectiveAt: unixTimestampSchema.optional(),
      })
      .optional(),
    usage: z.object({
      periodStartsAt: unixTimestampSchema,
      periodEndsAt: unixTimestampSchema,
      confirmedMiBMilliseconds: z.number().nonnegative(),
      projectedMiBMilliseconds: z.number().nonnegative(),
      usedMiBMilliseconds: z.number().nonnegative(),
      limitMiBMilliseconds: z.number().nonnegative().nullable(),
      remainingMiBMilliseconds: z.number().nonnegative().nullable(),
      usedGiBHours: z.number().nonnegative(),
      limitGiBHours: z.number().nonnegative().nullable(),
      percentUsed: z.number().nonnegative().nullable(),
      exhausted: z.boolean(),
    }),
    environmentCount: z.number().int().nonnegative(),
    overEnvironmentLimit: z.boolean(),
    customerPortalAvailable: z.boolean(),
    usageSource: z.enum(["sandbox0-sdk", "local-projection"]),
  }),
);

export const checkoutResultSchema = component(
  "SandpiCheckoutResult",
  z.object({
    kind: z.enum(["checkout", "subscription-updated"]),
    url: z.string().url().optional(),
  }),
);

export const customerPortalResultSchema = component(
  "SandpiCustomerPortalResult",
  z.object({ url: z.string().url() }),
);

const credentialProjectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("http_headers"),
    headers: z.array(
      z.object({ name: z.string(), valueTemplate: z.string() }),
    ),
  }),
  z.object({
    type: z.literal("placeholder_substitution"),
    replacements: z.array(
      z.object({
        placeholder: z.string(),
        valueTemplate: z.string(),
        locations: z.array(z.enum(["header", "query", "body"])),
      }),
    ),
  }),
  z.object({ type: z.literal("tls_client_certificate") }),
  z.object({ type: z.literal("username_password") }),
  z.object({
    type: z.literal("ssh_proxy"),
    upstreamUsername: z.string(),
    sandboxPublicKeys: z.array(z.string()),
    knownHosts: z.array(z.string()),
  }),
]);

export const egressCredentialSchema = component(
  "EnvironmentEgressCredential",
  z.object({
    id: z.string(),
    environmentId: z.string(),
    name: z.string(),
    resolverKind: z.enum([
      "static_headers",
      "static_tls_client_certificate",
      "static_username_password",
      "static_ssh_private_key",
    ]),
    projection: credentialProjectionSchema,
    rule: z.object({
      protocol: z.enum([
        "http",
        "https",
        "grpc",
        "tls",
        "ssh",
        "socks5",
        "mqtt",
        "redis",
      ]),
      domains: z.array(z.string()),
      ports: z.array(
        z.object({ port: z.number().int(), protocol: z.literal("tcp") }),
      ),
      failurePolicy: z.enum(["fail-closed", "fail-open"]),
    }),
    enabled: z.boolean(),
    status: z.enum(["provisioning", "active", "error", "deleting"]),
    currentVersion: z.number().int().optional(),
    sourceStatus: z.string().optional(),
    error: z.string().optional(),
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  }),
);

export const deviceAuthFlowSchema = component(
  "CodexDeviceAuthFlow",
  z.object({
    id: z.string(),
    environmentId: z.string(),
    status: z.enum([
      "provisioning",
      "starting",
      "awaiting_user",
      "completed",
      "failed",
      "cancelled",
      "expired",
    ]),
    verificationUrl: z.string().url().optional(),
    userCode: z.string().optional(),
    error: z.string().optional(),
    expiresAt: unixTimestampSchema,
    createdAt: unixTimestampSchema,
    updatedAt: unixTimestampSchema,
  }),
);

export const codexAccountSchema = component(
  "CodexAccountSummary",
  z.object({
    type: z.enum(["chatgpt", "unknown"]),
    email: z.string().optional(),
    planType: z
      .enum([
        "free",
        "go",
        "plus",
        "pro",
        "prolite",
        "team",
        "self_serve_business_usage_based",
        "business",
        "enterprise_cbp_usage_based",
        "enterprise",
        "edu",
        "unknown",
      ])
      .optional(),
    lastVerified: unixTimestampSchema.optional(),
  }),
);

const rateLimitWindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().optional(),
  resetsAt: unixTimestampSchema.optional(),
});

export const codexRateLimitsSchema = component(
  "CodexAccountRateLimits",
  z.object({
    limits: z.array(
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        planType: codexAccountSchema.shape.planType,
        primary: rateLimitWindowSchema.optional(),
        secondary: rateLimitWindowSchema.optional(),
        credits: z
          .object({
            hasCredits: z.boolean(),
            unlimited: z.boolean(),
            balance: z.string().optional(),
          })
          .optional(),
        individualLimit: z
          .object({
            limit: z.string(),
            used: z.string(),
            remainingPercent: z.number(),
            resetsAt: unixTimestampSchema,
          })
          .optional(),
        reached: z.boolean(),
      }),
    ),
    resetCredits: z
      .object({ availableCount: z.number().int().nonnegative() })
      .optional(),
    fetchedAt: unixTimestampSchema,
  }),
);

export const rateLimitResetResultSchema = component(
  "CodexRateLimitResetResult",
  z.object({
    outcome: z.enum([
      "reset",
      "nothingToReset",
      "noCredit",
      "alreadyRedeemed",
    ]),
  }),
);

export const personalitySettingsSchema = component(
  "CodexPersonalitySettings",
  z.object({
    personality: z.enum(["friendly", "pragmatic", "none"]),
    supported: z.boolean(),
  }),
);

export const tokenUsageSchema = component(
  "CodexTokenUsage",
  z.object({
    summary: z.object({
      lifetimeTokens: z.number().nullable(),
      peakDailyTokens: z.number().nullable(),
      longestRunningTurnSec: z.number().nullable(),
      currentStreakDays: z.number().nullable(),
      longestStreakDays: z.number().nullable(),
    }),
    dailyUsageBuckets: z.array(
      z.object({ startDate: z.string(), tokens: z.number() }),
    ),
  }),
);

export const memoriesSettingsSchema = component(
  "CodexMemoriesSettings",
  z.object({
    featureEnabled: z.boolean(),
    useMemories: z.boolean(),
    generateMemories: z.boolean(),
  }),
);

export const hooksInventorySchema = component(
  "CodexHooksInventory",
  z.object({
    cwd: z.string(),
    hooks: z.array(
      z.object({
        key: z.string(),
        eventName: z.string(),
        handlerType: z.string(),
        isManaged: z.boolean(),
        matcher: z.string().nullable(),
        command: z.string().nullable(),
        timeoutSec: z.number(),
        statusMessage: z.string().nullable(),
        sourcePath: z.string(),
        source: z.string(),
        pluginId: z.string().nullable(),
        displayOrder: z.number(),
        enabled: z.boolean(),
        currentHash: z.string(),
        trustStatus: z.enum(["trusted", "untrusted", "modified", "managed"]),
      }),
    ),
    warnings: z.array(z.string()),
    errors: z.array(
      z.object({ path: z.string().optional(), message: z.string() }),
    ),
  }),
);

export const composerUploadSchema = component(
  "CodexComposerUpload",
  z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    kind: z.enum(["file", "localImage"]),
    source: z.literal("upload"),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  }),
);

export const skillsInventorySchema = component(
  "CodexSkillsInventory",
  z.object({
    cwd: z.string(),
    skills: z.array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        description: z.string(),
        shortDescription: z.string().optional(),
        path: z.string(),
        scope: z.enum(["user", "repo", "system", "admin"]),
        enabled: z.boolean(),
        dependencies: z.array(
          z.object({
            type: z.string(),
            value: z.string(),
            description: z.string().optional(),
            transport: z.string().optional(),
            command: z.string().optional(),
            url: z.string().optional(),
          }),
        ),
      }),
    ),
    errors: z.array(z.object({ path: z.string(), message: z.string() })),
  }),
);

const mcpServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "streamable-http"]),
  command: z.string().optional(),
  args: z.array(z.string()),
  url: z.string().optional(),
  enabled: z.boolean(),
  managed: z.boolean(),
  runtimeStatus: z.enum([
    "connected",
    "authentication-required",
    "unavailable",
    "disabled",
  ]),
  serverTitle: z.string().optional(),
  authStatus: z.string().optional(),
  tools: z.array(z.string()),
  resources: z.array(
    z.object({
      name: z.string(),
      title: z.string().optional(),
      uri: z.string(),
    }),
  ),
  resourceTemplates: z.array(
    z.object({
      name: z.string(),
      title: z.string().optional(),
      uriTemplate: z.string(),
    }),
  ),
  toolCount: z.number().int().nonnegative(),
  resourceCount: z.number().int().nonnegative(),
});

export const mcpInventorySchema = component(
  "CodexMcpInventory",
  z.object({ servers: z.array(mcpServerSchema) }),
);

export const mcpOAuthLoginSchema = component(
  "CodexMcpOAuthLogin",
  z.object({
    name: z.string(),
    authorizationUrl: z.string().url(),
    expiresAt: unixTimestampSchema,
  }),
);

export const sessionGoalSchema = component(
  "CodexSessionGoal",
  z.object({
    goal: z
      .object({
        objective: z.string(),
        status: z.string(),
        tokenBudget: z.number().nullable(),
        tokensUsed: z.number(),
        timeUsedSeconds: z.number(),
      })
      .nullable(),
  }),
);

export const backgroundTerminalsSchema = component(
  "CodexBackgroundTerminals",
  z.object({
    terminals: z.array(
      z.object({
        itemId: z.string(),
        processId: z.string(),
        command: z.string(),
        cwd: z.string(),
        osPid: z.number().int().nullable(),
        cpuPercent: z.number().nullable(),
        rssKb: z.number().nullable(),
      }),
    ),
  }),
);

const codexThreadStatusSchema = z.union([
  z.object({ type: z.enum(["notLoaded", "idle", "systemError"]) }),
  z.object({
    type: z.literal("active"),
    activeFlags: z.array(
      z.enum(["waitingOnApproval", "waitingOnUserInput"]),
    ),
  }),
]);

const codexThreadItemSchema =
  z.custom<CodexThread["turns"][number]["items"][number]>();

const codexTurnSchema = z.object({
  id: z.string(),
  items: z.array(codexThreadItemSchema),
  itemsView: z.enum(["notLoaded", "summary", "full"]),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  error: z
    .object({
      message: z.string(),
      codexErrorInfo: z.unknown().nullable(),
      additionalDetails: z.string().nullable(),
    })
    .nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
});

export const codexThreadSchema = component(
  "CodexThread",
  z.looseObject({
    id: z.string(),
    sessionId: z.string().optional(),
    forkedFromId: z.string().nullable().optional(),
    parentThreadId: z.string().nullable().optional(),
    preview: z.string().optional(),
    ephemeral: z.boolean().optional(),
    modelProvider: z.string().optional(),
    path: z.string().nullable().optional(),
    cwd: z.string().optional(),
    source: z.unknown().optional(),
    canAcceptDirectInput: z.boolean().nullable().optional(),
    agentNickname: z.string().nullable().optional(),
    agentRole: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    status: codexThreadStatusSchema,
    turns: z.array(codexTurnSchema),
  }),
);

export const codexAgentThreadsSchema = component(
  "CodexAgentThreads",
  z.object({
    root: codexThreadSchema,
    descendants: z.array(codexThreadSchema),
  }),
);

export const workspaceFileSchema: z.ZodType<WorkspaceFile> = component(
  "WorkspaceFile",
  z.lazy(() =>
    z.object({
      id: z.string(),
      name: z.string(),
      path: z.string(),
      kind: z.enum(["file", "folder"]),
      language: z.string().optional(),
      size: z.string().optional(),
      modifiedAt: unixTimestampSchema.optional(),
      content: z.string().optional(),
      children: z.array(workspaceFileSchema).optional(),
    }),
  ),
);

export const workspaceSearchResultSchema = component(
  "WorkspaceFileSearchResult",
  z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(["file", "folder"]),
  }),
);

export const workspaceDirectoryListingSchema = component(
  "WorkspaceDirectoryListing",
  z.object({
    path: z.string(),
    entries: z.array(workspaceFileSchema),
    refreshedAt: unixTimestampSchema,
  }),
);

const gitFileChangeSchema = z.object({
  path: z.string(),
  relativePath: z.string(),
  originalPath: z.string().optional(),
  kind: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
  ]),
  indexStatus: z.string(),
  worktreeStatus: z.string(),
  staged: z.boolean(),
  unstaged: z.boolean(),
});

export const workspaceGitStateSchema: z.ZodType<WorkspaceGitState> = component(
  "WorkspaceGitState",
  z.object({
    repositories: z.array(
      z.object({
        root: z.string(),
        branch: z.string().optional(),
        head: z.string().optional(),
        upstream: z.string().optional(),
        ahead: z.number().int(),
        behind: z.number().int(),
        files: z.array(gitFileChangeSchema),
      }),
    ),
  }),
);

export const workspaceIdeSnapshotSchema = component(
  "WorkspaceIdeSnapshot",
  z.object({
    files: z.array(workspaceFileSchema),
    git: workspaceGitStateSchema,
    refreshedAt: unixTimestampSchema,
  }),
);

export const workspaceIdeFileSchema = component(
  "WorkspaceIdeFile",
  z.object({
    path: z.string(),
    name: z.string(),
    revision: z.string(),
    encoding: z.literal("base64"),
    content: z.string(),
    kind: z.enum(["binary", "text"]),
    preview: z
      .object({
        kind: z.enum(["audio", "image", "pdf", "presentation", "video"]),
        mimeType: z.string(),
      })
      .optional(),
    bom: z.literal("utf8").optional(),
    editable: z.boolean(),
    readOnlyReason: z
      .enum(["binary", "deleted", "sandpi-managed"])
      .optional(),
    size: z.string().optional(),
    modifiedAt: unixTimestampSchema.optional(),
    git: gitFileChangeSchema.optional(),
    lineChanges: z.array(
      z.object({
        line: z.number().int(),
        kind: z.enum(["added", "modified", "deleted"]),
        staged: z.boolean(),
        unstaged: z.boolean(),
        deletedLines: z.number().int().optional(),
        placement: z.enum(["before", "after"]).optional(),
      }),
    ),
  }),
);

export const workspaceIdeEventSchema = component(
  "WorkspaceIdeEvent",
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("ready"), at: unixTimestampSchema }),
    z.object({
      type: z.literal("change"),
      event: z.string(),
      path: z.string(),
      at: unixTimestampSchema,
    }),
    z.object({
      type: z.literal("error"),
      error: z.string(),
      code: z.literal("workspace_watch_unavailable").optional(),
      at: unixTimestampSchema,
    }),
  ]),
);

export const workspaceIdeWatchSubscriptionSchema: z.ZodType<WorkspaceIdeWatchSubscription> =
  component(
    "WorkspaceIdeWatchSubscription",
    workspaceIdeWatchSubscriptionInputSchema,
  );

const metricSeriesSchema = z.object({
  metric: z.enum([
    "sandbox.cpu.utilization",
    "sandbox.memory.working_set",
    "sandbox.network.io",
  ]),
  unit: z.enum(["ratio", "bytes", "bytes_per_second"]),
  statistic: z.enum(["average", "rate"]),
  stepSeconds: z.number().positive(),
  dimensions: z.record(z.string(), z.string()).optional(),
  segments: z.array(
    z.object({
      points: z.array(
        z.object({ at: unixTimestampSchema, value: z.number() }),
      ),
    }),
  ),
});

export const resourceMetricsSchema = component(
  "EnvironmentResourceMetrics",
  z.object({
    cpuUtilization: z.number().nullable(),
    memoryUtilization: z.number().nullable(),
  }),
);

export const environmentMetricsSchema = component(
  "EnvironmentMetrics",
  z.object({
    cpuUtilization: metricSeriesSchema,
    memoryWorkingSet: metricSeriesSchema,
    memoryLimitBytes: z.number().nonnegative(),
    networkReceive: metricSeriesSchema,
    networkTransmit: metricSeriesSchema,
    window: z.object({
      startedAt: unixTimestampSchema,
      endedAt: unixTimestampSchema,
    }),
    pauseIntervals: z.array(
      z.object({
        startedAt: unixTimestampSchema,
        endedAt: unixTimestampSchema.optional(),
        reason: z.enum(["idle", "quota", "manual"]),
      }),
    ),
  }),
);

export const terminalClientMessageSchema = component(
  "TerminalClientMessage",
  terminalInputSchema,
);

export const terminalServerMessageSchema = component(
  "TerminalServerMessage",
  z.union([
    z.object({
      type: z.literal("ready"),
      sessionId: z.string(),
      attemptId: z.string(),
      replayAfter: z.number().int(),
      replayUntil: z.number().int(),
      replayReset: z.boolean(),
    }),
    z.object({
      type: z.enum(["ack", "error", "event"]),
      requestId: z.string().optional(),
      error: z.string().optional(),
      code: z.string().optional(),
      event: z
        .object({
          seq: z.number().int(),
          attemptId: z.string().optional(),
          stream: z.string().optional(),
          dataBase64: z.string().optional(),
          type: z.string(),
          occurredAt: unixTimestampSchema,
        })
        .optional(),
    }),
  ]),
);

export const codexNativeSnapshotSchema = component(
  "CodexNativeSnapshot",
  z.looseObject({
    protocol: z.literal("codex-app-server"),
    nativeSessionId: z.string(),
    historyRevision: z.number().int().nonnegative(),
    modelId: z.string(),
    reasoningEffort: z.string().optional(),
    sessionStatus: z.enum([
      "running",
      "waiting",
      "paused",
      "completed",
      "failed",
    ]),
    thread: codexThreadSchema,
    tokenUsage: z.record(z.string(), z.unknown()).nullable().optional(),
    activity: z.record(z.string(), z.unknown()),
    forkableTurnIds: z.array(z.string()),
  }),
);

export const nativeHarnessEventSchema = component(
  "NativeHarnessEvent",
  z.object({
    harness: z.enum(["codex", "claude-code", "opencode", "pi"]),
    harnessVersion: z.string(),
    protocolVersion: z.string(),
    sequence: z.number().int().nonnegative(),
    receivedAt: unixTimestampSchema,
    notification: z.looseObject({
      method: z.string(),
      params: z.unknown(),
    }),
  }),
);

export function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.object({ data: schema });
}

export function dataMetaEnvelope<T extends z.ZodType, M extends z.ZodType>(
  schema: T,
  meta: M,
) {
  return z.object({ data: schema, meta });
}

export const idResultSchema = z.object({ id: z.string() });
export const acceptedResultSchema = z.object({ accepted: z.boolean() });
export const nativeTurnResultSchema = z.object({ nativeTurnId: z.string() });
export const turnSubmissionResultSchema = z.looseObject({
  requestId: z.string(),
  clientMessageId: z.string(),
  nativeTurnId: z.string().optional(),
});
export const turnInterruptResultSchema = z.union([
  z.object({ status: z.literal("settled") }),
  z.object({
    turnId: z.string(),
    status: z.literal("interrupting"),
  }),
]);

const publicModelTypeChecks: {
  principal: z.ZodType<{
    userId: string;
    subject: string;
    email: string;
    name: string;
    kind: "builtin-admin" | "oidc-session" | "bearer";
  }>;
  user: z.ZodType<SandpiUser>;
  deployment: z.ZodType<SandpiDeploymentSummary>;
  environment: z.ZodType<Environment>;
  environmentCloudState: z.ZodType<EnvironmentCloudState>;
  workspaceBackup: z.ZodType<EnvironmentWorkspaceBackup>;
  schedule: z.ZodType<EnvironmentSchedule>;
  scheduleRun: z.ZodType<EnvironmentScheduleRun>;
  session: z.ZodType<CodingSession>;
  preferences: z.ZodType<SandpiPreferences>;
  bootstrap: z.ZodType<SandpiBootstrap>;
  cloudSnapshot: z.ZodType<SandpiCloudSnapshot>;
  billing: z.ZodType<SandpiBillingSummary>;
  checkout: z.ZodType<SandpiCheckoutResult>;
  credential: z.ZodType<EnvironmentEgressCredential>;
  deviceAuth: z.ZodType<PublicCodexDeviceAuthFlow>;
  codexAccount: z.ZodType<CodexAccountSummary>;
  codexBackgroundTerminals: z.ZodType<CodexBackgroundTerminals>;
  codexRateLimits: z.ZodType<CodexAccountRateLimits>;
  codexRateLimitReset: z.ZodType<CodexRateLimitResetResult>;
  codexPersonality: z.ZodType<CodexPersonalitySettings>;
  codexTokenUsage: z.ZodType<CodexTokenUsage>;
  codexMemories: z.ZodType<CodexMemoriesSettings>;
  codexHooks: z.ZodType<CodexHooksInventory>;
  codexUpload: z.ZodType<CodexComposerUpload>;
  codexSkills: z.ZodType<CodexSkillsInventory>;
  codexMcp: z.ZodType<CodexMcpInventory>;
  codexMcpOAuth: z.ZodType<CodexMcpOAuthLogin>;
  codexThread: z.ZodType<CodexThread>;
  codexAgentThreads: z.ZodType<CodexAgentThreads>;
  workspaceFile: z.ZodType<WorkspaceFile>;
  workspaceSearch: z.ZodType<WorkspaceFileSearchResult>;
  workspaceListing: z.ZodType<WorkspaceDirectoryListing>;
  workspaceGit: z.ZodType<WorkspaceGitState>;
  workspaceIde: z.ZodType<WorkspaceIdeSnapshot>;
  workspaceIdeFile: z.ZodType<WorkspaceIdeFile>;
  workspaceIdeWatch: z.ZodType<WorkspaceIdeWatchSubscription>;
  resourceMetrics: z.ZodType<EnvironmentResourceMetrics>;
  metrics: z.ZodType<EnvironmentMetrics>;
} = {
  principal: principalSchema,
  user: sandpiUserSchema,
  deployment: deploymentSummarySchema,
  environment: environmentSchema,
  environmentCloudState: environmentCloudStateSchema,
  workspaceBackup: workspaceBackupSchema,
  schedule: environmentScheduleSchema,
  scheduleRun: environmentScheduleRunSchema,
  session: codingSessionSchema,
  preferences: sandpiPreferencesSchema,
  bootstrap: bootstrapSchema,
  cloudSnapshot: cloudSnapshotSchema,
  billing: billingSummarySchema,
  checkout: checkoutResultSchema,
  credential: egressCredentialSchema,
  deviceAuth: deviceAuthFlowSchema,
  codexAccount: codexAccountSchema,
  codexBackgroundTerminals: backgroundTerminalsSchema,
  codexRateLimits: codexRateLimitsSchema,
  codexRateLimitReset: rateLimitResetResultSchema,
  codexPersonality: personalitySettingsSchema,
  codexTokenUsage: tokenUsageSchema,
  codexMemories: memoriesSettingsSchema,
  codexHooks: hooksInventorySchema,
  codexUpload: composerUploadSchema,
  codexSkills: skillsInventorySchema,
  codexMcp: mcpInventorySchema,
  codexMcpOAuth: mcpOAuthLoginSchema,
  codexThread: codexThreadSchema,
  codexAgentThreads: codexAgentThreadsSchema,
  workspaceFile: workspaceFileSchema,
  workspaceSearch: workspaceSearchResultSchema,
  workspaceListing: workspaceDirectoryListingSchema,
  workspaceGit: workspaceGitStateSchema,
  workspaceIde: workspaceIdeSnapshotSchema,
  workspaceIdeFile: workspaceIdeFileSchema,
  workspaceIdeWatch: workspaceIdeWatchSubscriptionSchema,
  resourceMetrics: resourceMetricsSchema,
  metrics: environmentMetricsSchema,
};
void publicModelTypeChecks;
