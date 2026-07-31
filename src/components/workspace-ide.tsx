"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Check,
  CircleAlert,
  ExternalLink,
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Eye,
  Pencil,
  Radio,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ApiError,
  apiFetch,
  apiWebSocketUrl,
  type ApiEnvelope,
} from "@/lib/api-client";
import { updateLocalUiPreferences } from "@/lib/local-ui-preferences";
import type { OperationLanguage } from "@/lib/operation-ui";
import { formatUnixTimestamp } from "@/lib/time";
import { useLocalUiPreferences } from "@/lib/use-local-ui-preferences";
import {
  mergeWorkspaceGitFiles,
  userVisibleWorkspaceFiles,
} from "@/lib/workspace-files";
import {
  repositoryForWorkspacePath,
  userVisibleWorkspaceGitState,
  workspaceGitChanges,
  workspaceRepositoryLabel,
} from "@/lib/workspace-git";
import {
  userVisibleWorkspacePath,
  workspaceFileParentDirectories,
  WORKSPACE_ROOT,
} from "@/lib/workspace-path-policy";
import { workspacePreviewKindForName } from "@/lib/workspace-file-preview";
import {
  clampFileBrowserSidebarWidthForAvailableWidth,
  DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
  fileBrowserSidebarWidthFromPointer,
  MAX_FILE_BROWSER_SIDEBAR_WIDTH,
  MIN_FILE_BROWSER_SIDEBAR_WIDTH,
  normalizeFileBrowserSidebarWidth,
} from "@/lib/workspace-layout";
import type {
  CodingSession,
  Environment,
  WorkspaceDirectoryListing,
  WorkspaceFile,
  WorkspaceGitFileChange,
  WorkspaceGitState,
  WorkspaceGitRepository,
  WorkspaceIdeCreateEntryRequest,
  WorkspaceIdeEvent,
  WorkspaceIdeFile,
  WorkspaceIdeRenameEntryRequest,
  WorkspaceIdeSnapshot,
  WorkspaceIdeWatchSubscription,
  WorkspaceIdeWriteRequest,
} from "@/lib/types";

import { useAlertDialog } from "./alert-dialog";
import { WorkspaceImagePreview } from "./workspace-image-preview";
import {
  WorkspaceTreeContextMenu,
  type WorkspaceTreeContextMenuTarget,
} from "./workspace-tree-context-menu";
import styles from "./workspace-ide.module.css";

export interface WorkspaceFileNavigationRequest {
  environmentId: string;
  path: string;
  requestId: number;
}

interface WorkspaceIdeProps {
  language: OperationLanguage;
  timeZone: string;
  environment: Environment;
  /** Optional navigation context; Workspace ownership belongs to Environment. */
  session?: CodingSession;
  variant: "embedded" | "standalone";
  initialSnapshot?: WorkspaceIdeSnapshot;
  navigationRequest?: WorkspaceFileNavigationRequest;
  onNavigationHandled?: (request: WorkspaceFileNavigationRequest) => void;
}

interface DocumentState {
  data?: WorkspaceIdeFile;
  draft?: string;
  loading: boolean;
  saving?: boolean;
  dirty?: boolean;
  conflict?: WorkspaceIdeFile;
  comparing?: boolean;
  error?: string;
}

interface WorkspaceClientCacheEntry {
  accessedAt: number;
  snapshot?: WorkspaceIdeSnapshot;
  directoryListings: WorkspaceDirectoryListings;
  documents: Record<string, DocumentState>;
  openPaths: string[];
  selectedPath: string;
}

interface SharedWorkspaceRequest {
  controller: AbortController;
  consumers: Set<symbol>;
  settled: boolean;
  abortTimer?: ReturnType<typeof setTimeout>;
  promise: Promise<unknown>;
}

const WORKSPACE_CLIENT_CACHE_TTL_MS = 15 * 60 * 1_000;
const WORKSPACE_CLIENT_CACHE_MAX_ENVIRONMENTS = 8;
const workspaceClientCache = new Map<string, WorkspaceClientCacheEntry>();
const sharedWorkspaceRequests = new Map<string, SharedWorkspaceRequest>();

function workspaceClientCacheKey(environment: Environment) {
  return [
    environment.id,
    environment.sandboxId,
    environment.workspaceVolumeId,
  ].join(":");
}

function readWorkspaceClientCache(key: string) {
  const cached = workspaceClientCache.get(key);
  if (!cached) return undefined;
  if (cached.accessedAt + WORKSPACE_CLIENT_CACHE_TTL_MS < Date.now()) {
    workspaceClientCache.delete(key);
    return undefined;
  }
  cached.accessedAt = Date.now();
  workspaceClientCache.delete(key);
  workspaceClientCache.set(key, cached);
  return cached;
}

function writeWorkspaceClientCache(
  key: string,
  value: Omit<WorkspaceClientCacheEntry, "accessedAt">,
) {
  workspaceClientCache.delete(key);
  workspaceClientCache.set(key, { ...value, accessedAt: Date.now() });
  while (workspaceClientCache.size > WORKSPACE_CLIENT_CACHE_MAX_ENVIRONMENTS) {
    const disposable = [...workspaceClientCache].find(([, candidate]) =>
      Object.values(candidate.documents).every((document) => !document.dirty),
    );
    if (!disposable) break;
    workspaceClientCache.delete(disposable[0]);
  }
}

function acquireSharedWorkspaceRequest<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  let request = sharedWorkspaceRequests.get(key);
  if (!request) {
    const controller = new AbortController();
    const created: SharedWorkspaceRequest = {
      controller,
      consumers: new Set(),
      settled: false,
      promise: Promise.resolve(),
    };
    created.promise = load(controller.signal).finally(() => {
      created.settled = true;
      if (sharedWorkspaceRequests.get(key) === created) {
        sharedWorkspaceRequests.delete(key);
      }
    });
    request = created;
    sharedWorkspaceRequests.set(key, request);
  }
  if (request.abortTimer) {
    clearTimeout(request.abortTimer);
    request.abortTimer = undefined;
  }
  const consumer = Symbol(key);
  request.consumers.add(consumer);
  let released = false;
  return {
    promise: request.promise as Promise<T>,
    release() {
      if (released) return;
      released = true;
      request?.consumers.delete(consumer);
      if (!request?.settled && request?.consumers.size === 0) {
        const releasedRequest = request;
        releasedRequest.abortTimer = setTimeout(() => {
          releasedRequest.abortTimer = undefined;
          if (
            releasedRequest.settled ||
            releasedRequest.consumers.size > 0
          ) {
            return;
          }
          releasedRequest.controller.abort();
          if (sharedWorkspaceRequests.get(key) === releasedRequest) {
            sharedWorkspaceRequests.delete(key);
          }
        }, 0);
      }
    },
  };
}

async function trackedSharedWorkspaceRequest<T>(
  releases: Set<() => void>,
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const request = acquireSharedWorkspaceRequest(key, load);
  releases.add(request.release);
  try {
    return await request.promise;
  } finally {
    releases.delete(request.release);
    request.release();
  }
}

const loadWorkspaceCodeEditorModule = () => import("./workspace-code-editor");

const WorkspaceCodeEditor = dynamic(
  () =>
    loadWorkspaceCodeEditorModule().then(
      (module) => module.WorkspaceCodeEditor,
    ),
  { ssr: false, loading: () => <span>Loading editor…</span> },
);
const WorkspaceConflictDiff = dynamic(
  () =>
    loadWorkspaceCodeEditorModule().then(
      (module) => module.WorkspaceConflictDiff,
    ),
  { ssr: false, loading: () => <span>Loading comparison…</span> },
);

