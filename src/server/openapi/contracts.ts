import { z } from "zod";

import { ENVIRONMENT_METRIC_RANGES_SECONDS } from "@/lib/environment-metrics";
import { WORKSPACE_ROOT } from "@/lib/workspace-path-policy";
import {
  billingCheckoutSchema,
  browserOpenSchema,
  browserSessionSchema,
  codexComposerUploadSchema,
  codexHookUpdateSchema,
  codexMcpServerConfigurationSchema,
  codexMcpServerEnabledSchema,
  codexMemoriesSettingsSchema,
  codexPersonalitySelectionSchema,
  codexRateLimitResetSchema,
  codexSkillConfigurationSchema,
  codexSkillPutSchema,
  environmentBrowserViewportSchema,
  environmentCreateSchema,
  environmentOrderSchema,
  environmentProvisioningSchema,
  environmentScheduleSchema as environmentScheduleInputSchema,
  environmentWebhookSchema as environmentWebhookInputSchema,
  environmentUpdateSchema,
  preferencesSchema,
  rotateEnvironmentWebhookSecretSchema,
  sessionCreateSchema,
  sessionForkSchema,
  sessionGoalUpdateSchema,
  sessionMetadataSchema,
  sessionReviewSchema,
  turnCreateSchema,
  turnInterruptSchema,
  turnSteerSchema,
  workspaceBackupRestoreSchema,
  workspaceFileSearchQuerySchema,
  workspaceIdeCreateEntrySchema,
  workspaceIdeRenameEntrySchema,
  workspaceIdeWriteSchema,
} from "@/server/api-schemas";
import {
  createEnvironmentEgressCredentialSchema,
  environmentEgressCredentialConfigurationSchema,
  rotateEnvironmentEgressCredentialSchema,
} from "@/server/environment-credentials-schema";
import {
  acceptedResultSchema,
  backgroundTerminalsSchema,
  billingSummarySchema,
  bootstrapSchema,
  checkoutResultSchema,
  cloudSnapshotSchema,
  codexAccountSchema,
  codexAgentThreadsSchema,
  codexRateLimitsSchema,
  codexThreadSchema,
  codingSessionSchema,
  composerUploadSchema,
  customerPortalResultSchema,
  dataEnvelope,
  dataMetaEnvelope,
  deviceAuthFlowSchema,
  egressCredentialSchema,
  environmentMetricsSchema,
  environmentScheduleRunSchema,
  environmentScheduleSchema,
  environmentWebhookDeliverySchema,
  githubWebhookConnectionInventorySchema,
  githubWebhookInstallAttemptSchema,
  environmentWebhookRunSchema,
  environmentWebhookSchema,
  environmentWebhookSetupSchema,
  environmentSchema,
  errorSchema,
  hooksInventorySchema,
  idResultSchema,
  mcpInventorySchema,
  mcpOAuthLoginSchema,
  memoriesSettingsSchema,
  nativeTurnResultSchema,
  personalitySettingsSchema,
  principalSchema,
  rateLimitResetResultSchema,
  resourceMetricsSchema,
  sandpiPreferencesSchema,
  sessionGoalSchema,
  skillsInventorySchema,
  tokenUsageSchema,
  turnInterruptResultSchema,
  turnSubmissionResultSchema,
  workspaceBackupSchema,
  workspaceDirectoryListingSchema,
  workspaceFileSchema,
  workspaceGitStateSchema,
  workspaceIdeFileSchema,
  workspaceIdeSnapshotSchema,
  workspaceRuntimeAccessMetaSchema,
  workspaceSearchResultSchema,
} from "@/server/openapi/models";

export type OpenApiRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface OpenApiRouteContract {
  method: OpenApiRouteMethod;
  url: string;
  schema: {
    operationId?: string;
    summary?: string;
    description?: string;
    tags?: string[];
    security?: Array<Record<string, string[]>>;
    params?: z.ZodType;
    querystring?: z.ZodType;
    headers?: z.ZodType;
    body?: z.ZodType;
    response?: Record<string | number, z.ZodType>;
    hide?: boolean;
    [extension: `x-${string}`]: unknown;
  };
}

type ContractInput = Omit<OpenApiRouteContract, "schema"> & {
  schema: Omit<OpenApiRouteContract["schema"], "params" | "response"> & {
    params?: z.ZodType;
    response?: Record<string | number, z.ZodType>;
  };
  public?: boolean;
};

function defineContract(input: ContractInput): OpenApiRouteContract {
  const params = input.schema.params ?? pathParameters(input.url);
  const response = input.schema.hide
    ? undefined
    : {
        default: errorSchema,
        ...input.schema.response,
      };
  return {
    method: input.method,
    url: input.url,
    schema: {
      ...input.schema,
      ...(input.public ? { security: [] } : {}),
      ...(params ? { params } : {}),
      ...(response ? { response } : {}),
    },
  };
}

function pathParameters(url: string) {
  const names = [
    ...url.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g),
  ].map((match) => match[1]);
  if (names.length === 0) return undefined;
  return z.object(
    Object.fromEntries(
      names.map((name) => [name, z.string().min(1)]),
    ),
  );
}

