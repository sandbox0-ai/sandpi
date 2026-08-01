import { z } from "zod";

import { SANDPI_PAID_PLAN_IDS } from "@/lib/billing";
import type { SandpiPreferences } from "@/lib/types";
import {
  BROWSER_DASHBOARD_VIEWPORT_LIMITS,
} from "@/lib/environment-browser";
import {
  ENVIRONMENT_SANDBOX_MEMORY_MAX_MIB,
  ENVIRONMENT_SANDBOX_MEMORY_MIN_MIB,
} from "@/lib/environment-resources";
import { MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS } from "@/lib/environment-lifecycle";
import {
  ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS,
  ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS,
} from "@/lib/environment-workspace-backup";
import {
  MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH,
  MAX_CODEX_INPUT_LOCAL_IMAGES,
} from "@/server/harnesses/codex/input-files";
import {
  MAX_CODEX_INPUT_BASE64_LENGTH,
  MAX_CODEX_INPUT_IMAGES,
} from "@/server/harnesses/codex/input-images";
import { networkPolicySchema } from "@/server/network-policy-schema";

export const environmentBrowserViewportSchema = z
  .object({
    width: z
      .number()
      .int()
      .min(BROWSER_DASHBOARD_VIEWPORT_LIMITS.minWidth)
      .max(BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxWidth),
    height: z
      .number()
      .int()
      .min(BROWSER_DASHBOARD_VIEWPORT_LIMITS.minHeight)
      .max(BROWSER_DASHBOARD_VIEWPORT_LIMITS.maxHeight),
  })
  .strict();

export const workspaceFileSearchQuerySchema = z
  .string()
  .trim()
  .max(512)
  .refine((value) => !value.includes("\0"));

export const codexReasoningEffortSchema = z.string().trim().min(1).max(100);

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(128)
  .refine((value) => !/[\u0000\r\n]/.test(value));

const codexReferenceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000\r\n]/.test(value));

const codexLocalImageSchema = z.object({
  name: codexReferenceNameSchema,
  path: z.string().trim().min(1).max(4_096),
});

export const codexLocalImagesSchema = z
  .array(codexLocalImageSchema)
  .max(MAX_CODEX_INPUT_LOCAL_IMAGES)
  .default([]);

export const codexComposerUploadSchema = z.object({
  name: codexReferenceNameSchema,
  mimeType: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !/[\u0000\r\n]/.test(value))
    .default("application/octet-stream"),
  dataBase64: z.string().min(1).max(MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH),
});

export const codexRateLimitResetSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const environmentScheduleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    prompt: z.string().trim().min(1).max(100_000),
    timing: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("once"),
        runAt: z.number().positive(),
      }),
      z.object({
        kind: z.literal("cron"),
        expression: z.string().trim().min(1).max(200),
        timeZone: z.string().trim().min(1).max(100),
      }),
    ]),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("newSession") }),
      z.object({
        kind: z.literal("session"),
        sessionId: z.string().trim().min(1).max(200),
      }),
    ]),
    overlapPolicy: z.literal("skip").default("skip"),
    enabled: z.boolean().default(true),
    title: z.string().trim().min(1).max(200).optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    collaborationMode: z.literal("plan").optional(),
    serviceTier: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

export const billingCheckoutSchema = z
  .object({
    planId: z.enum(SANDPI_PAID_PLAN_IDS),
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();

export const environmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const environmentOrderSchema = z
  .object({
    environmentIds: z
      .array(z.string().trim().min(1).max(200))
      .max(1_000)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Environment IDs must be unique.",
      }),
  })
  .strict();

export const environmentUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  idlePauseTimeoutSeconds: z
    .number()
    .int()
    .min(0)
    .max(MAX_ENVIRONMENT_IDLE_PAUSE_TIMEOUT_SECONDS),
  sandboxMemoryMiB: z
    .number()
    .int()
    .min(ENVIRONMENT_SANDBOX_MEMORY_MIN_MIB)
    .max(ENVIRONMENT_SANDBOX_MEMORY_MAX_MIB),
  workspaceBackup: z.object({
    intervalSeconds: z.literal(
      ENVIRONMENT_WORKSPACE_BACKUP_INTERVAL_OPTIONS.map((option) =>
        option.seconds,
      ),
    ).meta({ type: "integer" }),
    retentionCount: z.literal(
      ENVIRONMENT_WORKSPACE_BACKUP_RETENTION_OPTIONS,
    ).meta({ type: "integer" }),
  }),
  networkPolicy: networkPolicySchema,
});

