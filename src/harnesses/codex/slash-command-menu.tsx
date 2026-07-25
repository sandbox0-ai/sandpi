"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  codexSlashCommandCompletion,
  codexSlashMenuCommands,
  type CodexSlashCommand,
  type CodexSlashCommandContext,
} from "@/harnesses/codex/slash-commands";
import type { OperationLanguage } from "@/lib/operation-ui";

interface CodexSlashCommandMenuProps {
  id: string;
  language: OperationLanguage;
  commands: readonly CodexSlashCommand[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (command: CodexSlashCommand) => void;
}

interface UseCodexSlashCommandMenuInput {
  value: string;
  context: CodexSlashCommandContext;
  turnRunning?: boolean;
  onComplete: (value: string) => void;
  onExecute: (command: CodexSlashCommand) => void;
}

/**
 * Keeps completion, pointer selection and keyboard behavior identical across
 * the two Codex-owned composers without leaking slash commands into the
 * harness-neutral conversation dispatcher.
 */
export function useCodexSlashCommandMenu({
  value,
  context,
  turnRunning = false,
  onComplete,
  onExecute,
}: UseCodexSlashCommandMenuInput) {
  const id = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const commands = useMemo(
    () =>
      dismissed
        ? []
        : codexSlashMenuCommands(value, context, turnRunning),
    [context, dismissed, turnRunning, value],
  );
  const resolvedActiveIndex = Math.min(
    activeIndex,
    Math.max(0, commands.length - 1),
  );
  const activeCommand = commands[resolvedActiveIndex];

  useEffect(() => {
    setActiveIndex(0);
    setDismissed(false);
  }, [value]);

  function select(command: CodexSlashCommand, completeOnly = false) {
    if (completeOnly || command.argumentMode === "required") {
      onComplete(codexSlashCommandCompletion(command));
      return;
    }
    onExecute(command);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (commands.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % commands.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (index) => (index - 1 + commands.length) % commands.length,
      );
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      return true;
    }
    if (event.key === "Tab" && activeCommand) {
      event.preventDefault();
      select(activeCommand, true);
      return true;
    }
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      activeCommand
    ) {
      event.preventDefault();
      select(activeCommand);
      return true;
    }
    return false;
  }

  return {
    id,
    commands,
    activeCommand,
    activeIndex: resolvedActiveIndex,
    setActiveIndex,
    select,
    handleKeyDown,
    show: () => setDismissed(false),
  };
}

export function CodexSlashCommandMenu({
  id,
  language,
  commands,
  activeIndex,
  onActiveIndexChange,
  onSelect,
}: CodexSlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = menuRef.current?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  if (commands.length === 0) return null;
  return (
    <div
      ref={menuRef}
      id={id}
      className="codex-slash-command-menu"
      role="listbox"
      aria-label={
        language === "zh-CN" ? "Codex 斜杠命令" : "Codex slash commands"
      }
    >
      {commands.map((command, index) => (
        <button
          id={`${id}-${command.name}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "is-active" : ""}
          key={command.name}
          onPointerMove={() => onActiveIndexChange(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command)}
        >
          <span className="codex-slash-command-name">
            /{command.name}
            {command.argumentMode !== "none" && command.argumentHint ? (
              <i>{command.argumentHint[language]}</i>
            ) : null}
          </span>
          <span className="codex-slash-command-description">
            {command.description[language]}
          </span>
        </button>
      ))}
    </div>
  );
}
