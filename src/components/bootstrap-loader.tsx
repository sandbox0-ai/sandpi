"use client";

import { LoaderCircle, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { PreferencesPage } from "@/components/preferences-page";
import { SandpiApp } from "@/components/sandpi-app";
import { TeamSettingsPage } from "@/components/team-settings-page";
import { WorkspaceIdePage } from "@/components/workspace-ide-page";
import {
  ApiError,
  type ApiEnvelope,
  apiFetch,
  apiUrl,
} from "@/lib/api-client";
import type { SandpiBootstrap } from "@/lib/types";

import styles from "./bootstrap-loader.module.css";

type LoaderState =
  | { status: "loading" }
  | { status: "redirecting" }
  | { status: "error"; message: string }
  | { status: "ready"; bootstrap: SandpiBootstrap };

function requestedWorkspace() {
  const search = new URLSearchParams(window.location.search);
  return {
    teamId: search.get("team") ?? undefined,
    environmentId: search.get("environment") ?? undefined,
    sessionId: search.get("session") ?? undefined,
    newSession: search.get("new") === "1",
  };
}

function bootstrapPath(workspace: ReturnType<typeof requestedWorkspace>) {
  const search = new URLSearchParams();
  if (workspace.teamId) search.set("team", workspace.teamId);
  if (workspace.environmentId) {
    search.set("environment", workspace.environmentId);
  }
  if (workspace.sessionId) search.set("session", workspace.sessionId);
  if (workspace.newSession) search.set("new", "1");
  const query = search.toString();
  return `/api/v1/bootstrap${query ? `?${query}` : ""}`;
}

function loginUrl(error: ApiError) {
  const returnTo = window.location.href;
  if (error.loginUrl) {
    const target = new URL(apiUrl(error.loginUrl), window.location.href);
    if (!target.searchParams.has("return_to")) {
      target.searchParams.set("return_to", returnTo);
    }
    return target.toString();
  }

  const target = new URL(apiUrl("/api/v1/auth/login"), window.location.href);
  target.searchParams.set("return_to", returnTo);
  return target.toString();
}

function useBootstrap() {
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
          setState({ status: "redirecting" });
          window.location.replace(loginUrl(error));
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
  }, [attempt]);

  return { state, retry };
}

function BootstrapBoundary({
  children,
}: {
  children: (bootstrap: SandpiBootstrap) => ReactNode;
}) {
  const { state, retry } = useBootstrap();

  if (state.status === "ready") {
    return children(state.bootstrap);
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
            <LoaderCircle
              className={styles.spinner}
              size={22}
              aria-hidden="true"
            />
            <p>
              {state.status === "redirecting"
                ? "Redirecting to sign in…"
                : "Loading Sandpi…"}
            </p>
          </>
        )}
      </section>
    </main>
  );
}

export function SandpiAppLoader() {
  return (
    <BootstrapBoundary>
      {(bootstrap) => <SandpiApp initialData={bootstrap} />}
    </BootstrapBoundary>
  );
}

export function PreferencesPageLoader() {
  return (
    <BootstrapBoundary>
      {(bootstrap) => {
        const team =
          bootstrap.teams.find(
            (candidate) => candidate.id === bootstrap.selectedTeamId,
          ) ?? bootstrap.teams[0];
        if (!team) {
          throw new Error("The authenticated user does not belong to a Team.");
        }
        return (
          <PreferencesPage
            initialPreferences={bootstrap.preferences}
            viewer={bootstrap.viewer}
            team={team}
          />
        );
      }}
    </BootstrapBoundary>
  );
}

export function TeamSettingsPageLoader() {
  return (
    <BootstrapBoundary>
      {(bootstrap) => {
        const team =
          bootstrap.teams.find(
            (candidate) => candidate.id === bootstrap.selectedTeamId,
          ) ?? bootstrap.teams[0];
        if (!team) {
          throw new Error("The authenticated user does not belong to a Team.");
        }
        const memberships = bootstrap.teamMemberships.filter(
          (membership) => membership.teamId === team.id,
        );
        const environmentCount = bootstrap.environments.filter(
          (environment) => environment.teamId === team.id,
        ).length;

        return (
          <TeamSettingsPage
            team={team}
            viewer={bootstrap.viewer}
            memberships={memberships}
            plans={bootstrap.plans}
            environmentCount={environmentCount}
            language={bootstrap.preferences.general.language}
            timeZone={bootstrap.preferences.general.timeZone}
          />
        );
      }}
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