const noContent = z.null().describe("No content.");
const redirect = z.null().describe("Redirect response.");
const rawObject = z.record(z.string(), z.unknown());
const webhookIngressResult = z.object({
  status: z.enum(["duplicate", "batched", "queued"]),
  deliveryId: z.string(),
  runId: z.string().optional(),
});
const githubWebhookIngressResult = z.object({
  status: z.enum(["accepted", "duplicate"]),
  deliveryId: z.string(),
});
const modelPage = z.object({ data: z.array(z.unknown()) });
const modelMeta = z.object({
  availability: z.enum(["available", "runtime-unavailable"]),
  source: z.literal("codex"),
  message: z.string().optional(),
});
const runtimeMeta = z.object({
  runtime: z.enum(["sandbox0", "unconfigured"]),
});
const workspaceMeta = z.object({
  source: z.enum(["sandbox0", "unconfigured"]),
  root: z.literal(WORKSPACE_ROOT),
});
const skillConfigurationResult = z.object({
  path: z.string(),
  enabled: z.boolean(),
});
const workspaceRawFile = z.object({
  path: z.string(),
  encoding: z.literal("base64"),
  content: z.string(),
  kind: z.enum(["binary", "text"]),
});

const browserDescription =
  "Sandpi's built-in Browser is one shared Playwright browser session for the human and the agent. The human can take over the embedded tab to complete an interactive sign-in, then hand the same authenticated profile back to the agent. Browser localhost and loopback URLs resolve inside the Environment sandbox, not on the client device.";