export const workspaceBackupRestoreSchema = z.object({
  confirmation: z.string().min(1).max(80),
});

export const environmentProvisioningSchema = z.object({
  desiredState: z.literal("ready"),
});

export const codexPersonalitySelectionSchema = z.object({
  personality: z.enum(["friendly", "pragmatic"]),
});

export const codexMemoriesSettingsSchema = z.object({
  featureEnabled: z.boolean(),
  useMemories: z.boolean(),
  generateMemories: z.boolean(),
});

export const codexHookUpdateSchema = z
  .object({
    key: z.string().trim().min(1).max(8_192),
    enabled: z.boolean().optional(),
    trustedHash: z.string().trim().min(1).max(512).optional(),
  })
  .refine(
    (value) => value.enabled !== undefined || value.trustedHash !== undefined,
    { message: "A hook update is required." },
  )
  .describe("At least one of enabled or trustedHash is required.");

export const codexSkillConfigurationSchema = z.object({
  path: z.string().trim().min(1).max(4_096),
  enabled: z.boolean(),
});

const codexSkillRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((component) => component !== ".." && component !== ""),
    "Skill file paths must be normalized relative POSIX paths.",
  );

export const codexSkillPutSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: codexSkillRelativePathSchema,
            contentBase64: z
              .string()
              .max(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 4)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
                "contentBase64 must be canonical base64",
              )
              .refine(
                (value) =>
                  Buffer.from(value, "base64").toString("base64") === value,
                "contentBase64 must be canonical base64",
              )
              .refine(
                (value) =>
                  Buffer.from(value, "base64").byteLength <= 5 * 1024 * 1024,
                "Skill files may contain at most 5 MiB.",
              ),
            executable: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = value.files.map((file) => file.path);
    if (!paths.includes("SKILL.md")) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "A skill must include SKILL.md.",
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Skill file paths must be unique.",
      });
    }
  });

const codexMcpSharedConfigurationShape = {
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  startupTimeoutSec: z.number().positive().max(300).optional(),
  toolTimeoutSec: z.number().positive().max(3_600).optional(),
  enabledTools: z.array(z.string().trim().min(1).max(256)).max(512).optional(),
  disabledTools: z.array(z.string().trim().min(1).max(256)).max(512).optional(),
  defaultToolsApprovalMode: z
    .enum(["auto", "prompt", "writes", "approve"])
    .optional(),
} as const;

const codexMcpHttpUrlSchema = z
  .url()
  .max(8_192)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }, "MCP URLs must use HTTP(S) and cannot contain credentials.");

export const codexMcpServerConfigurationSchema = z.discriminatedUnion(
  "transport",
  [
    z
      .object({
        transport: z.literal("stdio"),
        command: z.string().trim().min(1).max(4_096),
        args: z.array(z.string().max(8_192)).max(256).default([]),
        cwd: z.string().trim().min(1).max(4_096).optional(),
        envVars: z.array(z.string().trim().min(1).max(256)).max(256).optional(),
        ...codexMcpSharedConfigurationShape,
      })
      .strict(),
    z
      .object({
        transport: z.literal("streamable-http"),
        url: codexMcpHttpUrlSchema,
        auth: z.enum(["oauth", "chatgpt"]).optional(),
        oauthResource: z.string().trim().min(1).max(8_192).optional(),
        scopes: z.array(z.string().trim().min(1).max(512)).max(128).optional(),
        ...codexMcpSharedConfigurationShape,
      })
      .strict(),
  ],
);

export const codexMcpServerEnabledSchema = z.object({
  enabled: z.boolean(),
});

export const codexInputImagesSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(255),
      mimeType: z.enum(["image/gif", "image/jpeg", "image/png", "image/webp"]),
      dataBase64: z.string().max(MAX_CODEX_INPUT_BASE64_LENGTH),
    }),
  )
  .max(MAX_CODEX_INPUT_IMAGES)
  .default([]);

export const sessionCreateSchema = z
  .object({
    environmentId: z.string().min(1),
    idempotencyKey: idempotencyKeySchema.optional(),
    prompt: z.string().trim().max(100_000).default(""),
    title: z.string().trim().max(200).optional(),
    modelId: z.string().max(200).optional(),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    collaborationMode: z.literal("plan").optional(),
    serviceTier: z.string().trim().min(1).max(100).optional(),
    sessionStartSource: z.enum(["startup", "clear"]).optional(),
    images: codexInputImagesSchema,
    localImages: codexLocalImagesSchema,
  })
  .refine(
    (value) =>
      value.prompt.length > 0 ||
      value.images.length > 0 ||
      value.localImages.length > 0,
    { message: "A Session requires text or an image." },
  )
  .describe("At least one of prompt, images, or localImages is required.");

