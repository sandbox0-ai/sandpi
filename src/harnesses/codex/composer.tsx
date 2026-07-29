"use client";

import {
  AtSign,
  ChevronDown,
  File,
  FileImage,
  Folder,
  LoaderCircle,
  Paperclip,
  Search,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

import {
  codexReasoningEffortLabel,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import { workspaceRelativePath } from "@/harnesses/codex/file-mentions";
import type {
  CodexComposerLocalImage,
  CodexComposerUpload,
} from "@/harnesses/codex/types";
import {
  MAX_CODEX_COMPOSER_UPLOAD_FILES,
  MAX_CODEX_COMPOSER_UPLOAD_BYTES,
} from "@/harnesses/codex/types";
import { EnvironmentResourceStatus } from "@/components/environment-resource-status";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import type { OperationLanguage } from "@/lib/operation-ui";
import type { WorkspaceFileSearchResult } from "@/lib/types";

interface CodexComposerStatus {
  state: "ready" | "loading" | "unavailable";
  label: string;
}

interface CodexComposerToolbarProps {
  language: OperationLanguage;
  environmentId: string;
  agentLabel: string;
  localImages: CodexComposerLocalImage[];
  onLocalImagesChange: Dispatch<SetStateAction<CodexComposerLocalImage[]>>;
  onInsertFileMentions: (filePaths: string[]) => void;
  onAttachmentError: (message: string) => void;
  attachmentDisabled?: boolean;
  modelOptions: CodexModelOption[];
  selectedModel?: CodexModelOption;
  modelPlaceholder: string;
  modelTitle?: string;
  modelDisabled: boolean;
  reasoningDisabled: boolean;
  selectedReasoningEffort: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (effort: string) => void;
  fastEnabled: boolean;
  fastDisabled: boolean;
  onFastEnabledChange: (enabled: boolean) => void;
  mentionOpenRequest?: number;
  contextUsedPercent?: number | null;
  status: CodexComposerStatus;
  action: ReactNode;
}

const composerCopy = {
  en: {
    uploadFiles: "Upload files",
    uploadingFiles: "Uploading files",
    mentionFile: "Mention a Workspace file",
    searchFiles: "Search /workspace",
    typeToSearch: "Type to search /workspace",
    searchingFiles: "Searching Workspace…",
    noFiles: "No matching files",
    searchFailed: "Workspace search is temporarily unavailable.",
    removeReference: (name: string) => `Remove ${name}`,
    attachedImages: "Attached images",
    uploadedFile: "Uploaded file",
    tooManyFiles: `Upload up to ${MAX_CODEX_COMPOSER_UPLOAD_FILES} files at once.`,
    fileTooLarge: "Each uploaded file must be 20 MiB or smaller.",
    uploadFailed: "The selected file could not be uploaded.",
    boundToEnvironment: "Bound to this Environment",
    selectModel: (agent: string) => `Select ${agent} model`,
    selectReasoning: (model: string) => `Select reasoning effort for ${model}`,
    fastMode: (name: string) => `${name} mode`,
    contextUsed: (percent: number) => `Context ${percent}%`,
    contextUsedTitle: (percent: number) =>
      `${percent}% of the current context is used`,
  },
  "zh-CN": {
    uploadFiles: "上传文件",
    uploadingFiles: "正在上传文件",
    mentionFile: "引用工作区文件",
    searchFiles: "搜索 /workspace",
    typeToSearch: "输入内容以搜索 /workspace",
    searchingFiles: "正在搜索工作区…",
    noFiles: "没有匹配文件",
    searchFailed: "工作区搜索暂时不可用。",
    removeReference: (name: string) => `移除 ${name}`,
    attachedImages: "已附加图片",
    uploadedFile: "已上传文件",
    tooManyFiles: `每次最多上传 ${MAX_CODEX_COMPOSER_UPLOAD_FILES} 个文件。`,
    fileTooLarge: "每个上传文件不能超过 20 MiB。",
    uploadFailed: "无法上传所选文件。",
    boundToEnvironment: "绑定到此环境",
    selectModel: (agent: string) => `选择 ${agent} 模型`,
    selectReasoning: (model: string) => `选择 ${model} 的推理深度`,
    fastMode: (name: string) => `${name} 模式`,
    contextUsed: (percent: number) => `上下文 ${percent}%`,
    contextUsedTitle: (percent: number) => `当前上下文已使用 ${percent}%`,
  },
} as const;

const WORKSPACE_FILE_SEARCH_DEBOUNCE_MS = 250;

export function encodeCodexComposerLocalImages(
  localImages: readonly CodexComposerLocalImage[],
) {
  return localImages.map(({ name, path }) => ({ name, path }));
}

export function CodexComposerLocalImages({
  language,
  localImages,
  onRemove,
}: {
  language: OperationLanguage;
  localImages: readonly CodexComposerLocalImage[];
  onRemove?: (id: string) => void;
}) {
  if (localImages.length === 0) return null;
  const copy = composerCopy[language];
  return (
    <div
      className={`composer-file-references ${onRemove ? "" : "is-readonly"}`}
      aria-label={copy.attachedImages}
    >
      {localImages.map((localImage) => {
        return (
          <span
            className="composer-file-reference"
            title={localImage.path}
            key={localImage.id}
          >
            <FileImage size={13} aria-hidden="true" />
            <span>
              <strong>{localImage.name}</strong>
              <small>
                {localImage.source === "workspace"
                  ? workspaceRelativePath(localImage.path)
                  : copy.uploadedFile}
              </small>
            </span>
            {onRemove ? (
              <button
                type="button"
                aria-label={copy.removeReference(localImage.name)}
                title={copy.removeReference(localImage.name)}
                onClick={() => onRemove(localImage.id)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function CodexComposerToolbar({
  language,
  environmentId,
  agentLabel,
  localImages,
  onLocalImagesChange,
  onInsertFileMentions,
  onAttachmentError,
  attachmentDisabled = false,
  modelOptions,
  selectedModel,
  modelPlaceholder,
  modelTitle,
  modelDisabled,
  reasoningDisabled,
  selectedReasoningEffort,
  onModelChange,
  onReasoningEffortChange,
  fastEnabled,
  fastDisabled,
  onFastEnabledChange,
  mentionOpenRequest,
  contextUsedPercent,
  status,
  action,
}: CodexComposerToolbarProps) {
  const copy = composerCopy[language];
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionResults, setMentionResults] = useState<
    WorkspaceFileSearchResult[]
  >([]);
  const [mentionState, setMentionState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const mentionControlRef = useRef<HTMLDivElement>(null);
  const mentionInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const mentionResultsId = useId();

  useEffect(() => {
    setMentionOpen(false);
    setMentionQuery("");
    setMentionResults([]);
    setMentionState("idle");
  }, [environmentId]);

  useEffect(() => {
    if (!mentionOpenRequest) return;
    setMentionOpen(true);
    setMentionQuery("");
    setMentionResults([]);
    setMentionState("idle");
    onAttachmentError("");
  }, [mentionOpenRequest, onAttachmentError]);

  useEffect(() => {
    if (!mentionOpen) return;
    const frame = window.requestAnimationFrame(() =>
      mentionInputRef.current?.focus(),
    );
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !mentionControlRef.current?.contains(event.target)
      ) {
        setMentionOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", close);
    };
  }, [mentionOpen]);

  useEffect(() => {
    if (!mentionOpen) return;
    if (!mentionQuery.trim()) {
      setMentionResults([]);
      setActiveMentionIndex(0);
      setMentionState("idle");
      return;
    }
    const controller = new AbortController();
    setMentionState("loading");
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ query: mentionQuery });
      void apiFetch<ApiEnvelope<WorkspaceFileSearchResult[]>>(
        `/api/v1/environments/${encodeURIComponent(environmentId)}/files/search?${query.toString()}`,
        { signal: controller.signal },
      )
        .then((response) => {
          setMentionResults(response.data);
          setActiveMentionIndex(0);
          setMentionState("ready");
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setMentionResults([]);
            setMentionState("error");
          }
        });
    }, WORKSPACE_FILE_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [environmentId, mentionOpen, mentionQuery]);

  function selectMention(result: WorkspaceFileSearchResult) {
    onAttachmentError("");
    onInsertFileMentions([result.path]);
    setMentionOpen(false);
    setMentionQuery("");
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || uploading) return;
    const available = MAX_CODEX_COMPOSER_UPLOAD_FILES - localImages.length;
    if (available <= 0) {
      onAttachmentError(copy.tooManyFiles);
      return;
    }
    const selected = files.slice(0, available);
    if (
      selected.length < files.length ||
      selected.some(
        (file) => file.size <= 0 || file.size > MAX_CODEX_COMPOSER_UPLOAD_BYTES,
      )
    ) {
      onAttachmentError(
        selected.length < files.length ? copy.tooManyFiles : copy.fileTooLarge,
      );
      return;
    }

    setUploading(true);
    onAttachmentError("");
    try {
      const uploaded: CodexComposerUpload[] = [];
      for (const file of selected) {
        const response = await apiFetch<ApiEnvelope<CodexComposerUpload>>(
          `/api/v1/environments/${encodeURIComponent(environmentId)}/harnesses/codex/uploads`,
          {
            method: "POST",
            body: JSON.stringify({
              name: file.name,
              mimeType: file.type || "application/octet-stream",
              dataBase64: await browserFileBase64(file),
            }),
          },
        );
        uploaded.push(response.data);
      }
      onInsertFileMentions(
        uploaded
          .filter((candidate) => candidate.kind === "file")
          .map((candidate) => candidate.path),
      );
      const uploadedLocalImages: CodexComposerLocalImage[] = uploaded
        .filter((candidate) => candidate.kind === "localImage")
        .map((candidate) => ({ ...candidate, kind: "localImage" as const }));
      if (uploadedLocalImages.length > 0) {
        onLocalImagesChange((current) =>
          [...current, ...uploadedLocalImages].slice(
            0,
            MAX_CODEX_COMPOSER_UPLOAD_FILES,
          ),
        );
      }
    } catch (error) {
      onAttachmentError(
        error instanceof Error ? error.message : copy.uploadFailed,
      );
    } finally {
      setUploading(false);
    }
  }

  const mentionStatus =
    mentionState === "idle"
      ? copy.typeToSearch
      : mentionState === "loading"
        ? copy.searchingFiles
        : mentionState === "error"
          ? copy.searchFailed
          : mentionResults.length === 0
            ? copy.noFiles
            : "";

  return (
    <div className="composer-toolbar codex-composer-toolbar">
      <div className="composer-tools">
        <button
          type="button"
          className="composer-icon-button"
          aria-label={uploading ? copy.uploadingFiles : copy.uploadFiles}
          title={uploading ? copy.uploadingFiles : copy.uploadFiles}
          aria-busy={uploading}
          disabled={attachmentDisabled || uploading}
          onClick={() => uploadInputRef.current?.click()}
        >
          {uploading ? (
            <LoaderCircle
              className="composer-upload-spinner"
              size={16}
              aria-hidden="true"
            />
          ) : (
            <Paperclip size={17} aria-hidden="true" />
          )}
        </button>
        <input
          ref={uploadInputRef}
          className="sr-only"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          data-testid="codex-composer-upload-input"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void uploadFiles(files);
          }}
        />
        <div className="composer-mention-control" ref={mentionControlRef}>
          <button
            type="button"
            className="composer-icon-button"
            aria-label={copy.mentionFile}
            title={copy.mentionFile}
            aria-expanded={mentionOpen}
            aria-controls={mentionResultsId}
            disabled={attachmentDisabled}
            onClick={() => {
              setMentionOpen((open) => !open);
              onAttachmentError("");
            }}
          >
            <AtSign size={17} aria-hidden="true" />
          </button>
          {mentionOpen ? (
            <div className="composer-mention-popover">
              <label className="composer-mention-search">
                <Search size={13} aria-hidden="true" />
                <span className="sr-only">{copy.searchFiles}</span>
                <input
                  ref={mentionInputRef}
                  value={mentionQuery}
                  placeholder={copy.searchFiles}
                  autoComplete="off"
                  onChange={(event) => setMentionQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setMentionOpen(false);
                    } else if (
                      event.key === "ArrowDown" &&
                      mentionResults.length > 0
                    ) {
                      event.preventDefault();
                      setActiveMentionIndex(
                        (index) => (index + 1) % mentionResults.length,
                      );
                    } else if (
                      event.key === "ArrowUp" &&
                      mentionResults.length > 0
                    ) {
                      event.preventDefault();
                      setActiveMentionIndex(
                        (index) =>
                          (index - 1 + mentionResults.length) %
                          mentionResults.length,
                      );
                    } else if (
                      event.key === "Enter" &&
                      mentionResults[activeMentionIndex]
                    ) {
                      event.preventDefault();
                      selectMention(mentionResults[activeMentionIndex]);
                    }
                  }}
                />
              </label>
              <div
                id={mentionResultsId}
                className="composer-mention-results"
                role="listbox"
                aria-label={copy.searchFiles}
              >
                {mentionResults.map((result, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeMentionIndex}
                    className={index === activeMentionIndex ? "is-active" : ""}
                    key={result.path}
                    onPointerMove={() => setActiveMentionIndex(index)}
                    onClick={() => selectMention(result)}
                  >
                    {result.kind === "folder" ? (
                      <Folder size={14} aria-hidden="true" />
                    ) : (
                      <File size={14} aria-hidden="true" />
                    )}
                    <span>
                      <strong>{result.name}</strong>
                      <small>{workspaceRelativePath(result.path)}</small>
                    </span>
                  </button>
                ))}
                {mentionStatus ? (
                  <p
                    className="composer-mention-status"
                    role={mentionState === "error" ? "alert" : "status"}
                  >
                    {mentionState === "loading" ? (
                      <LoaderCircle size={13} aria-hidden="true" />
                    ) : null}
                    {mentionStatus}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <span className="composer-agent-bound" title={copy.boundToEnvironment}>
          <span className="codex-glyph" />
          <span className="composer-harness-label">{agentLabel}</span>
          <label
            className="composer-model-picker"
            title={modelTitle}
            data-availability={modelTitle ? "runtime-unavailable" : "available"}
          >
            <span className="sr-only">{copy.selectModel(agentLabel)}</span>
            <select
              name="coding-agent-model"
              aria-label={copy.selectModel(agentLabel)}
              value={selectedModel?.id ?? ""}
              disabled={modelDisabled}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {modelOptions.length > 0 ? (
                modelOptions.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.displayName}
                  </option>
                ))
              ) : (
                <option value="">{modelPlaceholder}</option>
              )}
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          {selectedModel?.supportedReasoningEfforts.length ? (
            <label
              className="composer-reasoning-picker"
              title={
                selectedModel.supportedReasoningEfforts.find(
                  (option) => option.id === selectedReasoningEffort,
                )?.description
              }
            >
              <span className="sr-only">
                {copy.selectReasoning(selectedModel.displayName)}
              </span>
              <select
                name="coding-agent-reasoning-effort"
                aria-label={copy.selectReasoning(selectedModel.displayName)}
                value={selectedReasoningEffort}
                disabled={reasoningDisabled}
                onChange={(event) =>
                  onReasoningEffortChange(event.target.value)
                }
              >
                {selectedModel.supportedReasoningEfforts.map((effort) => (
                  <option value={effort.id} key={effort.id}>
                    {codexReasoningEffortLabel(effort.id)}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </label>
          ) : null}
          {selectedModel?.fastServiceTier ? (
            <button
              type="button"
              className="composer-fast-toggle"
              data-testid="codex-fast-toggle"
              aria-label={copy.fastMode(selectedModel.fastServiceTier.name)}
              aria-pressed={fastEnabled}
              title={selectedModel.fastServiceTier.description}
              disabled={fastDisabled}
              onClick={() => onFastEnabledChange(!fastEnabled)}
            >
              {selectedModel.fastServiceTier.name}
            </button>
          ) : null}
        </span>
      </div>
      <div className="composer-send-area">
        <EnvironmentResourceStatus
          environmentId={environmentId}
          language={language}
        />
        {contextUsedPercent !== null &&
        contextUsedPercent !== undefined ? (
          <span
            className="composer-context-usage"
            role="meter"
            aria-label={copy.contextUsedTitle(contextUsedPercent)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={contextUsedPercent}
            title={copy.contextUsedTitle(contextUsedPercent)}
          >
            {copy.contextUsed(contextUsedPercent)}
          </span>
        ) : null}
        <span
          className={`connection-copy ${
            status.state === "unavailable"
              ? "is-unavailable"
              : status.state === "loading"
                ? "is-loading"
                : ""
          }`}
        >
          <span />
          {status.label}
        </span>
        {action}
      </div>
    </div>
  );
}

async function browserFileBase64(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("File read failed");
  return dataUrl.slice(separator + 1);
}
