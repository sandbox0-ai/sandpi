"use client";

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
  GripVertical,
  PanelLeftClose,
  Plus,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { AppSidebar } from "@/components/app-frame";
import { SidebarAccountFooter } from "@/components/sidebar-account-footer";
import {
  moveEnvironment,
  moveEnvironmentByOffset,
} from "@/lib/environment-order";
import type { OperationLanguage } from "@/lib/operation-ui";
import type { Environment, SandpiUser } from "@/lib/types";

import styles from "./environment-sidebar.module.css";

interface EnvironmentSidebarProps {
  language: OperationLanguage;
  timeZone: string;
  viewer: SandpiUser;
  environments: Environment[];
  selectedEnvironmentId: string;
  onSelectEnvironment: (environmentId: string) => void;
  onNewEnvironment: () => void;
  onEnvironmentSettings: (environmentId: string) => void;
  onReorderEnvironments: (environments: Environment[]) => void;
  onCollapse: () => void;
  onCloseMobile: () => void;
}

type SortableActivator = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners"
>;

const DRAG_CLICK_SUPPRESSION_MS = 350;

function SortableEnvironment({
  environmentId,
  children,
}: {
  environmentId: string;
  children: (activator: SortableActivator) => ReactNode;
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
    <li
      ref={setNodeRef}
      className={`${styles.item} ${isDragging ? styles.dragging : ""} ${
        isOver && !isDragging ? styles.dropTarget : ""
      }`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({ attributes, listeners })}
    </li>
  );
}

function environmentState(environment: Environment) {
  if (environment.status === "updating") return "PROVISIONING";
  if (environment.status === "error") return "ERROR";
  return environment.sandboxState.toUpperCase();
}

export function EnvironmentSidebar({
  language,
  timeZone,
  viewer,
  environments,
  selectedEnvironmentId,
  onSelectEnvironment,
  onNewEnvironment,
  onEnvironmentSettings,
  onReorderEnvironments,
  onCollapse,
  onCloseMobile,
}: EnvironmentSidebarProps) {
  const [draggedId, setDraggedId] = useState("");
  const suppressedClick = useRef({ environmentId: "", until: 0 });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
  );

  const reorderByOffset = (environmentId: string, offset: -1 | 1) => {
    const reordered = moveEnvironmentByOffset(
      environments,
      environmentId,
      offset,
    );
    if (reordered !== environments) onReorderEnvironments(reordered);
  };
  const finishDrag = (environmentId: string) => {
    suppressedClick.current = {
      environmentId,
      until: Date.now() + DRAG_CLICK_SUPPRESSION_MS,
    };
    setDraggedId("");
  };
  const select = (environmentId: string) => {
    if (
      suppressedClick.current.environmentId === environmentId &&
      Date.now() < suppressedClick.current.until
    ) {
      suppressedClick.current = { environmentId: "", until: 0 };
      return;
    }
    onSelectEnvironment(environmentId);
  };

  return (
    <AppSidebar
      className={`sidebar ${styles.sidebar}`}
      label={language === "zh-CN" ? "环境导航" : "Environment navigation"}
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
            className={`icon-button sidebar-collapse-button ${styles.headerButton}`}
            type="button"
            aria-label={language === "zh-CN" ? "收起导航" : "Collapse navigation"}
            onClick={onCollapse}
          >
            <PanelLeftClose size={17} aria-hidden="true" />
          </button>
          <button
            className={`icon-button sidebar-close-button ${styles.headerButton}`}
            type="button"
            aria-label={language === "zh-CN" ? "关闭导航" : "Close navigation"}
            onClick={onCloseMobile}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </>
      }
    >
      <div className={styles.releaseLine} aria-label="Sandpi version">
        <TerminalSquare size={14} aria-hidden="true" />
        <span>SANDPI://V2</span>
        <span className={styles.live}>NATIVE_TUI</span>
      </div>

      <button
        className={styles.newButton}
        type="button"
        onClick={onNewEnvironment}
      >
        <Plus size={15} aria-hidden="true" />
        [NEW ENVIRONMENT]
      </button>

      <div className={styles.heading}>
        <span>ENVIRONMENTS</span>
        <span>{String(environments.length).padStart(2, "0")}</span>
      </div>

      <div className={styles.scrollRegion}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={({ active }) => {
            window.getSelection()?.removeAllRanges();
            setDraggedId(String(active.id));
          }}
          onDragCancel={({ active }) => finishDrag(String(active.id))}
          onDragEnd={({ active, over }) => {
            const sourceId = String(active.id);
            finishDrag(sourceId);
            if (!over) return;
            const reordered = moveEnvironment(
              environments,
              sourceId,
              String(over.id),
            );
            if (reordered !== environments) onReorderEnvironments(reordered);
          }}
        >
          <SortableContext
            items={environments.map(({ id }) => id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className={`${styles.list} ${draggedId ? styles.reordering : ""}`}
            >
              {environments.map((environment) => {
                const selected = environment.id === selectedEnvironmentId;
                const canManage = environment.ownerId === viewer.id;
                const state = environmentState(environment);
                return (
                  <SortableEnvironment
                    key={environment.id}
                    environmentId={environment.id}
                  >
                    {({ attributes, listeners }) => (
                      <div
                        className={`${styles.row} ${selected ? styles.selected : ""}`}
                      >
                        <button
                          {...attributes}
                          {...listeners}
                          className={styles.dragHandle}
                          type="button"
                          aria-label={`Move ${environment.name}`}
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
                          <GripVertical size={13} aria-hidden="true" />
                        </button>
                        <button
                          {...attributes}
                          {...listeners}
                          className={styles.environmentButton}
                          type="button"
                          aria-current={selected ? "page" : undefined}
                          onClick={() => select(environment.id)}
                        >
                          <span
                            className={`${styles.stateDot} ${
                              state === "RUNNING"
                                ? styles.running
                                : state === "ERROR" || state === "FAILED"
                                  ? styles.error
                                  : styles.idle
                            }`}
                            aria-hidden="true"
                          />
                          <span className={styles.environmentIdentity}>
                            <strong>{environment.name}</strong>
                            <small>
                              {environment.codingAgent.harness} / {state}
                            </small>
                          </span>
                        </button>
                        {canManage ? (
                          <button
                            className={styles.settingsButton}
                            type="button"
                            aria-label={`Settings for ${environment.name}`}
                            onClick={() => onEnvironmentSettings(environment.id)}
                          >
                            <Settings2 size={14} aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
                    )}
                  </SortableEnvironment>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
    </AppSidebar>
  );
}
