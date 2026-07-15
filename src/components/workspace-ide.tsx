"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Check,
  CircleAlert,
  ExternalLink,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  Radio,
  RefreshCw,
  Save,
  Share2,
  X,
} from "lucide-react";
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
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
import type { OperationLanguage } from "@/lib/operation-ui";
import { formatUnixTimestamp } from "@/lib/time";
import { mergeWorkspaceGitFiles } from "@/lib/workspace-files";
import {
  repositoryForWorkspacePath,
  userVisibleWorkspaceGitState,
  workspaceGitChanges,
  workspaceRepositoryLabel,
} from "@/lib/workspace-git";
import { userVisibleWorkspacePath } from "@/lib/workspace-path-policy";
import type {
  CodingSession,
  WorkspaceFile,
  WorkspaceGitFileChange,
  WorkspaceGitRepository,
  WorkspaceIdeEvent,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
  WorkspaceIdeWriteRequest,
} from "@/lib/types";

import styles from "./workspace-ide.module.css";

interface WorkspaceIdeProps {
  language: OperationLanguage;
  timeZone: string;
  session: CodingSession;
  variant: "embedded" | "standalone";
  initialSnapshot?: WorkspaceIdeSnapshot;
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

const WorkspaceCodeEditor = dynamic(
  () =>
    import("./workspace-code-editor").then((module) => module.WorkspaceCodeEditor),
  { ssr: false, loading: () => <span>Loading editor…</span> },
);
const WorkspaceConflictDiff = dynamic(
  () =>
    import("./workspace-code-editor").then((module) => module.WorkspaceConflictDiff),
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
    openFull: "Open full Web IDE",
    share: (name: string) => `Share ${name}`,
    shareFuture: "File sharing requires the future scoped-grant API.",
    back: "Back to Session",
    binary: "Binary files cannot be rendered as text.",
    deletedFile: "Deleted files are read-only. Restore them from Git before editing.",
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
    discardClose: "Discard the unsaved changes and close this file?",
    reloadDiscard: "Discard unsaved changes and reload the Workspace?",
    loading: "Loading Workspace…",
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
    openFull: "在完整 Web IDE 中打开",
    share: (name: string) => `分享 ${name}`,
    shareFuture: "文件分享需要后续的 scoped-grant API。",
    back: "返回 Session",
    binary: "二进制文件无法按文本显示。",
    deletedFile: "已删除文件为只读；请先通过 Git 恢复后再编辑。",
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
    discardClose: "放弃未保存修改并关闭此文件？",
    reloadDiscard: "放弃未保存修改并刷新 Workspace？",
    loading: "正在加载 Workspace…",
    selectFile: "从 workspace 中选择文件。",
    staged: "已暂存",
    unstaged: "工作区",
  },
} as const;

function flattenFiles(files: WorkspaceFile[]): WorkspaceFile[] {
  return files.flatMap((file) => [
    file,
    ...(file.children ? flattenFiles(file.children) : []),
  ]);
}

