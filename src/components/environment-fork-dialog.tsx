"use client";

import { GitFork, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { randomToken } from "@/lib/id";
import type { Environment, EnvironmentWorkspaceBackup } from "@/lib/types";

import styles from "./environment-fork-dialog.module.css";

interface EnvironmentForkDialogProps {
  source: Environment;
  onCreated: (environment: Environment) => void;
  onClose: () => void;
}

export function EnvironmentForkDialog({
  source,
  onCreated,
  onClose,
}: EnvironmentForkDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const idempotencyKeyRef = useRef<string | undefined>(undefined);
  const [name, setName] = useState(`${source.name} fork`);
  const [snapshotId, setSnapshotId] = useState("");
  const [snapshots, setSnapshots] = useState<EnvironmentWorkspaceBackup[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.select();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [busy, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setSnapshotsLoading(true);
    void apiFetch<ApiEnvelope<EnvironmentWorkspaceBackup[]>>(
      `/api/v1/environments/${encodeURIComponent(source.id)}/snapshots`,
      { signal: controller.signal },
    )
      .then(({ data }) => setSnapshots(data))
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof Error
              ? cause.message
              : "The Environment snapshots could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSnapshotsLoading(false);
      });
    return () => controller.abort();
  }, [source.id]);

  useEffect(() => {
    idempotencyKeyRef.current = undefined;
  }, [name, snapshotId, source.id]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const targetName = name.trim();
    if (!targetName || busy) return;
    setBusy(true);
    setError(undefined);
    idempotencyKeyRef.current ??= randomToken(32);
    try {
      const response = await apiFetch<ApiEnvelope<Environment>>(
        `/api/v1/environments/${encodeURIComponent(source.id)}/forks`,
        {
          method: "POST",
          body: JSON.stringify({
            name: targetName,
            idempotencyKey: idempotencyKeyRef.current,
            snapshotId: snapshotId || undefined,
          }),
        },
      );
      onCreated(response.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Environment fork could not be completed.",
      );
      setBusy(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <form onSubmit={submit}>
          <header>
            <div>
              <span className={styles.command}>$ sandpi environment fork</span>
              <h1 id={titleId}>Fork Environment</h1>
            </div>
            <button
              type="button"
              aria-label="Close Fork Environment dialog"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.body}>
            <p id={descriptionId}>
              Create a paused, independent Sandbox from the current RootFS or a
              named snapshot. Agent credentials and terminal control are not
              copied.
            </p>
            <dl>
              <div>
                <dt>SOURCE</dt>
                <dd>{source.name}</dd>
              </div>
              <div>
                <dt>AGENT</dt>
                <dd>{source.codingAgent.label}</dd>
              </div>
              <div>
                <dt>RESULT</dt>
                <dd>PAUSED</dd>
              </div>
            </dl>
            <label>
              <span>SOURCE STATE</span>
              <select
                value={snapshotId}
                disabled={busy || snapshotsLoading}
                onChange={(event) => setSnapshotId(event.currentTarget.value)}
              >
                <option value="">
                  {snapshotsLoading ? "LOADING SNAPSHOTS…" : "CURRENT ROOTFS"}
                </option>
                {snapshots.map((snapshot) => (
                  <option key={snapshot.id} value={snapshot.id}>
                    {snapshot.name} — {formatSnapshotTime(snapshot.createdAt)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>TARGET NAME</span>
              <input
                ref={inputRef}
                value={name}
                maxLength={80}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error ? (
              <p className={styles.error} role="alert">
                ERROR: {error}
              </p>
            ) : null}
          </div>

          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              [CANCEL]
            </button>
            <button type="submit" disabled={busy || !name.trim()}>
              {busy ? (
                <>
                  <LoaderCircle className={styles.spinner} size={14} /> FORKING…
                </>
              ) : (
                <>
                  <GitFork size={14} /> [CREATE FORK]
                </>
              )}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function formatSnapshotTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(createdAt * 1_000));
}
