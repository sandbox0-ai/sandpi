import type { Environment } from "@/lib/types";
import type { CodexService } from "@/server/harnesses/codex/service";
import { HttpError } from "@/server/http-error";
import type { SandpiStore, TurnSubmissionCoordinates } from "@/server/store";

interface AutomationLogger {
  warn(fields: object, message: string): void;
}

interface AutomationCodex {
  ensureAutomationSession(
    input: Parameters<CodexService["ensureAutomationSession"]>[0],
  ): ReturnType<CodexService["ensureAutomationSession"]>;
  startTurn(
    input: Parameters<CodexService["startTurn"]>[0],
  ): ReturnType<CodexService["startTurn"]>;
  readAutomationTurnStatus(
    input: Parameters<CodexService["readAutomationTurnStatus"]>[0],
  ): ReturnType<CodexService["readAutomationTurnStatus"]>;
}

export interface ClaimedEnvironmentAutomationRun {
  id: string;
  status: "claimed" | "running";
  prompt: string;
  target:
    | { kind: "newSession" }
    | { kind: "sourceThread" }
    | { kind: "session"; sessionId: string };
  sessionId?: string;
  title?: string;
  modelId?: string;
  reasoningEffort?: string;
  collaborationMode?: "plan";
  serviceTier?: string;
  submission: TurnSubmissionCoordinates;
  leaseToken?: string;
  dispatchAttemptCount: number;
}

export interface EnvironmentAutomationDefinition {
  id: string;
  sourceKind: "schedule" | "webhook";
  environmentId: string;
  createdByUserId?: string;
  name: string;
  overlapPolicy: "queue" | "skip";
}

export interface EnvironmentAutomationPersistence {
  markRunning(input: {
    runId: string;
    leaseToken: string;
    nativeTurnId?: string;
    retryAt: Date;
  }): Promise<boolean>;
  defer(input: {
    runId: string;
    leaseToken: string;
    error: string;
    retryAt: Date;
  }): Promise<boolean>;
  finish(input: {
    runId: string;
    leaseToken: string;
    status: "succeeded" | "failed" | "skipped";
    nativeTurnId?: string;
    error?: string;
  }): Promise<boolean>;
}

const DEFAULT_RUNNING_RECHECK_MS = 5_000;
const DEFAULT_TRANSIENT_RETRY_MS = 30_000;
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 100;

/** Delivers one already-leased Automation run to the native harness safely. */
export class EnvironmentAutomationExecutor {
  constructor(
    private readonly store: SandpiStore,
    private readonly codex: AutomationCodex,
    private readonly logger: AutomationLogger,
    private readonly options: {
      runningRecheckMs?: number;
      transientRetryMs?: number;
      maxDispatchAttempts?: number;
      now?: () => Date;
    } = {},
  ) {}

