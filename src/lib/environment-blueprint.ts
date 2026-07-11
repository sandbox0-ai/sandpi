import type { Environment } from "@/lib/types";

export const SESSION_HARD_TTL_DAYS = 30;
export const SESSION_HARD_TTL_SECONDS = SESSION_HARD_TTL_DAYS * 24 * 60 * 60;

export interface SessionForkPlanInput {
  environment: Pick<
    Environment,
    | "id"
    | "revision"
    | "templateId"
    | "rootfsSnapshotId"
    | "workspaceVolumeId"
    | "sandbox0ConnectionId"
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
  sandbox0ConnectionId: string;
  environmentRevision: number;
  credentialRevision: number;
  hardTtlSeconds: number;
  steps: SessionForkStep[];
}

export function buildSessionForkPlan(input: SessionForkPlanInput): SessionForkPlan {
  const { environment, sessionName } = input;

  return {
    environmentId: environment.id,
    sandbox0ConnectionId: environment.sandbox0ConnectionId,
    environmentRevision: environment.revision,
    credentialRevision: environment.credentialRevision,
    hardTtlSeconds: SESSION_HARD_TTL_SECONDS,
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
          mountPoint: "/workspace",
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
          cwd: "/workspace",
          recoverFromEvents: true,
        },
      },
    ],
  };
}
