import type { EnvironmentAgentId } from "@/lib/types";
import { HttpError } from "@/server/http-error";
import type {
  EnvironmentRuntimeRecord,
  RuntimeAdapter,
} from "@/server/runtime/types";
import { SecretBox } from "@/server/secrets";
import { SandpiStore } from "@/server/store";

import { agentAdapter } from "./registry";
import {
  AgentCredentialStore,
  type StoredAgentCredential,
} from "./credential-store";

const AGENT_CREDENTIAL_MAX_BYTES = 4 * 1024 * 1024;

interface AgentCredentialLogger {
  warn(fields: object, message: string): void;
}

export interface AgentCredentialMaterial {
  sourceId: string;
  revision: number;
  credentialJson: string;
}

/**
 * Encrypts native Agent account files at the Environment boundary. Plaintext
 * exists only while validating an in-memory value or below /dev/shm in the
 * Sandbox runtime.
 */
export class AgentCredentialService {
  constructor(
    private readonly store: SandpiStore,
    private readonly credentialStore: AgentCredentialStore,
    private readonly runtime: RuntimeAdapter,
    private readonly secretBox: SecretBox | undefined,
    private readonly logger: AgentCredentialLogger,
  ) {}

  async credentialForEnvironment(
    userId: string,
    environmentId: string,
    agentId: EnvironmentAgentId,
  ): Promise<AgentCredentialMaterial | undefined> {
    const stored = await this.credentialStore.getCredential(
      userId,
      environmentId,
      agentId,
    );
    return stored ? this.materialize(stored) : undefined;
  }

  async syncFromRuntime(
    environmentId: string,
    scopedStore: SandpiStore = this.store,
  ) {
    if (!this.secretBox || this.runtime.mode === "unconfigured") return;
    const environment = await scopedStore.getEnvironmentById(environmentId);
    const runtime = await scopedStore.environmentRuntime(environmentId);
    await this.syncOpenedRuntime(
      environmentId,
      environment.codingAgent.harness,
      runtime,
    );
  }

  async protectPersistenceBoundary(
    environmentId: string,
    scopedStore: SandpiStore = this.store,
  ) {
    const environment = await scopedStore.getEnvironmentById(environmentId);
    const runtime = await scopedStore.environmentRuntime(environmentId);
    await this.syncOpenedRuntime(
      environmentId,
      environment.codingAgent.harness,
      runtime,
    );
    await this.runtime.prepareAgentStateForPersistence(
      runtime,
      environment.codingAgent.harness,
    );
  }

  async syncOpenedRuntime(
    environmentId: string,
    agentId: EnvironmentAgentId,
    runtime: EnvironmentRuntimeRecord,
  ) {
    if (!this.secretBox || this.runtime.mode === "unconfigured") return;
    const adapter = agentAdapter(agentId);
    if (!adapter.credentialProjection.managedBySandpi) return;
    const credentialJson = await this.runtime.readAgentCredential(
      runtime,
      agentId,
    );
    if (credentialJson === undefined) return;
    validateAgentCredentialJson(agentId, credentialJson);

    const stored = await this.credentialStore.getCredentialForRuntime(
      environmentId,
      agentId,
    );
    if (stored && this.decrypt(stored) === credentialJson) {
      await this.markMaterialized(stored);
      return;
    }
    const replaced = await this.credentialStore.replaceCredentialFromRuntime({
      environmentId,
      agentId,
      credentialType: adapter.credentialProjection.credentialType!,
      accountLabel: adapter.label,
      expectedSourceId: stored?.sourceId,
      encrypted: this.secretBox.encrypt(
        credentialJson,
        agentCredentialAssociatedData(environmentId, agentId),
      ),
    });
    if (!replaced.replaced) {
      // Another Sandpi replica published a newer source while this one was
      // reading /dev/shm. Reinstall the winner instead of rolling it back.
      await this.runtime.installAgentCredential(
        runtime,
        agentId,
        this.decrypt(replaced.credential),
      );
    }
    await this.markMaterialized(replaced.credential);
  }

  async trySyncFromRuntime(
    environmentId: string,
    agentId: EnvironmentAgentId,
    runtime: EnvironmentRuntimeRecord,
  ) {
    try {
      await this.syncOpenedRuntime(environmentId, agentId, runtime);
    } catch (error) {
      this.logger.warn(
        { err: error, environmentId, agentId },
        "Native Agent credential synchronization deferred",
      );
    }
  }

  private async markMaterialized(stored: StoredAgentCredential) {
    const target = agentAdapter(stored.agentId).credentialProjection.ephemeralPath;
    if (!target) return;
    await this.credentialStore.markCredentialMaterialized({
      environmentId: stored.environmentId,
      agentId: stored.agentId,
      sourceId: stored.sourceId,
      sourceRevision: stored.revision,
      nativeTargetPath: target,
    });
  }

  private materialize(stored: StoredAgentCredential): AgentCredentialMaterial {
    return {
      sourceId: stored.sourceId,
      revision: stored.revision,
      credentialJson: this.decrypt(stored),
    };
  }

  private decrypt(stored: StoredAgentCredential) {
    if (!this.secretBox) {
      throw new HttpError(
        503,
        "credential_encryption_not_configured",
        "SANDPI_SECRET_KEY must be configured to restore native Agent credentials.",
      );
    }
    try {
      const credentialJson = this.secretBox.decrypt(
        stored.encrypted,
        agentCredentialAssociatedData(stored.environmentId, stored.agentId),
      );
      validateAgentCredentialJson(stored.agentId, credentialJson);
      return credentialJson;
    } catch {
      throw new HttpError(
        500,
        "agent_credential_unreadable",
        `The Environment's ${agentAdapter(stored.agentId).label} credentials cannot be decrypted.`,
      );
    }
  }
}

export function agentCredentialAssociatedData(
  environmentId: string,
  agentId: EnvironmentAgentId,
) {
  // Keep compatibility with every Codex credential encrypted by Sandpi v1.
  return agentId === "codex"
    ? `sandpi:codex:environment-credential:${environmentId}`
    : `sandpi:${agentId}:environment-credential:${environmentId}`;
}

export function validateAgentCredentialJson(
  agentId: EnvironmentAgentId,
  credentialJson: string,
) {
  const bytes = Buffer.byteLength(credentialJson, "utf8");
  if (bytes === 0 || bytes > AGENT_CREDENTIAL_MAX_BYTES) {
    throw new Error(`${agentAdapter(agentId).label} credential file is invalid.`);
  }
  const value = JSON.parse(credentialJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${agentAdapter(agentId).label} credential file must contain an object.`,
    );
  }
}
