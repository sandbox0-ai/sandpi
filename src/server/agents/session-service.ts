import type { SandpiStore } from "@/server/store";
import type { RuntimeAdapter } from "@/server/runtime/types";
import { HttpError } from "@/server/http-error";
import type { z } from "zod";
import type { openNativeAgentSessionSchema } from "@/lib/native-agent-sessions";

/** Index reads never access the guest; explicit refresh only scans a running guest. */
export class NativeAgentSessionService {
  constructor(
    private store: SandpiStore,
    private runtime: RuntimeAdapter,
  ) {}

  async refresh(userId: string, environmentId: string) {
    await this.store.getEnvironment(userId, environmentId);
    const locked = await this.store.withEnvironmentLifecycleLock(
      environmentId,
      async (store) => {
        const environment = await store.getEnvironment(userId, environmentId);
        const runtime = await store.getEnvironmentRuntime(
          userId,
          environmentId,
        );
        if (
          !runtime.sandboxId ||
          environment.status !== "ready" ||
          (await this.runtime.getEnvironmentSandboxState(runtime.sandboxId)) !==
            "running"
        ) {
          return store.getNativeSessionIndex(userId, environmentId);
        }
        const result = await this.runtime.discoverNativeSessions(
          runtime,
          environment.codingAgent.harness,
        );
        await store.saveNativeSessionIndex(
          environmentId,
          environment.codingAgent.harness,
          result.sessions,
          result.partial,
        );
        return store.getNativeSessionIndex(userId, environmentId);
      },
    );
    if (!locked.acquired)
      throw new HttpError(
        409,
        "environment_lifecycle_busy",
        "The Environment is changing. Retry shortly.",
      );
    return locked.value;
  }

  async open(
    userId: string,
    environmentId: string,
    input: z.infer<typeof openNativeAgentSessionSchema>,
  ) {
    await this.store.getEnvironment(userId, environmentId);
    const locked = await this.store.withEnvironmentLifecycleLock(
      environmentId,
      async (store) => {
        const environment = await store.getEnvironment(userId, environmentId);
        const runtime = await store.getEnvironmentRuntime(
          userId,
          environmentId,
        );
        if (runtime.agentLaunchId === input.requestId)
          return store.getNativeSessionIndex(userId, environmentId);
        if ((runtime.agentLaunchId ?? "") !== input.expectedLaunchId)
          throw new HttpError(
            409,
            "agent_session_selection_changed",
            "Another device changed the Agent session. Refresh before switching.",
          );
        if (
          environment.status !== "ready" ||
          !runtime.sandboxId ||
          (await this.runtime.getEnvironmentSandboxState(runtime.sandboxId)) !==
            "running"
        ) {
          throw new HttpError(
            409,
            "environment_not_running",
            "Open the Environment terminal before switching sessions.",
          );
        }
        // Verify native history before stopping anything; an index is not proof that
        // a file survived restore or user deletion. No fallback to a new conversation.
        const discovered = await this.runtime.discoverNativeSessions(
          runtime,
          environment.codingAgent.harness,
        );
        const session = input.sessionId
          ? discovered.sessions.find((s) => s.id === input.sessionId)
          : undefined;
        if (input.sessionId && !session)
          throw new HttpError(
            409,
            "native_session_unavailable",
            "This native session is no longer available in the current history window. Refresh the list.",
          );
        await this.runtime.stopAgentTerminal(runtime);
        await store.selectNativeSession(
          environmentId,
          input.expectedLaunchId,
          input.requestId,
          session,
        );
        await store.saveNativeSessionIndex(
          environmentId,
          environment.codingAgent.harness,
          discovered.sessions,
          discovered.partial,
        );
        return store.getNativeSessionIndex(userId, environmentId);
      },
    );
    if (!locked.acquired)
      throw new HttpError(
        409,
        "environment_lifecycle_busy",
        "The Environment is changing. Retry shortly.",
      );
    return locked.value;
  }
}