  async execute(input: {
    definition: EnvironmentAutomationDefinition;
    run: ClaimedEnvironmentAutomationRun;
    persistence: EnvironmentAutomationPersistence;
  }) {
    const { definition, run, persistence } = input;
    const leaseToken = run.leaseToken;
    if (!leaseToken) return;
    try {
      if (!definition.createdByUserId) {
        await this.fail(
          persistence,
          run,
          leaseToken,
          "The Automation owner no longer exists.",
        );
        return;
      }
      if (
        run.dispatchAttemptCount >=
          (this.options.maxDispatchAttempts ??
            DEFAULT_MAX_DISPATCH_ATTEMPTS) &&
        run.status === "claimed"
      ) {
        await this.fail(
          persistence,
          run,
          leaseToken,
          "The Automation run could not be delivered after repeated retries.",
        );
        return;
      }
      const environment = await this.store.getEnvironment(
        definition.createdByUserId,
        definition.environmentId,
      );
      const sessionId = await this.ensureRunSession(
        definition,
        run,
        environment,
      );
      const observed = await this.codex.readAutomationTurnStatus({
        userId: definition.createdByUserId,
        sessionId,
        clientMessageId: run.submission.clientMessageId,
      });
      if (observed.status === "succeeded") {
        await persistence.finish({
          runId: run.id,
          leaseToken,
          status: "succeeded",
          nativeTurnId: observed.nativeTurnId,
        });
        return;
      }
      if (observed.status === "failed") {
        await persistence.finish({
          runId: run.id,
          leaseToken,
          status: "failed",
          nativeTurnId: observed.nativeTurnId,
          error: observed.error,
        });
        return;
      }
      if (observed.status === "running") {
        await persistence.markRunning({
          runId: run.id,
          leaseToken,
          nativeTurnId: observed.nativeTurnId,
          retryAt: this.runningRecheckDeadline(),
        });
        return;
      }

      const submitted = await this.codex.startTurn({
        userId: definition.createdByUserId,
        sessionId,
        text: run.prompt,
        images: [],
        modelId: run.modelId,
        reasoningEffort: run.reasoningEffort,
        collaborationMode: run.collaborationMode,
        serviceTier: run.serviceTier,
        clientMessageId: run.submission.clientMessageId,
        durableSubmission: run.submission,
      });
      if (submitted.nativeTurnStatus === "completed") {
        await persistence.finish({
          runId: run.id,
          leaseToken,
          status: "succeeded",
          nativeTurnId: submitted.nativeTurnId,
        });
        return;
      }
      if (
        submitted.nativeTurnStatus === "failed" ||
        submitted.nativeTurnStatus === "interrupted"
      ) {
        await persistence.finish({
          runId: run.id,
          leaseToken,
          status: "failed",
          nativeTurnId: submitted.nativeTurnId,
          error: "The Automation Codex Turn did not complete.",
        });
        return;
      }
      if (submitted.nativeTurnId) {
        await persistence.markRunning({
          runId: run.id,
          leaseToken,
          nativeTurnId: submitted.nativeTurnId,
          retryAt: this.runningRecheckDeadline(),
        });
        return;
      }
      await persistence.defer({
        runId: run.id,
        leaseToken,
        error: "Waiting for Codex to confirm the Automation Turn.",
        retryAt: this.runningRecheckDeadline(),
      });
    } catch (error) {
      if (
        error instanceof HttpError &&
        error.code === "session_turn_in_progress"
      ) {
        if (definition.overlapPolicy === "queue") {
          await persistence.defer({
            runId: run.id,
            leaseToken,
            error: "Waiting for the target Session's active Turn.",
            retryAt: this.runningRecheckDeadline(),
          });
        } else {
          await persistence.finish({
            runId: run.id,
            leaseToken,
            status: "skipped",
            error: "The target Session already has a Turn in progress.",
          });
        }
        return;
      }
      if (isTerminalAutomationRunError(error)) {
        await this.fail(persistence, run, leaseToken, errorMessage(error));
        return;
      }
      await persistence.defer({
        runId: run.id,
        leaseToken,
        error: errorMessage(error),
        retryAt: new Date(
          this.now().getTime() +
            (this.options.transientRetryMs ?? DEFAULT_TRANSIENT_RETRY_MS),
        ),
      });
      this.logger.warn(
        {
          automationKind: definition.sourceKind,
          automationId: definition.id,
          runId: run.id,
          error: errorMessage(error),
        },
        "Environment Automation run deferred",
      );
    }
  }

  private async ensureRunSession(
    definition: EnvironmentAutomationDefinition,
    run: ClaimedEnvironmentAutomationRun,
    environment: Environment,
  ) {
    if (!run.sessionId) {
      throw new HttpError(
        500,
        "environment_automation_run_session_missing",
        "The Automation run has no reserved Session.",
      );
    }
    if (run.target.kind === "session") {
      const session = await this.store.getSession(
        definition.createdByUserId!,
        run.target.sessionId,
      );
      if (session.environmentId !== definition.environmentId) {
        throw new HttpError(
          409,
          "environment_automation_target_invalid",
          "The target Session no longer belongs to this Environment.",
        );
      }
      if (session.archived) {
        throw new HttpError(
          409,
          "environment_automation_target_archived",
          "The target Session is archived.",
        );
      }
      return run.target.sessionId;
    }
    await this.codex.ensureAutomationSession({
      userId: definition.createdByUserId!,
      environment,
      sessionId: run.sessionId,
      automationRunId: run.id,
      automationKind: definition.sourceKind,
      ...(run.target.kind === "sourceThread"
        ? {
            automationSessionKey: `${definition.sourceKind}:${definition.id}:source-thread:${run.sessionId}`,
          }
        : {}),
      title: run.title ?? definition.name,
      modelId: run.modelId,
      reasoningEffort: run.reasoningEffort,
      collaborationMode: run.collaborationMode,
      serviceTier: run.serviceTier,
    });
    return run.sessionId;
  }

  private fail(
    persistence: EnvironmentAutomationPersistence,
    run: ClaimedEnvironmentAutomationRun,
    leaseToken: string,
    error: string,
  ) {
    return persistence.finish({
      runId: run.id,
      leaseToken,
      status: "failed",
      error,
    });
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private runningRecheckDeadline() {
    return new Date(
      this.now().getTime() +
        (this.options.runningRecheckMs ?? DEFAULT_RUNNING_RECHECK_MS),
    );
  }
}

function isTerminalAutomationRunError(error: unknown) {
  return (
    error instanceof HttpError &&
    [
      "environment_automation_session_conflict",
      "environment_automation_target_archived",
      "environment_automation_target_invalid",
      "session_archived",
      "session_not_found",
      "native_session_failed",
    ].includes(error.code)
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
