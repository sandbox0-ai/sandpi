"use client";

import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  FilePlus2,
  FolderPlus,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";

import { copyTextToClipboard } from "@/lib/clipboard";
import type { OperationLanguage } from "@/lib/operation-ui";
import {
  isWorkspaceGitMetadataPath,
  isWorkspaceInternalPath,
  WORKSPACE_ROOT,
} from "@/lib/workspace-path-policy";
import type { WorkspaceFile } from "@/lib/types";

import styles from "./workspace-tree-context-menu.module.css";

export interface WorkspaceTreeContextMenuTarget {
  file: WorkspaceFile;
  expanded: boolean;
  anchor: HTMLButtonElement;
  point: {
    x: number;
    y: number;
  };
}

const copy = {
  en: {
    actionsFor: (name: string) => `Actions for ${name}`,
    open: "Open",
    openNewTab: "Open in New Tab",
    download: "Download",
    expand: "Expand Folder",
    collapse: "Collapse Folder",
    refresh: "Refresh Folder",
    newFile: "New File",
    newFolder: "New Folder",
    rename: "Rename",
    delete: "Delete",
    copyPath: "Copy Path",
    copyRelativePath: "Copy Relative Path",
    pathCopied: "Path copied",
    relativePathCopied: "Relative path copied",
    copyFailed: "The browser could not copy the path",
  },
  "zh-CN": {
    actionsFor: (name: string) => `${name} 的操作`,
    open: "打开",
    openNewTab: "在新标签页中打开",
    download: "下载",
    expand: "展开目录",
    collapse: "折叠目录",
    refresh: "刷新目录",
    newFile: "新建文件",
    newFolder: "新建文件夹",
    rename: "重命名",
    delete: "删除",
    copyPath: "复制路径",
    copyRelativePath: "复制相对路径",
    pathCopied: "路径已复制",
    relativePathCopied: "相对路径已复制",
    copyFailed: "浏览器无法复制路径",
  },
} as const;

function relativeWorkspacePath(filePath: string) {
  return filePath === WORKSPACE_ROOT
    ? "."
    : filePath.slice(`${WORKSPACE_ROOT}/`.length);
}

export function WorkspaceTreeContextMenu({
  language,
  target,
  openInNewTabHref,
  onClose,
  onOpenFile,
  onCreateFile,
  onCreateFolder,
  onRenameEntry,
  onDeleteEntry,
  onToggleFolder,
  onRefreshFolder,
  onDownloadFile,
  onAnnounce,
  canMutateEntry,
}: {
  language: OperationLanguage;
  target: WorkspaceTreeContextMenuTarget;
  openInNewTabHref?: string;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (parentPath: string) => void;
  onCreateFolder: (parentPath: string) => void;
  onRenameEntry: (path: string) => void;
  onDeleteEntry: (path: string) => void;
  onToggleFolder: (path: string, expanded: boolean) => void;
  onRefreshFolder: (path: string) => void;
  onDownloadFile: (path: string) => void;
  onAnnounce: (message: string) => void;
  canMutateEntry: boolean;
}) {
  const ui = copy[language];
  const menuRef = useRef<HTMLDivElement>(null);
  const folder = target.file.kind === "folder";
  const canCreateEntries =
    folder &&
    !isWorkspaceInternalPath(target.file.path) &&
    !isWorkspaceGitMetadataPath(target.file.path);
  const canMutate =
    canMutateEntry &&
    target.file.path !== WORKSPACE_ROOT &&
    !isWorkspaceInternalPath(target.file.path) &&
    !isWorkspaceGitMetadataPath(target.file.path);

  const closeMenu = useCallback(
    (restoreFocus = false) => {
      onClose();
      if (restoreFocus) {
        window.requestAnimationFrame(() =>
          target.anchor.focus({ preventScroll: true }),
        );
      }
    },
    [onClose, target.anchor],
  );

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>("[role='menuitem']")
        ?.focus();
    });

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeMenu(true);
    };
    const handleViewportChange = (event: Event) => {
      const eventTarget = event.target;
      if (
        event.type === "scroll" &&
        eventTarget instanceof Node &&
        menuRef.current?.contains(eventTarget)
      ) {
        return;
      }
      closeMenu();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [closeMenu]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    const activeIndex = menuItems.indexOf(document.activeElement as HTMLElement);
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

  const copyPath = async (relative: boolean) => {
    closeMenu(true);
    try {
      await copyTextToClipboard(
        relative
          ? relativeWorkspacePath(target.file.path)
          : target.file.path,
      );
      onAnnounce(relative ? ui.relativePathCopied : ui.pathCopied);
    } catch {
      onAnnounce(ui.copyFailed);
    }
  };

  const menuStyle = {
    "--workspace-menu-x": `${target.point.x}px`,
    "--workspace-menu-y": `${target.point.y}px`,
  } as CSSProperties;

  return createPortal(
    <div
      ref={menuRef}
      className={styles.menu}
      role="menu"
      aria-label={ui.actionsFor(target.file.name)}
      style={menuStyle}
      onKeyDown={handleMenuKeyDown}
    >
      {folder ? (
        <>
          {canCreateEntries ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onCreateFile(target.file.path);
                }}
              >
                <FilePlus2 size={14} aria-hidden="true" />
                {ui.newFile}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onCreateFolder(target.file.path);
                }}
              >
                <FolderPlus size={14} aria-hidden="true" />
                {ui.newFolder}
              </button>
              <span className={styles.separator} role="separator" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onToggleFolder(target.file.path, !target.expanded);
            }}
          >
            {target.expanded ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" />
            )}
            {target.expanded ? ui.collapse : ui.expand}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onRefreshFolder(target.file.path);
            }}
          >
            <RefreshCw size={14} aria-hidden="true" />
            {ui.refresh}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onOpenFile(target.file.path);
            }}
          >
            <File size={14} aria-hidden="true" />
            {ui.open}
          </button>
          {openInNewTabHref ? (
            <a
              href={openInNewTabHref}
              target="_blank"
              rel="noreferrer"
              role="menuitem"
              onClick={() => closeMenu(true)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              {ui.openNewTab}
            </a>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu(true);
              onDownloadFile(target.file.path);
            }}
          >
            <Download size={14} aria-hidden="true" />
            {ui.download}
          </button>
        </>
      )}

      <span className={styles.separator} role="separator" />
      {canMutate ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeMenu();
              onRenameEntry(target.file.path);
            }}
          >
            <Pencil size={14} aria-hidden="true" />
            {ui.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.danger}
            onClick={() => {
              closeMenu();
              onDeleteEntry(target.file.path);
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            {ui.delete}
          </button>
          <span className={styles.separator} role="separator" />
        </>
      ) : null}
      <button
        type="button"
        role="menuitem"
        onClick={() => void copyPath(false)}
      >
        <Copy size={14} aria-hidden="true" />
        {ui.copyPath}
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => void copyPath(true)}
      >
        <Copy size={14} aria-hidden="true" />
        {ui.copyRelativePath}
      </button>
    </div>,
    document.body,
  );
}
