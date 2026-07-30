"use client";

import Image from "next/image";
import {
  ArrowUp,
  BookOpenText,
  GitFork,
  KeyRound,
  LockKeyhole,
  LoaderCircle,
  Menu,
  PanelLeftOpen,
  PanelRight,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  EnvironmentSettingsOpenOptions,
  EnvironmentSettingsTab,
} from "@/components/environment-settings";
import {
  CodexComposerLocalImages,
  CodexComposerToolbar,
  encodeCodexComposerLocalImages,
} from "@/harnesses/codex/composer";
import { insertCodexFileMentions } from "@/harnesses/codex/file-mentions";
import {
  CodexSlashCommandMenu,
  useCodexSlashCommandMenu,
} from "@/harnesses/codex/slash-command-menu";
import {
  CODEX_INIT_COMMAND_PROMPT,
  parseCodexSlashInvocation,
  type CodexSlashCommand,
} from "@/harnesses/codex/slash-commands";
import {
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import type {
  CodexComposerImage,
  CodexComposerLocalImage,
  CodexSession,
} from "@/harnesses/codex/types";
import {
  clipboardCodexImageFiles,
  encodeCodexComposerImage,
  MAX_CODEX_COMPOSER_IMAGES,
  readCodexComposerImage,
  selectCodexImageFiles,
  type CodexImageSelectionIssue,
} from "@/harnesses/codex/composer-images";
import {
  codexModelOptionsFromNativeResult,
  codexReasoningEffortForModel,
  reconcileCodexComposerPreference,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import {
  CodexNativeCommandDialog,
  type CodexNativeDialogMode,
} from "@/harnesses/codex/native-command-dialog";
import { parseCodexTokenUsageView } from "@/harnesses/codex/token-usage";
import { ensureWorkspaceAgentsFile } from "@/harnesses/codex/workspace-agents";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
import { consumePendingGuestPrompt } from "@/lib/auth-navigation";
import {
  codingAgentComposerPreference,
  rememberCodingAgentComposerPreference,
} from "@/lib/local-ui-preferences";
import type { Environment } from "@/lib/types";

import styles from "@/components/new-session-workspace.module.css";

interface NewSessionWorkspaceProps {
  language: OperationLanguage;
  sendShortcut: SendShortcut;
  environment: Environment;
  canManageEnvironment: boolean;
  onEnvironmentChange: (environment: Environment) => void;
  onCreated: (session: CodexSession) => void;
  initialTitle?: string;
  sessionStartSource?: "startup" | "clear";
  onOpenAgentHarnessSettings: () => void;
  onOpenEnvironmentSettings: (
    tab: EnvironmentSettingsTab,
    options?: EnvironmentSettingsOpenOptions,
  ) => void;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenWorkspacePath: (path: string) => void;
}

interface CreateCodexSessionOptions {
  instruction?: string;
  collaborationMode?: "plan";
  bypassSlash?: boolean;
  restorePrompt?: string;
}

export function CodexNewSessionWorkspace({
  language,
  sendShortcut,
  environment,
  canManageEnvironment,
  onEnvironmentChange,
  onCreated,
  initialTitle,
  sessionStartSource,
  onOpenAgentHarnessSettings,
  onOpenEnvironmentSettings,
  onToggleSidebar,
  inspectorOpen,
  onToggleInspector,
  terminalOpen,
  onToggleTerminal,
  onOpenWorkspacePath,
}: NewSessionWorkspaceProps) {
  const ui = getCodexUiCopy(language).newSession;
  const [prompt, setPrompt] = useState("");
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelOptions, setModelOptions] = useState<CodexModelOption[]>([]);
  const [reasoningEfforts, setReasoningEfforts] = useState<
    Record<string, string>
  >({});
  const [modelCatalogState, setModelCatalogState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [modelCatalogError, setModelCatalogError] = useState("");
  const [creating, setCreating] = useState(false);
  const [retryingEnvironment, setRetryingEnvironment] = useState(false);
  const [openingAgentsFile, setOpeningAgentsFile] = useState(false);
  const [error, setError] = useState("");
  const [commandNotice, setCommandNotice] = useState<{
    tone: "info" | "error";
    message: string;
  } | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [fastMode, setFastMode] = useState(false);
  const [mentionOpenRequest, setMentionOpenRequest] = useState(0);
  const [nativeDialog, setNativeDialog] = useState<{
    mode: CodexNativeDialogMode;
    usageView?: "daily" | "weekly" | "cumulative";
  }>();
  const [images, setImages] = useState<CodexComposerImage[]>([]);
  const [localImages, setLocalImages] = useState<CodexComposerLocalImage[]>([]);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const selectedModel = modelOptions.find(
    (model) => model.id === selectedModelId,
  );
  const selectedReasoningEffort = codexReasoningEffortForModel(
    selectedModel,
    selectedModel ? reasoningEfforts[selectedModel.id] : undefined,
  );
  const slashMenu = useCodexSlashCommandMenu({
    value: prompt,
    context: "new-session",
    onComplete: setComposerPrompt,
    onExecute: (command) => void executeSlashCommand(command, ""),
  });

  useEffect(() => {
    if (!window.matchMedia("(min-width: 641px)").matches) {
      return;
    }
    const focusFrame = window.requestAnimationFrame(() =>
      promptRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  useEffect(() => {
    try {
      const pendingPrompt = consumePendingGuestPrompt(window.sessionStorage);
      if (pendingPrompt) {
        setPrompt((current) => current || pendingPrompt);
      }
    } catch {
      // Restricted browser contexts can disable sessionStorage. The regular
      // authenticated composer remains fully usable without the guest draft.
    }
  }, []);

  useEffect(() => {
    setSelectedModelId("");
    setModelOptions([]);
    setReasoningEfforts({});
    setModelCatalogError("");
    setModelCatalogState("idle");
    setCommandNotice(null);
    setPlanMode(false);
    setFastMode(false);
    setMentionOpenRequest(0);
    if (
      environment.status !== "ready" ||
      environment.codingAgent.status !== "connected"
    ) {
      return;
    }
    setModelCatalogState("loading");
    const controller = new AbortController();
    // Capability discovery intentionally starts the Environment-native coding
    // agent. A stale login-time cache or Sandpi-owned default must never make a
    // model or reasoning option appear available.
    void apiFetch<ApiEnvelope<unknown>>(
      `/api/v1/environments/${encodeURIComponent(environment.id)}/harnesses/codex/models`,
      { signal: controller.signal },
    )
      .then((response) => {
        const models = codexModelOptionsFromNativeResult(response.data);
        const preference = codingAgentComposerPreference({
          environmentId: environment.id,
          harness: environment.codingAgent.harness,
        });
        const selection = reconcileCodexComposerPreference(models, preference);
        if (!selection.model) throw new Error(ui.modelListEmpty);
        setModelOptions(models);
        setSelectedModelId(selection.model.id);
        setReasoningEfforts(selection.reasoningEfforts);
        setModelCatalogState("ready");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setModelCatalogError(
            cause instanceof Error ? cause.message : ui.modelListFailed,
          );
          setModelCatalogState("error");
        }
      });
    return () => controller.abort();
  }, [
    environment.codingAgent.harness,
    environment.codingAgent.status,
    environment.id,
    environment.status,
    ui.modelListEmpty,
    ui.modelListFailed,
  ]);

  function rememberComposerPreference(
    modelId: string,
    nextReasoningEfforts: Record<string, string>,
  ) {
    rememberCodingAgentComposerPreference({
      environmentId: environment.id,
      harness: environment.codingAgent.harness,
      modelId,
      reasoningEfforts: nextReasoningEfforts,
    });
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
    setSelectedModelId(model.id);
    if (!model.fastServiceTier) setFastMode(false);
    setReasoningEfforts(nextReasoningEfforts);
    rememberComposerPreference(model.id, nextReasoningEfforts);
  }

  function selectReasoningEffort(effort: string) {
    if (!selectedModel) return;
    const nextReasoningEfforts = {
      ...reasoningEfforts,
      [selectedModel.id]: effort,
    };
    setReasoningEfforts(nextReasoningEfforts);
    rememberComposerPreference(selectedModel.id, nextReasoningEfforts);
  }

  function insertFileMentions(filePaths: string[]) {
    if (filePaths.length === 0) return;
    const textarea = promptRef.current;
    const insertion = insertCodexFileMentions(
      textarea?.value ?? prompt,
      filePaths,
      textarea?.selectionStart ?? Number.POSITIVE_INFINITY,
      textarea?.selectionEnd ?? Number.POSITIVE_INFINITY,
    );
    setPrompt(insertion.text);
    setError("");
    window.requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(insertion.cursor, insertion.cursor);
    });
  }

  function setComposerPrompt(value: string) {
    setPrompt(value);
    window.requestAnimationFrame(() => {
      const textarea = promptRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  }

  function clearComposerPrompt() {
    setPrompt("");
    window.requestAnimationFrame(() => promptRef.current?.focus());
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

  async function executeSlashCommand(
    command: CodexSlashCommand,
    argumentsValue: string,
  ) {
    clearComposerPrompt();
    setCommandNotice(null);
    setError("");
    if (command.intent === "composer.mention") {
      setMentionOpenRequest((request) => request + 1);
      return;
    }
    if (command.intent === "environment.skills") {
      onOpenEnvironmentSettings("skills");
      return;
    }
    if (command.intent === "environment.mcp") {
      if (argumentsValue && argumentsValue.toLowerCase() !== "verbose") {
        setCommandNotice({
          tone: "error",
          message:
            language === "zh-CN"
              ? "/mcp 仅支持可选参数 verbose。"
              : "/mcp only accepts the optional verbose argument.",
        });
        return;
      }
      onOpenEnvironmentSettings("mcp", {
        mcpVerbose: argumentsValue.toLowerCase() === "verbose",
      });
      return;
    }
    if (command.intent === "environment.network") {
      onOpenEnvironmentSettings("network");
      return;
    }
    if (command.intent === "environment.credentials") {
      onOpenEnvironmentSettings("credentials");
      return;
    }
    if (
      command.intent === "codex.personality" ||
      command.intent === "codex.memories" ||
      command.intent === "codex.hooks"
    ) {
      setNativeDialog({
        mode:
          command.intent === "codex.personality"
            ? "personality"
            : command.intent === "codex.memories"
              ? "memories"
              : "hooks",
      });
      return;
    }
    if (command.intent === "codex.usage") {
      const view = parseCodexTokenUsageView(argumentsValue);
      if (!view) {
        setCommandNotice({
          tone: "error",
          message:
            language === "zh-CN"
              ? "/usage 参数必须是 daily、weekly 或 cumulative。"
              : "/usage expects daily, weekly, or cumulative.",
        });
        return;
      }
      setNativeDialog({ mode: "usage", usageView: view });
      return;
    }
    if (command.intent === "composer.plan") {
      setPlanMode(true);
      if (argumentsValue) {
        await createSession({
          instruction: argumentsValue,
          collaborationMode: "plan",
          bypassSlash: true,
          restorePrompt: `/plan ${argumentsValue}`,
        });
      } else {
        setCommandNotice({
          tone: "info",
          message:
            language === "zh-CN"
              ? "计划模式已开启，将应用到新 Session。"
              : "Plan mode is active for the new Session.",
        });
      }
      return;
    }
    if (command.intent === "codex.init") {
      await createSession({
        instruction: CODEX_INIT_COMMAND_PROMPT,
        bypassSlash: true,
        restorePrompt: "/init",
      });
    }
  }

  async function createSession(options: CreateCodexSessionOptions = {}) {
    if (!options.bypassSlash) {
      const invocation = parseCodexSlashInvocation(prompt, "new-session");
      if (invocation.kind === "command") {
        await executeSlashCommand(invocation.command, invocation.arguments);
        return;
      }
      if (invocation.kind === "unknown") {
        setCommandNotice({
          tone: "error",
          message:
            language === "zh-CN"
              ? `未知命令 /${invocation.name}。输入 / 查看可用命令。`
              : `Unknown command /${invocation.name}. Type / to see available commands.`,
        });
        return;
      }
      if (invocation.kind === "unavailable") {
        setCommandNotice({
          tone: "error",
          message:
            language === "zh-CN"
              ? `/${invocation.command.name} 需要先打开一个 Session。`
              : `/${invocation.command.name} requires an active Session.`,
        });
        return;
      }
      if (invocation.kind === "missing-arguments") {
        setCommandNotice({
          tone: "error",
          message:
            language === "zh-CN"
              ? `/${invocation.command.name} 缺少参数。`
              : `/${invocation.command.name} requires an argument.`,
        });
        return;
      }
    }
    if (environment.status !== "ready") {
      setError(
        environment.status === "error"
          ? environment.provisioningError ?? "Environment provisioning failed."
          : "The Environment Workspace is still being prepared.",
      );
      return;
    }
    if (environment.codingAgent.status !== "connected") {
      if (canManageEnvironment) {
        onOpenAgentHarnessSettings();
      } else {
        setError(ui.askAdminToConnect(environment.codingAgent.label));
      }
      return;
    }
    if (!selectedModel || modelCatalogState !== "ready") {
      setError(modelCatalogError || ui.waitForModels);
      return;
    }
    const instruction = (options.instruction ?? prompt).trim();
    if (!instruction && images.length === 0 && localImages.length === 0) {
      setError(ui.emptyInstruction(environment.codingAgent.label));
      promptRef.current?.focus();
      return;
    }

    setCreating(true);
    setError("");
    setCommandNotice(null);
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        "/api/v1/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            environmentId: environment.id,
            ...(initialTitle?.trim() ? { title: initialTitle.trim() } : {}),
            ...(sessionStartSource ? { sessionStartSource } : {}),
            prompt: instruction,
            images: images.map(encodeCodexComposerImage),
            localImages: encodeCodexComposerLocalImages(localImages),
            modelId: selectedModel.id,
            ...(selectedReasoningEffort
              ? { reasoningEffort: selectedReasoningEffort }
              : {}),
            ...((options.collaborationMode ?? (planMode ? "plan" : undefined))
              ? {
                  collaborationMode:
                    options.collaborationMode ??
                    (planMode ? ("plan" as const) : undefined),
                }
              : {}),
            ...(fastMode && selectedModel.fastServiceTier
              ? { serviceTier: selectedModel.fastServiceTier.id }
              : {}),
          }),
        },
      );
      onCreated(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui.startFailed);
      if (options.restorePrompt) {
        setComposerPrompt(options.restorePrompt);
      }
      setCreating(false);
    }
  }

  async function retryEnvironmentProvisioning() {
    if (retryingEnvironment) return;
    setRetryingEnvironment(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<Environment>>(
        `/api/v1/environments/${encodeURIComponent(environment.id)}/provisioning`,
        {
          method: "PUT",
          body: JSON.stringify({ desiredState: "ready" }),
        },
      );
      onEnvironmentChange(response.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not retry Environment provisioning.",
      );
    } finally {
      setRetryingEnvironment(false);
    }
  }

  async function addImages(files: File[]) {
    const selection = selectCodexImageFiles(files, images);
    setError(newSessionImageError(selection.issue));
    if (selection.files.length === 0) return;
    try {
      const next = await Promise.all(selection.files.map(readCodexComposerImage));
      setImages((current) =>
        [...current, ...next].slice(0, MAX_CODEX_COMPOSER_IMAGES),
      );
    } catch {
      setError("The selected image could not be read.");
    }
  }

  return (
    <section id="conversation" className={styles.workspace} tabIndex={-1}>
      <header
        className={styles.header}
        data-native-titlebar-leading-content
        data-tauri-drag-region="deep"
      >
        <button
          type="button"
          className={styles.desktopExpandButton}
          aria-label={ui.expandSidebar}
          title={ui.expandSidebar}
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.mobileMenuButton}
          aria-label={ui.openNavigation}
          onClick={onToggleSidebar}
        >
          <Menu size={19} aria-hidden="true" />
        </button>
        <div className={styles.heading}>
          <div className={styles.breadcrumb}>
            <span>{environment.name}</span>
            <i>/</i>
            <strong>{ui.title}</strong>
          </div>
          <div className={styles.meta}>
            <span
              className={styles.readyDot}
              data-status={environment.status}
              aria-hidden="true"
            />
            {environment.status === "ready"
              ? ui.environmentReady(environment.revision)
              : environment.status === "error"
                ? ui.environmentFailed
                : ui.preparingEnvironment}
          </div>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.agentsButton}
            aria-label={ui.openAgentsFile}
            aria-busy={openingAgentsFile}
            title={ui.openAgentsFile}
            disabled={environment.status !== "ready" || openingAgentsFile}
            onClick={() => void openAgentsFile()}
          >
            {openingAgentsFile ? (
              <span className="activity-spinner" aria-hidden="true" />
            ) : (
              <BookOpenText size={17} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            className={`${styles.terminalButton} ${terminalOpen ? styles.active : ""}`}
            aria-label={ui.terminal}
            aria-pressed={terminalOpen}
            title={ui.terminal}
            disabled={environment.status !== "ready"}
            onClick={onToggleTerminal}
          >
            <SquareTerminal size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${styles.inspectorButton} ${
              inspectorOpen ? styles.active : ""
            }`}
            aria-label={inspectorOpen ? ui.closeInspector : ui.openInspector}
            aria-pressed={inspectorOpen}
            onClick={onToggleInspector}
          >
            <PanelRight size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className={styles.content}>
        <div className={styles.intro}>
          <span className={styles.agentMark} aria-hidden="true">
            <span />
          </span>
          <h1>{ui.question(environment.codingAgent.label)}</h1>
          <p>{ui.introduction(environment.name)}</p>
          <div className={styles.facts}>
            <span>
              <GitFork size={13} aria-hidden="true" />{" "}
              {ui.environmentRevision(environment.revision)}
            </span>
            <span>
              <LockKeyhole size={13} aria-hidden="true" />{" "}
              {ui.agentBound(environment.codingAgent.label)}
            </span>
            <span>{ui.sharedRuntime}</span>
          </div>
        </div>

        {environment.status === "updating" ||
        (modelCatalogState === "loading" &&
          environment.status === "ready" &&
          environment.codingAgent.status === "connected") ? (
          <p className={styles.runtimeStatus} role="status">
            <LoaderCircle size={12} aria-hidden="true" />
            {environment.status === "updating"
              ? ui.preparingEnvironment
              : ui.startingAgent(environment.codingAgent.label)}
          </p>
        ) : null}

        {environment.codingAgent.status === "not-connected" &&
        environment.status !== "error" ? (
          <div className={styles.setupNotice}>
            <span className={styles.setupNoticeIcon} aria-hidden="true">
              <KeyRound size={15} />
            </span>
            <div>
              <strong>
                {ui.connectAgent(environment.codingAgent.label)}
              </strong>
              <p>
                {canManageEnvironment
                  ? ui.connectAgentDescription(environment.codingAgent.label)
                  : ui.askAdminToConnect(environment.codingAgent.label)}
              </p>
            </div>
            {canManageEnvironment ? (
              <button type="button" onClick={onOpenAgentHarnessSettings}>
                {ui.connectAgent(environment.codingAgent.label)}
              </button>
            ) : null}
          </div>
        ) : null}

        {error || modelCatalogError || environment.status === "error" ? (
          <p className={styles.error} role="alert">
            {error ||
              modelCatalogError ||
              environment.provisioningError ||
              "Environment provisioning failed."}
            {environment.status === "error" ? (
              <button
                type="button"
                disabled={retryingEnvironment}
                onClick={() => void retryEnvironmentProvisioning()}
              >
                {retryingEnvironment ? ui.retryingEnvironment : ui.retryEnvironment}
              </button>
            ) : null}
          </p>
        ) : null}

        <div className={styles.starters} aria-label={ui.starterLabel}>
          {ui.starters.map((starter) => (
            <button
              type="button"
              key={starter}
              onClick={() => {
                setPrompt(starter);
                setError("");
                promptRef.current?.focus();
              }}
            >
              <Sparkles size={13} aria-hidden="true" />
              {starter}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.composerRegion}>
        <div className={`composer-shell ${styles.composer}`}>
          <CodexSlashCommandMenu
            id={slashMenu.id}
            language={language}
            commands={slashMenu.commands}
            activeIndex={slashMenu.activeIndex}
            onActiveIndexChange={slashMenu.setActiveIndex}
            onSelect={slashMenu.select}
          />
          {images.length > 0 ? (
            <div className={styles.imagePreviews} aria-label="Attached images">
              {images.map((image) => (
                <div className={styles.imagePreview} key={image.id}>
                  <Image
                    src={image.previewUrl}
                    alt={image.name}
                    width={60}
                    height={60}
                    unoptimized
                  />
                  <button
                    type="button"
                    aria-label={`Remove ${image.name}`}
                    onClick={() => {
                      setImages((current) =>
                        current.filter((candidate) => candidate.id !== image.id),
                      );
                      setError("");
                    }}
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <CodexComposerLocalImages
            language={language}
            localImages={localImages}
            onRemove={(id) => {
              setLocalImages((current) =>
                current.filter((localImage) => localImage.id !== id),
              );
              setError("");
            }}
          />
          {commandNotice ? (
            <div
              className="codex-composer-notice"
              data-tone={commandNotice.tone}
              role={commandNotice.tone === "error" ? "alert" : "status"}
            >
              <span>{commandNotice.message}</span>
            </div>
          ) : null}
          {planMode ? (
            <div className="codex-composer-mode" role="status">
              <span>
                <strong>{language === "zh-CN" ? "计划模式" : "Plan mode"}</strong>
                {" · "}
                {language === "zh-CN"
                  ? "新 Session 使用 Codex 计划协作模式"
                  : "The new Session uses Codex Plan collaboration mode"}
              </span>
              <button
                type="button"
                aria-label={
                  language === "zh-CN" ? "退出计划模式" : "Exit Plan mode"
                }
                onClick={() => {
                  setPlanMode(false);
                  setCommandNotice(null);
                }}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {/*
            Codex slash-command completion belongs in this Codex composer. Future harnesses
            provide their own composer instead of registering commands in a shared catalog.
          */}
          <textarea
            ref={promptRef}
            name="new-session-instruction"
            autoComplete="off"
            rows={3}
            value={prompt}
            placeholder={ui.placeholder(environment.codingAgent.label)}
            onChange={(event) => {
              setPrompt(event.target.value);
              slashMenu.show();
              setCommandNotice(null);
              if (error && event.target.value.trim()) {
                setError("");
              }
            }}
            onPaste={(event) => {
              const pasted = clipboardCodexImageFiles(event.clipboardData);
              if (pasted.length === 0) return;
              // Preserve accompanying clipboard text while the image is added
              // as its own native Codex input.
              void addImages(pasted);
            }}
            onKeyDown={(event) => {
              if (slashMenu.handleKeyDown(event)) return;
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
                void createSession();
              }
            }}
            aria-controls={
              slashMenu.commands.length > 0 ? slashMenu.id : undefined
            }
            aria-activedescendant={
              slashMenu.activeCommand
                ? `${slashMenu.id}-${slashMenu.activeCommand.name}`
                : undefined
            }
          />
          <CodexComposerToolbar
            language={language}
            environmentId={environment.id}
            agentLabel={environment.codingAgent.label}
            localImages={localImages}
            onLocalImagesChange={setLocalImages}
            onInsertFileMentions={insertFileMentions}
            onAttachmentError={setError}
            attachmentDisabled={
              creating ||
              environment.status !== "ready" ||
              environment.codingAgent.status !== "connected"
            }
            modelOptions={modelOptions}
            selectedModel={selectedModel}
            modelPlaceholder={
              modelCatalogState === "loading"
                ? ui.startingAgent(environment.codingAgent.label)
                : ui.modelsUnavailable
            }
            modelTitle={modelCatalogError || undefined}
            modelDisabled={
              creating ||
              modelCatalogState !== "ready" ||
              modelOptions.length === 0
            }
            reasoningDisabled={creating}
            selectedReasoningEffort={selectedReasoningEffort}
            onModelChange={selectModel}
            onReasoningEffortChange={selectReasoningEffort}
            fastEnabled={fastMode}
            fastDisabled={creating}
            onFastEnabledChange={(enabled) => {
              setFastMode(enabled);
              setCommandNotice(null);
            }}
            mentionOpenRequest={mentionOpenRequest}
            status={{
              state:
                environment.codingAgent.status !== "connected" ||
                modelCatalogState === "error"
                  ? "unavailable"
                  : modelCatalogState === "ready"
                    ? "ready"
                    : "loading",
              label:
                environment.codingAgent.status !== "connected"
                  ? ui.connectAgent(environment.codingAgent.label)
                  : modelCatalogState === "error"
                  ? ui.modelsUnavailable
                  : modelCatalogState === "ready"
                    ? ui.environmentReady(environment.revision)
                    : ui.startingAgent(environment.codingAgent.label),
            }}
            action={
              <button
                type="button"
                className="send-button"
                aria-label={creating ? ui.starting : ui.sendAndStart}
                disabled={
                  creating ||
                  environment.status !== "ready" ||
                  environment.codingAgent.status !== "connected" ||
                  modelCatalogState !== "ready" ||
                  !selectedModel ||
                  (!prompt.trim() &&
                    images.length === 0 &&
                    localImages.length === 0)
                }
                onClick={() => void createSession()}
              >
                {creating ? (
                  <span className="activity-spinner" aria-hidden="true" />
                ) : (
                  <ArrowUp size={17} strokeWidth={2.5} aria-hidden="true" />
                )}
              </button>
            }
          />
        </div>
      </div>
      {nativeDialog ? (
        <CodexNativeCommandDialog
          mode={nativeDialog.mode}
          language={language}
          environmentId={environment.id}
          initialUsageView={nativeDialog.usageView}
          onClose={() => setNativeDialog(undefined)}
        />
      ) : null}
    </section>
  );
}

function newSessionImageError(issue?: CodexImageSelectionIssue) {
  if (!issue) return "";
  if (issue === "too-many") return `Attach up to ${MAX_CODEX_COMPOSER_IMAGES} images.`;
  if (issue === "unsupported") return "Use PNG, JPEG, GIF, or WebP images.";
  if (issue === "total-too-large") return "The combined image size is too large.";
  return "Each image must be 10 MB or smaller.";
}
