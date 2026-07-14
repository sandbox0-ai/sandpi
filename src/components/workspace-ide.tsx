"use client";

import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
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
  Share2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiFetch, apiWebSocketUrl, type ApiEnvelope } from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";
import { formatUnixTimestamp } from "@/lib/time";
import { mergeWorkspaceGitFiles } from "@/lib/workspace-files";
import type {
  CodingSession,
  WorkspaceFile,
  WorkspaceGitFileChange,
  WorkspaceIdeEvent,
  WorkspaceIdeFile,
  WorkspaceIdeSnapshot,
  WorkspaceLineChange,
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
  loading: boolean;
  error?: string;
}

const copy = {
  en: {
    changes: (count: number) => `${count} uncommitted ${count === 1 ? "file" : "files"}`,
    clean: "Working tree clean",
    noRepository: "This Workspace is not a Git repository",
    noFiles: "No files in /workspace",
    live: "Live",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    offline: "Disconnected",
    refresh: "Refresh Workspace",
    openFull: "Open full Web IDE",
    share: (name: string) => `Share ${name}`,
    shareFuture: "File sharing requires the future scoped-grant API.",
    back: "Back to Session",
    binary: "Binary files cannot be rendered as text.",
    deleted: (count: number) => `${count} deleted ${count === 1 ? "line" : "lines"}`,
    loading: "Loading Workspace…",
    selectFile: "Select a file from workspace.",
    staged: "staged",
    unstaged: "working tree",
  },
  "zh-CN": {
    changes: (count: number) => `${count} 个未提交文件`,
    clean: "工作区干净",
    noRepository: "此 Workspace 不是 Git 仓库",
    noFiles: "/workspace 中没有文件",
    live: "实时",
    connecting: "正在连接",
    reconnecting: "正在重连",
    offline: "已断开",
    refresh: "刷新 Workspace",
    openFull: "在完整 Web IDE 中打开",
    share: (name: string) => `分享 ${name}`,
    shareFuture: "文件分享需要后续的 scoped-grant API。",
    back: "返回 Session",
    binary: "二进制文件无法按文本显示。",
    deleted: (count: number) => `删除了 ${count} 行`,
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

export function workspaceIdeHref(session: CodingSession, filePath?: string) {
  const search = new URLSearchParams({
    environment: session.environmentId,
    session: session.id,
  });
  if (filePath) search.set("path", filePath);
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
  selectedPath,
  onOpen,
}: {
  files: WorkspaceFile[];
  changes: Map<string, WorkspaceGitFileChange>;
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

function EditorLines({
  content,
  changes,
  deletedLabel,
  stagedLabel,
  unstagedLabel,
}: {
  content: string;
  changes: WorkspaceLineChange[];
  deletedLabel: (count: number) => string;
  stagedLabel: string;
  unstagedLabel: string;
}) {
  const lineChanges = new Map<number, WorkspaceLineChange>();
  const before = new Map<number, WorkspaceLineChange>();
  const after = new Map<number, WorkspaceLineChange>();
  for (const change of changes) {
    if (change.placement === "before") before.set(change.line, change);
    else if (change.placement === "after") after.set(change.line, change);
    else lineChanges.set(change.line, change);
  }

  function deletion(change: WorkspaceLineChange | undefined, key: string) {
    if (!change?.deletedLines) return null;
    return (
      <span className={styles.deletedLines} key={key}>
        <i /> {deletedLabel(change.deletedLines)}
      </span>
    );
  }

  return content.split("\n").map((line, index) => {
    const lineNumber = index + 1;
    const change = lineChanges.get(lineNumber);
    const source = change
      ? `${change.staged ? stagedLabel : ""}${
          change.staged && change.unstaged ? " + " : ""
        }${change.unstaged ? unstagedLabel : ""}`
      : undefined;
    return (
      <span className={styles.lineGroup} key={lineNumber}>
        {deletion(before.get(lineNumber), `before-${lineNumber}`)}
        <span
          className={`${styles.codeLine} ${
            change ? styles[`line-${change.kind}`] : ""
          }`}
          title={source}
        >
          <i className={styles.changeGutter} aria-hidden="true" />
          <b>{lineNumber}</b>
          <code>{line || " "}</code>
        </span>
        {deletion(after.get(lineNumber), `after-${lineNumber}`)}
      </span>
    );
  });
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
    "connecting" | "live" | "reconnecting" | "offline"
  >("connecting");
  const openPathsRef = useRef(openPaths);
  const pendingPathsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    openPathsRef.current = openPaths;
  }, [openPaths]);

  const loadDocument = useCallback(
    async (filePath: string) => {
      setDocuments((current) => ({
        ...current,
        [filePath]: { ...current[filePath], loading: true, error: undefined },
      }));
      try {
        const query = new URLSearchParams({ path: filePath });
        const response = await apiFetch<ApiEnvelope<WorkspaceIdeFile>>(
          `/api/v1/sessions/${encodeURIComponent(session.id)}/ide/file?${query.toString()}`,
        );
        setDocuments((current) => ({
          ...current,
          [filePath]: { data: response.data, loading: false },
        }));
      } catch (cause) {
        setDocuments((current) => ({
          ...current,
          [filePath]: {
            ...current[filePath],
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
        setError(
          cause instanceof Error ? cause.message : "Workspace unavailable",
        );
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

  const gitChanges = useMemo(() => snapshot?.git.files ?? [], [snapshot?.git.files]);
  const workspaceFiles = useMemo(
    () => mergeWorkspaceGitFiles(snapshot?.files ?? [], gitChanges),
    [gitChanges, snapshot?.files],
  );
  const allFiles = useMemo(() => flattenFiles(workspaceFiles), [workspaceFiles]);
  const changesByPath = useMemo(
    () => new Map(gitChanges.map((change) => [change.path, change])),
    [gitChanges],
  );

  const openFile = useCallback(
    (filePath: string) => {
      setOpenPaths((current) =>
        current.includes(filePath) ? current : [...current, filePath],
      );
      setSelectedPath(filePath);
      if (!documents[filePath]?.data && !documents[filePath]?.loading) {
        void loadDocument(filePath);
      }
    },
    [documents, loadDocument],
  );

  useEffect(() => {
    if (!snapshot || selectedPath) return;
    const requestedPath =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("path") ?? "";
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
    if (variant !== "standalone" || !selectedPath) return;
    const url = new URL(window.location.href);
    url.searchParams.set("path", selectedPath);
    window.history.replaceState(window.history.state, "", url);
  }, [selectedPath, variant]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry = 0;

    const scheduleRefresh = (filePath: string) => {
      pendingPathsRef.current.add(filePath);
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
            void loadDocument(openPath);
          }
        }
      }, 180);
    };

    const connect = () => {
      if (disposed) return;
      setConnection(retry === 0 ? "connecting" : "reconnecting");
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
            setConnection("live");
          } else if (event.type === "change") {
            scheduleRefresh(event.path);
          } else if (event.type === "error") {
            setError(event.error);
          }
        } catch {
          setError("Workspace event stream returned invalid data.");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        retry += 1;
        setConnection(retry > 5 ? "offline" : "reconnecting");
        reconnectTimerRef.current = window.setTimeout(
          connect,
          Math.min(5_000, 500 * 2 ** Math.min(retry, 4)),
        );
      });
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    return () => {
      disposed = true;
      socket?.close();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [loadDocument, refreshSnapshot, session.id]);

  function closeTab(filePath: string) {
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
    selectedFile?.kind === "text" ? decodeBase64(selectedFile.content) : "";
  const locale = language === "zh-CN" ? "zh-CN" : "en-US";
  const connectionLabel = {
    connecting: ui.connecting,
    live: ui.live,
    reconnecting: ui.reconnecting,
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
                {changesByPath.has(filePath) ? <i className={styles.dirtyDot} /> : null}
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
                onClick={() => void refreshSnapshot()}
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
              {document?.loading && !selectedFile ? (
                <div className={styles.loading} role="status">
                  <RefreshCw size={17} /> {ui.loading}
                </div>
              ) : document?.error ? (
                <div className={styles.loading} role="alert">
                  <CircleAlert size={16} /> {document.error}
                </div>
              ) : selectedFile?.kind === "binary" ? (
                <div className={styles.loading}>{ui.binary}</div>
              ) : selectedFile ? (
                <pre className={styles.code} aria-label={selectedFile.name}>
                  <EditorLines
                    content={text}
                    changes={selectedFile.lineChanges}
                    deletedLabel={ui.deleted}
                    stagedLabel={ui.staged}
                    unstagedLabel={ui.unstaged}
                  />
                </pre>
              ) : null}
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
          {snapshot?.git.isRepository
            ? snapshot.git.branch ?? "detached HEAD"
            : ui.noRepository}
        </span>
        {snapshot?.git.isRepository ? (
          <span>
            <GitCommitHorizontal size={12} />
            {snapshot.git.files.length > 0
              ? ui.changes(snapshot.git.files.length)
              : ui.clean}
            {snapshot.git.ahead > 0 ? ` ↑${snapshot.git.ahead}` : ""}
            {snapshot.git.behind > 0 ? ` ↓${snapshot.git.behind}` : ""}
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
