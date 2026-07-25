"use client";

import {
  AlertTriangle,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  EnvironmentEgressCredentialEditor,
  type EnvironmentCredentialEditorState,
} from "@/components/environment-egress-credential-editor";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import {
  emptyEnvironmentCredentialForm,
  environmentCredentialConfigurationFor,
  environmentCredentialCreateInput,
  environmentCredentialEditInput,
  environmentCredentialFormFromCredential,
  environmentCredentialRotationForm,
  environmentCredentialRotationMaterial,
  environmentCredentialTypeLabel,
  type EnvironmentCredentialForm,
} from "@/lib/environment-credential-form";
import type { EnvironmentEgressCredential } from "@/lib/environment-credentials";
import type { Environment } from "@/lib/types";

interface EnvironmentEgressCredentialsProps {
  environmentId: string;
  environmentStatus: Environment["status"];
}

export function EnvironmentEgressCredentials({
  environmentId,
  environmentStatus,
}: EnvironmentEgressCredentialsProps) {
  const [credentials, setCredentials] = useState<
    EnvironmentEgressCredential[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [deleteConfirmationId, setDeleteConfirmationId] = useState("");
  const [editor, setEditor] =
    useState<EnvironmentCredentialEditorState | null>(null);
  const [form, setForm] = useState<EnvironmentCredentialForm>(() =>
    emptyEnvironmentCredentialForm(),
  );
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");

  const load = useCallback(
    async (force = false, signal?: AbortSignal) => {
      if (force) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError("");
      try {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentEgressCredential[]>
        >(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/egress-credentials`,
          signal ? { signal } : undefined,
        );
        if (!signal?.aborted) setCredentials(response.data);
      } catch (loadError) {
        if (!signal?.aborted) {
          setError(
            errorMessage(loadError, "Could not load Environment credentials."),
          );
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [environmentId],
  );

  useEffect(() => {
    setCredentials([]);
    setEditor(null);
    setDeleteConfirmationId("");
    const controller = new AbortController();
    void load(false, controller.signal);
    return () => controller.abort();
  }, [environmentId, load]);

  function openCreate() {
    setForm(emptyEnvironmentCredentialForm());
    setEditorError("");
    setDeleteConfirmationId("");
    setEditor({ mode: "create" });
  }

  function openEdit(credential: EnvironmentEgressCredential) {
    setForm(environmentCredentialFormFromCredential(credential));
    setEditorError("");
    setDeleteConfirmationId("");
    setEditor({ mode: "edit", credential });
  }

  function openRotate(credential: EnvironmentEgressCredential) {
    setForm(environmentCredentialRotationForm(credential));
    setEditorError("");
    setDeleteConfirmationId("");
    setEditor({ mode: "rotate", credential });
  }

  function closeEditor() {
    if (busyId) return;
    setEditor(null);
    setEditorError("");
    setForm(emptyEnvironmentCredentialForm());
  }

  async function setEnabled(
    credential: EnvironmentEgressCredential,
    enabled: boolean,
  ) {
    if (busyId || environmentStatus !== "ready") return;
    setBusyId(credential.id);
    setError("");
    try {
      const response = await apiFetch<
        ApiEnvelope<EnvironmentEgressCredential>
      >(credentialUrl(environmentId, credential.id), {
        method: "PUT",
        body: JSON.stringify(
          environmentCredentialConfigurationFor(credential, { enabled }),
        ),
      });
      replaceCredential(setCredentials, response.data);
    } catch (updateError) {
      setError(
        errorMessage(updateError, "Could not update the credential."),
      );
    } finally {
      setBusyId("");
    }
  }

  async function saveEditor() {
    if (!editor || busyId || environmentStatus !== "ready") return;
    const operationId =
      editor.mode === "create" ? "create" : editor.credential.id;
    setBusyId(operationId);
    setEditorError("");
    try {
      if (editor.mode === "create") {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentEgressCredential>
        >(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/egress-credentials`,
          {
            method: "POST",
            body: JSON.stringify(environmentCredentialCreateInput(form)),
          },
        );
        setCredentials((current) =>
          sortCredentials([...current, response.data]),
        );
      } else if (editor.mode === "edit") {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentEgressCredential>
        >(credentialUrl(environmentId, editor.credential.id), {
          method: "PUT",
          body: JSON.stringify(
            environmentCredentialEditInput(editor.credential, form),
          ),
        });
        replaceCredential(setCredentials, response.data);
      } else {
        const response = await apiFetch<
          ApiEnvelope<EnvironmentEgressCredential>
        >(`${credentialUrl(environmentId, editor.credential.id)}/material`, {
          method: "PUT",
          body: JSON.stringify({
            resolverKind: editor.credential.resolverKind,
            material: environmentCredentialRotationMaterial(
              editor.credential,
              form,
            ),
          }),
        });
        replaceCredential(setCredentials, response.data);
      }
      setEditor(null);
      setForm(emptyEnvironmentCredentialForm());
    } catch (saveError) {
      setEditorError(
        errorMessage(saveError, "Could not save the credential."),
      );
    } finally {
      setBusyId("");
    }
  }

  async function deleteCredential(credential: EnvironmentEgressCredential) {
    if (
      busyId ||
      environmentStatus !== "ready" ||
      deleteConfirmationId !== credential.id
    ) {
      setDeleteConfirmationId(credential.id);
      return;
    }
    setBusyId(credential.id);
    setError("");
    try {
      await apiFetch<ApiEnvelope<{ id: string }>>(
        credentialUrl(environmentId, credential.id),
        { method: "DELETE" },
      );
      setCredentials((current) =>
        current.filter((candidate) => candidate.id !== credential.id),
      );
      setDeleteConfirmationId("");
    } catch (deleteError) {
      setError(
        errorMessage(deleteError, "Could not delete the credential."),
      );
    } finally {
      setBusyId("");
    }
  }

  const mutationsDisabled = environmentStatus !== "ready";

  return (
    <div className="environment-credentials-panel">
      <div className="codex-extension-toolbar">
        <p>
          Credentials are injected only for matching destinations in this
          Environment. Secret values remain write-only in Sandbox0.
        </p>
        <div>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh credentials"
            title="Refresh credentials"
            disabled={refreshing}
            onClick={() => void load(true)}
          >
            <RefreshCw
              size={15}
              className={refreshing ? "is-spinning" : undefined}
            />
          </button>
          <button
            type="button"
            className="secondary-action-button"
            disabled={mutationsDisabled || Boolean(busyId)}
            onClick={openCreate}
          >
            <Plus size={13} aria-hidden="true" />
            Add credential
          </button>
        </div>
      </div>

      {mutationsDisabled ? (
        <div className="codex-extension-warning">
          <AlertTriangle size={14} aria-hidden="true" />
          <div>
            <strong>Environment is not ready</strong>
            <p>
              Credentials can be changed after the shared Sandbox finishes
              provisioning or recovery.
            </p>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="codex-extension-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {editor ? (
        <EnvironmentEgressCredentialEditor
          editor={editor}
          form={form}
          error={editorError}
          saving={Boolean(busyId)}
          onChange={setForm}
          onClose={closeEditor}
          onSave={() => void saveEditor()}
        />
      ) : null}

      {loading ? (
        <div className="codex-extension-list" aria-label="Loading credentials">
          {[0, 1].map((row) => (
            <div className="codex-extension-skeleton" key={row}>
              <span />
              <div>
                <span />
                <span />
              </div>
            </div>
          ))}
        </div>
      ) : credentials.length > 0 ? (
        <div
          className="codex-extension-list"
          aria-label="Environment credentials"
        >
          {credentials.map((credential) => (
            <article
              className="environment-credential-row"
              key={credential.id}
            >
              <span className="codex-extension-icon" aria-hidden="true">
                <KeyRound size={16} />
              </span>
              <div className="codex-extension-main">
                <div className="codex-extension-title">
                  <strong>{credential.name}</strong>
                  <span>
                    {environmentCredentialTypeLabel(credential.projection.type)}
                  </span>
                  <span
                    className={`environment-credential-status ${
                      !credential.enabled && credential.status === "active"
                        ? "is-disabled"
                        : `is-${credential.status}`
                    }`}
                  >
                    {credentialStatusLabel(credential)}
                  </span>
                </div>
                <p>{credentialDestination(credential)}</p>
                <div className="codex-extension-tags">
                  <span>{credential.rule.protocol}</span>
                  <span>{credential.rule.failurePolicy}</span>
                  {credential.currentVersion ? (
                    <span>version {credential.currentVersion}</span>
                  ) : null}
                </div>
                {credential.error ? (
                  <p className="environment-credential-row-error" role="alert">
                    {credential.error}
                  </p>
                ) : null}
              </div>
              <div className="environment-credential-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Edit ${credential.name}`}
                  title="Edit scope"
                  disabled={mutationsDisabled || Boolean(busyId)}
                  onClick={() => openEdit(credential)}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Replace secret for ${credential.name}`}
                  title="Replace secret"
                  disabled={mutationsDisabled || Boolean(busyId)}
                  onClick={() => openRotate(credential)}
                >
                  <RotateCw size={13} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`environment-credential-delete ${
                    deleteConfirmationId === credential.id ? "is-confirming" : ""
                  }`}
                  aria-label={
                    deleteConfirmationId === credential.id
                      ? `Confirm delete ${credential.name}`
                      : `Delete ${credential.name}`
                  }
                  title={
                    deleteConfirmationId === credential.id
                      ? "Click again to permanently delete"
                      : "Delete credential"
                  }
                  disabled={mutationsDisabled || Boolean(busyId)}
                  onClick={() => void deleteCredential(credential)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
                <NativeToggle
                  checked={credential.enabled}
                  disabled={mutationsDisabled || Boolean(busyId)}
                  label={`${credential.enabled ? "Disable" : "Enable"} ${credential.name}`}
                  onChange={(enabled) =>
                    void setEnabled(credential, enabled)
                  }
                />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="codex-extension-empty">
          <span aria-hidden="true">
            <ShieldCheck size={21} />
          </span>
          <strong>No Environment credentials</strong>
          <p>
            Add a write-only credential and choose exactly where the shared
            Sandbox may inject it.
          </p>
        </div>
      )}

      <p className="settings-footnote">
        Sandpi stores only Environment ownership, destination rules and source
        version metadata. It never reads or returns secret material.
      </p>
    </div>
  );
}

function NativeToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? "is-on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function credentialUrl(environmentId: string, credentialId: string) {
  return `/api/v1/environments/${encodeURIComponent(environmentId)}/egress-credentials/${encodeURIComponent(credentialId)}`;
}

function replaceCredential(
  setCredentials: React.Dispatch<
    React.SetStateAction<EnvironmentEgressCredential[]>
  >,
  credential: EnvironmentEgressCredential,
) {
  setCredentials((current) =>
    sortCredentials(
      current.map((candidate) =>
        candidate.id === credential.id ? credential : candidate,
      ),
    ),
  );
}

function sortCredentials(credentials: EnvironmentEgressCredential[]) {
  return [...credentials].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function credentialStatusLabel(credential: EnvironmentEgressCredential) {
  if (!credential.enabled && credential.status === "active") return "Disabled";
  if (credential.status === "active") return "Active";
  if (credential.status === "provisioning") return "Applying";
  if (credential.status === "deleting") return "Removing";
  return "Needs attention";
}

function credentialDestination(credential: EnvironmentEgressCredential) {
  const domains = credential.rule.domains.join(", ");
  const ports = credential.rule.ports.map(({ port }) => port).join(", ");
  return `${domains} · TCP ${ports}`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
