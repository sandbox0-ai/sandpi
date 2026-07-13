import type { Environment } from "@/lib/types";

export const SESSION_HARD_TTL_DAYS = 30;
export const SESSION_HARD_TTL_SECONDS = SESSION_HARD_TTL_DAYS * 24 * 60 * 60;
export const SESSION_WORKSPACE_ROOT = "/workspace";

export interface SessionForkPlanInput {
  environment: Pick<
    Environment,
    | "id"
    | "revision"
    | "templateId"
    | "rootfsSnapshotId"
    | "workspaceVolumeId"
    | "credentialRevision"
    | "codingAgent"
    | "networkPolicy"
  >;
  sessionName: string;
}

export interface SessionForkStep {
  id: string;
  label: string;
  sdkMethod: string;
  input: Record<string, unknown>;
}

export interface SessionForkPlan {
  environmentId: string;
  environmentRevision: number;
  credentialRevision: number;
  hardTtlSeconds: number;
  workspaceRoot: string;
  steps: SessionForkStep[];
}

/**
 * Builds the infrastructure portion of a new Session from one immutable Environment revision.
 * `credentialRevision` is only a secret-plane reference: the backend will resolve and inject
 * native Codex authentication at Session start, outside this rootfs/Volume fork plan. Never add
 * provider credential material to a snapshot input or `/workspace`.
 */
export function buildSessionForkPlan(input: SessionForkPlanInput): SessionForkPlan {
  const { environment, sessionName } = input;

  return {
    environmentId: environment.id,
    environmentRevision: environment.revision,
    credentialRevision: environment.credentialRevision,
    hardTtlSeconds: SESSION_HARD_TTL_SECONDS,
    workspaceRoot: SESSION_WORKSPACE_ROOT,
    steps: [
      {
        id: "fork-workspace",
        label: "Fork the Environment workspace volume",
        sdkMethod: "client.volumes.fork",
        input: {
          sourceVolumeId: environment.workspaceVolumeId,
        },
      },
      {
        id: "claim-sandbox",
        label: "Claim a Sandbox from the Environment revision",
        sdkMethod: "client.sandboxes.claim",
        input: {
          templateId: environment.templateId,
          snapshotId: environment.rootfsSnapshotId,
          mountPoint: SESSION_WORKSPACE_ROOT,
          hardTtl: SESSION_HARD_TTL_SECONDS,
        },
      },
      {
        id: "apply-network-policy",
        label: "Apply the Environment network policy",
        sdkMethod: "sandbox.updateNetworkPolicy",
        input: {
          policy: environment.networkPolicy,
        },
      },
      {
        id: "start-harness-session",
        label: "Start a native harness under Supervisor",
        sdkMethod: "sandbox.createSession",
        input: {
          name: sessionName,
          harness: environment.codingAgent.harness,
          cwd: SESSION_WORKSPACE_ROOT,
          recoverFromEvents: true,
        },
      },
    ],
  };
}
