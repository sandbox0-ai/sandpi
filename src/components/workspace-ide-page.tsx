"use client";

import { ArrowLeft, FileQuestion } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { WorkspaceIde } from "@/components/workspace-ide";
import {
  applyClientPreferences,
  CLIENT_PREFERENCES_CHANGED_EVENT,
  CLIENT_PREFERENCES_STORAGE_KEY,
  loadClientPreferences,
} from "@/lib/client-preferences";
import type { SandpiBootstrap } from "@/lib/types";

import styles from "./workspace-ide-page.module.css";

interface WorkspaceIdePageProps {
  initialData: SandpiBootstrap;
}

export function WorkspaceIdePage({ initialData }: WorkspaceIdePageProps) {
  const [preferences, setPreferences] = useState(initialData.preferences);
  const session = initialData.sessions.find(
    (candidate) => candidate.id === initialData.selectedSessionId,
  );
  const environment = initialData.environments.find(
    (candidate) =>
      candidate.id ===
      (session?.environmentId || initialData.selectedEnvironmentId),
  );

  useEffect(() => {
    const synchronizePreferences = () => {
      const next = loadClientPreferences(initialData.preferences);
      setPreferences(next);
      applyClientPreferences(next);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === CLIENT_PREFERENCES_STORAGE_KEY) synchronizePreferences();
    };

    synchronizePreferences();
    window.addEventListener(
      CLIENT_PREFERENCES_CHANGED_EVENT,
      synchronizePreferences,
    );
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(
        CLIENT_PREFERENCES_CHANGED_EVENT,
        synchronizePreferences,
      );
      window.removeEventListener("storage", handleStorage);
    };
  }, [initialData.preferences]);

  useEffect(() => {
    if (!environment) return;
    const warnBeforeClosingWorkspace = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClosingWorkspace);
    return () =>
      window.removeEventListener("beforeunload", warnBeforeClosingWorkspace);
  }, [environment]);

  if (!environment) {
    return (
      <main className={styles.missing}>
        <FileQuestion size={26} aria-hidden="true" />
        <h1>Environment unavailable</h1>
        <p>Open the Web IDE from an active Sandpi Environment.</p>
        <Link href="/">
          <ArrowLeft size={14} aria-hidden="true" /> Back to Sandpi
        </Link>
      </main>
    );
  }

  return (
    <WorkspaceIde
      language={preferences.general.language}
      timeZone={preferences.general.timeZone}
      environment={environment}
      session={session}
      variant="standalone"
    />
  );
}
