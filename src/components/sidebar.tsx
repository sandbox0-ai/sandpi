"use client";

import {
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CircleCheckBig,
  ChevronDown,
  ChevronUp,
  GripVertical,
  PanelLeftClose,
  Pin,
  Plus,
  Search,
  Settings2,
  X,
} from "lucide-react";

import { SidebarAccountFooter } from "@/components/sidebar-account-footer";
import { SessionActionsMenu } from "@/components/session-actions-menu";
import { SessionSearchDialog } from "@/components/session-search-dialog";
import { AppSidebar } from "@/components/app-frame";
import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import {
  moveEnvironment,
  moveEnvironmentByOffset,
} from "@/lib/environment-order";
import { sessionStateMarker } from "@/lib/session-state-marker";
import type {
  CodingSession,
  Environment,
  SandpiUser,
} from "@/lib/types";
import {
  SIDEBAR_INITIAL_SESSION_COUNT,
  SIDEBAR_SESSION_PAGE_SIZE,
  sidebarSessionPage,
  visibleSessionsForEnvironment,
} from "@/lib/session-list";

interface SidebarProps {
  language: OperationLanguage;
  timeZone: string;
  viewer: SandpiUser;
  environments: Environment[];
  sessions: CodingSession[];
  selectedEnvironmentId: string;
  selectedSessionId: string;
  onSelectEnvironment: (environmentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewEnvironment: () => void;
  onNewSession: (environmentId: string) => void;
  onEnvironmentSettings: (environmentId: string) => void;
  onReorderEnvironments: (environments: Environment[]) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onForkSession: (sessionId: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  onToggleSessionCompleted: (sessionId: string) => Promise<void>;
  onCollapse: () => void;
  onCloseMobile: () => void;
}

const DRAG_CLICK_SUPPRESSION_MS = 350;

type SortableEnvironmentActivator = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners"
>;

function SortableEnvironmentGroup({
  environmentId,
  children,
}: {
  environmentId: string;
  children: (activator: SortableEnvironmentActivator) => ReactNode;
}) {
  const {
    attributes,
    isDragging,
    isOver,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: environmentId });

  return (
    <section
      ref={setNodeRef}
      className={`environment-group ${isDragging ? "is-dragging" : ""} ${
        isOver && !isDragging ? "is-drop-target" : ""
      }`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      {children({ attributes, listeners })}
    </section>
  );
}

function SessionStateIndicator({
  session,
  unreadLabel,
  runningLabel,
  completedLabel,
}: {
  session: CodingSession;
  unreadLabel: "Unread" | "未读";
  runningLabel: "Running" | "运行中";
  completedLabel: "Completed" | "已完成";
}) {
  const marker = sessionStateMarker(session);
  if (!marker) return null;

  return (
    <span className="session-state-indicator">
      {marker === "completed" ? (
        <CircleCheckBig
          className="session-completed-indicator"
          size={11}
          role="img"
          aria-label={completedLabel}
        />
      ) : marker === "running" ? (
        <span
          className="session-running-indicator"
          role="img"
          aria-label={runningLabel}
        />
      ) : (
        <span
          className="session-unread-dot"
          role="img"
          aria-label={unreadLabel}
        />
      )}
    </span>
  );
}

export function Sidebar({
  language,
  timeZone,
  viewer,
  environments,
  sessions,
  selectedEnvironmentId,
  selectedSessionId,
  onSelectEnvironment,
  onSelectSession,
  onNewEnvironment,
  onNewSession,
  onEnvironmentSettings,
  onReorderEnvironments,
  onRenameSession,
  onForkSession,
  onArchiveSession,
  onTogglePinSession,
  onToggleSessionCompleted,
  onCollapse,
  onCloseMobile,
}: SidebarProps) {
  const ui = getOperationUiCopy(language).sidebar;
  const unreadLabel = language === "zh-CN" ? "未读" : "Unread";
  const runningLabel = language === "zh-CN" ? "运行中" : "Running";
  const completedLabel = language === "zh-CN" ? "已完成" : "Completed";
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [draggedEnvironmentId, setDraggedEnvironmentId] = useState("");
  const environmentSensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 180,
        tolerance: 8,
      },
    }),
  );
  const suppressedEnvironmentClick = useRef({
    environmentId: "",
    until: 0,
  });
  const [visibleSessionCounts, setVisibleSessionCounts] = useState<
    Record<string, number>
  >({});

  function showMoreSessions(environmentId: string) {
    setVisibleSessionCounts((current) => ({
      ...current,
      [environmentId]:
        (current[environmentId] ?? SIDEBAR_INITIAL_SESSION_COUNT) +
        SIDEBAR_SESSION_PAGE_SIZE,
    }));
  }

  function showFewerSessions(environmentId: string) {
    setVisibleSessionCounts((current) => {
      if (current[environmentId] === undefined) return current;
      const next = { ...current };
      delete next[environmentId];
      return next;
    });
  }

  function reorderByOffset(environmentId: string, offset: -1 | 1) {
    const reordered = moveEnvironmentByOffset(
      environments,
      environmentId,
      offset,
    );
    if (reordered !== environments) onReorderEnvironments(reordered);
  }

  function finishEnvironmentDrag(environmentId: string) {
    suppressedEnvironmentClick.current = {
      environmentId,
      until: Date.now() + DRAG_CLICK_SUPPRESSION_MS,
    };
    setDraggedEnvironmentId("");
  }

  function selectEnvironment(environmentId: string) {
    const suppressed = suppressedEnvironmentClick.current;
    if (
      suppressed.environmentId === environmentId &&
      Date.now() < suppressed.until
    ) {
      suppressedEnvironmentClick.current = {
        environmentId: "",
        until: 0,
      };
      return;
    }
    onSelectEnvironment(environmentId);
  }

  return (
    <>
      <AppSidebar
        className="sidebar"
        label={ui.navigation}
        footer={
          <SidebarAccountFooter
            language={language}
            timeZone={timeZone}
            viewer={viewer}
          />
        }
        headerAction={
          <>
            <button
              className="icon-button sidebar-collapse-button"
              type="button"
              aria-label={ui.collapse}
              title={ui.collapse}
              onClick={onCollapse}
            >
              <PanelLeftClose size={17} aria-hidden="true" />
            </button>
            <button
              className="icon-button sidebar-close-button"
              type="button"
              aria-label={ui.close}
              onClick={onCloseMobile}
            >
              <X size={18} />
            </button>
          </>
        }
      >
        <button
          className="new-session-button"
          type="button"
          onClick={onNewEnvironment}
        >
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
          {ui.newEnvironment}
        </button>

        <button
          className="sidebar-search"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={sessionSearchOpen}
          onClick={() => setSessionSearchOpen(true)}
        >
          <Search size={16} aria-hidden="true" />
          <span>{ui.searchSessions}</span>
        </button>

        <div className="sidebar-scroll-region">
          <div className="sidebar-section-heading">
            <span>{ui.environments}</span>
          </div>

          <DndContext
            sensors={environmentSensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }) => {
              window.getSelection()?.removeAllRanges();
              setDraggedEnvironmentId(String(active.id));
            }}
            onDragCancel={({ active }) => {
              finishEnvironmentDrag(String(active.id));
            }}
            onDragEnd={({ active, over }) => {
              const sourceEnvironmentId = String(active.id);
              const targetEnvironmentId = over ? String(over.id) : "";
              finishEnvironmentDrag(sourceEnvironmentId);
              if (!targetEnvironmentId) return;
              const reordered = moveEnvironment(
                environments,
                sourceEnvironmentId,
                targetEnvironmentId,
              );
              if (reordered !== environments) {
                onReorderEnvironments(reordered);
              }
            }}
          >
            <SortableContext
              items={environments.map(({ id }) => id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                className={`environment-list ${
                  draggedEnvironmentId ? "is-reordering" : ""
                }`}
              >
                {environments.map((environment) => {
                  const environmentSessions = visibleSessionsForEnvironment(
                    sessions,
                    environment.id,
                  );
                  const sessionPage = sidebarSessionPage(
                    environmentSessions,
                    visibleSessionCounts[environment.id] ??
                      SIDEBAR_INITIAL_SESSION_COUNT,
                    selectedSessionId,
                  );
                  const sessionListId = `environment-${environment.id}-sessions`;
                  const selected = environment.id === selectedEnvironmentId;
                  const canManage = environment.ownerId === viewer.id;

                  return (
                    <SortableEnvironmentGroup
                      environmentId={environment.id}
                      key={environment.id}
                    >
                      {({ attributes, listeners }) => (
                        <>
                          <div
                            className={`environment-row ${
                              selected ? "is-selected" : ""
                            }`}
                          >
                            <button
                              {...attributes}
                              {...listeners}
                              className="environment-drag-handle"
                              type="button"
                              aria-label={
                                language === "zh-CN"
                                  ? `移动 ${environment.name}`
                                  : `Move ${environment.name}`
                              }
                              title={
                                language === "zh-CN"
                                  ? "拖拽或使用上下方向键调整顺序"
                                  : "Drag or use the arrow keys to reorder"
                              }
                              onKeyDown={(event) => {
                                if (event.key === "ArrowUp") {
                                  event.preventDefault();
                                  reorderByOffset(environment.id, -1);
                                } else if (event.key === "ArrowDown") {
                                  event.preventDefault();
                                  reorderByOffset(environment.id, 1);
                                }
                              }}
                            >
                              <GripVertical size={14} aria-hidden="true" />
                            </button>
                            <button
                              {...attributes}
                              {...listeners}
                              className="environment-main-button"
                              type="button"
                              aria-current={selected ? "page" : undefined}
                              onClick={() =>
                                selectEnvironment(environment.id)
                              }
                            >
                              <span
                                className="environment-avatar"
                                style={{ backgroundColor: environment.color }}
                                aria-hidden="true"
                              >
                                {environment.name.slice(0, 1)}
                              </span>
                              <span className="environment-name">
                                {environment.name}
                              </span>
                            </button>
                            <span className="environment-row-actions">
                              <button
                                type="button"
                                aria-label={ui.newSessionIn(environment.name)}
                                title={ui.newSession}
                                onClick={() => onNewSession(environment.id)}
                              >
                                <Plus size={14} aria-hidden="true" />
                              </button>
                              {canManage ? (
                                <button
                                  type="button"
                                  aria-label={ui.environmentSettingsFor(
                                    environment.name,
                                  )}
                                  title={ui.environmentSettings}
                                  onClick={() =>
                                    onEnvironmentSettings(environment.id)
                                  }
                                >
                                  <Settings2 size={14} aria-hidden="true" />
                                </button>
                              ) : null}
                            </span>
                          </div>

                          <div className="session-list" id={sessionListId}>
                            {sessionPage.sessions.map((session) => (
                              <div
                                className={`session-row ${
                                  session.id === selectedSessionId
                                    ? "is-selected"
                                    : ""
                                } ${
                                  session.completed ? "is-completed" : ""
                                }`}
                                key={session.id}
                              >
                                <button
                                  className="session-main-button"
                                  type="button"
                                  onClick={() => onSelectSession(session.id)}
                                >
                                  {session.pinned ? (
                                    <Pin
                                      className="session-pinned-icon"
                                      size={10}
                                      aria-label={ui.pinned}
                                    />
                                  ) : null}
                                  <SessionStateIndicator
                                    session={session}
                                    unreadLabel={unreadLabel}
                                    runningLabel={runningLabel}
                                    completedLabel={completedLabel}
                                  />
                                  {session.owner &&
                                  session.owner.id !== viewer.id ? (
                                    <span
                                      className="session-owner-avatar"
                                      title={`Owner: ${session.owner.name}`}
                                      aria-label={`Owner: ${session.owner.name}`}
                                    >
                                      {session.owner.avatarInitials}
                                    </span>
                                  ) : null}
                                  <span className="session-title">
                                    {session.title}
                                  </span>
                                </button>

                                <SessionActionsMenu
                                  language={language}
                                  session={session}
                                  triggerClassName="session-more-button"
                                  sessionForkEnabled={
                                    session.status === "waiting"
                                  }
                                  onForkSession={onForkSession}
                                  onRenameSession={onRenameSession}
                                  onArchiveSession={onArchiveSession}
                                  onTogglePinSession={onTogglePinSession}
                                  onToggleSessionCompleted={
                                    onToggleSessionCompleted
                                  }
                                />
                              </div>
                            ))}
                            {sessionPage.hiddenCount > 0 ||
                            sessionPage.expanded ? (
                              <div className="session-pagination-controls">
                                {sessionPage.expanded ? (
                                  <button
                                    type="button"
                                    className="session-pagination-button"
                                    aria-controls={sessionListId}
                                    aria-label={ui.showFewerSessionsIn(
                                      environment.name,
                                    )}
                                    onClick={() =>
                                      showFewerSessions(environment.id)
                                    }
                                  >
                                    <ChevronUp
                                      size={11}
                                      aria-hidden="true"
                                    />
                                    {ui.showFewerSessions}
                                  </button>
                                ) : null}
                                {sessionPage.hiddenCount > 0 ? (
                                  <button
                                    type="button"
                                    className="session-pagination-button"
                                    aria-controls={sessionListId}
                                    aria-label={ui.showMoreSessionsIn(
                                      sessionPage.nextCount,
                                      environment.name,
                                    )}
                                    onClick={() =>
                                      showMoreSessions(environment.id)
                                    }
                                  >
                                    {ui.showMoreSessions(sessionPage.nextCount)}
                                    <ChevronDown
                                      size={11}
                                      aria-hidden="true"
                                    />
                                  </button>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </>
                      )}
                    </SortableEnvironmentGroup>
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>
        </div>
      </AppSidebar>
      {sessionSearchOpen ? (
        <SessionSearchDialog
          environments={environments}
          sessions={sessions}
          viewerId={viewer.id}
          onClose={() => setSessionSearchOpen(false)}
          onSelect={(sessionId) => {
            setSessionSearchOpen(false);
            onSelectSession(sessionId);
          }}
        />
      ) : null}
    </>
  );
}