export const sessionMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    completed: z.boolean().optional(),
    archived: z.boolean().optional(),
    unread: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0)
  .describe("At least one metadata field is required.");

export const turnCreateSchema = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    images: codexInputImagesSchema,
    modelId: z.string().trim().min(1).max(200).optional(),
    reasoningEffort: codexReasoningEffortSchema.optional(),
    clientMessageId: z.string().trim().min(1).max(200).optional(),
    collaborationMode: z.literal("plan").optional(),
    serviceTier: z.string().trim().min(1).max(100).optional(),
    localImages: codexLocalImagesSchema,
  })
  .refine(
    (value) =>
      value.text.length > 0 ||
      value.images.length > 0 ||
      value.localImages.length > 0,
    { message: "A Turn requires text or an image." },
  )
  .describe("At least one of text, images, or localImages is required.");

export const turnSteerSchema = z
  .object({
    expectedTurnId: z.string().trim().min(1).max(200),
    text: z.string().trim().max(100_000).default(""),
    images: codexInputImagesSchema,
    clientMessageId: z.string().trim().min(1).max(200).optional(),
    localImages: codexLocalImagesSchema,
  })
  .refine(
    (value) =>
      value.text.length > 0 ||
      value.images.length > 0 ||
      value.localImages.length > 0,
    { message: "Additional Turn input requires text or an image." },
  )
  .describe("At least one of text, images, or localImages is required.");

export const turnInterruptSchema = z.object({
  turnId: z.string().trim().min(1).max(200).optional(),
});

export const sessionReviewSchema = z
  .object({
    instructions: z.string().trim().min(1).max(100_000).optional(),
  })
  .default({});

export const sessionGoalUpdateSchema = z
  .object({
    objective: z.string().trim().min(1).max(10_000).optional(),
    status: z.enum(["active", "paused"]).optional(),
  })
  .refine(
    (value) => value.objective !== undefined || value.status !== undefined,
    { message: "A goal update is required." },
  )
  .describe("At least one of objective or status is required.");

export const sessionForkSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional() })
  .default({});

export const browserSessionSchema = z
  .object({ force: z.boolean().optional() })
  .strict();

export const browserOpenSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(8_192)
      .describe(
        "HTTP or HTTPS URL on localhost, 127.0.0.1, or ::1 inside the Environment sandbox.",
      ),
  })
  .strict();

export const preferencesSchema: z.ZodType<SandpiPreferences> = z.object({
  general: z.object({
    language: z.enum(["en", "zh-CN"]),
    timeZone: z.string().min(1).max(100),
    sendShortcut: z.enum(["enter", "mod-enter"]),
  }),
  appearance: z.object({
    theme: z.enum(["system", "light", "dark"]),
    density: z.enum(["comfortable", "compact"]),
  }),
});

export const workspaceIdeWriteSchema = z.object({
  encoding: z.literal("base64"),
  content: z
    .string()
    .max(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 4)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      "content must be canonical base64",
    ),
  baseRevision: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
});

export const workspaceIdeCreateEntrySchema = z
  .object({
    parentPath: z.string().trim().min(1).max(4_096),
    name: z.string().trim().min(1).max(255),
    kind: z.enum(["file", "folder"]),
  })
  .strict();

export const workspaceIdeRenameEntrySchema = z
  .object({
    path: z.string().trim().min(1).max(4_096),
    name: z.string().trim().min(1).max(255),
  })
  .strict();

export const workspaceIdeWatchSubscriptionSchema = z
  .object({
    type: z.literal("subscribe"),
    paths: z.array(z.string().trim().min(1).max(4_096)).max(64),
  })
  .strict();

export const terminalInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input"),
    data: z.string().max(1_000_000),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("binary"),
    dataBase64: z
      .string()
      .max(1_000_000)
      .regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "dataBase64 must be canonical base64",
      ),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("resize"),
    rows: z.number().int().min(1).max(1_000),
    cols: z.number().int().min(1).max(1_000),
    requestId: z.string().optional(),
  }),
  z.object({
    type: z.literal("signal"),
    signal: z.enum(["HUP", "INT", "QUIT", "TERM", "KILL", "WINCH"]),
    requestId: z.string().optional(),
  }),
]);
