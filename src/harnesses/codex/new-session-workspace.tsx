"use client";

import Image from "next/image";
import {
  ArrowUp,
  GitFork,
  LockKeyhole,
  LoaderCircle,
  Menu,
  PanelLeftOpen,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  CodexComposerLocalImages,
  CodexComposerToolbar,
  encodeCodexComposerLocalImages,
} from "@/harnesses/codex/composer";
import { insertCodexFileMentions } from "@/harnesses/codex/file-mentions";
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
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
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
  onEnvironmentChange: (environment: Environment) => void;
  onCreated: (session: CodexSession) => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
}

export function CodexNewSessionWorkspace({
  language,
  sendShortcut,
  environment,
  onEnvironmentChange,
  onCreated,
  onOpenSettings,
  onToggleSidebar,
  terminalOpen,
  onToggleTerminal,
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
  const [error, setError] = useState("");
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
    setSelectedModelId("");
    setModelOptions([]);
    setReasoningEfforts({});
    setModelCatalogError("");
    setModelCatalogState("idle");
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

  async function createSession() {
    if (environment.status !== "ready") {
      setError(
        environment.status === "error"
          ? environment.provisioningError ?? "Environment provisioning failed."
          : "The Environment Workspace is still being prepared.",
      );
      return;
    }
    if (environment.codingAgent.status !== "connected") {
      setError(
        `Connect ${environment.codingAgent.label} in Environment settings before starting a Session.`,
      );
      return;
    }
    if (!selectedModel || modelCatalogState !== "ready") {
      setError(modelCatalogError || ui.waitForModels);
      return;
    }
    const instruction = prompt.trim();
    if (!instruction && images.length === 0 && localImages.length === 0) {
      setError(ui.emptyInstruction(environment.codingAgent.label));
      promptRef.current?.focus();
      return;
    }

    setCreating(true);
    setError("");
    try {
      const response = await apiFetch<ApiEnvelope<CodexSession>>(
        "/api/v1/sessions",
        {
          method: "POST",
          body: JSON.stringify({
            environmentId: environment.id,
            prompt: instruction,
            images: images.map(encodeCodexComposerImage),
            localImages: encodeCodexComposerLocalImages(localImages),
            modelId: selectedModel.id,
            ...(selectedReasoningEffort
              ? { reasoningEffort: selectedReasoningEffort }
              : {}),
          }),
        },
      );
      onCreated(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : ui.startFailed);
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
      <header className={styles.header}>
        <button
          type="button"
          className={styles.desktopExpandButton}
          aria-label={ui.expandSidebar}
          title={ui.expandSidebar}
          onClick={onToggleSidebar}
        >
          <PanelLeftOpen size={19} aria-hidden="true" />
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
            className={styles.settingsButton}
            aria-label={ui.environmentSettings(environment.name)}
            onClick={onOpenSettings}
          >
            <Settings2 size={17} aria-hidden="true" />
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

        <div className={`composer-shell ${styles.composer}`}>
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
            status={{
              state:
                modelCatalogState === "error"
                  ? "unavailable"
                  : modelCatalogState === "ready"
                    ? "ready"
                    : "loading",
              label:
                modelCatalogState === "error"
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

        {modelCatalogState === "loading" &&
        environment.status === "ready" &&
        environment.codingAgent.status === "connected" ? (
          <p className={styles.runtimeStatus} role="status">
            <LoaderCircle size={12} aria-hidden="true" />
            {ui.startingAgent(environment.codingAgent.label)}
          </p>
        ) : null}

        {error ||
        modelCatalogError ||
        environment.status !== "ready" ||
        environment.codingAgent.status !== "connected" ? (
          <p className={styles.error} role="alert">
            {error ||
              modelCatalogError ||
              (environment.status === "error"
                ? environment.provisioningError ?? "Environment provisioning failed."
                : environment.status === "updating"
                  ? ui.preparingEnvironment
                  : `Connect ${environment.codingAgent.label} in Environment settings before starting a Session.`)}
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