export const openApiRouteContracts: readonly OpenApiRouteContract[] = [
  defineContract({
    method: "GET",
    url: "/health/live",
    public: true,
    schema: {
      operationId: "getLiveness",
      summary: "Check process liveness",
      tags: ["Health"],
      response: {
        200: z.object({ status: z.literal("ok") }),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/health/ready",
    public: true,
    schema: {
      operationId: "getReadiness",
      summary: "Check dependency readiness",
      tags: ["Health"],
      response: {
        200: z.object({
          status: z.literal("ready"),
          database: z.literal("ready"),
          runtime: z.enum(["sandbox0", "unconfigured"]),
        }),
        503: z.object({
          status: z.literal("not-ready"),
          database: z.literal("unavailable"),
          runtime: z.enum(["sandbox0", "unconfigured"]),
        }),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/auth/login",
    public: true,
    schema: {
      operationId: "startLogin",
      summary: "Start browser-based sign-in",
      description:
        "Starts the deployment's OIDC flow. Self-hosted built-in-admin mode redirects locally without an external identity provider.",
      tags: ["Authentication"],
      querystring: z.object({
        return_to: z.string().optional(),
      }),
      response: { 302: redirect },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/auth/callback",
    public: true,
    schema: {
      operationId: "completeLogin",
      summary: "Complete OIDC sign-in",
      tags: ["Authentication"],
      querystring: z.looseObject({
        code: z.string().optional(),
        state: z.string().optional(),
      }),
      response: { 302: redirect },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/auth/native/prepare",
    public: true,
    schema: {
      operationId: "prepareNativeLogin",
      summary: "Prepare system-browser sign-in for a native client",
      description:
        "Creates a short-lived PKCE handoff without retaining the client's verifier.",
      tags: ["Authentication"],
      body: z.object({
        returnTo: z.string(),
        verifier: z.string(),
        state: z.string(),
      }),
      response: {
        200: dataEnvelope(
          z.object({
            authorizationUrl: z.string(),
            expiresAt: z.iso.datetime(),
          }),
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/auth/native/login",
    public: true,
    schema: {
      operationId: "startNativeLogin",
      summary: "Start system-browser sign-in for a native client",
      description:
        "Creates a short-lived PKCE handoff and starts the deployment's browser-based sign-in flow.",
      tags: ["Authentication"],
      querystring: z.object({
        attempt_id: z.string(),
      }),
      response: { 302: redirect },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/auth/native/finalize",
    schema: {
      operationId: "finalizeNativeLogin",
      summary: "Return completed browser sign-in to a native client",
      tags: ["Authentication"],
      querystring: z.object({
        attempt_id: z.string(),
      }),
      response: { 302: redirect },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/auth/native/complete",
    public: true,
    schema: {
      operationId: "completeNativeLogin",
      summary: "Exchange a native PKCE handoff for a WebView session",
      tags: ["Authentication"],
      body: z.object({
        attemptId: z.string(),
        code: z.string(),
        verifier: z.string(),
      }),
      response: {
        200: dataEnvelope(
          z.object({
            returnTo: z.string(),
          }),
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/auth/me",
    schema: {
      operationId: "getCurrentPrincipal",
      summary: "Get the authenticated principal",
      tags: ["Authentication"],
      response: { 200: dataEnvelope(principalSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/auth/logout",
    schema: {
      operationId: "logout",
      summary: "End the current browser session",
      tags: ["Authentication"],
      response: { 204: noContent },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/bootstrap",
    schema: {
      operationId: "getBootstrap",
      summary: "Load the initial application snapshot",
      tags: ["Bootstrap"],
      querystring: z.object({
        environment: z.string().optional(),
        session: z.string().optional(),
        new: z.literal("1").optional(),
      }),
      response: {
        200: dataMetaEnvelope(bootstrapSchema, runtimeMeta),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sync",
    schema: {
      operationId: "syncCloudState",
      summary: "Synchronize durable client state",
      description:
        "Returns a database-only snapshot and supports conditional requests without resolving external runtime lifecycle state.",
      tags: ["Bootstrap"],
      headers: z.looseObject({
        "if-none-match": z.string().optional(),
      }),
      response: {
        200: dataEnvelope(cloudSnapshotSchema),
        304: noContent,
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/billing/summary",
    schema: {
      operationId: "getBillingSummary",
      summary: "Get plan, subscription and usage state",
      tags: ["Billing"],
      response: { 200: dataEnvelope(billingSummarySchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/billing/checkout",
    schema: {
      operationId: "createBillingCheckout",
      summary: "Create or update a paid subscription",
      tags: ["Billing"],
      body: billingCheckoutSchema,
      response: { 200: dataEnvelope(checkoutResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/billing/portal",
    schema: {
      operationId: "createBillingPortalSession",
      summary: "Create a customer portal session",
      tags: ["Billing"],
      response: { 200: dataEnvelope(customerPortalResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/billing/webhook",
    public: true,
    schema: {
      operationId: "receiveStripeWebhook",
      summary: "Receive a signed Stripe webhook",
      description:
        "Deployment integration endpoint. Application clients do not call it.",
      tags: ["Billing"],
      headers: z.looseObject({
        "stripe-signature": z.string(),
      }),
      body: rawObject,
      response: { 204: noContent },
      "x-sandpi-audience": "deployment",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments",
    schema: {
      operationId: "listEnvironments",
      summary: "List accessible Environments",
      tags: ["Environments"],
      response: { 200: dataEnvelope(z.array(environmentSchema)) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId",
    schema: {
      operationId: "getEnvironment",
      summary: "Get an Environment",
      tags: ["Environments"],
      response: { 200: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments",
    schema: {
      operationId: "createEnvironment",
      summary: "Create an Environment",
      tags: ["Environments"],
      body: environmentCreateSchema,
      response: { 201: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/order",
    schema: {
      operationId: "reorderEnvironments",
      summary: "Replace the Environment display order",
      tags: ["Environments"],
      body: environmentOrderSchema,
      response: { 200: dataEnvelope(z.array(environmentSchema)) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId",
    schema: {
      operationId: "updateEnvironment",
      summary: "Replace mutable Environment settings",
      tags: ["Environments"],
      body: environmentUpdateSchema,
      response: { 200: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId",
    schema: {
      operationId: "deleteEnvironment",
      summary: "Delete an Environment",
      tags: ["Environments"],
      response: { 200: dataEnvelope(idResultSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/sandbox/pause",
    schema: {
      operationId: "pauseEnvironmentSandbox",
      summary: "Pause an Environment Sandbox",
      description:
        "Explicitly pauses the shared Sandbox under the Environment lifecycle lock. Workspace and browser profile data remain durable, while live processes and connections stop.",
      tags: ["Environments"],
      response: { 200: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/sandbox/restart",
    schema: {
      operationId: "restartEnvironmentSandbox",
      summary: "Restart an Environment Sandbox",
      description:
        "Performs one committed pause and resume under the Environment lifecycle lock so Sandbox0 advances the runtime generation. Persistent Workspace and browser profile data are retained.",
      tags: ["Environments"],
      response: { 200: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/provisioning",
    schema: {
      operationId: "retryEnvironmentProvisioning",
      summary: "Retry Environment provisioning",
      tags: ["Environments"],
      body: environmentProvisioningSchema,
      response: { 202: dataEnvelope(environmentSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/egress-credentials",
    schema: {
      operationId: "listEnvironmentEgressCredentials",
      summary: "List secret-free egress credential projections",
      tags: ["Egress credentials"],
      response: { 200: dataEnvelope(z.array(egressCredentialSchema)) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/egress-credentials/:credentialId",
    schema: {
      operationId: "getEnvironmentEgressCredential",
      summary: "Get one secret-free egress credential projection",
      tags: ["Egress credentials"],
      response: { 200: dataEnvelope(egressCredentialSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/egress-credentials",
    schema: {
      operationId: "createEnvironmentEgressCredential",
      summary: "Create an egress credential",
      tags: ["Egress credentials"],
      body: createEnvironmentEgressCredentialSchema,
      response: { 201: dataEnvelope(egressCredentialSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/egress-credentials/:credentialId",
    schema: {
      operationId: "updateEnvironmentEgressCredential",
      summary: "Replace an egress credential configuration",
      tags: ["Egress credentials"],
      body: environmentEgressCredentialConfigurationSchema,
      response: { 200: dataEnvelope(egressCredentialSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/egress-credentials/:credentialId/material",
    schema: {
      operationId: "rotateEnvironmentEgressCredential",
      summary: "Replace egress credential secret material",
      tags: ["Egress credentials"],
      body: rotateEnvironmentEgressCredentialSchema,
      response: { 200: dataEnvelope(egressCredentialSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/egress-credentials/:credentialId",
    schema: {
      operationId: "deleteEnvironmentEgressCredential",
      summary: "Delete an egress credential",
      tags: ["Egress credentials"],
      response: { 200: dataEnvelope(idResultSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/workspace-backups",
    schema: {
      operationId: "listEnvironmentWorkspaceBackups",
      summary: "List Workspace backups",
      tags: ["Workspace backups"],
      response: { 200: dataEnvelope(z.array(workspaceBackupSchema)) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/workspace-backups",
    schema: {
      operationId: "createEnvironmentWorkspaceBackup",
      summary: "Create a Workspace backup now",
      tags: ["Workspace backups"],
      response: {
        201: dataEnvelope(
          z.object({
            backup: workspaceBackupSchema,
            environment: environmentSchema,
          }),
        ),
      },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/workspace-backups/:snapshotId/restore",
    schema: {
      operationId: "restoreEnvironmentWorkspaceBackup",
      summary: "Restore a Workspace backup",
      tags: ["Workspace backups"],
      body: workspaceBackupRestoreSchema,
      response: {
        200: dataEnvelope(
          z.object({
            backup: workspaceBackupSchema,
            environment: environmentSchema,
            unavailableSessionCount: z.number().int().nonnegative(),
          }),
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/schedules",
    schema: {
      operationId: "listEnvironmentSchedules",
      summary: "List Environment automations",
      tags: ["Schedules"],
      response: { 200: dataEnvelope(z.array(environmentScheduleSchema)) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/schedules",
    schema: {
      operationId: "createEnvironmentSchedule",
      summary: "Create an Environment automation",
      tags: ["Schedules"],
      body: environmentScheduleInputSchema,
      response: { 201: dataEnvelope(environmentScheduleSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/schedules/:scheduleId",
    schema: {
      operationId: "updateEnvironmentSchedule",
      summary: "Replace an Environment automation",
      tags: ["Schedules"],
      body: environmentScheduleInputSchema,
      response: { 200: dataEnvelope(environmentScheduleSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/schedules/:scheduleId",
    schema: {
      operationId: "deleteEnvironmentSchedule",
      summary: "Delete an Environment automation",
      tags: ["Schedules"],
      response: { 200: dataEnvelope(idResultSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/schedules/:scheduleId/runs",
    schema: {
      operationId: "listEnvironmentScheduleRuns",
      summary: "List recent automation runs",
      tags: ["Schedules"],
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      response: { 200: dataEnvelope(z.array(environmentScheduleRunSchema)) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/webhooks/:endpointId",
    public: true,
    schema: {
      operationId: "receiveEnvironmentWebhook",
      summary: "Receive an authenticated Environment webhook delivery",
      description:
        "Accepts JSON, form, or text payloads authenticated with a bearer or query token.",
      tags: ["Webhooks"],
      "x-sandpi-request-content-types": [
        "application/json",
        "application/x-www-form-urlencoded",
        "text/plain",
      ],
      headers: z.object({
        authorization: z.string().optional(),
        "idempotency-key": z.string().optional(),
        "x-request-id": z.string().optional(),
        "x-sandpi-delivery": z.string().optional(),
        "x-sandpi-event": z.string().optional(),
      }),
      querystring: z.object({ token: z.string().optional() }),
      body: z.unknown(),
      response: {
        200: webhookIngressResult,
        202: webhookIngressResult,
      },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/webhook-sources/github/events",
    public: true,
    schema: {
      operationId: "receiveGitHubWebhook",
      summary: "Receive a signed GitHub App webhook delivery",
      description:
        "Verifies the deployment GitHub App signature, durably acknowledges the delivery, and routes it to matching Environment Webhooks.",
      tags: ["Webhooks"],
      "x-sandpi-request-content-types": ["application/json"],
      headers: z.object({
        "x-hub-signature-256": z.string(),
        "x-github-delivery": z.string(),
        "x-github-event": z.string(),
      }),
      body: z.unknown(),
      response: {
        200: githubWebhookIngressResult,
        202: githubWebhookIngressResult,
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/webhook-sources/github/callback",
    public: true,
    schema: {
      operationId: "completeGitHubWebhookInstall",
      summary: "Complete GitHub App installation for Webhooks",
      tags: ["Webhooks"],
      querystring: z.looseObject({
        code: z.string().min(1),
        state: z.string().min(1),
        installation_id: z.string().regex(/^[0-9]+$/),
        setup_action: z.string().optional(),
      }),
      response: { 200: z.string() },
      "x-sandpi-content-type": "text/html",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/webhook-sources/github",
    schema: {
      operationId: "getGitHubWebhookConnections",
      summary: "List GitHub App connections available to Webhooks",
      tags: ["Webhooks"],
      response: {
        200: dataEnvelope(githubWebhookConnectionInventorySchema),
      },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/webhook-sources/github/install",
    schema: {
      operationId: "startGitHubWebhookInstall",
      summary: "Start a GitHub App installation for Webhooks",
      tags: ["Webhooks"],
      response: { 201: dataEnvelope(githubWebhookInstallAttemptSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/webhook-sources/github/connections/:connectionId",
    schema: {
      operationId: "disconnectGitHubWebhookConnection",
      summary: "Disconnect a GitHub App installation from Webhooks",
      tags: ["Webhooks"],
      response: { 200: dataEnvelope(idResultSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/webhooks",
    schema: {
      operationId: "listEnvironmentWebhooks",
      summary: "List Environment Webhooks",
      tags: ["Webhooks"],
      response: { 200: dataEnvelope(z.array(environmentWebhookSchema)) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/webhooks",
    schema: {
      operationId: "createEnvironmentWebhook",
      summary: "Create an Environment Webhook",
      tags: ["Webhooks"],
      body: environmentWebhookInputSchema,
      response: { 201: dataEnvelope(environmentWebhookSetupSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/webhooks/:webhookId",
    schema: {
      operationId: "updateEnvironmentWebhook",
      summary: "Replace an Environment Webhook",
      tags: ["Webhooks"],
      body: environmentWebhookInputSchema,
      response: { 200: dataEnvelope(environmentWebhookSetupSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/webhooks/:webhookId/secret",
    schema: {
      operationId: "rotateEnvironmentWebhookSecret",
      summary: "Replace or rotate an Environment webhook secret",
      tags: ["Webhooks"],
      body: rotateEnvironmentWebhookSecretSchema,
      response: { 200: dataEnvelope(environmentWebhookSetupSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/webhooks/:webhookId",
    schema: {
      operationId: "deleteEnvironmentWebhook",
      summary: "Delete an Environment Webhook",
      tags: ["Webhooks"],
      response: { 200: dataEnvelope(idResultSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/webhooks/:webhookId/runs",
    schema: {
      operationId: "listEnvironmentWebhookRuns",
      summary: "List recent webhook-triggered runs",
      tags: ["Webhooks"],
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      response: { 200: dataEnvelope(z.array(environmentWebhookRunSchema)) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/webhooks/:webhookId/deliveries",
    schema: {
      operationId: "listEnvironmentWebhookDeliveries",
      summary: "List recent verified webhook deliveries",
      tags: ["Webhooks"],
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
      response: {
        200: dataEnvelope(z.array(environmentWebhookDeliverySchema)),
      },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/harnesses/codex/device-login",
    schema: {
      operationId: "startCodexDeviceLogin",
      summary: "Start Codex device login",
      tags: ["Codex"],
      response: { 201: dataEnvelope(deviceAuthFlowSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/device-login",
    schema: {
      operationId: "getActiveCodexDeviceLogin",
      summary: "Get the active Codex device-login flow",
      tags: ["Codex"],
      response: { 200: dataEnvelope(deviceAuthFlowSchema.nullable()) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/device-login/:flowId",
    schema: {
      operationId: "getCodexDeviceLogin",
      summary: "Get a Codex device-login flow",
      tags: ["Codex"],
      response: { 200: dataEnvelope(deviceAuthFlowSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/harnesses/codex/device-login/:flowId",
    schema: {
      operationId: "cancelCodexDeviceLogin",
      summary: "Cancel a Codex device-login flow",
      tags: ["Codex"],
      response: { 200: dataEnvelope(deviceAuthFlowSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/account",
    schema: {
      operationId: "getCodexAccount",
      summary: "Get the Environment's Codex account",
      tags: ["Codex"],
      response: { 200: dataEnvelope(codexAccountSchema.nullable()) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/rate-limits",
    schema: {
      operationId: "getCodexRateLimits",
      summary: "Get Codex account rate limits",
      tags: ["Codex"],
      response: { 200: dataEnvelope(codexRateLimitsSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/rate-limits/reset",
    schema: {
      operationId: "resetCodexRateLimit",
      summary: "Consume one Codex rate-limit reset credit",
      tags: ["Codex"],
      body: codexRateLimitResetSchema,
      response: { 200: dataEnvelope(rateLimitResetResultSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/models",
    schema: {
      operationId: "listEnvironmentCodexModels",
      summary: "List native Codex model capabilities",
      description:
        "The nested model records are owned by the pinned Codex app-server protocol and may gain fields without a Sandpi API version change.",
      tags: ["Codex"],
      response: { 200: dataMetaEnvelope(modelPage, modelMeta) },
      "x-sandpi-native-schema": "codex-app-server",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/personality",
    schema: {
      operationId: "getEnvironmentCodexPersonality",
      summary: "Get the Environment Codex personality",
      tags: ["Codex"],
      response: { 200: dataEnvelope(personalitySettingsSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/personality",
    schema: {
      operationId: "setEnvironmentCodexPersonality",
      summary: "Set the Environment Codex personality",
      tags: ["Codex"],
      body: codexPersonalitySelectionSchema,
      response: { 200: dataEnvelope(personalitySettingsSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/token-usage",
    schema: {
      operationId: "getCodexTokenUsage",
      summary: "Get Codex account token usage",
      tags: ["Codex"],
      response: { 200: dataEnvelope(tokenUsageSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/memories",
    schema: {
      operationId: "getEnvironmentCodexMemories",
      summary: "Get Environment Codex memory settings",
      tags: ["Codex"],
      response: { 200: dataEnvelope(memoriesSettingsSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/memories",
    schema: {
      operationId: "setEnvironmentCodexMemories",
      summary: "Set Environment Codex memory settings",
      tags: ["Codex"],
      body: codexMemoriesSettingsSchema,
      response: { 200: dataEnvelope(memoriesSettingsSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/harnesses/codex/memories",
    schema: {
      operationId: "resetEnvironmentCodexMemories",
      summary: "Reset Environment Codex memories",
      tags: ["Codex"],
      response: {
        200: dataEnvelope(z.object({ reset: z.boolean() })),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/hooks",
    schema: {
      operationId: "listEnvironmentCodexHooks",
      summary: "List Environment Codex hooks",
      tags: ["Codex"],
      response: { 200: dataEnvelope(hooksInventorySchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/hooks",
    schema: {
      operationId: "updateEnvironmentCodexHook",
      summary: "Update one Environment Codex hook",
      tags: ["Codex"],
      body: codexHookUpdateSchema,
      response: { 200: dataEnvelope(hooksInventorySchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/harnesses/codex/uploads",
    schema: {
      operationId: "uploadCodexComposerFile",
      summary: "Upload a file for Codex composer input",
      tags: ["Codex"],
      body: codexComposerUploadSchema,
      response: { 201: dataEnvelope(composerUploadSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/skills",
    schema: {
      operationId: "listEnvironmentCodexSkills",
      summary: "List Environment Codex skills",
      tags: ["Codex"],
      querystring: z.object({ force: z.literal("1").optional() }),
      response: { 200: dataEnvelope(skillsInventorySchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/skills/config",
    schema: {
      operationId: "setEnvironmentCodexSkillEnabled",
      summary: "Enable or disable one Environment Codex skill",
      tags: ["Codex"],
      body: codexSkillConfigurationSchema,
      response: { 200: dataEnvelope(skillConfigurationResult) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/skills/:name",
    schema: {
      operationId: "putEnvironmentCodexSkill",
      summary: "Create or replace one user-owned Environment Codex skill",
      tags: ["Codex"],
      body: codexSkillPutSchema,
      response: { 200: dataEnvelope(skillsInventorySchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/harnesses/codex/skills/:name",
    schema: {
      operationId: "deleteEnvironmentCodexSkill",
      summary: "Delete one user-owned Environment Codex skill",
      tags: ["Codex"],
      response: { 200: dataEnvelope(skillsInventorySchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers",
    schema: {
      operationId: "listEnvironmentCodexMcpServers",
      summary: "List Environment Codex MCP servers",
      tags: ["Codex"],
      querystring: z.object({
        detail: z.enum(["full", "toolsAndAuthOnly"]).optional(),
      }),
      response: { 200: dataEnvelope(mcpInventorySchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name/enabled",
    schema: {
      operationId: "setEnvironmentCodexMcpServerEnabled",
      summary: "Enable or disable an Environment Codex MCP server",
      tags: ["Codex"],
      body: codexMcpServerEnabledSchema,
      response: { 200: dataEnvelope(mcpInventorySchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name",
    schema: {
      operationId: "putEnvironmentCodexMcpServer",
      summary: "Create or replace one Environment Codex MCP server",
      tags: ["Codex"],
      body: codexMcpServerConfigurationSchema,
      response: { 200: dataEnvelope(mcpInventorySchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name",
    schema: {
      operationId: "deleteEnvironmentCodexMcpServer",
      summary: "Delete one user-managed Environment Codex MCP server",
      tags: ["Codex"],
      response: { 200: dataEnvelope(mcpInventorySchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/harnesses/codex/mcp-servers/:name/oauth/login",
    schema: {
      operationId: "startEnvironmentCodexMcpOAuthLogin",
      summary: "Start MCP server OAuth login",
      tags: ["Codex"],
      response: { 202: dataEnvelope(mcpOAuthLoginSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions",
    schema: {
      operationId: "listSessions",
      summary: "List accessible product Sessions",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(z.array(codingSessionSchema)) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions",
    schema: {
      operationId: "createSession",
      summary: "Create a product Session and its first native Turn",
      tags: ["Sessions"],
      body: sessionCreateSchema,
      response: { 201: dataEnvelope(codingSessionSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId",
    schema: {
      operationId: "getSession",
      summary: "Get product Session metadata",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(codingSessionSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/sessions/:sessionId/metadata",
    schema: {
      operationId: "updateSessionMetadata",
      summary: "Update product Session metadata",
      tags: ["Sessions"],
      body: sessionMetadataSchema,
      response: { 200: dataEnvelope(codingSessionSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/turns",
    schema: {
      operationId: "startSessionTurn",
      summary: "Start a native Turn",
      tags: ["Sessions"],
      body: turnCreateSchema,
      response: { 202: dataEnvelope(turnSubmissionResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/turns/steer",
    schema: {
      operationId: "steerSessionTurn",
      summary: "Add user input to the active native Turn",
      tags: ["Sessions"],
      body: turnSteerSchema,
      response: { 202: dataEnvelope(turnSubmissionResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/turns/interrupt",
    schema: {
      operationId: "interruptSessionTurn",
      summary: "Interrupt the active native Turn",
      tags: ["Sessions"],
      body: turnInterruptSchema,
      response: { 202: dataEnvelope(turnInterruptResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/compact",
    schema: {
      operationId: "compactSession",
      summary: "Start native Session compaction",
      tags: ["Sessions"],
      response: { 202: dataEnvelope(acceptedResultSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/review",
    schema: {
      operationId: "startSessionReview",
      summary: "Start an inline native code review",
      tags: ["Sessions"],
      body: sessionReviewSchema,
      response: { 202: dataEnvelope(nativeTurnResultSchema) },
      "x-sandpi-optional-request-body": true,
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/goal",
    schema: {
      operationId: "getSessionGoal",
      summary: "Get the native Session goal",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(sessionGoalSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/sessions/:sessionId/goal",
    schema: {
      operationId: "updateSessionGoal",
      summary: "Update the native Session goal",
      tags: ["Sessions"],
      body: sessionGoalUpdateSchema,
      response: { 200: dataEnvelope(sessionGoalSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/sessions/:sessionId/goal",
    schema: {
      operationId: "clearSessionGoal",
      summary: "Clear the native Session goal",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(sessionGoalSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/personality",
    schema: {
      operationId: "getSessionCodexPersonality",
      summary: "Get the Session Codex personality",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(personalitySettingsSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/sessions/:sessionId/personality",
    schema: {
      operationId: "setSessionCodexPersonality",
      summary: "Set the Session Codex personality",
      tags: ["Sessions"],
      body: codexPersonalitySelectionSchema,
      response: { 200: dataEnvelope(personalitySettingsSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/memories",
    schema: {
      operationId: "getSessionCodexMemories",
      summary: "Get Session Codex memory settings",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(memoriesSettingsSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/sessions/:sessionId/memories",
    schema: {
      operationId: "setSessionCodexMemories",
      summary: "Set Session Codex memory settings",
      tags: ["Sessions"],
      body: codexMemoriesSettingsSchema,
      response: { 200: dataEnvelope(memoriesSettingsSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/background-terminals",
    schema: {
      operationId: "listSessionBackgroundTerminals",
      summary: "List Codex background terminals",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(backgroundTerminalsSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/sessions/:sessionId/background-terminals",
    schema: {
      operationId: "cleanSessionBackgroundTerminals",
      summary: "Clean completed Codex background terminals",
      tags: ["Sessions"],
      response: {
        200: dataEnvelope(z.object({ cleaned: z.boolean() })),
      },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/sessions/:sessionId/background-terminals/:processId",
    schema: {
      operationId: "terminateSessionBackgroundTerminal",
      summary: "Terminate one Codex background terminal",
      tags: ["Sessions"],
      response: {
        200: dataEnvelope(z.object({ terminated: z.boolean() })),
      },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/fork",
    schema: {
      operationId: "forkSession",
      summary: "Fork a Session from its current native branch",
      tags: ["Sessions"],
      body: sessionForkSchema,
      response: { 201: dataEnvelope(codingSessionSchema) },
      "x-sandpi-optional-request-body": true,
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/sessions/:sessionId/turns/:nativeTurnId/fork",
    schema: {
      operationId: "forkSessionTurn",
      summary: "Fork a Session at a completed native Turn",
      tags: ["Sessions"],
      body: sessionForkSchema,
      response: { 201: dataEnvelope(codingSessionSchema) },
      "x-sandpi-optional-request-body": true,
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/models",
    schema: {
      operationId: "listSessionCodexModels",
      summary: "List native Codex model capabilities for a Session",
      tags: ["Sessions"],
      response: { 200: dataMetaEnvelope(modelPage, modelMeta) },
      "x-sandpi-native-schema": "codex-app-server",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/agents",
    schema: {
      operationId: "listSessionAgentThreads",
      summary: "List the native Codex agent-thread tree",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(codexAgentThreadsSchema) },
      "x-sandpi-native-schema": "codex-app-server",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/agents/:nativeThreadId",
    schema: {
      operationId: "getSessionAgentThread",
      summary: "Read one native Codex agent Thread",
      tags: ["Sessions"],
      response: { 200: dataEnvelope(codexThreadSchema) },
      "x-sandpi-native-schema": "codex-app-server",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/sessions/:sessionId/events",
    schema: {
      operationId: "streamSessionEvents",
      summary: "Stream the native Session snapshot and live events",
      tags: ["Sessions"],
      response: {
        200: z.string().describe("Server-sent event stream."),
      },
      "x-sandpi-sse": {
        events: {
          snapshot: { schema: { $ref: "#/components/schemas/CodexNativeSnapshot" } },
          activity: { schema: { type: "object" } },
          notification: { schema: { $ref: "#/components/schemas/NativeHarnessEvent" } },
          invalidation: { schema: { type: "object" } },
          "stream-error": { schema: { type: "object" } },
        },
      },
      "x-sandpi-native-schema": "codex-app-server",
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/files/search",
    schema: {
      operationId: "searchEnvironmentFiles",
      summary: "Search the Environment Workspace",
      tags: ["Workspace"],
      querystring: z.object({
        query: workspaceFileSearchQuerySchema.optional(),
      }),
      response: {
        200: dataMetaEnvelope(
          z.array(workspaceSearchResultSchema),
          workspaceMeta,
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/files",
    schema: {
      operationId: "listEnvironmentFiles",
      summary: "List one Workspace directory",
      tags: ["Workspace"],
      querystring: z.object({ path: z.string().optional() }),
      response: {
        200: dataMetaEnvelope(
          workspaceDirectoryListingSchema,
          workspaceRuntimeAccessMetaSchema,
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/file",
    schema: {
      operationId: "readEnvironmentFile",
      summary: "Read a Workspace file as base64",
      tags: ["Workspace"],
      querystring: z.object({ path: z.string().min(1) }),
      response: {
        200: dataMetaEnvelope(
          workspaceRawFile,
          workspaceRuntimeAccessMetaSchema,
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/ide",
    schema: {
      operationId: "getEnvironmentIdeSnapshot",
      summary: "Get the cross-client Workspace IDE snapshot",
      tags: ["Workspace IDE"],
      response: {
        200: dataMetaEnvelope(
          workspaceIdeSnapshotSchema,
          workspaceRuntimeAccessMetaSchema,
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/ide/file",
    schema: {
      operationId: "readEnvironmentIdeFile",
      summary: "Read a Workspace IDE file",
      tags: ["Workspace IDE"],
      querystring: z.object({ path: z.string().min(1) }),
      response: {
        200: dataMetaEnvelope(
          workspaceIdeFileSchema,
          workspaceRuntimeAccessMetaSchema,
        ),
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/ide/git",
    schema: {
      operationId: "getEnvironmentIdeGitState",
      summary: "Get the cached Workspace Git projection",
      tags: ["Workspace IDE"],
      response: { 200: dataEnvelope(workspaceGitStateSchema) },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/ide/entries",
    schema: {
      operationId: "createEnvironmentIdeEntry",
      summary: "Create a Workspace IDE file or folder",
      tags: ["Workspace IDE"],
      body: workspaceIdeCreateEntrySchema,
      response: { 200: dataEnvelope(workspaceFileSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/ide/entries",
    schema: {
      operationId: "renameEnvironmentIdeEntry",
      summary: "Rename a Workspace IDE file or folder",
      tags: ["Workspace IDE"],
      body: workspaceIdeRenameEntrySchema,
      response: { 200: dataEnvelope(workspaceFileSchema) },
    },
  }),
  defineContract({
    method: "DELETE",
    url: "/api/v1/environments/:environmentId/ide/entries",
    schema: {
      operationId: "deleteEnvironmentIdeEntry",
      summary: "Delete a Workspace IDE file or folder",
      tags: ["Workspace IDE"],
      querystring: z.object({ path: z.string().min(1) }),
      response: { 200: dataEnvelope(workspaceFileSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/environments/:environmentId/ide/file",
    schema: {
      operationId: "writeEnvironmentIdeFile",
      summary: "Write a Workspace IDE file with optimistic concurrency",
      tags: ["Workspace IDE"],
      querystring: z.object({ path: z.string().min(1) }),
      body: workspaceIdeWriteSchema,
      response: { 200: dataEnvelope(workspaceIdeFileSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/ide/events",
    schema: {
      operationId: "connectEnvironmentIdeEvents",
      summary: "Connect to Workspace IDE invalidation events",
      tags: ["Workspace IDE"],
      response: { 101: noContent },
      "x-sandpi-websocket": {
        clientMessages: {
          $ref: "#/components/schemas/WorkspaceIdeWatchSubscription",
        },
        serverMessages: {
          $ref: "#/components/schemas/WorkspaceIdeEvent",
        },
      },
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/browser/session",
    schema: {
      operationId: "ensureEnvironmentBrowserSession",
      summary: "Ensure the shared Environment Browser session",
      description: browserDescription,
      tags: ["Browser"],
      body: browserSessionSchema,
      response: { 204: noContent },
      "x-sandpi-optional-request-body": true,
      "x-sandpi-shared-browser": true,
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/browser/open",
    schema: {
      operationId: "openEnvironmentBrowserUrl",
      summary: "Open a loopback URL in the shared Browser",
      description: browserDescription,
      tags: ["Browser"],
      body: browserOpenSchema,
      response: { 204: noContent },
      "x-sandpi-loopback-scope": "environment",
      "x-sandpi-shared-browser": true,
    },
  }),
  defineContract({
    method: "POST",
    url: "/api/v1/environments/:environmentId/browser/viewport",
    schema: {
      operationId: "resizeEnvironmentBrowserViewport",
      summary: "Resize the shared Browser viewport",
      description: browserDescription,
      tags: ["Browser"],
      body: environmentBrowserViewportSchema,
      response: { 204: noContent },
      "x-sandpi-shared-browser": true,
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/browser/ws/:dashboardSocketId",
    schema: {
      operationId: "connectEnvironmentBrowserDashboard",
      summary: "Connect the embedded Browser dashboard WebSocket",
      description: browserDescription,
      tags: ["Browser"],
      response: { 101: noContent },
      "x-sandpi-websocket": {
        protocol: "opaque-playwright-dashboard",
        direction: "bidirectional",
      },
      "x-sandpi-shared-browser": true,
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/browser",
    schema: {
      operationId: "getEnvironmentBrowserDashboard",
      summary: "Load the embedded shared Browser dashboard",
      description: browserDescription,
      tags: ["Browser"],
      querystring: z.looseObject({ embed: z.literal("1").optional() }),
      response: { 200: z.string(), 302: redirect },
      "x-sandpi-content-type": "text/html",
      "x-sandpi-proxy-protocol": "opaque-playwright-dashboard",
      "x-sandpi-shared-browser": true,
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/browser/",
    schema: { hide: true },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/browser/*",
    schema: { hide: true },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/metrics/current",
    schema: {
      operationId: "getCurrentEnvironmentMetrics",
      summary: "Get current Environment resource utilization",
      tags: ["Metrics"],
      response: { 200: dataEnvelope(resourceMetricsSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/metrics",
    schema: {
      operationId: "getEnvironmentMetrics",
      summary: "Get historical Environment metrics",
      tags: ["Metrics"],
      querystring: z.object({
        rangeSeconds: z
          .coerce
          .number()
          .int()
          .refine((value) =>
            ENVIRONMENT_METRIC_RANGES_SECONDS.some(
              (candidate) => candidate === value,
            ),
          )
          .meta({
            type: "integer",
            enum: [...ENVIRONMENT_METRIC_RANGES_SECONDS],
          })
          .optional(),
      }),
      response: { 200: dataEnvelope(environmentMetricsSchema) },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/environments/:environmentId/terminal",
    schema: {
      operationId: "connectEnvironmentTerminal",
      summary: "Connect to the shared Environment terminal",
      tags: ["Terminal"],
      querystring: z.object({
        after: z.coerce.number().int().nonnegative().optional(),
        terminalSessionId: z.string().optional(),
      }),
      response: { 101: noContent },
      "x-sandpi-websocket": {
        clientMessages: {
          $ref: "#/components/schemas/TerminalClientMessageInput",
        },
        serverMessages: {
          $ref: "#/components/schemas/TerminalServerMessage",
        },
      },
    },
  }),
  defineContract({
    method: "GET",
    url: "/api/v1/preferences",
    schema: {
      operationId: "getPreferences",
      summary: "Get viewer preferences",
      tags: ["Preferences"],
      response: { 200: dataEnvelope(sandpiPreferencesSchema) },
    },
  }),
  defineContract({
    method: "PUT",
    url: "/api/v1/preferences",
    schema: {
      operationId: "updatePreferences",
      summary: "Replace viewer preferences",
      tags: ["Preferences"],
      body: preferencesSchema,
      response: { 200: dataEnvelope(sandpiPreferencesSchema) },
    },
  }),
] as const;

export function openApiContractKey(
  method: string,
  url: string,
): string {
  return `${method.toUpperCase()} ${url}`;
}

export const openApiRouteContractMap = new Map(
  openApiRouteContracts.map((contract) => [
    openApiContractKey(contract.method, contract.url),
    contract,
  ]),
);

if (openApiRouteContractMap.size !== openApiRouteContracts.length) {
  throw new Error("OpenAPI route contracts contain duplicate method/path pairs.");
}
