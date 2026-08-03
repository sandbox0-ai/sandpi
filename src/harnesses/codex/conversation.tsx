"use client";

import Image from "next/image";
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  Check,
  Circle,
  CircleCheckBig,
  Copy,
  Files,
  GitFork,
  LoaderCircle,
  Menu,
  PanelLeftOpen,
  PanelRight,
  Settings2,
  Square,
  SquareTerminal,
  TriangleAlert,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";

import {
  Inspector,
  INSPECTOR_KEEP_ALIVE_MS,
  type InspectorTab,
} from "@/components/inspector";
import {
  SandpiMark,
  UserAvatar,
} from "@/components/identity-avatar";
import { MarkdownContent } from "@/components/markdown-content";
import type { WorkspaceFileNavigationRequest } from "@/components/workspace-ide";
import {
  CodexComposer,
  CodexComposerLocalImages,
  encodeCodexComposerLocalImages,
} from "@/harnesses/codex/composer";
import { insertCodexFileMentions } from "@/harnesses/codex/file-mentions";
import {
  codexModelOptionsFromNativeResult,
  codexReasoningEffortForModel,
  codexReasoningEffortLabel,
  reconcileCodexComposerPreference,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import {
  canInterruptCodexSession,
  codexComposerSubmissionTarget,
  codexTurnCapabilitySets,
  shouldRefreshSettledCodexProjection,
} from "@/harnesses/codex/capabilities";
import {
  clipboardCodexImageFiles,
  encodeCodexComposerImage,
  MAX_CODEX_COMPOSER_IMAGES,
  readCodexComposerImage,
  selectCodexImageFiles,
  type CodexImageSelectionIssue,
} from "@/harnesses/codex/composer-images";
import {
  CodexCommandActivity,
  CodexFileChangeActivity,
  CodexNativeItemActivity,
  CodexNativeToolActivity,
  CodexTurnActivity,
  CodexTurnResult,
} from "@/harnesses/codex/activity";
import { CodexSessionActivityView } from "@/harnesses/codex/session-activity-view";
import {
  codexContextUsedPercent,
  normalizeCodexThreadTokenUsage,
} from "@/harnesses/codex/context-usage";
import { ensureWorkspaceAgentsFile } from "@/harnesses/codex/workspace-agents";
import { normalizeCodexRolloutActivityFeed } from "@/harnesses/codex/rollout-activity";
import {
  groupCodexTimelineByTurn,
  type CodexTurnTimelineGroup,
  withPendingCodexUserMessages,
} from "@/harnesses/codex/timeline";
import type {
  CodexComposerImage,
  CodexComposerLocalImage,
  CodexEventEnvelope,
  CodexNativeActivityUpdate,
  CodexNativeInvalidation,
  CodexNativeSnapshot,
  CodexNativeStreamFailure,
  CodexSession,
} from "@/harnesses/codex/types";
import { MAX_CODEX_COMPOSER_UPLOAD_FILES } from "@/harnesses/codex/types";
import {
  projectCodexTimeline,
  shouldRefreshCodexNativeSnapshot,
  type CodexActiveTurnView,
  type CodexMessageView,
  type CodexTimelineEntry,
} from "@/harnesses/codex/events";
import {
  apiFetch,
  apiUrl,
  type ApiEnvelope,
} from "@/lib/api-client";
import { BoundedLruCache } from "@/lib/bounded-lru-cache";
import { copyTextToClipboard } from "@/lib/clipboard";
import { NATIVE_APP_RESUME_EVENT } from "@/lib/cloud-state-sync";
import { createId } from "@/lib/id";
import {
  codingAgentComposerPreference,
  rememberCodingAgentComposerPreference,
} from "@/lib/local-ui-preferences";
import { useConversationAutoScroll } from "@/lib/use-conversation-auto-scroll";
import {
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import type {
  EnvironmentSettingsOpenOptions,
  EnvironmentSettingsTab,
} from "@/components/environment-settings";
import type { Environment, SandpiUser } from "@/lib/types";

interface ConversationProps {
  language: OperationLanguage;
  timeZone: string;
  sendShortcut: SendShortcut;
  viewer: SandpiUser;
  environment: Environment;
  session: CodexSession;
  refreshEpoch: number;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  inspectorWidthRatio: number;
  terminalOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onInspectorTabChange: (tab: InspectorTab) => void;
  onInspectorWidthRatioChange: (ratio: number, persist: boolean) => void;
  onToggleTerminal: () => void;
  onNewSession: () => void;
  onOpenEnvironmentSettings: (
    tab: EnvironmentSettingsTab,
    options?: EnvironmentSettingsOpenOptions,
  ) => void;
  onOpenInspector: (tab: InspectorTab) => void;
  workspaceNavigationRequest?: WorkspaceFileNavigationRequest;
  onOpenWorkspacePath: (path: string) => void;
  onWorkspaceNavigationHandled: (
    request: WorkspaceFileNavigationRequest,
  ) => void;
  onSessionChange: (session: CodexSession) => void;
  onToggleSessionCompleted: (sessionId: string) => Promise<void>;
  onDerivedSessionCreated: (session: CodexSession) => void;
}

const CODEX_SESSION_STATUSES = new Set<CodexNativeSnapshot["sessionStatus"]>([
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
]);
const SETTLED_PROJECTION_REFRESH_DELAY_MS = 250;
const RECENT_SESSION_SNAPSHOT_CACHE_SIZE = 3;
const RECENT_SESSION_DRAFT_CACHE_SIZE = 20;
const EMPTY_CODEX_MODEL_OPTIONS: CodexModelOption[] = [];

interface CodexModelCatalog {
  environmentId: string;
  credentialRevision: number;
  options: CodexModelOption[];
  unavailable: string;
}

interface PendingCodexTurn {
  clientMessageId: string;
  nativeTurnId?: string;
  content: string;
  images: CodexComposerImage[];
  localImages: CodexComposerLocalImage[];
  startedAt: number;
  phase: "submitting" | "accepted";
}

interface PendingCodexSteer {
  clientMessageId: string;
  nativeTurnId: string;
  content: string;
  images: CodexComposerImage[];
  localImages: CodexComposerLocalImage[];
  startedAt: number;
  phase: "submitting" | "accepted";
}

export function CodexConversation({
  language,
  timeZone,
  sendShortcut,
  viewer,
  environment,
  session,
  refreshEpoch,
  inspectorOpen,
  inspectorTab,
  inspectorWidthRatio,
  terminalOpen,
  onToggleSidebar,
  onToggleInspector,
  onInspectorTabChange,
  onInspectorWidthRatioChange,
  onToggleTerminal,
  onNewSession,
  onOpenEnvironmentSettings,
  onOpenInspector,
  workspaceNavigationRequest,
  onOpenWorkspacePath,
  onWorkspaceNavigationHandled,
  onSessionChange,
  onToggleSessionCompleted,
  onDerivedSessionCreated,
}: ConversationProps) {
  const ui = getCodexUiCopy(language).conversation;
  const [completionSaving, setCompletionSaving] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [mountedInspectorEnvironmentId, setMountedInspectorEnvironmentId] =
    useState(inspectorOpen ? environment.id : "");
  const [modelCatalog, setModelCatalog] = useState<CodexModelCatalog>(() => ({
    environmentId: environment.id,
    credentialRevision: environment.credentialRevision,
    options: [],
    unavailable: "",
  }));
  const modelOptions =
    modelCatalog.environmentId === environment.id &&
    modelCatalog.credentialRevision === environment.credentialRevision
      ? modelCatalog.options
      : EMPTY_CODEX_MODEL_OPTIONS;

  useEffect(() => {
    setCompletionSaving(false);
    setCompletionError("");
  }, [session.id]);

  async function toggleSessionCompleted() {
    if (completionSaving) return;
    setCompletionSaving(true);
    setCompletionError("");
    try {
      await onToggleSessionCompleted(session.id);
    } catch {
      setCompletionError(ui.completionUpdateFailed);
    } finally {
      setCompletionSaving(false);
    }
  }

  useEffect(() => {
    if (inspectorOpen) {
      setMountedInspectorEnvironmentId(environment.id);
      return;
    }
    const timeout = window.setTimeout(() => {
      setMountedInspectorEnvironmentId((current) =>
        current === environment.id ? "" : current,
      );
    }, INSPECTOR_KEEP_ALIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [environment.id, inspectorOpen]);
  const modelCatalogUnavailable =
    modelCatalog.environmentId === environment.id &&
    modelCatalog.credentialRevision === environment.credentialRevision
      ? modelCatalog.unavailable
      : "";
  const [selectedModelId, setSelectedModelId] = useState(
    session.harnessState.modelId,
  );
  const [reasoningEfforts, setReasoningEfforts] = useState<
    Record<string, string>
  >(() =>
    session.harnessState.modelId && session.harnessState.reasoningEffort
      ? {
          [session.harnessState.modelId]:
            session.harnessState.reasoningEffort,
        }
      : {},
  );
  const fallbackReasoningEffort = session.harnessState.reasoningEffort ?? "";
  const selectedModel: CodexModelOption = modelOptions.find(
    (model) => model.id === selectedModelId,
  ) ?? {
    id: selectedModelId || session.harnessState.modelId || "default",
    displayName: selectedModelId || session.harnessState.modelId || "Default",
    isDefault: false,
    defaultReasoningEffort: fallbackReasoningEffort,
    supportedReasoningEfforts: fallbackReasoningEffort
      ? [
          {
            id: fallbackReasoningEffort,
            description: fallbackReasoningEffort,
          },
        ]
      : [],
  };
  const selectedReasoningEffort = codexReasoningEffortForModel(
    selectedModel,
    reasoningEfforts[selectedModel.id] ?? fallbackReasoningEffort,
  );
  const [draft, setDraft] = useState("");
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [pastedImages, setPastedImages] = useState<CodexComposerImage[]>([]);
  const [localImages, setLocalImages] = useState<CodexComposerLocalImage[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [commandNotice, setCommandNotice] = useState<{
    tone: "info" | "error";
    message: string;
  } | null>(null);
  const [fastMode, setFastMode] = useState(false);
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [openingAgentsFile, setOpeningAgentsFile] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [nativeSnapshot, setNativeSnapshot] =
    useState<CodexNativeSnapshot | null>(null);
  const [nativeSnapshotFromCache, setNativeSnapshotFromCache] = useState(false);
  const [liveNotifications, setLiveNotifications] = useState<
    CodexEventEnvelope[]
  >([]);
  const [nativeStreamEpoch, setNativeStreamEpoch] = useState(0);
  const [nativeStreamReady, setNativeStreamReady] = useState(false);
  const [streamForeground, setStreamForeground] = useState(
    () => document.visibilityState !== "hidden",
  );
  const [nativeHistoryError, setNativeHistoryError] = useState("");
  const [nativeHistoryWaitLong, setNativeHistoryWaitLong] = useState(false);
  const [activityClock, setActivityClock] = useState(() => Date.now());
  const [pendingTurn, setPendingTurn] = useState<PendingCodexTurn | null>(null);
  const [pendingSteers, setPendingSteers] = useState<PendingCodexSteer[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollbarHideTimerRef = useRef<number | null>(null);
  const pendingTurnStartedAtRef = useRef<number | null>(null);
  const nativeAcceptedMessageIdsRef = useRef(new Set<string>());
  const hasNativeSnapshotRef = useRef(false);
  const hasNativeStreamFailureRef = useRef(false);
  const liveNotificationSequencesRef = useRef(new Set<number>());
  const liveNotificationCountRef = useRef(0);
  const nativeSnapshotRefreshRequestedRef = useRef(false);
  const settledProjectionRefreshKeyRef = useRef<string | null>(null);
  const localComposerPreferenceActiveRef = useRef(false);
  const modelCatalogRequestRef = useRef<{
    key: string;
    request: Promise<ApiEnvelope<unknown>>;
  } | null>(null);
  const sessionRef = useRef(session);
  const activeSessionIdRef = useRef(session.id);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [nativeSnapshotCache] = useState(
    () =>
      new BoundedLruCache<string, CodexNativeSnapshot>(
        RECENT_SESSION_SNAPSHOT_CACHE_SIZE,
      ),
  );
  const [sessionDraftCache] = useState(
    () =>
      new BoundedLruCache<string, string>(
        RECENT_SESSION_DRAFT_CACHE_SIZE,
      ),
  );
  const sessionTransitionRef = useRef({
    session,
    nativeSnapshotCache,
    sessionDraftCache,
  });
  sessionTransitionRef.current = {
    session,
    nativeSnapshotCache,
    sessionDraftCache,
  };
  const requestNativeSnapshotRefresh = useCallback(
    (options: { clearProjection?: boolean } = {}) => {
      if (options.clearProjection) {
        liveNotificationSequencesRef.current.clear();
        liveNotificationCountRef.current = 0;
        nativeSnapshotCache.delete(sessionRef.current.id);
        setNativeSnapshot(null);
        setNativeSnapshotFromCache(false);
        setLiveNotifications([]);
      }
      hasNativeSnapshotRef.current = false;
      setNativeStreamReady(false);
      setNativeHistoryError("");
      if (nativeSnapshotRefreshRequestedRef.current) return;
      nativeSnapshotRefreshRequestedRef.current = true;
      setNativeStreamEpoch((current) => current + 1);
    },
    [nativeSnapshotCache],
  );
  const refreshEpochRef = useRef(refreshEpoch);

  useEffect(() => {
    if (refreshEpochRef.current === refreshEpoch) return;
    refreshEpochRef.current = refreshEpoch;
    requestNativeSnapshotRefresh();
  }, [refreshEpoch, requestNativeSnapshotRefresh]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden";
      setStreamForeground(visible);
      if (visible) requestNativeSnapshotRefresh();
    };
    const handleNativeResume = () => {
      setStreamForeground(true);
      requestNativeSnapshotRefresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener(NATIVE_APP_RESUME_EVENT, handleNativeResume);
    return () => {
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
      window.removeEventListener(
        NATIVE_APP_RESUME_EVENT,
        handleNativeResume,
      );
    };
  }, [requestNativeSnapshotRefresh]);
  const visibleTimeline = useMemo(() => {
    return projectCodexTimeline(nativeSnapshot?.thread, liveNotifications);
  }, [liveNotifications, nativeSnapshot?.thread]);
  const nativeSteerClientMessageIds = useMemo(() => {
    const pendingClientIds = new Set(
      pendingSteers.map((steer) => steer.clientMessageId),
    );
    return new Set(
      visibleTimeline.entries
        .filter(
          (entry): entry is CodexMessageView =>
            entry.kind === "message" &&
            entry.role === "user" &&
            Boolean(entry.clientId) &&
            pendingClientIds.has(entry.clientId ?? ""),
        )
        .map((entry) => entry.clientId as string),
    );
  }, [pendingSteers, visibleTimeline.entries]);
  const timelineWithPendingSteers = useMemo(
    () =>
      withPendingCodexUserMessages(
        visibleTimeline,
        pendingSteers.map((steer) => ({
          kind: "message",
          id: steer.clientMessageId,
          clientId: steer.clientMessageId,
          turnId: steer.nativeTurnId,
          role: "user",
          content: steer.content,
          createdAt: steer.startedAt,
          attachments: steer.images.length ? steer.images : undefined,
          localImages: steer.localImages.length
            ? steer.localImages
            : undefined,
        })),
      ),
    [pendingSteers, visibleTimeline],
  );
  const timelineTurns = useMemo(
    () => groupCodexTimelineByTurn(timelineWithPendingSteers),
    [timelineWithPendingSteers],
  );
  const turnCapabilities = useMemo(
    () => codexTurnCapabilitySets(nativeSnapshot),
    [nativeSnapshot],
  );
  const observedPendingTurnId =
    pendingTurn?.nativeTurnId ??
    (pendingTurn ? visibleTimeline.activeTurn?.turnId : undefined);
  const pendingNativeMessage = pendingTurn
    ? visibleTimeline.entries.find(
        (entry): entry is CodexMessageView =>
          entry.kind === "message" &&
          entry.role === "user" &&
          (entry.clientId === pendingTurn.clientMessageId ||
            (Boolean(observedPendingTurnId) &&
              entry.turnId === observedPendingTurnId)),
      )
    : undefined;
  const pendingTurnVisible = Boolean(pendingTurn && !pendingNativeMessage);
  const pendingNativeTurnId =
    pendingNativeMessage?.turnId ?? observedPendingTurnId;
  const pendingNativeTimelineTurn =
    pendingTurnVisible && pendingNativeTurnId
      ? timelineTurns.find((turn) => turn.turnId === pendingNativeTurnId)
      : undefined;
  const optimisticActiveTurn: CodexActiveTurnView | undefined =
    pendingTurn && !pendingNativeMessage
      ? {
          turnId: pendingNativeTurnId ?? `pending:${pendingTurn.clientMessageId}`,
          startedAt: pendingTurn.startedAt,
          state: pendingTurn.phase === "submitting" ? "submitting" : "working",
        }
      : undefined;
  const runningTurn =
    visibleTimeline.activeTurn ??
    optimisticActiveTurn ??
    (session.status === "running"
      ? {
          turnId: `pending:${session.id}`,
          startedAt: pendingTurnStartedAtRef.current ?? session.updatedAt,
          state: "working" as const,
        }
      : undefined);
  const runningTurnId = runningTurn?.turnId;
  const interruptibleTurnId = visibleTimeline.activeTurn?.turnId;
  const turnRunning = Boolean(runningTurnId || pendingTurn);
  const interruptProjection = {
    nativeActiveTurnId: interruptibleTurnId,
    sessionRunning: session.status === "running",
    localTurnPending: Boolean(pendingTurn),
  };
  const canInterruptTurn = canInterruptCodexSession(interruptProjection);
  const settledProjectionNeedsRefresh =
    shouldRefreshSettledCodexProjection(interruptProjection);
  const nativeReady =
    Boolean(nativeSnapshot) && nativeStreamReady && !nativeHistoryError;
  const composerSubmissionTarget = codexComposerSubmissionTarget({
    nativeReady,
    turnRunning,
    activeTurnId: visibleTimeline.activeTurn?.turnId,
    sessionStatus: session.status,
  });
  const contextUsedPercent = codexContextUsedPercent(
    nativeSnapshot?.tokenUsage,
  );
  // Sandpi deliberately stores no secondary chat transcript. Until the native
  // harness snapshot arrives, this is runtime recovery—not an empty history.
  // Do not infer a cold start from persisted Sandbox state here: bootstrap may
  // still say paused while an ordinary refresh is already loading the runtime.
  const nativeHistoryLoading = !nativeSnapshot && !nativeHistoryError;
  const nativeHistorySyncing =
    nativeSnapshotFromCache && !nativeStreamReady && !nativeHistoryError;
  const {
    scrollRef: conversationScrollRef,
    contentRef: conversationContentRef,
    onScroll: handleAutoScroll,
    scrollToBottom,
    following: followingLatest,
  } = useConversationAutoScroll({ resetKey: session.id });

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!settledProjectionNeedsRefresh) {
      if (session.status === "running" || pendingTurn) {
        settledProjectionRefreshKeyRef.current = null;
      }
      return;
    }
    const refreshKey = `${session.id}:${interruptibleTurnId}`;
    if (settledProjectionRefreshKeyRef.current === refreshKey) return;
    const timer = window.setTimeout(() => {
      settledProjectionRefreshKeyRef.current = refreshKey;
      requestNativeSnapshotRefresh({ clearProjection: true });
    }, SETTLED_PROJECTION_REFRESH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    interruptibleTurnId,
    pendingTurn,
    requestNativeSnapshotRefresh,
    session.id,
    session.status,
    settledProjectionNeedsRefresh,
  ]);

  useEffect(() => {
    setNativeHistoryWaitLong(false);
    if (!nativeHistoryLoading) return;
    const timer = window.setTimeout(() => {
      setNativeHistoryWaitLong(true);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [nativeHistoryLoading, session.id]);

  useLayoutEffect(() => {
    const {
      session: nextSession,
      nativeSnapshotCache: snapshots,
      sessionDraftCache: drafts,
    } = sessionTransitionRef.current;
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId !== nextSession.id) {
      if (draftRef.current) {
        drafts.set(previousSessionId, draftRef.current);
      } else {
        drafts.delete(previousSessionId);
      }
    }
    activeSessionIdRef.current = nextSession.id;
    sessionRef.current = nextSession;
    const cachedDraft = drafts.get(nextSession.id) ?? "";
    draftRef.current = cachedDraft;
    const cachedSnapshotCandidate = snapshots.get(nextSession.id);
    const cachedSnapshot =
      cachedSnapshotCandidate?.nativeSessionId ===
        nextSession.harnessState.threadId &&
      cachedSnapshotCandidate.historyRevision ===
        nextSession.harnessState.historyRevision
        ? cachedSnapshotCandidate
        : undefined;
    if (cachedSnapshotCandidate && !cachedSnapshot) {
      snapshots.delete(nextSession.id);
    }

    pendingTurnStartedAtRef.current = null;
    nativeAcceptedMessageIdsRef.current.clear();
    setPendingTurn(null);
    setPendingSteers([]);
    setDraft(cachedDraft);
    setPastedImages([]);
    setLocalImages([]);
    setAttachmentError("");
    setCommandNotice(null);
    setFastMode(false);
    setSending(false);
    setInterrupting(false);
    setForkingMessageId(null);
    setNativeSnapshot(cachedSnapshot ?? null);
    setNativeSnapshotFromCache(Boolean(cachedSnapshot));
    setLiveNotifications([]);
    setNativeStreamReady(false);
    setNativeHistoryError("");
    hasNativeSnapshotRef.current = false;
    hasNativeStreamFailureRef.current = false;
    liveNotificationSequencesRef.current.clear();
    liveNotificationCountRef.current = 0;
    nativeSnapshotRefreshRequestedRef.current = false;
    settledProjectionRefreshKeyRef.current = null;
    localComposerPreferenceActiveRef.current = false;
  }, [session.id]);

  useEffect(() => {
    if (
      !nativeSnapshot ||
      nativeSnapshot.nativeSessionId !== session.harnessState.threadId
    ) {
      return;
    }
    nativeSnapshotCache.set(session.id, nativeSnapshot);
  }, [
    nativeSnapshot,
    nativeSnapshotCache,
    session.harnessState.threadId,
    session.id,
  ]);

  useEffect(() => {
    if (!pendingTurn || !pendingNativeMessage) return;
    const clientMessageId = pendingTurn.clientMessageId;
    nativeAcceptedMessageIdsRef.current.add(clientMessageId);
    setPendingTurn((current) =>
      current?.clientMessageId === clientMessageId ? null : current,
    );
  }, [pendingNativeMessage, pendingTurn]);

  useEffect(() => {
    if (nativeSteerClientMessageIds.size === 0) return;
    for (const clientMessageId of nativeSteerClientMessageIds) {
      nativeAcceptedMessageIdsRef.current.add(clientMessageId);
    }
    setPendingSteers((current) =>
      current.filter(
        (steer) =>
          !nativeSteerClientMessageIds.has(steer.clientMessageId),
      ),
    );
  }, [nativeSteerClientMessageIds]);

  useEffect(() => {
    if (!nativeReady || turnRunning) return;
    const orphaned = pendingSteers.filter(
      (steer) =>
        steer.phase === "accepted" &&
        !nativeSteerClientMessageIds.has(steer.clientMessageId),
    );
    if (orphaned.length === 0) return;
    const orphanedIds = new Set(
      orphaned.map((steer) => steer.clientMessageId),
    );
    const restoredDraft = orphaned
      .map((steer) => steer.content)
      .filter(Boolean)
      .join("\n");
    setPendingSteers((current) =>
      current.filter((steer) => !orphanedIds.has(steer.clientMessageId)),
    );
    setDraft((current) =>
      current && restoredDraft
        ? `${restoredDraft}${restoredDraft.endsWith("\n") ? "" : "\n"}${current}`
        : restoredDraft || current,
    );
    setPastedImages((current) =>
      [...orphaned.flatMap((steer) => steer.images), ...current].slice(
        0,
        MAX_CODEX_COMPOSER_IMAGES,
      ),
    );
    setLocalImages((current) => {
      const restored = new Map(
        [
          ...orphaned.flatMap((steer) => steer.localImages),
          ...current,
        ].map((localImage) => [localImage.path, localImage]),
      );
      return [...restored.values()].slice(
        0,
        MAX_CODEX_COMPOSER_UPLOAD_FILES,
      );
    });
    setAttachmentError(ui.steerTurnNotAccepted);
  }, [
    nativeReady,
    nativeSteerClientMessageIds,
    pendingSteers,
    turnRunning,
    ui.steerTurnNotAccepted,
  ]);

  useEffect(() => {
    if (!runningTurnId) return;
    setActivityClock(Date.now());
    const timer = window.setInterval(() => setActivityClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [runningTurnId]);

  useEffect(() => {
    setInterrupting(false);
  }, [runningTurnId]);

  useEffect(() => {
    const requestKey = `${environment.id}:${environment.credentialRevision}`;
    setModelCatalog({
      environmentId: environment.id,
      credentialRevision: environment.credentialRevision,
      options: [],
      unavailable: "",
    });
    const currentRequest = modelCatalogRequestRef.current;
    const request =
      currentRequest?.key === requestKey
        ? currentRequest.request
        : apiFetch<ApiEnvelope<unknown>>(
            `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/models`,
          );
    modelCatalogRequestRef.current = { key: requestKey, request };
    let active = true;
    void request
      .then((response) => {
        if (!active) return;
        const models = codexModelOptionsFromNativeResult(response.data);
        setModelCatalog({
          environmentId: environment.id,
          credentialRevision: environment.credentialRevision,
          options: models,
          unavailable:
            response.meta?.availability === "runtime-unavailable"
              ? typeof response.meta.message === "string"
                ? response.meta.message
                : ui.modelListUnavailable
              : "",
        });
      })
      .catch((error) => {
        if (modelCatalogRequestRef.current?.request === request) {
          modelCatalogRequestRef.current = null;
        }
        if (!active) return;
        setModelCatalog({
          environmentId: environment.id,
          credentialRevision: environment.credentialRevision,
          options: [],
          unavailable:
            error instanceof Error ? error.message : ui.modelListUnavailable,
        });
      });
    return () => {
      active = false;
    };
  }, [
    environment.codingAgent.harness,
    environment.credentialRevision,
    environment.id,
    ui.modelListUnavailable,
  ]);

  useEffect(() => {
    const persistedPreference =
      session.harnessState.modelId && session.harnessState.reasoningEffort
        ? {
            modelId: session.harnessState.modelId,
            reasoningEfforts: {
              [session.harnessState.modelId]:
                session.harnessState.reasoningEffort,
            },
          }
        : {
            modelId: session.harnessState.modelId,
            reasoningEfforts: {},
          };
    if (modelOptions.length === 0) {
      localComposerPreferenceActiveRef.current = false;
      setSelectedModelId(session.harnessState.modelId);
      setReasoningEfforts(persistedPreference.reasoningEfforts);
      return;
    }
    const localPreference = codingAgentComposerPreference({
      environmentId: environment.id,
      harness: environment.codingAgent.harness,
      sessionId: session.id,
    });
    const localModelAvailable = Boolean(
      localPreference &&
      modelOptions.some((model) => model.id === localPreference.modelId),
    );
    const selection = reconcileCodexComposerPreference(
      modelOptions,
      localModelAvailable ? localPreference : persistedPreference,
    );
    localComposerPreferenceActiveRef.current = localModelAvailable;
    if (selection.model) {
      setSelectedModelId(selection.model.id);
      setReasoningEfforts(selection.reasoningEfforts);
    }
  }, [
    environment.codingAgent.harness,
    environment.id,
    modelOptions,
    session.harnessState.modelId,
    session.harnessState.reasoningEffort,
    session.id,
  ]);

  useEffect(() => {
    if (!streamForeground) return;
    const source = new EventSource(
      apiUrl(`/api/v1/sessions/${encodeURIComponent(session.id)}/events`),
      { withCredentials: true },
    );

    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const snapshot = JSON.parse(event.data) as CodexNativeSnapshot;
        if (
          snapshot.protocol !== "codex-app-server" ||
          !snapshot.thread ||
          snapshot.thread.id !== snapshot.nativeSessionId ||
          !Array.isArray(snapshot.thread.turns) ||
          !Number.isSafeInteger(snapshot.historyRevision) ||
          snapshot.historyRevision < 0 ||
          (snapshot.reasoningEffort !== undefined &&
            typeof snapshot.reasoningEffort !== "string") ||
          !CODEX_SESSION_STATUSES.has(snapshot.sessionStatus) ||
          !Array.isArray(snapshot.forkableTurnIds) ||
          snapshot.forkableTurnIds.some((turnId) => typeof turnId !== "string")
        ) {
          throw new Error("Invalid Codex native snapshot");
        }
        snapshot.activity = normalizeCodexRolloutActivityFeed(snapshot.activity);
        const tokenUsage = normalizeCodexThreadTokenUsage(snapshot.tokenUsage);
        if (
          snapshot.tokenUsage !== null &&
          snapshot.tokenUsage !== undefined &&
          !tokenUsage
        ) {
          throw new Error("Invalid Codex context usage");
        }
        snapshot.tokenUsage = tokenUsage;
        hasNativeSnapshotRef.current = true;
        hasNativeStreamFailureRef.current = false;
        nativeSnapshotRefreshRequestedRef.current = false;
        liveNotificationSequencesRef.current.clear();
        liveNotificationCountRef.current = 0;
        setNativeSnapshot(snapshot);
        setNativeSnapshotFromCache(false);
        // A snapshot is the new native authority. Never replay the prior
        // connection's notification suffix on top of it.
        setLiveNotifications([]);
        setNativeStreamReady(true);
        setNativeHistoryError("");
        // Empty snapshot metadata means the native model is not known yet; it
        // must not overwrite a model just returned by the native model catalog.
        if (snapshot.modelId && !localComposerPreferenceActiveRef.current) {
          setSelectedModelId(snapshot.modelId);
        }
        if (
          snapshot.modelId &&
          snapshot.reasoningEffort &&
          !localComposerPreferenceActiveRef.current
        ) {
          setReasoningEfforts((current) => ({
            ...current,
            [snapshot.modelId]: snapshot.reasoningEffort!,
          }));
        }
        const current = sessionRef.current;
        const next: CodexSession = {
          ...current,
          updatedAt: snapshot.thread.updatedAt ?? current.updatedAt,
          status: snapshot.sessionStatus,
          completed:
            snapshot.sessionStatus === "running" ? false : current.completed,
          harnessState: {
            ...current.harnessState,
            threadId: snapshot.thread.id,
            modelId: snapshot.modelId || current.harnessState.modelId,
            reasoningEffort:
              snapshot.reasoningEffort ?? current.harnessState.reasoningEffort,
            historyRevision: snapshot.historyRevision,
          },
        };
        sessionRef.current = next;
        onSessionChange(next);
      } catch (error) {
        hasNativeSnapshotRef.current = false;
        hasNativeStreamFailureRef.current = true;
        liveNotificationSequencesRef.current.clear();
        liveNotificationCountRef.current = 0;
        nativeSnapshotCache.delete(session.id);
        setNativeSnapshot(null);
        setNativeSnapshotFromCache(false);
        setLiveNotifications([]);
        setNativeStreamReady(false);
        setNativeHistoryError(ui.nativeRolloutUnavailableBody);
        console.error("Unable to decode Codex native snapshot", error);
      }
    };

    const handleNotification = (event: MessageEvent<string>) => {
      try {
        const envelope = JSON.parse(event.data) as CodexEventEnvelope;
        if (envelope.harness !== "codex" || !hasNativeSnapshotRef.current) {
          return;
        }
        if (envelope.notification.method === "thread/tokenUsage/updated") {
          const { threadId, tokenUsage: nativeTokenUsage } =
            envelope.notification.params;
          const tokenUsage =
            normalizeCodexThreadTokenUsage(nativeTokenUsage);
          if (tokenUsage) {
            setNativeSnapshot((current) =>
              current && current.nativeSessionId === threadId
                ? { ...current, tokenUsage }
                : current,
            );
          }
          return;
        }
        if (liveNotificationSequencesRef.current.has(envelope.sequence)) return;
        liveNotificationSequencesRef.current.add(envelope.sequence);
        liveNotificationCountRef.current += 1;
        const refreshSnapshotAfterNotification =
          shouldRefreshCodexNativeSnapshot(
            liveNotificationCountRef.current,
          );
        setLiveNotifications((current) => [...current, envelope]);

        const current = sessionRef.current;
        const started = envelope.notification.method === "turn/started";
        const completed = envelope.notification.method === "turn/completed";
        if (envelope.notification.method === "turn/started") {
          const nativeTurnId = envelope.notification.params.turn.id;
          setPendingTurn((current) => {
            if (!current) return current;
            nativeAcceptedMessageIdsRef.current.add(current.clientMessageId);
            return current.nativeTurnId
              ? current
              : { ...current, nativeTurnId };
          });
        }
        const next: CodexSession = {
          ...current,
          updatedAt: envelope.receivedAt,
          status: started ? "running" : completed ? "waiting" : current.status,
          completed: started ? false : current.completed,
          unread:
            completed && document.visibilityState !== "visible"
              ? true
              : current.unread,
        };
        sessionRef.current = next;
        if (started || completed) {
          onSessionChange(next);
        }
        if (completed && document.visibilityState === "visible") {
          void apiFetch(
            `/api/v1/sessions/${encodeURIComponent(session.id)}/metadata`,
            {
              method: "PUT",
              body: JSON.stringify({ unread: false }),
            },
          ).catch((error) =>
            console.error("Unable to mark completed Codex Turn as read", error),
          );
        }
        if (refreshSnapshotAfterNotification) {
          // Apply the boundary event before reconnecting. In particular, never
          // discard turn/completed when it is the event that fills the bounded
          // suffix.
          requestNativeSnapshotRefresh();
        }
      } catch (error) {
        console.error("Unable to decode Codex live notification", error);
      }
    };

    const handleActivity = (event: MessageEvent<string>) => {
      try {
        const update = JSON.parse(event.data) as CodexNativeActivityUpdate;
        if (
          typeof update.nativeSessionId !== "string" ||
          !Number.isSafeInteger(update.historyRevision) ||
          update.historyRevision < 0
        ) {
          throw new Error("Invalid Codex Activity update");
        }
        const activity = normalizeCodexRolloutActivityFeed(update.activity);
        const tokenUsage = normalizeCodexThreadTokenUsage(update.tokenUsage);
        if (
          update.tokenUsage !== null &&
          update.tokenUsage !== undefined &&
          !tokenUsage
        ) {
          throw new Error("Invalid Codex context usage");
        }
        setNativeSnapshot((current) =>
          current &&
          current.nativeSessionId === update.nativeSessionId &&
          current.historyRevision === update.historyRevision
            ? {
                ...current,
                activity,
                // A live notification is newer than an in-flight rollout read.
                tokenUsage: current.tokenUsage ?? tokenUsage,
              }
            : current,
        );
      } catch (error) {
        setNativeSnapshot((current) =>
          current
            ? {
                ...current,
                activity: normalizeCodexRolloutActivityFeed(null),
              }
            : current,
        );
        console.error("Unable to decode Codex Activity update", error);
      }
    };

    const handleInvalidation = (event: MessageEvent<string>) => {
      let invalidation: CodexNativeInvalidation = {};
      try {
        invalidation = event.data
          ? (JSON.parse(event.data) as CodexNativeInvalidation)
          : {};
      } catch (error) {
        console.error("Unable to decode Codex native invalidation", error);
      }
      hasNativeSnapshotRef.current = false;
      liveNotificationSequencesRef.current.clear();
      liveNotificationCountRef.current = 0;
      nativeSnapshotCache.delete(session.id);
      setNativeSnapshot(null);
      setNativeSnapshotFromCache(false);
      setLiveNotifications([]);
      setNativeStreamReady(false);
      const reason = invalidation.reason?.toLowerCase() ?? "";
      const unrecoverable =
        invalidation.unrecoverable === true ||
        reason.includes("unrecoverable") ||
        reason.includes("rollout-lost") ||
        reason.includes("rollout_lost");
      setNativeHistoryError(
        unrecoverable
          ? invalidation.message || ui.nativeRolloutUnavailableBody
          : "",
      );
      hasNativeStreamFailureRef.current = unrecoverable;
    };

    const handleStreamFailure = (event: MessageEvent<string>) => {
      try {
        const failure = JSON.parse(event.data) as CodexNativeStreamFailure;
        if (
          !Number.isInteger(failure.status) ||
          typeof failure.code !== "string" ||
          typeof failure.message !== "string" ||
          typeof failure.retryable !== "boolean"
        ) {
          throw new Error("Invalid Codex native stream failure");
        }
        hasNativeStreamFailureRef.current = true;
        setNativeStreamReady(false);
        setNativeHistoryError(failure.message || ui.nativeStreamUnavailableBody);
        if (!failure.retryable) source.close();
      } catch (error) {
        hasNativeStreamFailureRef.current = true;
        setNativeStreamReady(false);
        setNativeHistoryError(ui.nativeStreamUnavailableBody);
        console.error("Unable to decode Codex native stream failure", error);
      }
    };

    const handleStreamError = () => {
      setNativeStreamReady(false);
      if (
        !hasNativeSnapshotRef.current &&
        !hasNativeStreamFailureRef.current
      ) {
        setNativeHistoryError(
          (current) => current || ui.nativeStreamUnavailableBody,
        );
      }
    };

    source.addEventListener("snapshot", handleSnapshot as EventListener);
    source.addEventListener("activity", handleActivity as EventListener);
    source.addEventListener("notification", handleNotification as EventListener);
    source.addEventListener("invalidation", handleInvalidation as EventListener);
    source.addEventListener("stream-error", handleStreamFailure as EventListener);
    source.addEventListener("error", handleStreamError);
    return () => source.close();
  }, [
    nativeStreamEpoch,
    nativeSnapshotCache,
    onSessionChange,
    requestNativeSnapshotRefresh,
    session.id,
    streamForeground,
    ui.nativeRolloutUnavailableBody,
    ui.nativeStreamUnavailableBody,
  ]);

  useEffect(
    () => () => {
      if (scrollbarHideTimerRef.current !== null) {
        window.clearTimeout(scrollbarHideTimerRef.current);
      }
    },
    [],
  );

  function rememberComposerPreference(
    modelId: string,
    nextReasoningEfforts: Record<string, string>,
  ) {
    const preference = {
      environmentId: environment.id,
      harness: environment.codingAgent.harness,
      modelId,
      reasoningEfforts: nextReasoningEfforts,
    };
    rememberCodingAgentComposerPreference({
      ...preference,
      sessionId: session.id,
    });
    // A deliberate Session choice also becomes the New Session default for
    // this Environment. The Session entry separately preserves an unsubmitted
    // choice across a refresh of the current conversation.
    rememberCodingAgentComposerPreference(preference);
  }

  function selectModel(modelId: string) {
    const model = modelOptions.find((candidate) => candidate.id === modelId);
    if (!model) return;
    const nextReasoningEfforts = {
      ...reasoningEfforts,
      [model.id]: codexReasoningEffortForModel(
        model,
        reasoningEfforts[model.id],
      ),
    };
    localComposerPreferenceActiveRef.current = true;
    setSelectedModelId(model.id);
    if (!model.fastServiceTier) setFastMode(false);
    setReasoningEfforts(nextReasoningEfforts);
    rememberComposerPreference(model.id, nextReasoningEfforts);
  }

  function selectReasoningEffort(effort: string) {
    const nextReasoningEfforts = {
      ...reasoningEfforts,
      [selectedModel.id]: effort,
    };
    localComposerPreferenceActiveRef.current = true;
    setReasoningEfforts(nextReasoningEfforts);
    rememberComposerPreference(selectedModel.id, nextReasoningEfforts);
  }

  function insertFileMentions(filePaths: string[]) {
    if (filePaths.length === 0) return;
    const textarea = composerRef.current;
    const insertion = insertCodexFileMentions(
      textarea?.value ?? draft,
      filePaths,
      textarea?.selectionStart ?? Number.POSITIVE_INFINITY,
      textarea?.selectionEnd ?? Number.POSITIVE_INFINITY,
    );
    setDraft(insertion.text);
    setAttachmentError("");
    window.requestAnimationFrame(() => {
      if (!composerRef.current) return;
      composerRef.current.focus();
      composerRef.current.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  async function submitMessage() {
    const submittedDraft = draft;
    const submittedImages = pastedImages;
    const submittedLocalImages = localImages;
    const content = draft.trim();
    if (
      !content &&
      submittedImages.length === 0 &&
      submittedLocalImages.length === 0
    ) {
      return;
    }
    const submissionTarget = composerSubmissionTarget;
    if (sending || !submissionTarget) return;
    const clientMessageId = createId("user-message", 24);
    const startedAt = Date.now() / 1_000;
    if (submissionTarget.kind === "steer") {
      setPendingSteers((current) => [
        ...current,
        {
          clientMessageId,
          nativeTurnId: submissionTarget.turnId,
          content,
          images: submittedImages,
          localImages: submittedLocalImages,
          startedAt,
          phase: "submitting",
        },
      ]);
    } else {
      pendingTurnStartedAtRef.current = startedAt;
      setPendingTurn({
        clientMessageId,
        content,
        images: submittedImages,
        localImages: submittedLocalImages,
        startedAt,
        phase: "submitting",
      });
    }
    setSending(true);
    setDraft("");
    setPastedImages([]);
    setLocalImages([]);
    setAttachmentError("");
    setCommandNotice(null);
    try {
      const response = await apiFetch<
        ApiEnvelope<{
          requestId: string;
          clientMessageId: string;
          nativeTurnId?: string;
        }>
      >(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns${
          submissionTarget.kind === "steer" ? "/steer" : ""
        }`,
        {
          method: "POST",
          body: JSON.stringify({
            text: content,
            images: submittedImages.map(encodeCodexComposerImage),
            localImages: encodeCodexComposerLocalImages(submittedLocalImages),
            clientMessageId,
            ...(submissionTarget.kind === "steer"
              ? { expectedTurnId: submissionTarget.turnId }
              : {
                  ...(selectedModel.id !== "default"
                    ? { modelId: selectedModel.id }
                    : {}),
                  ...(selectedReasoningEffort
                    ? { reasoningEffort: selectedReasoningEffort }
                    : {}),
                  ...(fastMode && selectedModel.fastServiceTier
                    ? { serviceTier: selectedModel.fastServiceTier.id }
                    : {}),
                }),
          }),
        },
      );
      if (submissionTarget.kind === "steer") {
        setPendingSteers((current) =>
          current.map((steer) =>
            steer.clientMessageId === clientMessageId
              ? {
                  ...steer,
                  nativeTurnId:
                    response.data.nativeTurnId ?? steer.nativeTurnId,
                  phase: "accepted",
                }
              : steer,
          ),
        );
      } else {
        setPendingTurn((current) =>
          current?.clientMessageId === clientMessageId
            ? {
                ...current,
                nativeTurnId:
                  response.data.nativeTurnId ?? current.nativeTurnId,
                phase: "accepted",
              }
            : current,
        );
        const next = {
          ...sessionRef.current,
          status: "running" as const,
          unread: false,
          completed: false,
          harnessState: {
            ...sessionRef.current.harnessState,
            modelId: selectedModel.id,
            reasoningEffort: selectedReasoningEffort,
          },
        };
        sessionRef.current = next;
        onSessionChange(next);
      }
    } catch (error) {
      if (nativeAcceptedMessageIdsRef.current.has(clientMessageId)) {
        setSending(false);
        return;
      }
      if (submissionTarget.kind === "steer") {
        setPendingSteers((current) =>
          current.filter(
            (steer) => steer.clientMessageId !== clientMessageId,
          ),
        );
      } else {
        pendingTurnStartedAtRef.current = null;
        setPendingTurn((current) =>
          current?.clientMessageId === clientMessageId ? null : current,
        );
      }
      setDraft((current) =>
        current && submittedDraft
          ? `${submittedDraft}${submittedDraft.endsWith("\n") ? "" : "\n"}${current}`
          : submittedDraft || current,
      );
      setPastedImages((current) =>
        [...submittedImages, ...current].slice(0, MAX_CODEX_COMPOSER_IMAGES),
      );
      setLocalImages((current) => {
        const restored = new Map(
          [...submittedLocalImages, ...current].map((localImage) => [
            localImage.path,
            localImage,
          ]),
        );
        return [...restored.values()].slice(
          0,
          MAX_CODEX_COMPOSER_UPLOAD_FILES,
        );
      });
      setAttachmentError(
        error instanceof Error
          ? error.message
          : submissionTarget.kind === "steer"
            ? ui.steerTurnFailed
            : "Could not start the Codex Turn.",
      );
      setSending(false);
      return;
    }
    setAttachmentError("");
    setSending(false);
  }

  async function interruptActiveTurn() {
    if (!canInterruptTurn || interrupting) {
      return;
    }
    setInterrupting(true);
    setAttachmentError("");
    try {
      const response = await apiFetch<
        ApiEnvelope<{
          turnId?: string;
          status: "interrupting" | "settled";
        }>
      >(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/interrupt`,
        {
          method: "POST",
          body: JSON.stringify(
            interruptibleTurnId ? { turnId: interruptibleTurnId } : {},
          ),
        },
      );
      if (response.data.status === "settled") {
        setInterrupting(false);
        requestNativeSnapshotRefresh({ clearProjection: true });
      }
      // For an active Turn, keep the stop state until it disappears. Product
      // Session status converges from the shared native event stream/snapshot.
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : ui.interruptTurnFailed,
      );
      setInterrupting(false);
    }
  }

  async function forkTurn(message: CodexMessageView) {
    if (sending || !turnCapabilities.forkableTurnIds.has(message.turnId)) {
      return;
    }
    setSending(true);
    setForkingMessageId(message.id);
    setAttachmentError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        `/api/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(message.turnId)}/fork`,
        { method: "POST", body: JSON.stringify({}) },
      );
      onDerivedSessionCreated(response.data);
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : ui.forkTurnFailed,
      );
    } finally {
      setForkingMessageId(null);
      setSending(false);
    }
  }

  async function copyMessage(message: CodexMessageView) {
    try {
      await copyTextToClipboard(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) =>
          current === message.id ? null : current,
        );
      }, 1600);
    } catch {
      setCopiedMessageId(null);
    }
  }

  async function addPastedImages(files: File[]) {
    const selection = selectCodexImageFiles(files, pastedImages);
    setAttachmentError(imageSelectionError(selection.issue));
    if (selection.files.length === 0) return;

    try {
      const attachments = await Promise.all(
        selection.files.map(readCodexComposerImage),
      );
      setPastedImages((current) =>
        [...current, ...attachments].slice(0, MAX_CODEX_COMPOSER_IMAGES),
      );
    } catch {
      setAttachmentError(ui.imagePasteFailed);
    }
  }

  function handleConversationScroll(event: UIEvent<HTMLDivElement>) {
    const scrollRegion = event.currentTarget;
    handleAutoScroll(event);
    scrollRegion.classList.add("is-scrolling");
    if (scrollbarHideTimerRef.current !== null) {
      window.clearTimeout(scrollbarHideTimerRef.current);
    }
    scrollbarHideTimerRef.current = window.setTimeout(() => {
      scrollRegion.classList.remove("is-scrolling");
      scrollbarHideTimerRef.current = null;
    }, 700);
  }

  async function openAgentsFile() {
    if (openingAgentsFile) return;
    setOpeningAgentsFile(true);
    setCommandNotice(null);
    try {
      const path = await ensureWorkspaceAgentsFile(environment.id);
      onOpenWorkspacePath(path);
    } catch (error) {
      setCommandNotice({
        tone: "error",
        message:
          error instanceof Error ? error.message : ui.openAgentsFileFailed,
      });
    } finally {
      setOpeningAgentsFile(false);
    }
  }

  function openChangedFile(path?: string) {
    if (path) {
      onOpenWorkspacePath(path);
      return;
    }
    onOpenInspector("files");
  }

  function renderTimelineEntry(entry: CodexTimelineEntry) {
    if (entry.kind === "command") {
      return (
        <CodexCommandActivity
          key={entry.id}
          activity={entry}
          language={language}
        />
      );
    }
    if (entry.kind === "fileChange") {
      return (
        <CodexFileChangeActivity
          key={entry.id}
          activity={entry}
          language={language}
          onOpenFiles={openChangedFile}
        />
      );
    }
    if (entry.kind === "nativeItem") {
      return (
        <CodexNativeItemActivity
          key={entry.id}
          activity={entry}
          language={language}
        />
      );
    }
    if (
      entry.kind === "mcpToolCall" ||
      entry.kind === "dynamicToolCall" ||
      entry.kind === "webSearch" ||
      entry.kind === "collabAgentToolCall" ||
      entry.kind === "subAgentActivity" ||
      entry.kind === "imageGeneration"
    ) {
      return (
        <CodexNativeToolActivity
          key={entry.id}
          activity={entry}
          language={language}
        />
      );
    }
    if (entry.kind === "turnResult") {
      return (
        <CodexTurnResult key={entry.id} result={entry} language={language} />
      );
    }

    const message = entry;
    return (
      <article
        className={`message message-${message.role}`}
        key={message.id}
      >
        {message.role === "assistant" ? (
          <div className="assistant-avatar" role="img" aria-label="Sandpi">
            <SandpiMark className="assistant-avatar-mark" />
          </div>
        ) : null}
        <div className="message-body">
          <div className="message-author">
            {message.role === "user" ? ui.you : session.harnessLabel}
          </div>
          {message.attachments?.length ? (
            <div
              className={`message-image-attachments ${
                message.attachments.length === 1 ? "is-single" : ""
              }`}
              aria-label={ui.attachedImages}
            >
              {message.attachments.map((attachment) => (
                <Image
                  key={attachment.id}
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  width={440}
                  height={300}
                  sizes="(max-width: 680px) 72vw, 320px"
                  unoptimized
                />
              ))}
            </div>
          ) : null}
          {message.localImages?.length ? (
            <CodexComposerLocalImages
              language={language}
              localImages={message.localImages}
            />
          ) : null}
          {message.content ? (
            <MarkdownContent
              content={message.content}
              onOpenWorkspacePath={onOpenWorkspacePath}
            />
          ) : message.streaming ? (
            <div
              className="assistant-streaming"
              aria-label={ui.turnActivity("responding")}
            >
              <span />
              <span />
              <span />
            </div>
          ) : null}

          {message.role === "assistant" ? (
            <div className="message-actions message-actions-assistant">
              <button
                type="button"
                aria-label={ui.copyResponse}
                title={ui.copy}
                onClick={() => void copyMessage(message)}
              >
                {copiedMessageId === message.id ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          ) : (
            <div className="message-actions message-actions-user">
              <button
                type="button"
                aria-label={ui.forkTurnMessage}
                title={ui.forkTurnHere}
                aria-busy={forkingMessageId === message.id}
                disabled={
                  sending ||
                  session.status !== "waiting" ||
                  !turnCapabilities.forkableTurnIds.has(message.turnId)
                }
                onClick={() => void forkTurn(message)}
              >
                {forkingMessageId === message.id ? (
                  <span className="activity-spinner" aria-hidden="true" />
                ) : (
                  <GitFork size={14} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                aria-label={ui.copyMessage}
                title={ui.copy}
                onClick={() => void copyMessage(message)}
              >
                {copiedMessageId === message.id ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </button>
            </div>
          )}
        </div>
        {message.role === "user" ? (
          <UserAvatar
            viewer={viewer}
            className="user-avatar"
            label={ui.you}
          />
        ) : null}
      </article>
    );
  }

  function renderTimelineTurn(timelineTurn: CodexTurnTimelineGroup) {
    const lastActivityBlockIndex = timelineTurn.blocks.findLastIndex(
      (block) => block.kind === "activity",
    );
    // The answer lives below this disclosure. Release completed tool history
    // as soon as response streaming starts so bottom-following tracks text.
    const streamingFinalResponse =
      runningTurn?.turnId === timelineTurn.turnId &&
      runningTurn.state === "responding" &&
      timelineTurn.blocks.some(
        (block) =>
          block.kind === "message" &&
          block.entry.role === "assistant" &&
          block.entry.streaming,
      );
    return (
      <Fragment key={timelineTurn.turnId}>
        {timelineTurn.blocks.map((block, blockIndex) => {
          if (block.kind === "message") {
            return renderTimelineEntry(block.entry);
          }
          if (block.kind === "result") {
            return renderTimelineEntry(block.entry);
          }
          const activeTurn =
            block.id === timelineTurn.activeActivityBlockId &&
            runningTurn?.turnId === timelineTurn.turnId
              ? runningTurn
              : undefined;
          if (block.entries.length === 0 && !activeTurn) return null;
          return (
            <CodexTurnActivity
              key={block.id}
              activeTurn={activeTurn}
              autoExpand={!streamingFinalResponse}
              turn={
                blockIndex === lastActivityBlockIndex
                  ? timelineTurn.turn
                  : undefined
              }
              language={language}
              now={activityClock}
            >
              {block.entries.map(renderTimelineEntry)}
            </CodexTurnActivity>
          );
        })}
      </Fragment>
    );
  }

  const pendingMessage: CodexMessageView | undefined =
    pendingTurn && !pendingNativeMessage
      ? {
          kind: "message",
          id: pendingTurn.clientMessageId,
          clientId: pendingTurn.clientMessageId,
          turnId:
            pendingNativeTimelineTurn?.turnId ??
            `pending:${pendingTurn.clientMessageId}`,
          role: "user",
          content: pendingTurn.content,
          createdAt: pendingTurn.startedAt,
          attachments: pendingTurn.images.length
            ? pendingTurn.images
            : undefined,
          localImages: pendingTurn.localImages.length
            ? pendingTurn.localImages
            : undefined,
        }
      : undefined;

  return (
    <>
      <section
        id="conversation"
        className="conversation-pane"
        aria-label={ui.label}
        tabIndex={-1}
      >
        <header
          className="conversation-header"
          data-native-titlebar-leading-content
          data-tauri-drag-region="deep"
        >
          <div className="conversation-title-area">
            <button
              type="button"
              className="icon-button sidebar-expand-button"
              aria-label={ui.expandSidebar}
              title={ui.expandSidebar}
              onClick={onToggleSidebar}
            >
              <PanelLeftOpen size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button mobile-menu-button"
              aria-label={ui.openNavigation}
              onClick={onToggleSidebar}
            >
              <Menu size={19} aria-hidden="true" />
            </button>
            <div className="conversation-title-line">
              <div className="conversation-breadcrumb">
                <button type="button" onClick={() => onNewSession()}>
                  {environment.name}
                </button>
                <span>/</span>
                <span>{session.title}</span>
              </div>
              <span className="conversation-context">
                <span
                  className={`live-indicator status-${session.status}`}
                  aria-hidden="true"
                />
                <span>{ui.status(session.status)}</span>
                <span aria-hidden="true">·</span>
                <span className="conversation-context-summary">
                  {session.harnessLabel} · {selectedModel.displayName} ·{" "}
                  {selectedReasoningEffort
                    ? `${codexReasoningEffortLabel(selectedReasoningEffort)} · `
                    : ""}
                  {ui.environmentRevision(session.environmentRevision)}
                </span>
              </span>
            </div>
          </div>

          <div className="conversation-header-actions">
            {completionError ? (
              <span className="completion-save-error" role="alert">
                {completionError}
              </span>
            ) : null}
            <button
              type="button"
              className={`header-action-button session-completion-button ${
                session.completed ? "is-active" : ""
              }`}
              aria-label={session.completed ? ui.markIncomplete : ui.markComplete}
              aria-pressed={session.completed}
              aria-busy={completionSaving}
              title={session.completed ? ui.markIncomplete : ui.markComplete}
              disabled={completionSaving}
              onClick={() => void toggleSessionCompleted()}
            >
              {completionSaving ? (
                <span className="activity-spinner" aria-hidden="true" />
              ) : session.completed ? (
                <CircleCheckBig size={15} aria-hidden="true" />
              ) : (
                <Circle size={15} aria-hidden="true" />
              )}
              <span>
                {session.completed ? ui.markIncomplete : ui.markComplete}
              </span>
            </button>
            <button
              type="button"
              className="header-action-button"
              aria-label={ui.openAgentsFile}
              aria-busy={openingAgentsFile}
              title={ui.openAgentsFile}
              disabled={openingAgentsFile}
              onClick={() => void openAgentsFile()}
            >
              {openingAgentsFile ? (
                <span className="activity-spinner" aria-hidden="true" />
              ) : (
                <BookOpenText size={15} aria-hidden="true" />
              )}
              <span translate="no">AGENTS.md</span>
            </button>
            <button
              type="button"
              className={`header-action-button ${terminalOpen ? "is-active" : ""}`}
              aria-label={ui.terminal}
              aria-pressed={terminalOpen}
              title={ui.terminal}
              onClick={onToggleTerminal}
            >
              <SquareTerminal size={15} aria-hidden="true" />
              <span>{ui.terminal}</span>
            </button>
            <button
              type="button"
              className={`icon-button ${inspectorOpen ? "is-active" : ""}`}
              aria-label={inspectorOpen ? ui.closeInspector : ui.openInspector}
              onClick={onToggleInspector}
            >
              <PanelRight size={18} />
            </button>
          </div>
        </header>

        <div
          ref={conversationScrollRef}
          className="conversation-scroll"
          onScroll={handleConversationScroll}
        >
          <div
            ref={conversationContentRef}
            className="message-column"
            aria-busy={nativeHistoryLoading || nativeHistorySyncing}
          >
            {nativeHistoryLoading ? (
              <div
                className="conversation-runtime-loading"
                role="status"
                aria-live="polite"
              >
                <span className="conversation-runtime-loading-icon">
                  <LoaderCircle size={18} aria-hidden="true" />
                </span>
                <span className="conversation-runtime-loading-copy">
                  <strong>
                    {nativeHistoryWaitLong
                      ? ui.wakingConversation
                      : ui.loadingConversation}
                  </strong>
                  <small>
                    {nativeHistoryWaitLong
                      ? ui.wakingConversationBody
                      : ui.loadingConversationBody}
                  </small>
                </span>
              </div>
            ) : null}
            {nativeHistoryError ? (
              <div className="native-context-reset-notice" role="alert">
                <TriangleAlert size={16} aria-hidden="true" />
                <span>
                  <strong>{ui.nativeRolloutUnavailableTitle}</strong>
                  <small>{nativeHistoryError}</small>
                </span>
              </div>
            ) : null}
            {timelineTurns.map((timelineTurn) =>
              timelineTurn.turnId === pendingNativeTimelineTurn?.turnId
                ? null
                : renderTimelineTurn(timelineTurn),
            )}
            {pendingMessage ? (
              <Fragment key={pendingMessage.id}>
                {renderTimelineEntry(pendingMessage)}
                {pendingNativeTimelineTurn ? (
                  renderTimelineTurn(pendingNativeTimelineTurn)
                ) : (
                  <CodexTurnActivity
                    activeTurn={runningTurn}
                    language={language}
                    now={activityClock}
                  />
                )}
              </Fragment>
            ) : null}
            {runningTurn &&
              !pendingMessage &&
              !nativeHistoryLoading &&
              !timelineTurns.some(
                (turn) => turn.turnId === runningTurn.turnId,
              ) ? (
              <CodexTurnActivity
                activeTurn={runningTurn}
                language={language}
                now={activityClock}
              />
            ) : null}
          </div>
        </div>

        <div className="composer-region">
          {!followingLatest ? (
            <button
              type="button"
              className="conversation-jump-to-latest"
              aria-label={ui.jumpToLatest}
              onClick={scrollToBottom}
            >
              <ArrowDown size={14} aria-hidden="true" />
              <span>{ui.jumpToLatest}</span>
            </button>
          ) : null}
          <CodexComposer
            language={language}
            inputRef={composerRef}
            inputProps={{
              name: "message",
              value: draft,
              onChange: (event) => {
                setDraft(event.target.value);
                setCommandNotice(null);
              },
              onPaste: (event) => {
                const imageFiles = clipboardCodexImageFiles(event.clipboardData);
                if (imageFiles.length === 0) return;
                // A textarea ignores image clipboard items on its own. Let the
                // browser keep any accompanying plain text while images are
                // attached separately.
                void addPastedImages(imageFiles);
              },
              onKeyDown: (event) => {
                if (
                  shouldSubmitComposer(
                    {
                      key: event.key,
                      shiftKey: event.shiftKey,
                      metaKey: event.metaKey,
                      ctrlKey: event.ctrlKey,
                      isComposing: event.nativeEvent.isComposing,
                    },
                    sendShortcut,
                  )
                ) {
                  event.preventDefault();
                  void submitMessage();
                }
              },
              "aria-label": ui.messageAgent(environment.codingAgent.label),
              placeholder: turnRunning
                ? ui.steerPlaceholder(environment.codingAgent.label)
                : ui.askPlaceholder(environment.codingAgent.label),
            }}
            images={pastedImages}
            onRemoveImage={(id) => {
              setPastedImages((current) =>
                current.filter((image) => image.id !== id),
              );
              setAttachmentError("");
            }}
            localImages={localImages}
            onRemoveLocalImage={(id) => {
              setLocalImages((current) =>
                current.filter((localImage) => localImage.id !== id),
              );
              setAttachmentError("");
            }}
            attachmentError={attachmentError}
            notice={commandNotice}
            toolbar={{
              environmentId: environment.id,
              agentLabel: environment.codingAgent.label,
              onLocalImagesChange: setLocalImages,
              onInsertFileMentions: insertFileMentions,
              onAttachmentError: setAttachmentError,
              modelOptions:
                modelOptions.length > 0 ? modelOptions : [selectedModel],
              selectedModel,
              modelPlaceholder: selectedModel.displayName,
              modelTitle: modelCatalogUnavailable || undefined,
              modelDisabled:
                modelOptions.length === 0 || sending || turnRunning,
              reasoningDisabled: sending || turnRunning,
              selectedReasoningEffort,
              onModelChange: selectModel,
              onReasoningEffortChange: selectReasoningEffort,
              fastEnabled: fastMode,
              fastDisabled: sending || turnRunning,
              onFastEnabledChange: (enabled) => {
                setFastMode(enabled);
                setCommandNotice(null);
              },
              contextUsedPercent,
              status: {
                state: nativeHistoryError
                  ? "unavailable"
                  : nativeReady
                    ? "ready"
                    : "loading",
                label: nativeHistoryError
                  ? ui.runtimeUnavailable
                  : nativeReady
                    ? ui.durableSession
                    : ui.checkingRuntime,
              },
              action: (
                <>
                  {turnRunning ? (
                    <button
                      type="button"
                      className={`send-button is-running is-interrupt ${
                        !canInterruptTurn ? "is-starting" : ""
                      } ${interrupting ? "is-interrupting" : ""}`}
                      disabled={interrupting || !canInterruptTurn}
                      aria-label={
                        interrupting
                          ? ui.interruptingTurn
                          : canInterruptTurn
                            ? ui.interruptTurn
                            : ui.turnStarting
                      }
                      aria-busy={interrupting || !canInterruptTurn}
                      title={
                        canInterruptTurn ? ui.interruptTurn : ui.turnStarting
                      }
                      onClick={() => void interruptActiveTurn()}
                    >
                      {interrupting || !canInterruptTurn ? (
                        <span className="activity-spinner" aria-hidden="true" />
                      ) : (
                        <Square
                          size={10}
                          fill="currentColor"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="send-button"
                    disabled={
                      sending ||
                      !composerSubmissionTarget ||
                      (!draft.trim() &&
                        pastedImages.length === 0 &&
                        localImages.length === 0)
                    }
                    aria-label={
                      composerSubmissionTarget?.kind === "steer"
                        ? ui.steerTurn
                        : ui.sendMessage
                    }
                    title={
                      composerSubmissionTarget?.kind === "steer"
                        ? ui.steerTurn
                        : undefined
                    }
                    onClick={() => void submitMessage()}
                  >
                    <ArrowUp size={17} strokeWidth={2.5} />
                  </button>
                </>
              ),
            }}
          />
          <p className="composer-footnote">
            <Files size={12} /> {ui.workingInWorkspace}
            <span>·</span>
            <Settings2 size={12} /> {ui.networkInherited(environment.name)}
          </p>
        </div>
      </section>
      {inspectorOpen ||
      mountedInspectorEnvironmentId === environment.id ? (
        <Inspector
          language={language}
          timeZone={timeZone}
          environment={environment}
          session={session}
          activeTab={inspectorTab}
          hidden={!inspectorOpen}
          widthRatio={inspectorWidthRatio}
          workspaceNavigationRequest={workspaceNavigationRequest}
          onWorkspaceNavigationHandled={onWorkspaceNavigationHandled}
          onTabChange={onInspectorTabChange}
          onWidthRatioChange={onInspectorWidthRatioChange}
          onOpenEnvironmentSettings={() =>
            onOpenEnvironmentSettings("general")
          }
          onClose={onToggleInspector}
          sessionActivity={{
            label: ui.activity,
            content: (
              <CodexSessionActivityView
                key={`${session.id}:${
                  nativeSnapshot?.thread.id ?? session.harnessState.threadId
                }`}
                language={language}
                timeZone={timeZone}
                projection={visibleTimeline}
                rolloutActivity={nativeSnapshot?.activity}
                loading={nativeHistoryLoading}
                error={nativeHistoryError}
                onOpenFiles={openChangedFile}
              />
            ),
          }}
        />
      ) : null}
    </>
  );
}

function imageSelectionError(issue?: CodexImageSelectionIssue) {
  if (!issue) return "";
  if (issue === "too-many") return `Attach up to ${MAX_CODEX_COMPOSER_IMAGES} images.`;
  if (issue === "unsupported") return "Use PNG, JPEG, GIF, or WebP images.";
  if (issue === "total-too-large") return "The combined image size is too large.";
  return "Each image must be 10 MB or smaller.";
}