function fileIcon(fileName: string, folder = false, open = false) {
  if (folder) return open ? <FolderOpen size={14} /> : <Folder size={14} />;
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
  const raw = window.atob(content);
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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

export function workspaceIdeHref(session: CodingSession, filePath?: string) {
  const search = new URLSearchParams({
    environment: session.environmentId,
    session: session.id,
  });
  const visibleFilePath = filePath
    ? userVisibleWorkspacePath(filePath)
    : undefined;
  if (visibleFilePath) search.set("path", visibleFilePath);
  return `/ide/?${search.toString()}`;
}

function sessionHref(session: CodingSession) {
  const search = new URLSearchParams({
    environment: session.environmentId,
    session: session.id,
  });
  return `/?${search.toString()}`;
}

function IdeFileTree({
  files,
  changes,
  repositories,
  selectedPath,
  onOpen,
}: {
  files: WorkspaceFile[];
  changes: Map<string, WorkspaceGitFileChange>;
  repositories: Map<string, WorkspaceGitRepository>;
  selectedPath: string;
  onOpen: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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

  function render(items: WorkspaceFile[], depth: number) {
    return items.map((file) => {
      const folder = file.kind === "folder";
      const isCollapsed = collapsed[file.path] ?? false;
      const change = changes.get(file.path);
      const repository = repositories.get(file.path);
      const descendantCount = changedDescendants.get(file.path) ?? 0;
      return (
        <div key={file.path}>
          <button
            type="button"
            className={`${styles.treeRow} ${
              file.path === selectedPath ? styles.selected : ""
            } ${change?.kind === "deleted" ? styles.deletedFile : ""}`}
            style={{ paddingLeft: `${7 + depth * 13}px` }}
            title={file.path}
            onClick={() => {
              if (folder) {
                setCollapsed((current) => ({
                  ...current,
                  [file.path]: !isCollapsed,
                }));
              } else {
                onOpen(file.path);
              }
            }}
          >
            <span className={styles.disclosure}>
              {folder ? (
                isCollapsed ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )
              ) : null}
            </span>
            <span className={styles.fileIcon}>
              {fileIcon(file.name, folder, !isCollapsed)}
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
          {folder && !isCollapsed && file.children
            ? render(file.children, depth + 1)
            : null}
        </div>
      );
    });
  }

  return <>{render(files, 0)}</>;
}

export function WorkspaceIde({
  language,
  timeZone,
  session,
  variant,
  initialSnapshot,
}: WorkspaceIdeProps) {
  const ui = copy[language];
  const [snapshot, setSnapshot] = useState<WorkspaceIdeSnapshot | undefined>(
    initialSnapshot,
  );
  const [documents, setDocuments] = useState<Record<string, DocumentState>>({});
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "polling" | "offline"
  >("connecting");
  const documentsRef = useRef(documents);
  const openPathsRef = useRef(openPaths);
  const pendingPathsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);

  const loadDocument = useCallback(
    async (filePath: string, reason: "open" | "external" | "reload" = "open") => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return;
      setDocuments((current) => ({
        ...current,
        [visiblePath]: {
          ...current[visiblePath],
          loading: reason !== "external" || !current[visiblePath]?.data,
          error: undefined,
        },
      }));
      try {
        const query = new URLSearchParams({ path: visiblePath });
        const response = await apiFetch<ApiEnvelope<WorkspaceIdeFile>>(
          `/api/v1/sessions/${encodeURIComponent(session.id)}/ide/file?${query.toString()}`,
        );
        const responsePath = userVisibleWorkspacePath(response.data.path);
        if (!responsePath || responsePath !== visiblePath) {
          throw new Error("Workspace returned an internal or unexpected file path.");
        }
        const responseData = { ...response.data, path: responsePath };
        setDocuments((current) => ({
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
        }));
      } catch (cause) {
        setDocuments((current) => ({
          ...current,
          [visiblePath]: {
            ...current[visiblePath],
            loading: false,
            error: cause instanceof Error ? cause.message : "File unavailable",
          },
        }));
      }
    },
    [session.id],
  );

  const refreshSnapshot = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await apiFetch<ApiEnvelope<WorkspaceIdeSnapshot>>(
          `/api/v1/sessions/${encodeURIComponent(session.id)}/ide`,
        );
        setSnapshot(response.data);
        setError("");
      } catch (cause) {
        if (!silent) {
          setError(
            cause instanceof Error ? cause.message : "Workspace unavailable",
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [session.id],
  );

  useEffect(() => {
    setSnapshot(initialSnapshot);
    setDocuments({});
    setOpenPaths([]);
    setSelectedPath("");
    setError("");
    if (initialSnapshot) setLoading(false);
    else void refreshSnapshot();
  }, [initialSnapshot, refreshSnapshot, session.id]);

  const visibleGit = useMemo(
    () => userVisibleWorkspaceGitState(snapshot?.git),
    [snapshot?.git],
  );
  const repositories = visibleGit.repositories;
  const gitChanges = useMemo(
    () => workspaceGitChanges(visibleGit),
    [visibleGit],
  );
  const workspaceFiles = useMemo(
    () => mergeWorkspaceGitFiles(snapshot?.files ?? [], gitChanges),
    [gitChanges, snapshot?.files],
  );
  const allFiles = useMemo(() => flattenFiles(workspaceFiles), [workspaceFiles]);
  const changesByPath = useMemo(
    () => new Map(gitChanges.map((change) => [change.path, change])),
    [gitChanges],
  );
  const repositoriesByRoot = useMemo(
    () => new Map(repositories.map((repository) => [repository.root, repository])),
    [repositories],
  );

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
      if (!visiblePath) return;
      setOpenPaths((current) =>
        current.includes(visiblePath) ? current : [...current, visiblePath],
      );
      setSelectedPath(visiblePath);
      if (!documents[visiblePath]?.data && !documents[visiblePath]?.loading) {
        void loadDocument(visiblePath);
      }
    },
    [documents, loadDocument],
  );

  useEffect(() => {
    if (!snapshot || selectedPath) return;
    const requestedPathValue =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("path") ?? "";
    const requestedPath = userVisibleWorkspacePath(requestedPathValue) ?? "";
    const firstFile = allFiles.find((file) => file.kind === "file")?.path;
    const initialPath =
      (requestedPath &&
      (allFiles.some((file) => file.path === requestedPath) ||
        changesByPath.has(requestedPath))
        ? requestedPath
        : undefined) ??
      gitChanges.find(
        (change) =>
          change.kind !== "deleted" && change.kind !== "untracked",
      )?.path ??
      gitChanges.find((change) => change.kind !== "deleted")?.path ??
      gitChanges[0]?.path ??
      firstFile;
    if (initialPath) openFile(initialPath);
  }, [
    allFiles,
    changesByPath,
    gitChanges,
    openFile,
    selectedPath,
    snapshot,
  ]);

  useEffect(() => {
    if (variant !== "standalone") return;
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
  }, [selectedPath, variant]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry = 0;
    let pollingFallback = false;
    let pollingTimer: number | undefined;

    const scheduleRefresh = (filePath: string) => {
      const visiblePath = userVisibleWorkspacePath(filePath);
      if (!visiblePath) return;
      pendingPathsRef.current.add(visiblePath);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        const changedPaths = [...pendingPathsRef.current];
        pendingPathsRef.current.clear();
        void refreshSnapshot(true);
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
      }, 180);
    };

    const stopPolling = () => {
      if (pollingTimer === undefined) return;
      window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    };

    const startPolling = () => {
      if (disposed || pollingTimer !== undefined) return;
      scheduleRefresh("/workspace");
      pollingTimer = window.setInterval(
        () => scheduleRefresh("/workspace"),
        3_000,
      );
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
          `/api/v1/sessions/${encodeURIComponent(session.id)}/ide/events`,
        ),
      );
      socket.addEventListener("message", (message) => {
        try {
          const event = JSON.parse(message.data as string) as WorkspaceIdeEvent;
          if (event.type === "ready") {
            retry = 0;
            pollingFallback = false;
            stopPolling();
            setError("");
            setConnection("live");
          } else if (event.type === "change") {
            scheduleRefresh(event.path);
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
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [loadDocument, refreshSnapshot, session.id]);

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
        `/api/v1/sessions/${encodeURIComponent(session.id)}/ide/file?${query.toString()}`,
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
      await refreshSnapshot(true);
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
    if (dirty && !window.confirm(ui.reloadDiscard)) return;
    await refreshSnapshot();
    await Promise.all(
      openPathsRef.current.map((filePath) => loadDocument(filePath, "reload")),
    );
  }

  function closeTab(filePath: string) {
    if (
      documentsRef.current[filePath]?.dirty &&
      !window.confirm(ui.discardClose)
    ) {
      return;
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

  return (
    <section
      className={`${styles.ide} ${
        variant === "standalone" ? styles.standalone : styles.embedded
      }`}
      aria-label="Sandpi Web IDE"
    >
      {variant === "standalone" ? (
        <header className={styles.topbar}>
          <a href={sessionHref(session)} className={styles.backLink}>
            <ArrowLeft size={14} /> {ui.back}
          </a>
          <span className={styles.brand}>
            <i /> sandpi <b>/</b> {session.title}
          </span>
          <span className={`${styles.liveBadge} ${styles[connection]}`}>
            <Radio size={12} /> {connectionLabel}
          </span>
        </header>
      ) : null}

      <div className={styles.workbench}>
        <aside className={styles.sidebar} aria-label="Workspace files">
          <div className={styles.treeRoot}>
            {workspaceFiles.length > 0 ? (
              <IdeFileTree
                files={workspaceFiles}
                changes={changesByPath}
                repositories={repositoriesByRoot}
                selectedPath={selectedPath}
                onOpen={openFile}
              />
            ) : (
              <p className={styles.sidebarEmpty}>{ui.noFiles}</p>
            )}
          </div>
        </aside>

        <main className={styles.editor}>
          <div className={styles.tabs} role="tablist" aria-label="Open files">
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
                    closeTab(filePath);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeTab(filePath);
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
                  href={workspaceIdeHref(session, selectedPath || undefined)}
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

          {loading && !snapshot ? (
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
                  ) : selectedFile?.editable ? (
                    <span className={styles.saveState}>
                      <Check size={10} /> {ui.saved}
                    </span>
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
                  <button
                    type="button"
                    aria-label={ui.share(selectedFile?.name ?? selectedPath)}
                    title={ui.shareFuture}
                    disabled
                  >
                    <Share2 size={13} />
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
                {selectedFile?.readOnlyReason ? (
                  <div className={styles.readOnlyNotice}>
                    {selectedFile.readOnlyReason === "deleted"
                      ? ui.deletedFile
                      : ui.binary}
                  </div>
                ) : null}
                {document?.loading && !selectedFile ? (
                  <div className={styles.loading} role="status">
                    <RefreshCw size={17} /> {ui.loading}
                  </div>
                ) : selectedFile?.kind === "binary" ? (
                  <div className={styles.loading}>{ui.binary}</div>
                ) : selectedFile ? (
                  <div className={styles.code} aria-label={selectedFile.name}>
                    {document?.comparing && document.conflict ? (
                      <WorkspaceConflictDiff
                        modelPath={`sandpi://${session.id}${selectedPath}`}
                        latest={latestConflictText}
                        local={text}
                        language={monacoLanguage(selectedFile.name)}
                      />
                    ) : (
                      <WorkspaceCodeEditor
                        modelPath={`sandpi://${session.id}${selectedPath}`}
                        value={text}
                        language={monacoLanguage(selectedFile.name)}
                        readOnly={!selectedFile.editable}
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
            {languageLabel(selectedFile.name)}
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
