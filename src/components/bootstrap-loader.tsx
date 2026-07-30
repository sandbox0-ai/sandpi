"use client";

import { LoaderCircle, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { GuestSandpiApp } from "@/components/guest-sandpi-app";
import { PreferencesPage } from "@/components/preferences-page";
import { SandpiApp } from "@/components/sandpi-app";
import { WorkspaceIdePage } from "@/components/workspace-ide-page";
import { ApiError, type ApiEnvelope, apiFetch } from "@/lib/api-client";
import {
  authLoginUrl,
  navigateToAuthLogin,
} from "@/lib/auth-navigation";
import type { SandpiBootstrap } from "@/lib/types";

import styles from "./bootstrap-loader.module.css";

type LoaderState =
  | { status: "loading" }
  | { status: "redirecting" }
  | { status: "unauthenticated"; loginUrl: string }
  | { status: "error"; message: string }
  | { status: "ready"; bootstrap: SandpiBootstrap };

function requestedWorkspace() {
  const search = new URLSearchParams(window.location.search);
  return {
    environmentId: search.get("environment") ?? undefined,
    sessionId: search.get("session") ?? undefined,
    newSession: search.get("new") === "1",
  };
}

function bootstrapPath(workspace: ReturnType<typeof requestedWorkspace>) {
  const search = new URLSearchParams();
  if (workspace.environmentId) {
    search.set("environment", workspace.environmentId);
  }
  if (workspace.sessionId) search.set("session", workspace.sessionId);
  if (workspace.newSession) search.set("new", "1");
  const query = search.toString();
  return `/api/v1/bootstrap${query ? `?${query}` : ""}`;
}

function useBootstrap(allowUnauthenticated: boolean) {
  const [state, setState] = useState<LoaderState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      try {
        const response = await apiFetch<ApiEnvelope<SandpiBootstrap>>(
          bootstrapPath(requestedWorkspace()),
          { signal: controller.signal },
        );
        setState({ status: "ready", bootstrap: response.data });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          const target = authLoginUrl(window.location.href, error.loginUrl);
          if (allowUnauthenticated) {
            setState({ status: "unauthenticated", loginUrl: target });
            return;
          }
          setState({ status: "redirecting" });
          navigateToAuthLogin(target, "replace");
          return;
        }
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Sandpi could not load this page.",
        });
      }
    }

    void load();
    return () => controller.abort();
  }, [allowUnauthenticated, attempt]);

  return { state, retry };
}

function BootstrapBoundary({
  children,
  renderUnauthenticated,
}: {
  children: (bootstrap: SandpiBootstrap) => ReactNode;
  renderUnauthenticated?: (loginUrl: string) => ReactNode;
}) {
  const { state, retry } = useBootstrap(Boolean(renderUnauthenticated));

  if (state.status === "ready") {
    return children(state.bootstrap);
  }
  if (state.status === "unauthenticated" && renderUnauthenticated) {
    return renderUnauthenticated(state.loginUrl);
  }

  return (
    <main className={styles.shell} aria-live="polite">
      <section className={styles.card}>
        {state.status === "error" ? (
          <>
            <h1>Unable to load Sandpi</h1>
            <p>{state.message}</p>
            <button type="button" onClick={retry}>
              <RotateCw size={16} aria-hidden="true" />
              Try again
            </button>
          </>
        ) : (
          <>
            <h1>Sandpi</h1>
            <p>Remote coding agents that keep working when you disconnect.</p>
            <div className={styles.status}>
              <LoaderCircle
                className={styles.spinner}
                size={18}
                aria-hidden="true"
              />
              <span>
                {state.status === "redirecting"
                  ? "Redirecting to sign in…"
                  : "Loading your workspace…"}
              </span>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export function SandpiAppLoader() {
  return (
    <BootstrapBoundary
      renderUnauthenticated={(loginUrl) => (
        <GuestSandpiApp loginUrl={loginUrl} />
      )}
    >
      {(bootstrap) => <SandpiApp initialData={bootstrap} />}
    </BootstrapBoundary>
  );
}

export function PreferencesPageLoader() {
  return (
    <BootstrapBoundary>
      {(bootstrap) => (
        <PreferencesPage
          initialPreferences={bootstrap.preferences}
          viewer={bootstrap.viewer}
        />
      )}
    </BootstrapBoundary>
  );
}

export function WorkspaceIdePageLoader() {
  return (
    <BootstrapBoundary>
      {(bootstrap) => <WorkspaceIdePage initialData={bootstrap} />}
    </BootstrapBoundary>
  );
}
