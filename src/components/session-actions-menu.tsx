"use client";

import { Archive, GitFork, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { getOperationUiCopy, type OperationLanguage } from "@/lib/operation-ui";
import type { CodingSession } from "@/lib/types";

interface SessionActionsMenuProps {
  language: OperationLanguage;
  session: CodingSession;
  triggerClassName: string;
  triggerIconSize?: number;
  onForkSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
}

interface MenuPosition {
  top: number;
  left: number;
}

const MENU_WIDTH = 210;
const MENU_HEIGHT = 146;
const VIEWPORT_GAP = 8;

export function SessionActionsMenu({
  language,
  session,
  triggerClassName,
  triggerIconSize = 15,
  onForkSession,
  onRenameSession,
  onArchiveSession,
  onTogglePinSession,
}: SessionActionsMenuProps) {
  const ui = getOperationUiCopy(language).sidebar;
  const renameCopy =
    language === "zh-CN"
      ? { cancel: "取消", input: "会话名称", save: "保存" }
      : { cancel: "Cancel", input: "Session name", save: "Save" };
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const renameInputId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const closeMenu = useCallback(
    (restoreTriggerFocus = false) => {
      setOpen(false);
      setRenaming(false);
      setRenameDraft(session.title);
      setPosition(null);

      if (restoreTriggerFocus) {
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }
    },
    [session.title],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !menuRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        closeMenu();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      closeMenu(true);
    };

    const handleViewportChange = () => closeMenu();

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const animationFrame = window.requestAnimationFrame(() => {
      if (renaming) {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
        return;
      }

      menuRef.current
        ?.querySelector<HTMLButtonElement>("[role='menuitem']")
        ?.focus();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [open, renaming]);

  const openMenu = () => {
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    if (!triggerRect) {
      return;
    }

    const top =
      triggerRect.bottom + 4 + MENU_HEIGHT <= window.innerHeight - VIEWPORT_GAP
        ? triggerRect.bottom + 4
        : triggerRect.top - MENU_HEIGHT - 4;

    setRenameDraft(session.title);
    setRenaming(false);
    setPosition({
      top: Math.max(VIEWPORT_GAP, top),
      left: Math.min(
        Math.max(VIEWPORT_GAP, triggerRect.right - MENU_WIDTH),
        window.innerWidth - MENU_WIDTH - VIEWPORT_GAP,
      ),
    });
    setOpen(true);
  };

  const runAndClose = (action: (sessionId: string) => void) => {
    closeMenu();
    action(session.id);
  };

  const saveRename = () => {
    const title = renameDraft.trim();
    if (!title) {
      return;
    }

    closeMenu(true);
    if (title !== session.title) {
      onRenameSession(session.id, title);
    }
  };

  const cancelRename = () => {
    setRenaming(false);
    setRenameDraft(session.title);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renaming) {
      return;
    }

    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']"),
    );
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown") {
      nextIndex = activeIndex < menuItems.length - 1 ? activeIndex + 1 : 0;
    } else if (event.key === "ArrowUp") {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : menuItems.length - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        className={`${triggerClassName} ${open ? "is-active" : ""}`}
        type="button"
        aria-label={ui.sessionActions(session.title)}
        aria-haspopup={renaming ? "dialog" : "menu"}
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <MoreHorizontal size={triggerIconSize} aria-hidden="true" />
      </button>

      {open && position ? (
        <div
          className="session-action-menu"
          ref={menuRef}
          role={renaming ? "dialog" : "menu"}
          aria-label={
            renaming ? ui.renameSession(session.title) : ui.actionsFor(session.title)
          }
          style={position}
          onKeyDown={handleMenuKeyDown}
        >
          {renaming ? (
            <form
              className="session-action-rename"
              onSubmit={(event) => {
                event.preventDefault();
                saveRename();
              }}
            >
              <label htmlFor={renameInputId}>{renameCopy.input}</label>
              <input
                id={renameInputId}
                ref={renameInputRef}
                name="session-title"
                autoComplete="off"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
              <div className="session-action-rename-buttons">
                <button type="button" onClick={cancelRename}>
                  {renameCopy.cancel}
                </button>
                <button
                  className="is-primary"
                  type="submit"
                  disabled={!renameDraft.trim()}
                >
                  {renameCopy.save}
                </button>
              </div>
            </form>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onForkSession)}
              >
                <GitFork size={14} aria-hidden="true" />
                {ui.forkSession}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onTogglePinSession)}
              >
                {session.pinned ? (
                  <PinOff size={14} aria-hidden="true" />
                ) : (
                  <Pin size={14} aria-hidden="true" />
                )}
                {session.pinned ? ui.unpin : ui.pin}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setRenameDraft(session.title);
                  setRenaming(true);
                }}
              >
                <Pencil size={14} aria-hidden="true" />
                {ui.rename}
              </button>
              <button
                className="is-destructive"
                type="button"
                role="menuitem"
                onClick={() => runAndClose(onArchiveSession)}
              >
                <Archive size={14} aria-hidden="true" />
                {ui.archive}
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
