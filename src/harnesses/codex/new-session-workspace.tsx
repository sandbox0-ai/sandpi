"use client";

import Image from "next/image";
import {
  ArrowUp,
  AtSign,
  ChevronDown,
  GitFork,
  LockKeyhole,
  LoaderCircle,
  Menu,
  PanelLeftOpen,
  Paperclip,
  Settings2,
  Sparkles,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  shouldSubmitComposer,
  type OperationLanguage,
  type SendShortcut,
} from "@/lib/operation-ui";
import { getCodexUiCopy } from "@/harnesses/codex/ui";
import type { CodexComposerImage, CodexSession } from "@/harnesses/codex/types";
import {
  clipboardCodexImageFiles,
  encodeCodexComposerImage,
  MAX_CODEX_COMPOSER_IMAGES,
  readCodexComposerImage,
  selectCodexImageFiles,
  type CodexImageSelectionIssue,
} from "@/harnesses/codex/composer-images";
import {
  codexDefaultModel,
  codexModelOptionsFromNativeResult,
  codexReasoningEffortForModel,
  codexReasoningEffortLabel,
  type CodexModelOption,
} from "@/harnesses/codex/models";
import { apiFetch, type ApiEnvelope } from "@/lib/api-client";
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
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const selectedModel = modelOptions.find(
    (model) => model.id === selectedModelId,
  );
  const selectedReasoningEffort = codexReasoningEffortForModel(
    selectedModel,
    selectedModel ? reasoningEfforts[selectedModel.id] : undefined,
  );
  const selectedReasoningDescription =
    selectedModel?.supportedReasoningEfforts.find(
      (option) => option.id === selectedReasoningEffort,
    )?.description;

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
        const defaultModel = codexDefaultModel(models);
        if (!defaultModel) throw new Error(ui.modelListEmpty);
        setModelOptions(models);
        setSelectedModelId(defaultModel.id);
        setReasoningEfforts({
          [defaultModel.id]: defaultModel.defaultReasoningEffort,
        });
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
    environment.codingAgent.status,
    environment.id,
    environment.status,
    ui.modelListEmpty,
    ui.modelListFailed,
  ]);

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
    if (!instruction && images.length === 0) {
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

        <div className={styles.composer}>
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
              event.preventDefault();
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
          <div className={styles.composerToolbar}>
            <div>
              <button
                type="button"
                aria-label={ui.attachFile}
                onClick={() => imageInputRef.current?.click()}
              >
                <Paperclip size={17} aria-hidden="true" />
              </button>
              <input
                ref={imageInputRef}
                className={styles.srOnly}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                tabIndex={-1}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length > 0) void addImages(files);
                }}
              />
              <button type="button" aria-label={ui.mentionFile}>
                <AtSign size={17} aria-hidden="true" />
              </button>
              <span className={styles.boundAgent}>
                <span className={styles.boundAgentMark} aria-hidden="true" />
                <span className={styles.harnessLabel}>
                  {environment.codingAgent.label}
                </span>
                <label className={styles.modelPicker}>
                  <span className={styles.srOnly}>
                    {ui.selectModel(environment.codingAgent.label)}
                  </span>
                  <select
                    name="new-session-model"
                    aria-label={ui.selectModel(
                      environment.codingAgent.label,
                    )}
                    value={selectedModelId}
                    disabled={
                      modelCatalogState !== "ready" ||
                      modelOptions.length === 0
                    }
                    onChange={(event) => {
                      const model = modelOptions.find(
                        (candidate) => candidate.id === event.target.value,
                      );
                      if (!model) return;
                      setSelectedModelId(model.id);
                      setReasoningEfforts((current) => ({
                        ...current,
                        [model.id]: codexReasoningEffortForModel(
                          model,
                          current[model.id],
                        ),
                      }));
                    }}
                  >
                    {modelOptions.length > 0 ? (
                      modelOptions.map((model) => (
                        <option value={model.id} key={model.id}>
                          {model.displayName}
                        </option>
                      ))
                    ) : (
                      <option value="">
                        {modelCatalogState === "loading"
                          ? ui.startingAgent(environment.codingAgent.label)
                          : ui.modelsUnavailable}
                      </option>
                    )}
                  </select>
                  <ChevronDown size={12} aria-hidden="true" />
                </label>
                {selectedModel?.supportedReasoningEfforts.length ? (
                  <label
                    className={styles.reasoningPicker}
                    title={selectedReasoningDescription}
                  >
                    <span className={styles.srOnly}>
                      {ui.selectReasoningEffort(selectedModel.displayName)}
                    </span>
                    <select
                      name="new-session-reasoning-effort"
                      aria-label={ui.selectReasoningEffort(
                        selectedModel.displayName,
                      )}
                      value={selectedReasoningEffort}
                      disabled={creating}
                      onChange={(event) =>
                        setReasoningEfforts((current) => ({
                          ...current,
                          [selectedModel.id]: event.target.value,
                        }))
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
              </span>
            </div>
            <button
              type="button"
              className={styles.sendButton}
              aria-label={creating ? ui.starting : ui.sendAndStart}
              disabled={
                creating ||
                environment.status !== "ready" ||
                environment.codingAgent.status !== "connected" ||
                modelCatalogState !== "ready" ||
                !selectedModel
              }
              onClick={() => void createSession()}
            >
              {creating ? (
                <span className={styles.spinner} />
              ) : (
                <ArrowUp size={18} aria-hidden="true" />
              )}
            </button>
          </div>
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