const copy = {
  en: {
    changes: (count: number) => `${count} uncommitted ${count === 1 ? "file" : "files"}`,
    clean: "Working tree clean",
    noRepository: "No Git repositories in this Workspace",
    repositories: (count: number) => `${count} Git repositories`,
    noFiles: "No files in /workspace",
    live: "Live",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    polling: "Polling",
    offline: "Disconnected",
    refresh: "Refresh Workspace",
    files: "Files",
    collapseFileBrowser: "Collapse file browser",
    expandFileBrowser: "Expand file browser",
    resizeFileBrowser: "Resize file browser",
    resizeFileBrowserValue: (width: number) => `${width} pixels wide`,
    resizeFileBrowserHelp:
      "Drag to resize. Use Left and Right Arrow keys. Double-click to reset.",
    openFull: "Open full Web IDE",
    back: "Back to Session",
    backEnvironment: "Back to Environment",
    binary: "Binary files cannot be rendered as text.",
    previewOnly: "Read-only preview",
    previewMode: "Preview only",
    editMode: "Edit file",
    previewUnavailable: "Your browser cannot preview this media format.",
    downloadPreview: "Download file",
    downloadFailed: "File could not be downloaded.",
    previewLabel: (kind: string, name: string) =>
      `${kind === "pdf" ? "PDF" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`} preview: ${name}`,
    deletedFile: "Deleted files are read-only. Restore them from Git before editing.",
    managedFile: "Sandpi-managed files are read-only in the Web IDE.",
    save: "Save file (⌘/Ctrl+S)",
    saved: "Saved",
    saving: "Saving…",
    unsaved: "Unsaved changes",
    saveBlocked: "The coding agent is working. Your draft is safe; save after this Turn finishes.",
    externalChange: "This file changed outside the editor.",
    compare: "Compare",
    hideCompare: "Hide comparison",
    useLatest: "Use latest",
    overwrite: "Overwrite with mine",
    discardCloseTitle: "Discard changes?",
    discardClose: "Closing this file will discard its unsaved changes.",
    discardCloseAction: "Discard & close",
    reloadDiscardTitle: "Reload Workspace?",
    reloadDiscard: "Unsaved changes in open files will be discarded.",
    reloadDiscardAction: "Discard & reload",
    keepEditing: "Keep editing",
    cancel: "Cancel",
    loading: "Loading Workspace…",
    loadingFolder: "Loading folder…",
    folderUnavailable: "Folder unavailable. Click to retry.",
    newFileName: (parentPath: string) => `New file in ${parentPath}`,
    newFolderName: (parentPath: string) => `New folder in ${parentPath}`,
    fileNamePlaceholder: "File name",
    folderNamePlaceholder: "Folder name",
    entryNameRequired: "Enter a name.",
    entryNameInvalid: "Names cannot be . or .. or contain slashes.",
    entryExists: (name: string) => `“${name}” already exists in this folder.`,
    entryCreateFailed: "The Workspace entry could not be created.",
    renameEntryName: (path: string) => `Rename ${path}`,
    entryRenameFailed: "The Workspace entry could not be renamed.",
    entryRenamed: (name: string) => `Renamed to ${name}`,
    entryDeleted: (name: string) => `${name} deleted`,
    deleteTitle: (name: string) => `Delete “${name}”?`,
    deleteConfirm: (kind: "file" | "folder", dirtyCount: number) =>
      `${kind === "folder" ? "Everything inside this folder will also be deleted." : "This file will be deleted."}${
        dirtyCount > 0
          ? ` ${dirtyCount} open ${dirtyCount === 1 ? "file has" : "files have"} unsaved changes.`
          : ""
      } This cannot be undone.`,
    deleteAction: (kind: "file" | "folder") =>
      kind === "folder" ? "Delete folder" : "Delete file",
    deleteFailed: "The Workspace entry could not be deleted.",
    selectFile: "Select a file from workspace.",
    staged: "staged",
    unstaged: "working tree",
  },
  "zh-CN": {
    changes: (count: number) => `${count} 个未提交文件`,
    clean: "工作区干净",
    noRepository: "此 Workspace 中没有 Git 仓库",
    repositories: (count: number) => `${count} 个 Git 仓库`,
    noFiles: "/workspace 中没有文件",
    live: "实时",
    connecting: "正在连接",
    reconnecting: "正在重连",
    polling: "轮询更新",
    offline: "已断开",
    refresh: "刷新 Workspace",
    files: "文件",
    collapseFileBrowser: "折叠文件浏览器",
    expandFileBrowser: "展开文件浏览器",
    resizeFileBrowser: "调整文件浏览器宽度",
    resizeFileBrowserValue: (width: number) => `宽 ${width} 像素`,
    resizeFileBrowserHelp:
      "拖拽调整宽度；也可以使用左右方向键，双击恢复默认宽度。",
    openFull: "在完整 Web IDE 中打开",
    back: "返回 Session",
    backEnvironment: "返回 Environment",
    binary: "二进制文件无法按文本显示。",
    previewOnly: "只读预览",
    previewMode: "仅预览",
    editMode: "编辑文件",
    previewUnavailable: "当前浏览器无法预览此媒体格式。",
    downloadPreview: "下载文件",
    downloadFailed: "文件无法下载。",
    previewLabel: (kind: string, name: string) => `${name} ${kind}预览`,
    deletedFile: "已删除文件为只读；请先通过 Git 恢复后再编辑。",
    managedFile: "Sandpi 管理的文件在 Web IDE 中为只读。",
    save: "保存文件（⌘/Ctrl+S）",
    saved: "已保存",
    saving: "正在保存…",
    unsaved: "有未保存修改",
    saveBlocked: "Coding Agent 正在工作。草稿仍会保留，请在本轮结束后保存。",
    externalChange: "此文件已在编辑器外发生变化。",
    compare: "比较",
    hideCompare: "隐藏比较",
    useLatest: "使用最新版本",
    overwrite: "用我的版本覆盖",
    discardCloseTitle: "放弃修改？",
    discardClose: "关闭此文件将丢失其中尚未保存的修改。",
    discardCloseAction: "放弃并关闭",
    reloadDiscardTitle: "刷新 Workspace？",
    reloadDiscard: "已打开文件中尚未保存的修改将会丢失。",
    reloadDiscardAction: "放弃并刷新",
    keepEditing: "继续编辑",
    cancel: "取消",
    loading: "正在加载 Workspace…",
    loadingFolder: "正在加载文件夹…",
    folderUnavailable: "文件夹暂时不可用，点击重试。",
    newFileName: (parentPath: string) => `在 ${parentPath} 中新建文件`,
    newFolderName: (parentPath: string) => `在 ${parentPath} 中新建文件夹`,
    fileNamePlaceholder: "文件名",
    folderNamePlaceholder: "文件夹名",
    entryNameRequired: "请输入名称。",
    entryNameInvalid: "名称不能是 . 或 ..，也不能包含斜杠。",
    entryExists: (name: string) => `此文件夹中已存在“${name}”。`,
    entryCreateFailed: "无法创建 Workspace 条目。",
    renameEntryName: (path: string) => `重命名 ${path}`,
    entryRenameFailed: "无法重命名 Workspace 条目。",
    entryRenamed: (name: string) => `已重命名为 ${name}`,
    entryDeleted: (name: string) => `已删除 ${name}`,
    deleteTitle: (name: string) => `删除“${name}”？`,
    deleteConfirm: (kind: "file" | "folder", dirtyCount: number) =>
      `${kind === "folder" ? "此文件夹中的所有内容也将一并删除。" : "此文件将被删除。"}${
        dirtyCount > 0
          ? ` 其中 ${dirtyCount} 个已打开文件有未保存修改。`
          : ""
      }此操作无法撤销。`,
    deleteAction: (kind: "file" | "folder") =>
      kind === "folder" ? "删除文件夹" : "删除文件",
    deleteFailed: "无法删除 Workspace 条目。",
    selectFile: "从 workspace 中选择文件。",
    staged: "已暂存",
    unstaged: "工作区",
  },
} as const;

function workspacePathAtOrBelow(candidate: string, root: string) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function replaceWorkspacePathPrefix(
  candidate: string,
  source: string,
  destination: string,
) {
  return workspacePathAtOrBelow(candidate, source)
    ? `${destination}${candidate.slice(source.length)}`
    : candidate;
}

function workspaceParentPath(filePath: string) {
  const separator = filePath.lastIndexOf("/");
  return separator <= WORKSPACE_ROOT.length
    ? WORKSPACE_ROOT
    : filePath.slice(0, separator);
}

function remapWorkspaceIdeFile(
  file: WorkspaceIdeFile,
  sourcePath: string,
  destinationPath: string,
): WorkspaceIdeFile {
  const nextPath = replaceWorkspacePathPrefix(
    file.path,
    sourcePath,
    destinationPath,
  );
  return {
    ...file,
    path: nextPath,
    name: nextPath.split("/").at(-1) ?? file.name,
    git: file.git
      ? {
          ...file.git,
          path: replaceWorkspacePathPrefix(
            file.git.path,
            sourcePath,
            destinationPath,
          ),
          originalPath: file.git.originalPath
            ? replaceWorkspacePathPrefix(
                file.git.originalPath,
                sourcePath,
                destinationPath,
              )
            : undefined,
        }
      : undefined,
  };
}

type WorkspaceDirectoryListings = Record<string, WorkspaceFile[]>;

function shallowVisibleEntries(files: WorkspaceFile[]) {
  return userVisibleWorkspaceFiles(files).map((file) => {
    const entry = { ...file };
    delete entry.children;
    return entry;
  });
}

function rootEntries(snapshot?: WorkspaceIdeSnapshot) {
  const root = snapshot?.files.find((file) => file.path === "/workspace");
  return shallowVisibleEntries(root?.children ?? []);
}

function snapshotFromRootListing(
  listing: WorkspaceDirectoryListing,
  git: WorkspaceGitState,
): WorkspaceIdeSnapshot {
  return {
    files: [
      {
        id: "workspace",
        name: "workspace",
        path: WORKSPACE_ROOT,
        kind: "folder",
        children: shallowVisibleEntries(listing.entries),
      },
    ],
    git,
    refreshedAt: listing.refreshedAt,
  };
}

function isAbortError(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "AbortError"
  );
}

function workspaceTreeFromListings(
  listings: WorkspaceDirectoryListings,
): WorkspaceFile[] {
  const hydrate = (
    entries: WorkspaceFile[],
    ancestors: ReadonlySet<string>,
  ): WorkspaceFile[] =>
    entries.map((entry) => {
      const file = { ...entry };
      delete file.children;
      if (
        file.kind === "folder" &&
        Object.hasOwn(listings, file.path) &&
        !ancestors.has(file.path)
      ) {
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(file.path);
        file.children = hydrate(listings[file.path] ?? [], nextAncestors);
      }
      return file;
    });

  return [
    {
      id: "workspace",
      name: "workspace",
      path: "/workspace",
      kind: "folder",
      children: hydrate(listings["/workspace"] ?? [], new Set(["/workspace"])),
    },
  ];
}

function fileIcon(fileName: string, folder = false, open = false) {
  if (folder) return open ? <FolderOpen size={14} /> : <Folder size={14} />;
  const previewKind = workspacePreviewKindForName(fileName);
  if (previewKind === "audio") return <FileAudio size={14} />;
  if (previewKind === "image") return <FileImage size={14} />;
  if (previewKind === "video") return <FileVideo size={14} />;
  if (previewKind === "pdf") return <FileText size={14} />;
  if (fileName.endsWith(".json")) return <FileJson size={14} />;
  if (fileName.endsWith(".md") || fileName.endsWith(".mdx")) {
    return <FileText size={14} />;
  }
  if (/\.(?:[cm]?[jt]sx?|go|rs|py|java|kt|swift|css|html|ya?ml)$/.test(fileName)) {
    return <FileCode2 size={14} />;
  }
  return <File size={14} />;
}

function languageLabel(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return (
    {
      ts: "TypeScript",
      tsx: "TypeScript React",
      js: "JavaScript",
      jsx: "JavaScript React",
      json: "JSON",
      md: "Markdown",
      mdx: "MDX",
      css: "CSS",
      html: "HTML",
      go: "Go",
      rs: "Rust",
      py: "Python",
      sh: "Shell",
      yaml: "YAML",
      yml: "YAML",
      toml: "TOML",
      sql: "SQL",
    }[extension ?? ""] ?? "Plain text"
  );
}

function workspaceFileTypeLabel(file: WorkspaceIdeFile) {
  if (!file.preview) return languageLabel(file.name);
  return (
    {
      "application/pdf": "PDF",
      "audio/aac": "AAC audio",
      "audio/aiff": "AIFF audio",
      "audio/flac": "FLAC audio",
      "audio/midi": "MIDI audio",
      "audio/mp4": "MPEG-4 audio",
      "audio/mpeg": "MP3 audio",
      "audio/ogg": "Ogg audio",
      "audio/wav": "WAV audio",
      "audio/webm": "WebM audio",
      "image/avif": "AVIF image",
      "image/bmp": "BMP image",
      "image/gif": "GIF image",
      "image/jpeg": "JPEG image",
      "image/png": "PNG image",
      "image/webp": "WebP image",
      "image/x-icon": "Icon image",
      "video/mp4": "MPEG-4 video",
      "video/ogg": "Ogg video",
      "video/quicktime": "QuickTime video",
      "video/webm": "WebM video",
    }[file.preview.mimeType] ?? `${file.preview.kind} preview`
  );
}

function monacoLanguage(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      md: "markdown",
      mdx: "markdown",
      css: "css",
      scss: "scss",
      less: "less",
      html: "html",
      go: "go",
      rs: "rust",
      py: "python",
      sh: "shell",
      bash: "shell",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      sql: "sql",
      java: "java",
      kt: "kotlin",
      swift: "swift",
    }[extension ?? ""] ?? "plaintext"
  );
}

function statusCode(change: WorkspaceGitFileChange) {
  return {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
    copied: "C",
    untracked: "U",
    conflicted: "!",
  }[change.kind];
}

function decodeBase64(content: string) {
  return new TextDecoder().decode(decodeBase64Bytes(content));
}

function decodeBase64Bytes(content: string) {
  const raw = window.atob(content);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function encodeBase64(content: string, bom?: "utf8") {
  const encoded = new TextEncoder().encode(content);
  let bytes = encoded;
  if (bom === "utf8") {
    bytes = new Uint8Array(encoded.byteLength + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(encoded, 3);
  }
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return window.btoa(binary);
}

function useWorkspacePreviewUrl(file: WorkspaceIdeFile) {
  const [source, setSource] = useState<string>();
  const mimeType = file.preview?.mimeType;

  useEffect(() => {
    if (!mimeType) return;
    const objectUrl = URL.createObjectURL(
      new Blob([decodeBase64Bytes(file.content)], { type: mimeType }),
    );
    setSource(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file.content, mimeType]);

  return source;
}

function WorkspaceFileMediaPreview({
  file,
  language,
}: {
  file: WorkspaceIdeFile;
  language: OperationLanguage;
}) {
  const source = useWorkspacePreviewUrl(file);
  const preview = file.preview;
  if (!preview) return null;
  const ui = copy[language];
  const label = ui.previewLabel(preview.kind, file.name);
  if (!source) {
    return (
      <div className={styles.loading} role="status">
        <RefreshCw size={17} /> {ui.loading}
      </div>
    );
  }

  if (preview.kind === "image") {
    return (
      <div className={`${styles.filePreview} ${styles.imagePreview}`}>
        <WorkspaceImagePreview
          key={`${file.path}:${file.revision}`}
          source={source}
          name={file.name}
          alt={label}
          language={language}
        />
      </div>
    );
  }
  if (preview.kind === "audio") {
    return (
      <div className={`${styles.filePreview} ${styles.audioPreview}`}>
        <div className={styles.audioIdentity}>
          <FileAudio size={30} aria-hidden="true" />
          <strong>{file.name}</strong>
          <span>{workspaceFileTypeLabel(file)}</span>
        </div>
        <audio aria-label={label} controls preload="metadata" src={source}>
          {ui.previewUnavailable}
        </audio>
      </div>
    );
  }
  if (preview.kind === "video") {
    return (
      <div className={`${styles.filePreview} ${styles.videoPreview}`}>
        <video aria-label={label} controls preload="metadata" src={source}>
          {ui.previewUnavailable}
        </video>
      </div>
    );
  }
  return (
    <div className={`${styles.filePreview} ${styles.pdfPreview}`}>
      <object aria-label={label} data={source} type={preview.mimeType}>
        <p>
          {ui.previewUnavailable}{" "}
          <a href={source} download={file.name}>
            {ui.downloadPreview}
          </a>
        </p>
      </object>
    </div>
  );
}

export function workspaceIdeHref(
  environmentId: string,
  sessionId?: string,
  filePath?: string,
) {
  const search = new URLSearchParams({
    environment: environmentId,
  });
  if (sessionId) search.set("session", sessionId);
  const visibleFilePath = filePath
    ? userVisibleWorkspacePath(filePath)
    : undefined;
  if (visibleFilePath) search.set("path", visibleFilePath);
  return `/ide/?${search.toString()}`;
}

function environmentHref(environmentId: string, sessionId?: string) {
  const search = new URLSearchParams({
    environment: environmentId,
  });
  if (sessionId) search.set("session", sessionId);
  return `/?${search.toString()}`;
}

function WorkspaceTreeNameForm({
  language,
  mode,
  path,
  kind,
  depth,
  initialName = "",
  existingNames,
  onSubmit,
  onCancel,
}: {
  language: OperationLanguage;
  mode: "create" | "rename";
  path: string;
  kind: "file" | "folder";
  depth: number;
  initialName?: string;
  existingNames: ReadonlySet<string>;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const ui = copy[language];
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      if (mode === "rename") {
        const extensionIndex =
          kind === "file" ? initialName.lastIndexOf(".") : -1;
        input.setSelectionRange(
          0,
          extensionIndex > 0 ? extensionIndex : initialName.length,
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialName, kind, mode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(ui.entryNameRequired);
      return;
    }
    if (
      normalizedName === "." ||
      normalizedName === ".." ||
      /[/\u0000-\u001f\u007f]/.test(normalizedName)
    ) {
      setError(ui.entryNameInvalid);
      return;
    }
    if (mode === "rename" && normalizedName === initialName) {
      onCancel();
      return;
    }
    if (existingNames.has(normalizedName)) {
      setError(ui.entryExists(normalizedName));
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      await onSubmit(normalizedName);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : mode === "create"
            ? ui.entryCreateFailed
            : ui.entryRenameFailed,
      );
      setSubmitting(false);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  const inputLabel =
    mode === "rename"
      ? ui.renameEntryName(path)
      : kind === "file"
        ? ui.newFileName(path)
        : ui.newFolderName(path);

  return (
    <form
      className={styles.treeNameForm}
      style={{ paddingLeft: `${7 + depth * 13}px` }}
      aria-label={inputLabel}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || submitting) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <span className={styles.disclosure} />
      <span className={styles.fileIcon}>
        {submitting ? (
          <RefreshCw
            size={12}
            className={styles.directorySpinner}
            aria-hidden="true"
          />
        ) : kind === "file" ? (
          <File size={13} aria-hidden="true" />
        ) : (
          <Folder size={13} aria-hidden="true" />
        )}
      </span>
      <input
        ref={inputRef}
        type="text"
        name="workspace-entry-name"
        autoComplete="off"
        spellCheck={false}
        maxLength={255}
        value={name}
        placeholder={
          kind === "file" ? ui.fileNamePlaceholder : ui.folderNamePlaceholder
        }
        aria-label={inputLabel}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        disabled={submitting}
        onChange={(event) => {
          setName(event.currentTarget.value);
          if (error) setError("");
        }}
      />
      {error ? (
        <span id={errorId} className={styles.treeNameError} role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

function IdeFileTree({
  language,
  environmentId,
  sessionId,
  files,
  changes,
  repositories,
  selectedPath,
  revealRequest,
  onOpen,
  loadedDirectories,
  loadingDirectories,
  directoryErrors,
  onExpand,
  loadingFolderLabel,
  folderUnavailableLabel,
  onDownloadFile,
  onCreateEntry,
  onRenameEntry,
  onDeleteEntry,
}: {
  language: OperationLanguage;
  environmentId: string;
  sessionId?: string;
  files: WorkspaceFile[];
  changes: Map<string, WorkspaceGitFileChange>;
  repositories: Map<string, WorkspaceGitRepository>;
  selectedPath: string;
  revealRequest?: { path: string; requestId: number };
  onOpen: (path: string) => void;
  loadedDirectories: ReadonlySet<string>;
  loadingDirectories: ReadonlySet<string>;
  directoryErrors: Readonly<Record<string, string>>;
  onExpand: (path: string, force?: boolean) => void;
  loadingFolderLabel: string;
  folderUnavailableLabel: string;
  onDownloadFile: (path: string) => void;
  onCreateEntry: (
    parentPath: string,
    name: string,
    kind: "file" | "folder",
  ) => Promise<void>;
  onRenameEntry: (file: WorkspaceFile, name: string) => Promise<WorkspaceFile>;
  onDeleteEntry: (file: WorkspaceFile) => Promise<boolean>;
}) {
  const ui = copy[language];
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "/workspace": true,
  });
  const [contextMenu, setContextMenu] =
    useState<WorkspaceTreeContextMenuTarget>();
  const [createTarget, setCreateTarget] = useState<{
    parentPath: string;
    kind: "file" | "folder";
    anchor: HTMLButtonElement;
    requestId: number;
  }>();
  const createRequestIdRef = useRef(0);
  const [renameTarget, setRenameTarget] = useState<{
    file: WorkspaceFile;
    requestId: number;
  }>();
  const renameRequestIdRef = useRef(0);
  const [announcement, setAnnouncement] = useState("");
  const announcementTimerRef = useRef<number | null>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const changedDescendants = useMemo(() => {
    const counts = new Map<string, number>();
    for (const changedPath of changes.keys()) {
      const parts = changedPath.split("/").filter(Boolean);
      for (let index = 1; index < parts.length; index += 1) {
        const parent = `/${parts.slice(0, index).join("/")}`;
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
    }
    return counts;
  }, [changes]);

  useEffect(() => {
    if (!revealRequest) return;
    const parentDirectories = workspaceFileParentDirectories(
      revealRequest.path,
    );
    setExpanded((current) => {
      if (parentDirectories.every((path) => current[path])) return current;
      const next = { ...current };
      for (const path of parentDirectories) next[path] = true;
      return next;
    });
  }, [revealRequest]);

  useEffect(() => {
    if (
      !revealRequest ||
      revealRequest.path !== selectedPath ||
      !selectedRowRef.current
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      selectedRowRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expanded, files, revealRequest, selectedPath]);

  useEffect(
    () => () => {
      if (announcementTimerRef.current !== null) {
        window.clearTimeout(announcementTimerRef.current);
      }
    },
    [],
  );

  function setFolderExpanded(filePath: string, nextExpanded: boolean) {
    setExpanded((current) => ({
      ...current,
      [filePath]: nextExpanded,
    }));
    if (nextExpanded && !loadedDirectories.has(filePath)) onExpand(filePath);
  }

  function openContextMenu(
    file: WorkspaceFile,
    isExpanded: boolean,
    anchor: HTMLButtonElement,
    point?: { x: number; y: number },
  ) {
    const anchorRect = anchor.getBoundingClientRect();
    anchor.focus({ preventScroll: true });
    setContextMenu({
      file,
      expanded: isExpanded,
      anchor,
      point:
        point && (point.x !== 0 || point.y !== 0)
          ? point
          : {
              x: anchorRect.left + Math.min(anchorRect.width, 24),
              y: anchorRect.bottom,
            },
    });
  }

  function announce(message: string) {
    setAnnouncement(message);
    if (announcementTimerRef.current !== null) {
      window.clearTimeout(announcementTimerRef.current);
    }
    announcementTimerRef.current = window.setTimeout(() => {
      setAnnouncement("");
      announcementTimerRef.current = null;
    }, 1_600);
  }

  const closeContextMenu = useCallback(() => {
    setContextMenu(undefined);
  }, []);

  function startCreate(
    parentPath: string,
    kind: "file" | "folder",
    anchor: HTMLButtonElement,
  ) {
    setFolderExpanded(parentPath, true);
    setRenameTarget(undefined);
    createRequestIdRef.current += 1;
    setCreateTarget({
      parentPath,
      kind,
      anchor,
      requestId: createRequestIdRef.current,
    });
  }

  function cancelCreate() {
    const anchor = createTarget?.anchor;
    setCreateTarget(undefined);
    if (anchor) {
      window.requestAnimationFrame(() =>
        anchor.focus({ preventScroll: true }),
      );
    }
  }

  function startRename(file: WorkspaceFile) {
    setCreateTarget(undefined);
    renameRequestIdRef.current += 1;
    setRenameTarget({
      file,
      requestId: renameRequestIdRef.current,
    });
  }

  function cancelRename() {
    const filePath = renameTarget?.file.path;
    setRenameTarget(undefined);
    if (filePath) {
      window.requestAnimationFrame(() =>
        rowRefs.current.get(filePath)?.focus({ preventScroll: true }),
      );
    }
  }

  function render(items: WorkspaceFile[], depth: number) {
    return items.map((file) => {
      const folder = file.kind === "folder";
      const isExpanded = expanded[file.path] ?? false;
      const isLoaded = loadedDirectories.has(file.path);
      const isLoading = loadingDirectories.has(file.path);
      const directoryError = directoryErrors[file.path];
      const change = changes.get(file.path);
      const repository = repositories.get(file.path);
      const descendantCount = changedDescendants.get(file.path) ?? 0;
      const isRenaming = renameTarget?.file.path === file.path;
      return (
        <div key={file.path}>
          {isRenaming ? (
            <WorkspaceTreeNameForm
              key={renameTarget.requestId}
              language={language}
              mode="rename"
              path={file.path}
              kind={file.kind}
              depth={depth}
              initialName={file.name}
              existingNames={
                new Set(
                  items
                    .filter((candidate) => candidate.path !== file.path)
                    .map((candidate) => candidate.name),
                )
              }
              onCancel={cancelRename}
              onSubmit={async (name) => {
                const renamed = await onRenameEntry(file, name);
                setExpanded((current) =>
                  Object.fromEntries(
                    Object.entries(current).map(([filePath, value]) => [
                      replaceWorkspacePathPrefix(
                        filePath,
                        file.path,
                        renamed.path,
                      ),
                      value,
                    ]),
                  ),
                );
                setRenameTarget(undefined);
                announce(ui.entryRenamed(renamed.name));
                window.requestAnimationFrame(() =>
                  rowRefs.current
                    .get(renamed.path)
                    ?.focus({ preventScroll: true }),
                );
              }}
            />
          ) : (
            <button
              type="button"
              ref={(element) => {
                if (element) rowRefs.current.set(file.path, element);
                else rowRefs.current.delete(file.path);
                if (file.path === selectedPath) {
                  selectedRowRef.current = element;
                }
              }}
              className={`${styles.treeRow} ${
                file.path === selectedPath ? styles.selected : ""
              } ${change?.kind === "deleted" ? styles.deletedFile : ""} ${
                contextMenu?.file.path === file.path ? styles.contextTarget : ""
              }`}
              aria-current={
                !folder && file.path === selectedPath ? "page" : undefined
              }
              aria-expanded={folder ? isExpanded : undefined}
              aria-haspopup="menu"
              style={{ paddingLeft: `${7 + depth * 13}px` }}
              title={file.path}
              onClick={() => {
                if (folder) {
                  setFolderExpanded(file.path, !isExpanded);
                } else {
                  onOpen(file.path);
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                openContextMenu(file, isExpanded, event.currentTarget, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "ContextMenu" &&
                  !(event.shiftKey && event.key === "F10")
                ) {
                  return;
                }
                event.preventDefault();
                openContextMenu(file, isExpanded, event.currentTarget);
              }}
            >
              <span className={styles.disclosure}>
                {folder ? (
                  isLoading ? (
                    <RefreshCw size={11} className={styles.directorySpinner} />
                  ) : isExpanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )
                ) : null}
              </span>
              <span className={styles.fileIcon}>
                {fileIcon(file.name, folder, isExpanded)}
              </span>
              <span className={styles.fileName}>{file.name}</span>
              {change ? (
                <span className={`${styles.statusCode} ${styles[change.kind]}`}>
                  {statusCode(change)}
                </span>
              ) : repository ? (
                <span
                  className={styles.repositoryBadge}
                  title={`${workspaceRepositoryLabel(repository.root)} · ${
                    repository.branch ?? "detached HEAD"
                  }`}
                >
                  <GitBranch size={9} />
                  {repository.branch ?? "Git"}
                </span>
              ) : folder && descendantCount > 0 ? (
                <span className={styles.descendantCount}>{descendantCount}</span>
              ) : null}
            </button>
          )}
          {folder && isExpanded ? (
            <>
              {createTarget?.parentPath === file.path ? (
                <WorkspaceTreeNameForm
                  key={createTarget.requestId}
                  language={language}
                  mode="create"
                  path={file.path}
                  kind={createTarget.kind}
                  depth={depth + 1}
                  existingNames={
                    new Set(file.children?.map((child) => child.name) ?? [])
                  }
                  onCancel={cancelCreate}
                  onSubmit={async (name) => {
                    await onCreateEntry(file.path, name, createTarget.kind);
                    setCreateTarget(undefined);
                  }}
                />
              ) : null}
              {directoryError ? (
                <button
                  type="button"
                  className={styles.directoryStatus}
                  style={{ paddingLeft: `${20 + (depth + 1) * 13}px` }}
                  title={directoryError}
                  onClick={() => onExpand(file.path, true)}
                >
                  <CircleAlert size={11} /> {folderUnavailableLabel}
                </button>
              ) : isLoading && !isLoaded ? (
                <span
                  className={styles.directoryStatus}
                  style={{ paddingLeft: `${20 + (depth + 1) * 13}px` }}
                >
                  {loadingFolderLabel}
                </span>
              ) : isLoaded && file.children ? (
                render(file.children, depth + 1)
              ) : null}
            </>
          ) : null}
        </div>
      );
    });
  }

  return (
    <>
      {render(files, 0)}
      {contextMenu ? (
        <WorkspaceTreeContextMenu
          language={language}
          target={contextMenu}
          openInNewTabHref={
            contextMenu.file.kind === "file"
              ? workspaceIdeHref(
                  environmentId,
                  sessionId,
                  contextMenu.file.path,
                )
              : undefined
          }
          onClose={closeContextMenu}
          onOpenFile={onOpen}
          onCreateFile={(parentPath) =>
            startCreate(parentPath, "file", contextMenu.anchor)
          }
          onCreateFolder={(parentPath) =>
            startCreate(parentPath, "folder", contextMenu.anchor)
          }
          onRenameEntry={() => startRename(contextMenu.file)}
          onDeleteEntry={() => {
            const { file, anchor } = contextMenu;
            void onDeleteEntry(file).then((deleted) => {
              if (deleted) {
                announce(ui.entryDeleted(file.name));
              } else {
                window.requestAnimationFrame(() =>
                  anchor.focus({ preventScroll: true }),
                );
              }
            });
          }}
          onToggleFolder={setFolderExpanded}
          onRefreshFolder={(filePath) => onExpand(filePath, true)}
          onDownloadFile={onDownloadFile}
          onAnnounce={announce}
          canMutateEntry={
            changes.get(contextMenu.file.path)?.kind !== "deleted"
          }
        />
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

export function WorkspaceIde({
  language,
  timeZone,
  environment,
  session,
  variant,
  initialSnapshot,
  navigationRequest,
  onNavigationHandled,
}: WorkspaceIdeProps) {
  const ui = copy[language];
  const { confirm } = useAlertDialog();
  const localUiPreferences = useLocalUiPreferences();
  const fileBrowserSidebarCollapsed =
    localUiPreferences.workspace.fileBrowserSidebarCollapsed;
  const storedFileBrowserSidebarWidth =
    localUiPreferences.workspace.fileBrowserSidebarWidth;
  const cacheKey = workspaceClientCacheKey(environment);
  const initialCacheStateRef = useRef<{
    key: string;
    value: Omit<WorkspaceClientCacheEntry, "accessedAt">;
  } | null>(null);
  if (initialCacheStateRef.current === null) {
    const cached = readWorkspaceClientCache(cacheKey);
    const snapshot = initialSnapshot ?? cached?.snapshot;
    initialCacheStateRef.current = {
      key: cacheKey,
      value: {
        snapshot,
        directoryListings: initialSnapshot
          ? { [WORKSPACE_ROOT]: rootEntries(initialSnapshot) }
          : (cached?.directoryListings ?? {}),
        documents: cached?.documents ?? {},
        openPaths: cached?.openPaths ?? [],
        selectedPath: cached?.selectedPath ?? "",
      },
    };
  }
  const initialCacheState = initialCacheStateRef.current.value;
  const stateCacheKeyRef = useRef(cacheKey);
  const [snapshot, setSnapshot] = useState<WorkspaceIdeSnapshot | undefined>(
    initialCacheState.snapshot,
  );
  const [directoryListings, setDirectoryListings] = useState<
    WorkspaceDirectoryListings
  >(initialCacheState.directoryListings);
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>(
    {},
  );
  const [documents, setDocuments] = useState<Record<string, DocumentState>>(
    initialCacheState.documents,
  );
  const [openPaths, setOpenPaths] = useState<string[]>(
    initialCacheState.openPaths,
  );
  const [selectedPath, setSelectedPath] = useState(
    initialCacheState.selectedPath,
  );
  const [previewOnly, setPreviewOnly] = useState(false);
  const [loading, setLoading] = useState(!initialCacheState.snapshot);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "polling" | "offline"
  >("connecting");
  const [fileBrowserSidebarWidth, setFileBrowserSidebarWidth] = useState(
    storedFileBrowserSidebarWidth,
  );
  const [fileBrowserWorkbenchWidth, setFileBrowserWorkbenchWidth] = useState(0);
  const [fileBrowserResizing, setFileBrowserResizing] = useState(false);
  const snapshotRef = useRef(snapshot);
  const gitStateRef = useRef<WorkspaceGitState>(
    snapshot?.git ?? { repositories: [] },
  );
  const documentsRef = useRef(documents);
  const fileBrowserWorkbenchRef = useRef<HTMLDivElement>(null);
  const fileBrowserResizePointerRef = useRef<number | null>(null);
  const fileBrowserSidebarWidthRef = useRef(fileBrowserSidebarWidth);
  const fileBrowserCollapseButtonRef = useRef<HTMLButtonElement>(null);
  const fileBrowserExpandButtonRef = useRef<HTMLButtonElement>(null);
  const fileBrowserSidebarId = useId();
  const environmentIdRef = useRef(environment.id);
  const directoryListingsRef = useRef(directoryListings);
  const directoryRequestsRef = useRef(
    new Map<string, { promise: Promise<void>; token: symbol }>(),
  );
  const activeRequestReleasesRef = useRef(new Set<() => void>());
  const openPathsRef = useRef(openPaths);
  const selectedPathRef = useRef(selectedPath);
  const pendingPathsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const gitRefreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const workspaceSocketRef = useRef<WebSocket | undefined>(undefined);
  const workspaceSocketReadyRef = useRef(false);
  const environmentGenerationRef = useRef(0);
  const environmentIdentityRef = useRef(cacheKey);
  const selectedPathEnvironmentRef = useRef(environment.id);

  useEffect(() => {
    setPreviewOnly(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  const handledNavigationRequestRef = useRef("");
  const initialNavigationGenerationRef = useRef(-1);
  const revealRequestIdRef = useRef(0);
  const resetIdentityRef = useRef<{
    cacheKey: string;
    initialSnapshot: WorkspaceIdeSnapshot | undefined;
  } | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    path: string;
    requestId: number;
  }>();
  const explicitNavigationPath =
    navigationRequest?.environmentId === environment.id
      ? userVisibleWorkspacePath(navigationRequest.path)
      : typeof window === "undefined"
        ? undefined
        : userVisibleWorkspacePath(
            new URLSearchParams(window.location.search).get("path") ?? "",
          );
  const prioritizeExplicitFileContent = Boolean(
    !snapshot &&
      explicitNavigationPath &&
      explicitNavigationPath !== WORKSPACE_ROOT &&
      !documents[explicitNavigationPath]?.data &&
      !documents[explicitNavigationPath]?.error,
  );

  if (environmentIdentityRef.current !== cacheKey) {
    environmentIdentityRef.current = cacheKey;
    environmentIdRef.current = environment.id;
    environmentGenerationRef.current += 1;
    selectedPathEnvironmentRef.current = "";
  }

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    directoryListingsRef.current = directoryListings;
  }, [directoryListings]);

  useEffect(() => {
    if (fileBrowserResizePointerRef.current !== null) return;
    fileBrowserSidebarWidthRef.current = storedFileBrowserSidebarWidth;
    setFileBrowserSidebarWidth(storedFileBrowserSidebarWidth);
  }, [storedFileBrowserSidebarWidth]);

  useEffect(() => {
    const workbench = fileBrowserWorkbenchRef.current;
    if (!workbench) return;
    const updateWidth = () => {
      setFileBrowserWorkbenchWidth(
        Math.round(workbench.getBoundingClientRect().width),
      );
    };
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workbench);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      window.document.body.style.removeProperty("cursor");
      window.document.body.style.removeProperty("user-select");
    },
    [],
  );

  useEffect(() => {
    if (stateCacheKeyRef.current !== cacheKey) return;
    writeWorkspaceClientCache(cacheKey, {
      snapshot,
      directoryListings,
      documents,
      openPaths,
      selectedPath,
    });
  }, [
    cacheKey,
    directoryListings,
    documents,
    openPaths,
    selectedPath,
    snapshot,
  ]);

  useEffect(
    () => () => {
      for (const release of activeRequestReleasesRef.current) release();
      activeRequestReleasesRef.current.clear();
      directoryRequestsRef.current.clear();
    },
    [cacheKey],
  );

  const loadDirectory = useCallback(
    (requestedPath: string, force = false) => {
      const directoryPath = userVisibleWorkspacePath(requestedPath);
      if (!directoryPath) return Promise.resolve();
      if (!force && Object.hasOwn(directoryListingsRef.current, directoryPath)) {
        return Promise.resolve();
      }
      const inFlight = directoryRequestsRef.current.get(directoryPath);
      if (inFlight) return inFlight.promise;

      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.add(directoryPath);
        return next;
      });
      setDirectoryErrors((current) => {
        if (!current[directoryPath]) return current;
        const next = { ...current };
        delete next[directoryPath];
        return next;
      });

      const environmentId = environment.id;
      const environmentGeneration = environmentGenerationRef.current;
      const requestToken = Symbol(directoryPath);
      const hadListing = Object.hasOwn(
        directoryListingsRef.current,
        directoryPath,
      );
      const task = (async () => {
        try {
          const query = new URLSearchParams({ path: directoryPath });
          const requestPath =
            `/api/v1/environments/${encodeURIComponent(environmentId)}` +
            `/files?${query.toString()}`;
          const response = await trackedSharedWorkspaceRequest<
            ApiEnvelope<WorkspaceDirectoryListing>
          >(
            activeRequestReleasesRef.current,
            `directory:${cacheKey}:${requestPath}`,
            (signal) => apiFetch(requestPath, { signal }),
          );
          if (
            environmentIdRef.current !== environmentId ||
            environmentGenerationRef.current !== environmentGeneration
          ) {
            return;
          }
          const responsePath = userVisibleWorkspacePath(response.data.path);
          if (!responsePath || responsePath !== directoryPath) {
            throw new Error(
              "Workspace returned an internal or unexpected directory path.",
            );
          }
          const next = {
            ...directoryListingsRef.current,
            [directoryPath]: shallowVisibleEntries(response.data.entries),
          };
          directoryListingsRef.current = next;
          setDirectoryListings(next);
          if (directoryPath === WORKSPACE_ROOT) {
            const nextSnapshot = snapshotFromRootListing(
              response.data,
              gitStateRef.current,
            );
            snapshotRef.current = nextSnapshot;
            setSnapshot(nextSnapshot);
            setError("");
          }
        } catch (cause) {
          if (isAbortError(cause)) return;
          if (
            environmentIdRef.current !== environmentId ||
            environmentGenerationRef.current !== environmentGeneration
          ) {
            return;
          }
          if (!hadListing) {
            const next = { ...directoryListingsRef.current };
            delete next[directoryPath];
            directoryListingsRef.current = next;
            setDirectoryListings(next);
          }
          setDirectoryErrors((current) => ({
            ...current,
            [directoryPath]:
              cause instanceof Error ? cause.message : "Folder unavailable",
          }));
          if (directoryPath === WORKSPACE_ROOT && !snapshotRef.current) {
            setError(
              cause instanceof Error ? cause.message : "Workspace unavailable",
            );
          }
        } finally {
          const ownsRequest =
            directoryRequestsRef.current.get(directoryPath)?.token ===
            requestToken;
          if (ownsRequest) {
            directoryRequestsRef.current.delete(directoryPath);
            if (
              environmentIdRef.current === environmentId &&
              environmentGenerationRef.current === environmentGeneration
            ) {
              setLoadingDirectories((current) => {
                const next = new Set(current);
                next.delete(directoryPath);
                return next;
              });
              if (directoryPath === WORKSPACE_ROOT) setLoading(false);
            }
          }
        }
      })();
      directoryRequestsRef.current.set(directoryPath, {
        promise: task,
        token: requestToken,
      });
      return task;
    },
    [cacheKey, environment.id],
  );

  const loadDocument = useCallback(
    async (filePath: string, reason: "open" | "external" | "reload" = "open") => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return;
      void loadWorkspaceCodeEditorModule();
      const environmentId = environment.id;
      const environmentGeneration = environmentGenerationRef.current;
      setDocuments((current) => {
        const next = {
          ...current,
          [visiblePath]: {
            ...current[visiblePath],
            loading: reason !== "external" || !current[visiblePath]?.data,
            error: undefined,
          },
        };
        documentsRef.current = next;
        return next;
      });
      try {
        const query = new URLSearchParams({ path: visiblePath });
        const requestPath =
          `/api/v1/environments/${encodeURIComponent(environmentId)}` +
          `/ide/file?${query.toString()}`;
        const response = await trackedSharedWorkspaceRequest<
          ApiEnvelope<WorkspaceIdeFile>
        >(
          activeRequestReleasesRef.current,
          `document:${cacheKey}:${requestPath}`,
          (signal) => apiFetch(requestPath, { signal }),
        );
        if (
          environmentIdRef.current !== environmentId ||
          environmentGenerationRef.current !== environmentGeneration
        ) {
          return;
        }
        const responsePath = userVisibleWorkspacePath(response.data.path);
        if (!responsePath || responsePath !== visiblePath) {
          throw new Error(
            "Workspace returned an internal or unexpected file path.",
          );
        }
        const responseData = { ...response.data, path: responsePath };
        setDocuments((current) => {
          const next = {
            ...current,
            [visiblePath]:
            reason === "external" && current[visiblePath]?.dirty
              ? {
                  ...current[visiblePath],
                  loading: false,
                  conflict:
                    current[visiblePath]?.data?.revision === responseData.revision
                      ? current[visiblePath]?.conflict
                      : responseData,
                }
              : {
                  data: responseData,
                  draft:
                    responseData.kind === "text"
                      ? decodeBase64(responseData.content)
                      : undefined,
                  loading: false,
                  dirty: false,
                },
          };
          documentsRef.current = next;
          return next;
        });
      } catch (cause) {
        if (isAbortError(cause)) return;
        if (
          environmentIdRef.current !== environmentId ||
          environmentGenerationRef.current !== environmentGeneration
        ) {
          return;
        }
        setDocuments((current) => {
          const next = {
            ...current,
            [visiblePath]: {
              ...current[visiblePath],
              loading: false,
              error:
                cause instanceof Error ? cause.message : "File unavailable",
            },
          };
          documentsRef.current = next;
          return next;
        });
      }
    },
    [cacheKey, environment.id],
  );

  const loadGitState = useCallback(async () => {
    const environmentId = environment.id;
    const environmentGeneration = environmentGenerationRef.current;
    const requestPath =
      `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/git`;
    try {
      const response = await trackedSharedWorkspaceRequest<
        ApiEnvelope<WorkspaceGitState>
      >(
        activeRequestReleasesRef.current,
        `git:${cacheKey}:${requestPath}`,
        (signal) => apiFetch(requestPath, { signal }),
      );
      if (
        environmentIdRef.current !== environmentId ||
        environmentGenerationRef.current !== environmentGeneration
      ) {
        return;
      }
      gitStateRef.current = response.data;
      const current = snapshotRef.current;
      if (!current) return;
      const next = { ...current, git: response.data };
      snapshotRef.current = next;
      setSnapshot(next);
    } catch (cause) {
      if (!isAbortError(cause)) {
        // The file tree remains useful while Git projection refresh retries.
      }
    }
  }, [cacheKey, environment.id]);

  const refreshSnapshot = useCallback(
    async (silent = false, refreshLoadedDirectories = false) => {
      if (!silent) setLoading(true);
      const loadedDirectoryPaths = Object.keys(
        directoryListingsRef.current,
      ).filter((directoryPath) => directoryPath !== WORKSPACE_ROOT);
      await Promise.all([
        loadDirectory(WORKSPACE_ROOT, true),
        loadGitState(),
        ...(refreshLoadedDirectories
          ? loadedDirectoryPaths.map((directoryPath) =>
              loadDirectory(directoryPath, true),
            )
          : []),
      ]);
      if (!silent && environmentIdRef.current === environment.id) {
        setLoading(false);
      }
    },
    [environment.id, loadDirectory, loadGitState],
  );

  useEffect(() => {
    if (
      resetIdentityRef.current?.cacheKey === cacheKey &&
      resetIdentityRef.current.initialSnapshot === initialSnapshot
    ) {
      return;
    }
    resetIdentityRef.current = {
      cacheKey,
      initialSnapshot,
    };
    const cached = readWorkspaceClientCache(cacheKey);
    const nextSnapshot = initialSnapshot ?? cached?.snapshot;
    const nextListings: WorkspaceDirectoryListings = initialSnapshot
      ? { [WORKSPACE_ROOT]: rootEntries(initialSnapshot) }
      : (cached?.directoryListings ?? {});
    stateCacheKeyRef.current = cacheKey;
    snapshotRef.current = nextSnapshot;
    gitStateRef.current = nextSnapshot?.git ?? { repositories: [] };
    setSnapshot(nextSnapshot);
    directoryListingsRef.current = nextListings;
    setDirectoryListings(nextListings);
    directoryRequestsRef.current.clear();
    setLoadingDirectories(new Set());
    setDirectoryErrors({});
    const nextDocuments = cached?.documents ?? {};
    documentsRef.current = nextDocuments;
    setDocuments(nextDocuments);
    const nextOpenPaths = cached?.openPaths ?? [];
    openPathsRef.current = nextOpenPaths;
    setOpenPaths(nextOpenPaths);
    const nextSelectedPath = cached?.selectedPath ?? "";
    selectedPathRef.current = nextSelectedPath;
    setSelectedPath(nextSelectedPath);
    selectedPathEnvironmentRef.current = environment.id;
    handledNavigationRequestRef.current = "";
    initialNavigationGenerationRef.current = -1;
    setRevealRequest(undefined);
    setError("");
    setLoading(!nextSnapshot);
  }, [
    cacheKey,
    environment.id,
    initialSnapshot,
  ]);

  useEffect(() => {
    if (prioritizeExplicitFileContent) return;
    void loadDirectory(WORKSPACE_ROOT, true);
    void loadGitState();
  }, [
    cacheKey,
    loadDirectory,
    loadGitState,
    prioritizeExplicitFileContent,
  ]);

  const visibleGit = useMemo(
    () => userVisibleWorkspaceGitState(snapshot?.git),
    [snapshot?.git],
  );
  const repositories = visibleGit.repositories;
  const gitChanges = useMemo(
    () => workspaceGitChanges(visibleGit),
    [visibleGit],
  );
  const nativeWorkspaceFiles = useMemo(
    () => workspaceTreeFromListings(directoryListings),
    [directoryListings],
  );
  const workspaceFiles = useMemo(
    () => mergeWorkspaceGitFiles(nativeWorkspaceFiles, gitChanges),
    [gitChanges, nativeWorkspaceFiles],
  );
  const changesByPath = useMemo(
    () => new Map(gitChanges.map((change) => [change.path, change])),
    [gitChanges],
  );
  const repositoriesByRoot = useMemo(
    () => new Map(repositories.map((repository) => [repository.root, repository])),
    [repositories],
  );
  const loadedDirectories = useMemo(
    () => new Set(Object.keys(directoryListings)),
    [directoryListings],
  );
  const watchedDirectoryPaths = useMemo(
    () =>
      [
        ...new Set([
          ...Object.keys(directoryListings).filter(
            (directoryPath) => directoryPath !== WORKSPACE_ROOT,
          ),
          ...repositories.map((repository) => `${repository.root}/.git`),
        ]),
      ].slice(-64),
    [directoryListings, repositories],
  );
  const watchedDirectorySignature = watchedDirectoryPaths.join("\n");
  const watchedDirectoryPathsRef = useRef(watchedDirectoryPaths);
  useEffect(() => {
    watchedDirectoryPathsRef.current = watchedDirectoryPaths;
  }, [watchedDirectoryPaths]);

  useEffect(() => {
    setOpenPaths((current) => {
      const visible = [
        ...new Set(current.flatMap((filePath) => {
          const normalized = userVisibleWorkspacePath(filePath);
          return normalized ? [normalized] : [];
        })),
      ];
      openPathsRef.current = visible;
      return visible;
    });
    setDocuments((current) => {
      const visible = Object.fromEntries(
        Object.entries(current).flatMap(([filePath, document]) => {
          const normalized = userVisibleWorkspacePath(filePath);
          return normalized ? [[normalized, document] as const] : [];
        }),
      );
      documentsRef.current = visible;
      return visible;
    });
    setSelectedPath((current) =>
      current ? (userVisibleWorkspacePath(current) ?? "") : "",
    );
    pendingPathsRef.current = new Set(
      [...pendingPathsRef.current].filter((filePath) =>
        Boolean(userVisibleWorkspacePath(filePath)),
      ),
    );
  }, [snapshot]);

  const openFile = useCallback(
    (filePath: string) => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return Promise.resolve();
      setOpenPaths((current) => {
        const next = current.includes(visiblePath)
          ? current
          : [...current, visiblePath];
        openPathsRef.current = next;
        return next;
      });
      selectedPathEnvironmentRef.current = environment.id;
      selectedPathRef.current = visiblePath;
      setSelectedPath(visiblePath);
      const document = documentsRef.current[visiblePath];
      if (!document?.data) {
        return loadDocument(visiblePath);
      }
      return Promise.resolve();
    },
    [environment.id, loadDocument],
  );

  const createWorkspaceEntry = useCallback(
    async (
      requestedParentPath: string,
      name: string,
      kind: "file" | "folder",
    ) => {
      const parentPath = userVisibleWorkspacePath(requestedParentPath);
      if (!parentPath) {
        throw new Error("The target Workspace folder is unavailable.");
      }
      const environmentId = environment.id;
      const environmentGeneration = environmentGenerationRef.current;
      const body: WorkspaceIdeCreateEntryRequest = {
        parentPath,
        name,
        kind,
      };
      const response = await apiFetch<ApiEnvelope<WorkspaceFile>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/entries`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (
        environmentIdRef.current !== environmentId ||
        environmentGenerationRef.current !== environmentGeneration
      ) {
        return;
      }
      const responsePath = userVisibleWorkspacePath(response.data.path);
      const expectedPath = `${parentPath}/${name}`;
      if (
        !responsePath ||
        responsePath !== expectedPath ||
        response.data.kind !== kind
      ) {
        throw new Error(
          "Workspace returned an internal or unexpected created path.",
        );
      }

      await directoryRequestsRef.current.get(parentPath)?.promise;
      await loadDirectory(parentPath, true);
      if (
        environmentIdRef.current !== environmentId ||
        environmentGenerationRef.current !== environmentGeneration
      ) {
        return;
      }
      setError("");
      if (kind === "file") openFile(responsePath);
    },
    [environment.id, loadDirectory, openFile],
  );

  const renameWorkspaceEntry = useCallback(
    async (source: WorkspaceFile, requestedName: string) => {
      const sourcePath = userVisibleWorkspacePath(source.path);
      if (!sourcePath || sourcePath === WORKSPACE_ROOT) {
        throw new Error("The Workspace entry cannot be renamed.");
      }
      const parentPath = workspaceParentPath(sourcePath);
      const destinationPath = userVisibleWorkspacePath(
        `${parentPath}/${requestedName}`,
      );
      if (!destinationPath || workspaceParentPath(destinationPath) !== parentPath) {
        throw new Error("The new Workspace entry name is invalid.");
      }

      const environmentId = environment.id;
      const environmentGeneration = environmentGenerationRef.current;
      await Promise.all(
        [...directoryRequestsRef.current.entries()]
          .filter(
            ([directoryPath]) =>
              directoryPath === parentPath ||
              workspacePathAtOrBelow(directoryPath, sourcePath),
          )
          .map(([, request]) => request.promise),
      );

      const body: WorkspaceIdeRenameEntryRequest = {
        path: sourcePath,
        name: requestedName,
      };
      const response = await apiFetch<ApiEnvelope<WorkspaceFile>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/entries`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      if (
        environmentIdRef.current !== environmentId ||
        environmentGenerationRef.current !== environmentGeneration
      ) {
        return response.data;
      }
      const responsePath = userVisibleWorkspacePath(response.data.path);
      if (
        !responsePath ||
        responsePath !== destinationPath ||
        response.data.kind !== source.kind
      ) {
        throw new Error(
          "Workspace returned an internal or unexpected renamed path.",
        );
      }
      const renamedEntry = { ...response.data, path: responsePath };
      const sourceWasLoaded = Object.hasOwn(
        directoryListingsRef.current,
        sourcePath,
      );

      const nextListings = Object.fromEntries(
        Object.entries(directoryListingsRef.current).map(
          ([directoryPath, entries]) => [
            replaceWorkspacePathPrefix(
              directoryPath,
              sourcePath,
              responsePath,
            ),
            entries.map((entry) => {
              const nextPath = replaceWorkspacePathPrefix(
                entry.path,
                sourcePath,
                responsePath,
              );
              if (nextPath === entry.path) return entry;
              return {
                ...entry,
                ...(entry.path === sourcePath ? renamedEntry : {}),
                path: nextPath,
                name: nextPath.split("/").at(-1) ?? entry.name,
              };
            }),
          ],
        ),
      );
      directoryListingsRef.current = nextListings;
      setDirectoryListings(nextListings);
      setDirectoryErrors((current) =>
        Object.fromEntries(
          Object.entries(current).map(([directoryPath, message]) => [
            replaceWorkspacePathPrefix(
              directoryPath,
              sourcePath,
              responsePath,
            ),
            message,
          ]),
        ),
      );
      setLoadingDirectories((current) => {
        const next = new Set<string>();
        for (const directoryPath of current) {
          next.add(
            replaceWorkspacePathPrefix(
              directoryPath,
              sourcePath,
              responsePath,
            ),
          );
        }
        return next;
      });

      const nextOpenPaths = [
        ...new Set(
          openPathsRef.current.map((filePath) =>
            replaceWorkspacePathPrefix(filePath, sourcePath, responsePath),
          ),
        ),
      ];
      openPathsRef.current = nextOpenPaths;
      setOpenPaths(nextOpenPaths);

      const nextDocuments: Record<string, DocumentState> = {};
      for (const [filePath, document] of Object.entries(documentsRef.current)) {
        const nextPath = replaceWorkspacePathPrefix(
          filePath,
          sourcePath,
          responsePath,
        );
        nextDocuments[nextPath] =
          nextPath === filePath
            ? document
            : {
                ...document,
                data: document.data
                  ? remapWorkspaceIdeFile(
                      document.data,
                      sourcePath,
                      responsePath,
                    )
                  : undefined,
                conflict: document.conflict
                  ? remapWorkspaceIdeFile(
                      document.conflict,
                      sourcePath,
                      responsePath,
                    )
                  : undefined,
              };
      }
      documentsRef.current = nextDocuments;
      setDocuments(nextDocuments);
      setSelectedPath((current) =>
        replaceWorkspacePathPrefix(current, sourcePath, responsePath),
      );
      setRevealRequest((current) =>
        current
          ? {
              ...current,
              path: replaceWorkspacePathPrefix(
                current.path,
                sourcePath,
                responsePath,
              ),
            }
          : current,
      );
      pendingPathsRef.current = new Set(
        [...pendingPathsRef.current].map((filePath) =>
          replaceWorkspacePathPrefix(filePath, sourcePath, responsePath),
        ),
      );
      setError("");

      void (async () => {
        await refreshSnapshot(true);
        if (
          environmentIdRef.current !== environmentId ||
          environmentGenerationRef.current !== environmentGeneration
        ) {
          return;
        }
        const directoryRefreshes = [loadDirectory(parentPath, true)];
        if (source.kind === "folder" && sourceWasLoaded) {
          directoryRefreshes.push(loadDirectory(responsePath, true));
        }
        await Promise.all(directoryRefreshes);
        await Promise.all(
          nextOpenPaths
            .filter((filePath) =>
              workspacePathAtOrBelow(filePath, responsePath),
            )
            .map((filePath) => loadDocument(filePath, "external")),
        );
      })();

      return renamedEntry;
    },
    [environment.id, loadDirectory, loadDocument, refreshSnapshot],
  );

  const deleteWorkspaceEntry = useCallback(
    async (entry: WorkspaceFile) => {
      const entryPath = userVisibleWorkspacePath(entry.path);
      if (!entryPath || entryPath === WORKSPACE_ROOT) return false;
      const dirtyCount = Object.entries(documentsRef.current).filter(
        ([filePath, document]) =>
          document.dirty && workspacePathAtOrBelow(filePath, entryPath),
      ).length;
      const confirmed = await confirm({
        title: ui.deleteTitle(entry.name),
        description: ui.deleteConfirm(entry.kind, dirtyCount),
        actionLabel: ui.deleteAction(entry.kind),
        cancelLabel: ui.cancel,
        tone: "danger",
      });
      if (!confirmed) {
        return false;
      }

      const environmentId = environment.id;
      const environmentGeneration = environmentGenerationRef.current;
      const parentPath = workspaceParentPath(entryPath);
      try {
        await Promise.all(
          [...directoryRequestsRef.current.entries()]
            .filter(
              ([directoryPath]) =>
                directoryPath === parentPath ||
                workspacePathAtOrBelow(directoryPath, entryPath),
            )
            .map(([, request]) => request.promise),
        );
        const query = new URLSearchParams({ path: entryPath });
        const response = await apiFetch<ApiEnvelope<WorkspaceFile>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/ide/entries?${query.toString()}`,
          { method: "DELETE" },
        );
        if (
          environmentIdRef.current !== environmentId ||
          environmentGenerationRef.current !== environmentGeneration
        ) {
          return true;
        }
        const responsePath = userVisibleWorkspacePath(response.data.path);
        if (
          !responsePath ||
          responsePath !== entryPath ||
          response.data.kind !== entry.kind
        ) {
          throw new Error(
            "Workspace returned an internal or unexpected deleted path.",
          );
        }

        const currentOpenPaths = openPathsRef.current;
        const nextOpenPaths = currentOpenPaths.filter(
          (filePath) => !workspacePathAtOrBelow(filePath, entryPath),
        );
        openPathsRef.current = nextOpenPaths;
        setOpenPaths(nextOpenPaths);
        setSelectedPath((current) => {
          if (!workspacePathAtOrBelow(current, entryPath)) return current;
          const previousIndex = Math.max(currentOpenPaths.indexOf(current), 0);
          return (
            nextOpenPaths[Math.min(previousIndex, nextOpenPaths.length - 1)] ??
            ""
          );
        });

        const nextDocuments = Object.fromEntries(
          Object.entries(documentsRef.current).filter(
            ([filePath]) => !workspacePathAtOrBelow(filePath, entryPath),
          ),
        );
        documentsRef.current = nextDocuments;
        setDocuments(nextDocuments);
        pendingPathsRef.current = new Set(
          [...pendingPathsRef.current].filter(
            (filePath) => !workspacePathAtOrBelow(filePath, entryPath),
          ),
        );
        setRevealRequest((current) =>
          current && workspacePathAtOrBelow(current.path, entryPath)
            ? undefined
            : current,
        );

        const nextListings = Object.fromEntries(
          Object.entries(directoryListingsRef.current).flatMap(
            ([directoryPath, entries]) =>
              workspacePathAtOrBelow(directoryPath, entryPath)
                ? []
                : [
                    [
                      directoryPath,
                      entries.filter(
                        (candidate) =>
                          !workspacePathAtOrBelow(candidate.path, entryPath),
                      ),
                    ] as const,
                  ],
          ),
        );
        directoryListingsRef.current = nextListings;
        setDirectoryListings(nextListings);
        setDirectoryErrors((current) =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([directoryPath]) =>
                !workspacePathAtOrBelow(directoryPath, entryPath),
            ),
          ),
        );
        setLoadingDirectories((current) => {
          const next = new Set(current);
          for (const directoryPath of next) {
            if (workspacePathAtOrBelow(directoryPath, entryPath)) {
              next.delete(directoryPath);
            }
          }
          return next;
        });
        setError("");

        void (async () => {
          await refreshSnapshot(true);
          if (
            environmentIdRef.current === environmentId &&
            environmentGenerationRef.current === environmentGeneration
          ) {
            await loadDirectory(parentPath, true);
          }
        })();
        return true;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : ui.deleteFailed);
        return false;
      }
    },
    [confirm, environment.id, loadDirectory, refreshSnapshot, ui],
  );

  const downloadWorkspaceFile = useCallback(
    async (requestedPath: string) => {
      const filePath = userVisibleWorkspacePath(requestedPath);
      if (!filePath || filePath === WORKSPACE_ROOT) return;
      try {
        const query = new URLSearchParams({ path: filePath });
        const response = await apiFetch<ApiEnvelope<WorkspaceIdeFile>>(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/file?${query.toString()}`,
        );
        const responsePath = userVisibleWorkspacePath(response.data.path);
        if (!responsePath || responsePath !== filePath) {
          throw new Error(
            "Workspace returned an internal or unexpected file path.",
          );
        }
        const objectUrl = URL.createObjectURL(
          new Blob([decodeBase64Bytes(response.data.content)], {
            type: response.data.preview?.mimeType ?? "application/octet-stream",
          }),
        );
        const link = window.document.createElement("a");
        link.href = objectUrl;
        link.download = response.data.name;
        link.style.display = "none";
        try {
          window.document.body.appendChild(link);
          link.click();
        } finally {
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        }
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : ui.downloadFailed);
      }
    },
    [environment.id, ui.downloadFailed],
  );

  const revealWorkspaceFile = useCallback(
    (filePath: string) => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return Promise.resolve();
      revealRequestIdRef.current += 1;
      setRevealRequest({
        path: visiblePath,
        requestId: revealRequestIdRef.current,
      });
      const fileTask =
        visiblePath === WORKSPACE_ROOT
          ? Promise.resolve()
          : openFile(visiblePath);
      return fileTask;
    },
    [openFile],
  );

  useEffect(() => {
    if (prioritizeExplicitFileContent || !revealRequest) return;
    void Promise.all(
      workspaceFileParentDirectories(revealRequest.path).map((directoryPath) =>
        loadDirectory(directoryPath),
      ),
    );
  }, [
    loadDirectory,
    prioritizeExplicitFileContent,
    revealRequest,
  ]);

  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.environmentId !== environment.id) return;
    const requestKey = `${navigationRequest.environmentId}:${navigationRequest.requestId}:${navigationRequest.path}`;
    if (handledNavigationRequestRef.current === requestKey) return;
    handledNavigationRequestRef.current = requestKey;
    const requestedPath = userVisibleWorkspacePath(navigationRequest.path);
    let active = true;
    const navigation = requestedPath
      ? revealWorkspaceFile(requestedPath)
      : Promise.resolve();
    void navigation.finally(() => {
      if (active) onNavigationHandled?.(navigationRequest);
    });
    return () => {
      active = false;
      if (handledNavigationRequestRef.current === requestKey) {
        handledNavigationRequestRef.current = "";
      }
    };
  }, [
    environment.id,
    navigationRequest,
    onNavigationHandled,
    revealWorkspaceFile,
  ]);

  useEffect(() => {
    if (navigationRequest?.environmentId === environment.id) return;
    const environmentGeneration = environmentGenerationRef.current;
    if (initialNavigationGenerationRef.current === environmentGeneration) {
      return;
    }
    initialNavigationGenerationRef.current = environmentGeneration;
    const requestedPathValue =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("path") ?? "";
    const requestedPath = userVisibleWorkspacePath(requestedPathValue) ?? "";
    if (requestedPath) {
      void revealWorkspaceFile(requestedPath);
    }
    return () => {
      if (
        initialNavigationGenerationRef.current === environmentGeneration
      ) {
        initialNavigationGenerationRef.current = -1;
      }
    };
  }, [
    environment.id,
    navigationRequest,
    revealWorkspaceFile,
  ]);

  useEffect(() => {
    if (selectedPathEnvironmentRef.current !== environment.id) return;
    const url = new URL(window.location.href);
    const requestedPath = url.searchParams.get("path");
    const visibleSelectedPath = selectedPath
      ? userVisibleWorkspacePath(selectedPath)
      : undefined;
    if (visibleSelectedPath) {
      if (requestedPath === visibleSelectedPath) return;
      url.searchParams.set("path", visibleSelectedPath);
    } else if (requestedPath && !userVisibleWorkspacePath(requestedPath)) {
      url.searchParams.delete("path");
    } else {
      return;
    }
    window.history.replaceState(window.history.state, "", url);
  }, [environment.id, selectedPath]);

  useEffect(() => {
    if (prioritizeExplicitFileContent) {
      setConnection("connecting");
      return;
    }
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry = 0;
    let pollingFallback = false;
    let pollingTimer: number | undefined;
    let handshakeTimer: number | undefined;

    const scheduleGitRefresh = () => {
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
      }
      gitRefreshTimerRef.current = window.setTimeout(() => {
        gitRefreshTimerRef.current = null;
        void loadGitState();
      }, 450);
    };

    const scheduleRefresh = (filePath: string, event = "") => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return;
      if (event.startsWith("git:")) {
        scheduleGitRefresh();
        return;
      }
      pendingPathsRef.current.add(visiblePath);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        const changedPaths = [...pendingPathsRef.current];
        pendingPathsRef.current.clear();
        refreshTimerRef.current = null;
        const changedDirectories = new Set(
          changedPaths.map((changedPath) =>
            changedPath === WORKSPACE_ROOT
              ? WORKSPACE_ROOT
              : workspaceParentPath(changedPath),
          ),
        );
        for (const directoryPath of changedDirectories) {
          if (
            directoryPath === WORKSPACE_ROOT ||
            Object.hasOwn(directoryListingsRef.current, directoryPath)
          ) {
            void loadDirectory(directoryPath, true);
          }
        }
        for (const openPath of openPathsRef.current) {
          if (
            changedPaths.some(
              (changedPath) =>
                openPath === changedPath || openPath.startsWith(`${changedPath}/`),
            )
          ) {
            void loadDocument(openPath, "external");
          }
        }
        scheduleGitRefresh();
      }, 180);
    };

    const stopPolling = () => {
      if (pollingTimer === undefined) return;
      window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    };

    const startPolling = () => {
      if (disposed || pollingTimer !== undefined) return;
      void refreshSnapshot(true, true);
      pollingTimer = window.setInterval(() => {
        void refreshSnapshot(true, true);
      }, 15_000);
    };

    const connect = () => {
      if (disposed) return;
      setConnection(
        pollingFallback
          ? "polling"
          : retry === 0
            ? "connecting"
            : "reconnecting",
      );
      socket = new WebSocket(
        apiWebSocketUrl(
          `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/events`,
        ),
      );
      workspaceSocketRef.current = socket;
      workspaceSocketReadyRef.current = false;
      handshakeTimer = window.setTimeout(() => {
        if (disposed || workspaceSocketReadyRef.current) return;
        pollingFallback = true;
        startPolling();
        setConnection("polling");
      }, 10_000);
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data as string) as WorkspaceIdeEvent;
          if (event.type === "ready") {
            retry = 0;
            pollingFallback = false;
            workspaceSocketReadyRef.current = true;
            if (handshakeTimer !== undefined) {
              window.clearTimeout(handshakeTimer);
              handshakeTimer = undefined;
            }
            stopPolling();
            setError("");
            setConnection("live");
            const subscription: WorkspaceIdeWatchSubscription = {
              type: "subscribe",
              paths: watchedDirectoryPathsRef.current,
            };
            socket?.send(JSON.stringify(subscription));
          } else if (event.type === "change") {
            scheduleRefresh(event.path, event.event);
          } else if (event.type === "error") {
            if (event.code === "workspace_watch_unavailable") {
              pollingFallback = true;
              startPolling();
              setConnection("polling");
            } else {
              setError(event.error);
            }
          }
        } catch {
          setError("Workspace event stream returned invalid data.");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        if (workspaceSocketRef.current === socket) {
          workspaceSocketRef.current = undefined;
          workspaceSocketReadyRef.current = false;
        }
        if (handshakeTimer !== undefined) {
          window.clearTimeout(handshakeTimer);
          handshakeTimer = undefined;
        }
        retry += 1;
        // Keep editor state fresh only while the native watch is unavailable
        // or reconnecting. A subsequent `ready` event stops this fallback.
        startPolling();
        setConnection(
          pollingFallback
            ? "polling"
            : retry > 5
              ? "polling"
              : "reconnecting",
        );
        reconnectTimerRef.current = window.setTimeout(
          connect,
          pollingFallback
            ? 30_000
            : Math.min(5_000, 500 * 2 ** Math.min(retry, 4)),
        );
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      disposed = true;
      stopPolling();
      socket?.close();
      workspaceSocketRef.current = undefined;
      workspaceSocketReadyRef.current = false;
      if (handshakeTimer !== undefined) {
        window.clearTimeout(handshakeTimer);
      }
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (gitRefreshTimerRef.current !== null) {
        window.clearTimeout(gitRefreshTimerRef.current);
        gitRefreshTimerRef.current = null;
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [
    environment.id,
    loadDirectory,
    loadDocument,
    loadGitState,
    prioritizeExplicitFileContent,
    refreshSnapshot,
  ]);

  useEffect(() => {
    const socket = workspaceSocketRef.current;
    if (
      !workspaceSocketReadyRef.current ||
      socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const subscription: WorkspaceIdeWatchSubscription = {
      type: "subscribe",
      paths: watchedDirectoryPathsRef.current,
    };
    socket.send(JSON.stringify(subscription));
  }, [watchedDirectorySignature]);

  useEffect(() => {
    const warnForUnsavedFiles = (event: BeforeUnloadEvent) => {
      if (!Object.values(documentsRef.current).some((candidate) => candidate.dirty)) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnForUnsavedFiles);
    return () => window.removeEventListener("beforeunload", warnForUnsavedFiles);
  }, []);

  function updateDraft(filePath: string, draft: string) {
    setDocuments((current) => {
      const document = current[filePath];
      if (!document?.data) return current;
      const original =
        document.data.kind === "text" ? decodeBase64(document.data.content) : "";
      const next = {
        ...current,
        [filePath]: {
          ...document,
          draft,
          dirty: draft !== original,
          error: undefined,
        },
      };
      documentsRef.current = next;
      return next;
    });
  }

  async function saveDocument(filePath: string, revisionOverride?: string) {
    const visiblePath = userVisibleWorkspacePath(filePath);
    if (!visiblePath) return;
    const document = documentsRef.current[visiblePath];
    if (
      !document?.data?.editable ||
      document.draft === undefined ||
      document.saving ||
      (!document.dirty && !revisionOverride)
    ) {
      return;
    }
    setDocuments((current) => ({
      ...current,
      [visiblePath]: {
        ...current[visiblePath],
        saving: true,
        error: undefined,
      },
    }));
    const body: WorkspaceIdeWriteRequest = {
      encoding: "base64",
      content: encodeBase64(document.draft, document.data.bom),
      baseRevision: revisionOverride ?? document.data.revision,
    };
    try {
      const query = new URLSearchParams({ path: visiblePath });
      const response = await apiFetch<ApiEnvelope<WorkspaceIdeFile>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/ide/file?${query.toString()}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      const responsePath = userVisibleWorkspacePath(response.data.path);
      if (!responsePath || responsePath !== visiblePath) {
        throw new Error("Workspace returned an internal or unexpected file path.");
      }
      const responseData = { ...response.data, path: responsePath };
      const savedDraft = decodeBase64(responseData.content);
      setDocuments((current) => ({
        ...current,
        [visiblePath]: {
          data: responseData,
          draft: savedDraft,
          loading: false,
          saving: false,
          dirty: false,
        },
      }));
      await refreshSnapshot(true, true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "workspace_file_conflict") {
        await loadDocument(visiblePath, "external");
        setDocuments((current) => ({
          ...current,
          [visiblePath]: { ...current[visiblePath], saving: false },
        }));
        return;
      }
      setDocuments((current) => ({
        ...current,
        [visiblePath]: {
          ...current[visiblePath],
          saving: false,
          error:
            cause instanceof ApiError && cause.code === "workspace_write_not_ready"
              ? ui.saveBlocked
              : cause instanceof Error
                ? cause.message
                : "File could not be saved.",
        },
      }));
    }
  }

  function acceptLatestFile(filePath: string) {
    setDocuments((current) => {
      const document = current[filePath];
      const latest = document?.conflict;
      if (!document || !latest) return current;
      return {
        ...current,
        [filePath]: {
          data: latest,
          draft: latest.kind === "text" ? decodeBase64(latest.content) : undefined,
          loading: false,
          dirty: false,
        },
      };
    });
  }

  function toggleComparison(filePath: string) {
    setDocuments((current) => ({
      ...current,
      [filePath]: {
        ...current[filePath],
        comparing: !current[filePath]?.comparing,
      },
    }));
  }

  async function refreshWorkspace() {
    const dirty = Object.values(documentsRef.current).some(
      (candidate) => candidate.dirty,
    );
    if (
      dirty &&
      !(await confirm({
        title: ui.reloadDiscardTitle,
        description: ui.reloadDiscard,
        actionLabel: ui.reloadDiscardAction,
        cancelLabel: ui.keepEditing,
        tone: "danger",
      }))
    ) {
      return;
    }
    await refreshSnapshot(false, true);
    await Promise.all(
      openPathsRef.current.map((filePath) => loadDocument(filePath, "reload")),
    );
  }

  async function closeTab(filePath: string) {
    if (documentsRef.current[filePath]?.dirty) {
      const discard = await confirm({
        title: ui.discardCloseTitle,
        description: ui.discardClose,
        actionLabel: ui.discardCloseAction,
        cancelLabel: ui.keepEditing,
        tone: "danger",
      });
      if (!discard) return;
      setDocuments((current) => {
        if (!current[filePath]?.dirty) return current;
        const next = { ...current };
        delete next[filePath];
        documentsRef.current = next;
        return next;
      });
    }
    setOpenPaths((current) => {
      const index = current.indexOf(filePath);
      const next = current.filter((path) => path !== filePath);
      if (selectedPath === filePath) {
        setSelectedPath(next[Math.min(index, next.length - 1)] ?? "");
      }
      return next;
    });
  }

  const document = selectedPath ? documents[selectedPath] : undefined;
  const selectedFile = document?.data;
  const text =
    document?.draft ??
    (selectedFile?.kind === "text" ? decodeBase64(selectedFile.content) : "");
  const latestConflictText =
    document?.conflict?.kind === "text"
      ? decodeBase64(document.conflict.content)
      : "";
  const locale = language === "zh-CN" ? "zh-CN" : "en-US";
  const selectedRepository = repositoryForWorkspacePath(
    repositories,
    selectedPath,
  );
  const statusRepository =
    selectedRepository ?? (repositories.length === 1 ? repositories[0] : undefined);
  const statusRepositoryChanges = statusRepository
    ? gitChanges.filter(
        (change) =>
          repositoryForWorkspacePath(repositories, change.path)?.root ===
          statusRepository.root,
      )
    : [];
  const connectionLabel = {
    connecting: ui.connecting,
    live: ui.live,
    reconnecting: ui.reconnecting,
    polling: ui.polling,
    offline: ui.offline,
  }[connection];
  const displayedFileBrowserSidebarWidth =
    fileBrowserWorkbenchWidth > 0
      ? clampFileBrowserSidebarWidthForAvailableWidth(
          fileBrowserSidebarWidth,
          fileBrowserWorkbenchWidth,
        )
      : fileBrowserSidebarWidth;
  const displayedFileBrowserMinimumWidth =
    fileBrowserWorkbenchWidth > 0
      ? clampFileBrowserSidebarWidthForAvailableWidth(
          MIN_FILE_BROWSER_SIDEBAR_WIDTH,
          fileBrowserWorkbenchWidth,
        )
      : MIN_FILE_BROWSER_SIDEBAR_WIDTH;
  const displayedFileBrowserMaximumWidth =
    fileBrowserWorkbenchWidth > 0
      ? clampFileBrowserSidebarWidthForAvailableWidth(
          MAX_FILE_BROWSER_SIDEBAR_WIDTH,
          fileBrowserWorkbenchWidth,
        )
      : MAX_FILE_BROWSER_SIDEBAR_WIDTH;
  const fileBrowserWorkbenchStyle = {
    "--workspace-file-sidebar-width": `${displayedFileBrowserSidebarWidth}px`,
  } as CSSProperties;

  function updateFileBrowserSidebarWidth(width: number, persist: boolean) {
    const normalizedWidth = normalizeFileBrowserSidebarWidth(width);
    fileBrowserSidebarWidthRef.current = normalizedWidth;
    setFileBrowserSidebarWidth(normalizedWidth);
    if (!persist) return;
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: {
        ...current.workspace,
        fileBrowserSidebarWidth: normalizedWidth,
      },
    }));
  }

  function setFileBrowserSidebarCollapsed(collapsed: boolean) {
    updateLocalUiPreferences((current) => ({
      ...current,
      workspace: {
        ...current.workspace,
        fileBrowserSidebarCollapsed: collapsed,
      },
    }));
    window.requestAnimationFrame(() => {
      (collapsed
        ? fileBrowserExpandButtonRef
        : fileBrowserCollapseButtonRef
      ).current?.focus({ preventScroll: true });
    });
  }

  function fileBrowserWidthForPointer(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    const workbench = fileBrowserWorkbenchRef.current;
    if (!workbench) return fileBrowserSidebarWidthRef.current;
    const workbenchRect = workbench.getBoundingClientRect();
    return fileBrowserSidebarWidthFromPointer({
      pointerX: event.clientX,
      workbenchLeft: workbenchRect.left,
      workbenchWidth: workbenchRect.width,
    });
  }

  function finishFileBrowserResize(
    event: ReactPointerEvent<HTMLDivElement>,
    width: number,
  ) {
    updateFileBrowserSidebarWidth(width, true);
    fileBrowserResizePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setFileBrowserResizing(false);
    window.document.body.style.removeProperty("cursor");
    window.document.body.style.removeProperty("user-select");
  }

  function handleFileBrowserResizePointerDown(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    fileBrowserResizePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setFileBrowserResizing(true);
    window.document.body.style.cursor = "col-resize";
    window.document.body.style.userSelect = "none";
  }

  function handleFileBrowserResizePointerMove(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (fileBrowserResizePointerRef.current !== event.pointerId) return;
    updateFileBrowserSidebarWidth(fileBrowserWidthForPointer(event), false);
  }

  function handleFileBrowserResizePointerUp(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (fileBrowserResizePointerRef.current !== event.pointerId) return;
    finishFileBrowserResize(event, fileBrowserWidthForPointer(event));
  }

  function handleFileBrowserResizePointerCancel(
    event: ReactPointerEvent<HTMLDivElement>,
  ) {
    if (fileBrowserResizePointerRef.current !== event.pointerId) return;
    finishFileBrowserResize(
      event,
      fileBrowserSidebarWidthRef.current,
    );
  }

  function handleFileBrowserResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextWidth =
      displayedFileBrowserSidebarWidth +
      (event.key === "ArrowLeft" ? -16 : 16);
    updateFileBrowserSidebarWidth(
      clampFileBrowserSidebarWidthForAvailableWidth(
        nextWidth,
        fileBrowserWorkbenchWidth,
      ),
      true,
    );
  }

  return (
    <section
      className={`${styles.ide} ${
        variant === "standalone" ? styles.standalone : styles.embedded
      }`}
      aria-label="Sandpi Web IDE"
    >
      {variant === "standalone" ? (
        <header className={styles.topbar} data-tauri-drag-region="deep">
          <a
            href={environmentHref(environment.id, session?.id)}
            className={styles.backLink}
          >
            <ArrowLeft size={14} /> {session ? ui.back : ui.backEnvironment}
          </a>
          <span className={styles.brand}>
            <i /> sandpi <b>/</b> {session?.title ?? environment.name}
          </span>
          <span className={`${styles.liveBadge} ${styles[connection]}`}>
            <Radio size={12} /> {connectionLabel}
          </span>
        </header>
      ) : null}

      <div
        ref={fileBrowserWorkbenchRef}
        className={`${styles.workbench} ${
          fileBrowserSidebarCollapsed ? styles.sidebarCollapsed : ""
        } ${fileBrowserResizing ? styles.resizing : ""}`}
        style={fileBrowserWorkbenchStyle}
      >
        <aside
          id={fileBrowserSidebarId}
          className={styles.sidebar}
          aria-label="Workspace files"
          aria-hidden={fileBrowserSidebarCollapsed || undefined}
          inert={fileBrowserSidebarCollapsed || undefined}
        >
          <header className={styles.sidebarHeader}>
            <span>
              <Folder size={13} aria-hidden="true" />
              {ui.files}
            </span>
            <button
              ref={fileBrowserCollapseButtonRef}
              type="button"
              aria-label={ui.collapseFileBrowser}
              title={ui.collapseFileBrowser}
              aria-controls={fileBrowserSidebarId}
              aria-expanded="true"
              onClick={() => setFileBrowserSidebarCollapsed(true)}
            >
              <PanelLeftClose size={14} aria-hidden="true" />
            </button>
          </header>
          <div className={styles.treeViewport}>
            <div className={styles.treeRoot}>
              {workspaceFiles.length > 0 ? (
                <IdeFileTree
                  key={environment.id}
                  language={language}
                  environmentId={environment.id}
                  sessionId={session?.id}
                  files={workspaceFiles}
                  changes={changesByPath}
                  repositories={repositoriesByRoot}
                  selectedPath={selectedPath}
                  revealRequest={revealRequest}
                  onOpen={openFile}
                  loadedDirectories={loadedDirectories}
                  loadingDirectories={loadingDirectories}
                  directoryErrors={directoryErrors}
                  onExpand={(directoryPath, force) =>
                    void loadDirectory(directoryPath, force)
                  }
                  loadingFolderLabel={ui.loadingFolder}
                  folderUnavailableLabel={ui.folderUnavailable}
                  onDownloadFile={(filePath) =>
                    void downloadWorkspaceFile(filePath)
                  }
                  onCreateEntry={createWorkspaceEntry}
                  onRenameEntry={renameWorkspaceEntry}
                  onDeleteEntry={deleteWorkspaceEntry}
                />
              ) : loading && !snapshot ? (
                <p className={styles.sidebarEmpty}>{ui.loading}</p>
              ) : (
                <p className={styles.sidebarEmpty}>{ui.noFiles}</p>
              )}
            </div>
          </div>
        </aside>

        <div
          className={styles.sidebarResizeHandle}
          role="separator"
          aria-label={ui.resizeFileBrowser}
          aria-orientation="vertical"
          aria-controls={fileBrowserSidebarId}
          aria-valuemin={displayedFileBrowserMinimumWidth}
          aria-valuemax={displayedFileBrowserMaximumWidth}
          aria-valuenow={displayedFileBrowserSidebarWidth}
          aria-valuetext={ui.resizeFileBrowserValue(
            displayedFileBrowserSidebarWidth,
          )}
          title={ui.resizeFileBrowserHelp}
          tabIndex={fileBrowserSidebarCollapsed ? -1 : 0}
          onDoubleClick={() =>
            updateFileBrowserSidebarWidth(
              DEFAULT_FILE_BROWSER_SIDEBAR_WIDTH,
              true,
            )
          }
          onKeyDown={handleFileBrowserResizeKeyDown}
          onPointerDown={handleFileBrowserResizePointerDown}
          onPointerMove={handleFileBrowserResizePointerMove}
          onPointerUp={handleFileBrowserResizePointerUp}
          onPointerCancel={handleFileBrowserResizePointerCancel}
        >
          <span aria-hidden="true" />
        </div>

        <main className={styles.editor}>
          <div className={styles.tabs} role="tablist" aria-label="Open files">
            {fileBrowserSidebarCollapsed ? (
              <button
                ref={fileBrowserExpandButtonRef}
                type="button"
                className={styles.sidebarExpandButton}
                aria-label={ui.expandFileBrowser}
                title={ui.expandFileBrowser}
                aria-controls={fileBrowserSidebarId}
                aria-expanded="false"
                onClick={() => setFileBrowserSidebarCollapsed(false)}
              >
                <PanelLeftOpen size={14} aria-hidden="true" />
              </button>
            ) : null}
            {openPaths.map((filePath) => (
              <button
                type="button"
                role="tab"
                aria-selected={selectedPath === filePath}
                className={selectedPath === filePath ? styles.activeTab : ""}
                key={filePath}
                onClick={() => setSelectedPath(filePath)}
              >
                {fileIcon(filePath)}
                <span>{filePath.split("/").at(-1)}</span>
                {documents[filePath]?.dirty ? (
                  <i className={styles.dirtyDot} title={ui.unsaved} />
                ) : changesByPath.has(filePath) ? (
                  <i className={styles.tabGitState}>
                    {statusCode(changesByPath.get(filePath)!)}
                  </i>
                ) : null}
                <span
                  role="button"
                  tabIndex={0}
                  className={styles.closeTab}
                  aria-label={`Close ${filePath.split("/").at(-1)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(filePath);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      void closeTab(filePath);
                    }
                  }}
                >
                  <X size={11} />
                </span>
              </button>
            ))}
            <span className={styles.tabActions}>
              <button
                type="button"
                aria-label={ui.refresh}
                onClick={() => void refreshWorkspace()}
              >
                <RefreshCw size={13} />
              </button>
              {variant === "embedded" ? (
                <a
                  href={workspaceIdeHref(
                    environment.id,
                    session?.id,
                    selectedPath || undefined,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={ui.openFull}
                  title={ui.openFull}
                >
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </span>
          </div>

          {error ? (
            <div className={styles.error} role="alert">
              <CircleAlert size={14} /> {error}
            </div>
          ) : null}

          {loading && !snapshot && !selectedPath ? (
            <div className={styles.loading} role="status">
              <RefreshCw size={17} /> {ui.loading}
            </div>
          ) : selectedPath ? (
            <div className={styles.document}>
              <header className={styles.documentHeader}>
                <span>
                  {selectedPath.replace("/workspace/", "workspace / ")}
                </span>
                <span className={styles.documentActions}>
                  {selectedFile?.git ? (
                    <b className={`${styles.gitPill} ${styles[selectedFile.git.kind]}`}>
                      {statusCode(selectedFile.git)} · {selectedFile.git.staged ? ui.staged : ""}
                      {selectedFile.git.staged && selectedFile.git.unstaged
                        ? " + "
                        : ""}
                      {selectedFile.git.unstaged ? ui.unstaged : ""}
                    </b>
                  ) : null}
                  {document?.saving ? (
                    <span className={styles.saveState}>{ui.saving}</span>
                  ) : document?.dirty ? (
                    <span className={styles.saveState}>{ui.unsaved}</span>
                  ) : selectedFile?.editable && previewOnly ? (
                    <span className={styles.saveState}>{ui.previewOnly}</span>
                  ) : selectedFile?.editable ? (
                    <span className={styles.saveState}>
                      <Check size={10} /> {ui.saved}
                    </span>
                  ) : selectedFile?.preview ? (
                    <span className={styles.saveState}>{ui.previewOnly}</span>
                  ) : null}
                  {selectedFile?.kind === "text" && selectedFile.editable ? (
                    <button
                      type="button"
                      aria-label={previewOnly ? ui.editMode : ui.previewMode}
                      title={previewOnly ? ui.editMode : ui.previewMode}
                      aria-pressed={previewOnly}
                      onClick={() => setPreviewOnly((current) => !current)}
                    >
                      {previewOnly ? <Pencil size={13} /> : <Eye size={13} />}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={ui.save}
                    title={ui.save}
                    disabled={
                      !selectedFile?.editable ||
                      !document?.dirty ||
                      document.saving ||
                      Boolean(document.conflict)
                    }
                    onClick={() => void saveDocument(selectedPath)}
                  >
                    <Save size={13} />
                  </button>
                </span>
              </header>
              <div className={styles.documentBody}>
                {document?.conflict ? (
                  <div className={styles.conflictBanner} role="alert">
                    <CircleAlert size={13} />
                    <span>{ui.externalChange}</span>
                    <button type="button" onClick={() => toggleComparison(selectedPath)}>
                      {document.comparing ? ui.hideCompare : ui.compare}
                    </button>
                    <button type="button" onClick={() => acceptLatestFile(selectedPath)}>
                      {ui.useLatest}
                    </button>
                    <button
                      type="button"
                      className={styles.overwriteButton}
                      onClick={() =>
                        void saveDocument(selectedPath, document.conflict?.revision)
                      }
                    >
                      {ui.overwrite}
                    </button>
                  </div>
                ) : null}
                {document?.error ? (
                  <div className={styles.documentError} role="alert">
                    <CircleAlert size={13} /> {document.error}
                  </div>
                ) : null}
                {selectedFile?.readOnlyReason &&
                selectedFile.readOnlyReason !== "binary" ? (
                  <div className={styles.readOnlyNotice}>
                    {selectedFile.readOnlyReason === "deleted"
                      ? ui.deletedFile
                      : ui.managedFile}
                  </div>
                ) : null}
                {document?.loading && !selectedFile ? (
                  <div className={styles.loading} role="status">
                    <RefreshCw size={17} /> {ui.loading}
                  </div>
                ) : selectedFile?.preview ? (
                  <WorkspaceFileMediaPreview
                    file={selectedFile}
                    language={language}
                  />
                ) : selectedFile?.kind === "binary" ? (
                  <div className={styles.loading}>{ui.binary}</div>
                ) : selectedFile ? (
                  <div className={styles.code} aria-label={selectedFile.name}>
                    {document?.comparing && document.conflict ? (
                      <WorkspaceConflictDiff
                        modelPath={`sandpi://${environment.id}${selectedPath}`}
                        latest={latestConflictText}
                        local={text}
                        language={monacoLanguage(selectedFile.name)}
                      />
                    ) : (
                      <WorkspaceCodeEditor
                        modelPath={`sandpi://${environment.id}${selectedPath}`}
                        value={text}
                        language={monacoLanguage(selectedFile.name)}
                        readOnly={!selectedFile.editable || previewOnly}
                        lineChanges={document?.dirty ? [] : selectedFile.lineChanges}
                        onChange={(value) => updateDraft(selectedPath, value)}
                        onSave={() => void saveDocument(selectedPath)}
                      />
                    )}
                  </div>
                ) : null}
              </div>
              {document?.loading && selectedFile ? (
                <span className={styles.documentRefreshing}>
                  <RefreshCw size={11} />
                </span>
              ) : null}
            </div>
          ) : (
            <div className={styles.emptyEditor}>
              <FileCode2 size={24} />
              <p>{ui.selectFile}</p>
            </div>
          )}
        </main>
      </div>

      <footer className={styles.statusbar}>
        <span>
          <GitBranch size={12} />
          {statusRepository
            ? `${workspaceRepositoryLabel(statusRepository.root)} · ${
                statusRepository.branch ?? "detached HEAD"
              }`
            : repositories.length > 0
              ? ui.repositories(repositories.length)
              : ui.noRepository}
        </span>
        {statusRepository ? (
          <span>
            <GitCommitHorizontal size={12} />
            {statusRepositoryChanges.length > 0
              ? ui.changes(statusRepositoryChanges.length)
              : ui.clean}
            {statusRepository.ahead > 0 ? ` ↑${statusRepository.ahead}` : ""}
            {statusRepository.behind > 0 ? ` ↓${statusRepository.behind}` : ""}
          </span>
        ) : repositories.length > 0 ? (
          <span>
            <GitCommitHorizontal size={12} />
            {gitChanges.length > 0 ? ui.changes(gitChanges.length) : ui.clean}
          </span>
        ) : null}
        <span className={styles.statusSpacer} />
        {selectedFile ? (
          <span>
            {workspaceFileTypeLabel(selectedFile)}
            {selectedFile.size ? ` · ${selectedFile.size}` : ""}
            {selectedFile.modifiedAt
              ? ` · ${formatUnixTimestamp(
                  selectedFile.modifiedAt,
                  locale,
                  timeZone,
                  { hour: "2-digit", minute: "2-digit", second: "2-digit" },
                )}`
              : ""}
          </span>
        ) : null}
        <span className={`${styles.connection} ${styles[connection]}`}>
          <i /> {connectionLabel}
        </span>
      </footer>
    </section>
  );
}
