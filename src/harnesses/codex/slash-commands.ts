import type { OperationLanguage } from "@/lib/operation-ui";

export type CodexSlashCommandContext = "new-session" | "session";

/**
 * Stable browser intents decouple Codex command spelling from Sandpi UI
 * execution. Aliases such as `/agent` and `/subagents` intentionally share an
 * intent, while the menu can continue mirroring the Codex TUI vocabulary.
 */
export type CodexCommandIntent =
  | "agents.open"
  | "codex.compact"
  | "codex.goal"
  | "codex.hooks"
  | "codex.init"
  | "codex.memories"
  | "codex.personality"
  | "codex.processes"
  | "codex.review"
  | "codex.stop"
  | "codex.usage"
  | "composer.mention"
  | "composer.model"
  | "composer.plan"
  | "environment.credentials"
  | "environment.mcp"
  | "environment.network"
  | "environment.skills"
  | "response.copy"
  | "session.archive"
  | "session.fork"
  | "session.new"
  | "session.rename"
  | "workspace.open";

export type CodexSlashCommandName =
  | "agent"
  | "archive"
  | "clear"
  | "compact"
  | "copy"
  | "diff"
  | "fork"
  | "goal"
  | "hooks"
  | "init"
  | "ide"
  | "logout"
  | "mcp"
  | "memories"
  | "mention"
  | "model"
  | "new"
  | "permissions"
  | "plan"
  | "personality"
  | "ps"
  | "rename"
  | "review"
  | "skills"
  | "stop"
  | "subagents"
  | "usage";

// Kept verbatim with codex-rs/tui/prompt_for_init_command.md from the Codex
// version pinned by Sandbox0: openai/codex@rust-v0.144.1
// (44918ea10c0f99151c6710411b4322c2f5c96bea).
export const CODEX_INIT_COMMAND_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

export interface CodexSlashCommand {
  name: CodexSlashCommandName;
  intent: CodexCommandIntent;
  contexts: readonly CodexSlashCommandContext[];
  argumentMode: "none" | "optional" | "required";
  unavailableWhileTurnRunning?: boolean;
  description: Record<OperationLanguage, string>;
  argumentHint?: Record<OperationLanguage, string>;
}

const BOTH_CONTEXTS: readonly CodexSlashCommandContext[] = [
  "new-session",
  "session",
];

/**
 * Browser commands belong to the Codex harness and map to either a native
 * app-server operation or an existing Sandpi product surface. Terminal-only
 * commands are intentionally absent. In particular, Sandpi does not expose
 * `/resume`, `/side`, its `/btw` alias, `/fast`, or `/status`. Fast is a
 * composer control, while the browser already presents Session status.
 */
export const CODEX_SLASH_COMMANDS: readonly CodexSlashCommand[] = [
  {
    name: "new",
    intent: "session.new",
    contexts: ["session"],
    argumentMode: "optional",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Start a new Sandpi Session",
      "zh-CN": "新建一个 Sandpi Session",
    },
    argumentHint: {
      en: "name",
      "zh-CN": "名称",
    },
  },
  {
    name: "fork",
    intent: "session.fork",
    contexts: ["session"],
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Fork this Session and switch to the child",
      "zh-CN": "派生当前 Session 并切换到子 Session",
    },
  },
  {
    name: "clear",
    intent: "session.new",
    contexts: ["session"],
    argumentMode: "optional",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Start a clean Sandpi Session",
      "zh-CN": "新建一个干净的 Sandpi Session",
    },
    argumentHint: {
      en: "name",
      "zh-CN": "名称",
    },
  },
  {
    name: "compact",
    intent: "codex.compact",
    contexts: ["session"],
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Compact this native Codex Session",
      "zh-CN": "压缩当前 Codex 原生 Session 上下文",
    },
  },
  {
    name: "review",
    intent: "codex.review",
    contexts: ["session"],
    argumentMode: "optional",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Review uncommitted changes or custom instructions",
      "zh-CN": "审查未提交改动，或按自定义要求审查",
    },
    argumentHint: {
      en: "instructions",
      "zh-CN": "审查要求",
    },
  },
  {
    name: "plan",
    intent: "composer.plan",
    contexts: BOTH_CONTEXTS,
    argumentMode: "optional",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Enter Plan mode, optionally with a prompt",
      "zh-CN": "进入计划模式，可同时输入任务",
    },
    argumentHint: {
      en: "prompt",
      "zh-CN": "任务",
    },
  },
  {
    name: "goal",
    intent: "codex.goal",
    contexts: ["session"],
    argumentMode: "optional",
    description: {
      en: "Show, edit, pause, resume, or clear the native Codex goal",
      "zh-CN": "查看、编辑、暂停、恢复或清除 Codex 原生目标",
    },
    argumentHint: {
      en: "objective | edit | pause | resume | clear",
      "zh-CN": "目标 | edit | pause | resume | clear",
    },
  },
  {
    name: "rename",
    intent: "session.rename",
    contexts: ["session"],
    argumentMode: "optional",
    description: {
      en: "Rename this Sandpi Session",
      "zh-CN": "重命名当前 Sandpi Session",
    },
    argumentHint: {
      en: "name",
      "zh-CN": "名称",
    },
  },
  {
    name: "archive",
    intent: "session.archive",
    contexts: ["session"],
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Archive this Sandpi Session",
      "zh-CN": "归档当前 Sandpi Session",
    },
  },
  {
    name: "init",
    intent: "codex.init",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Create AGENTS.md when it does not exist",
      "zh-CN": "仅在不存在时创建 AGENTS.md 项目说明",
    },
  },
  {
    name: "model",
    intent: "composer.model",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Choose a model reported by Codex",
      "zh-CN": "选择 Codex 提供的模型",
    },
  },
  {
    name: "personality",
    intent: "codex.personality",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Choose the Codex response personality",
      "zh-CN": "选择 Codex 回复风格",
    },
  },
  {
    name: "mention",
    intent: "composer.mention",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Mention files from the Environment Workspace",
      "zh-CN": "引用环境工作区中的文件",
    },
  },
  {
    name: "diff",
    intent: "workspace.open",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open changed Workspace files",
      "zh-CN": "打开工作区改动文件",
    },
  },
  {
    name: "ide",
    intent: "workspace.open",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open the Sandpi Workspace IDE",
      "zh-CN": "打开 Sandpi 工作区 IDE",
    },
  },
  {
    name: "agent",
    intent: "agents.open",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Switch or inspect native Codex agent threads",
      "zh-CN": "切换或查看 Codex 原生 Agent Threads",
    },
  },
  {
    name: "subagents",
    intent: "agents.open",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Switch or inspect native Codex agent threads",
      "zh-CN": "切换或查看 Codex 原生 Agent Threads",
    },
  },
  {
    name: "copy",
    intent: "response.copy",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Copy the latest assistant response",
      "zh-CN": "复制最近一条助手回复",
    },
  },
  {
    name: "skills",
    intent: "environment.skills",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Environment Skills",
      "zh-CN": "打开环境 Skills",
    },
  },
  {
    name: "mcp",
    intent: "environment.mcp",
    contexts: BOTH_CONTEXTS,
    argumentMode: "optional",
    description: {
      en: "Open Environment MCP servers",
      "zh-CN": "打开环境 MCP servers",
    },
    argumentHint: {
      en: "verbose",
      "zh-CN": "verbose",
    },
  },
  {
    name: "permissions",
    intent: "environment.network",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Environment network permissions",
      "zh-CN": "打开环境网络权限",
    },
  },
  {
    name: "usage",
    intent: "codex.usage",
    contexts: BOTH_CONTEXTS,
    argumentMode: "optional",
    description: {
      en: "Open Codex account token activity",
      "zh-CN": "打开 Codex 账户 token 活动",
    },
    argumentHint: {
      en: "daily | weekly | cumulative",
      "zh-CN": "daily | weekly | cumulative",
    },
  },
  {
    name: "memories",
    intent: "codex.memories",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Configure Codex memory use and generation",
      "zh-CN": "配置 Codex 记忆读取与生成",
    },
  },
  {
    name: "hooks",
    intent: "codex.hooks",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "View and manage Codex lifecycle hooks",
      "zh-CN": "查看和管理 Codex 生命周期 hooks",
    },
  },
  {
    name: "ps",
    intent: "codex.processes",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "List native Codex background terminals",
      "zh-CN": "列出 Codex 原生后台终端",
    },
  },
  {
    name: "stop",
    intent: "codex.stop",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Stop all native Codex background terminals",
      "zh-CN": "停止所有 Codex 原生后台终端",
    },
  },
  {
    name: "logout",
    intent: "environment.credentials",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open the Codex account connection",
      "zh-CN": "打开 Codex 账户连接设置",
    },
  },
];

export interface CodexSlashInvocation {
  command: CodexSlashCommand;
  arguments: string;
}

export type CodexSlashInvocationResult =
  | { kind: "not-command" }
  | { kind: "unknown"; name: string }
  | { kind: "unavailable"; command: CodexSlashCommand }
  | { kind: "missing-arguments"; command: CodexSlashCommand }
  | ({ kind: "command" } & CodexSlashInvocation);

function commandByName(name: string) {
  return CODEX_SLASH_COMMANDS.find((command) => command.name === name);
}

export function parseCodexSlashInvocation(
  value: string,
  context: CodexSlashCommandContext,
): CodexSlashInvocationResult {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return { kind: "not-command" };

  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { kind: "unknown", name: trimmed.slice(1) };
  const name = match[1].toLowerCase();
  const command = commandByName(name);
  if (!command) return { kind: "unknown", name };
  if (!command.contexts.includes(context)) {
    return { kind: "unavailable", command };
  }
  const argumentsValue = (match[2] ?? "").trim();
  if (command.argumentMode === "required" && !argumentsValue) {
    return { kind: "missing-arguments", command };
  }
  return { kind: "command", command, arguments: argumentsValue };
}

export function codexSlashMenuCommands(
  value: string,
  context: CodexSlashCommandContext,
  turnRunning = false,
) {
  if (!value.startsWith("/") || value.includes("\n")) return [];
  const query = value.slice(1);
  if (/\s/.test(query)) return [];
  const normalizedQuery = query.toLowerCase();
  return CODEX_SLASH_COMMANDS.filter(
    (command) =>
      command.contexts.includes(context) &&
      !(turnRunning && command.unavailableWhileTurnRunning) &&
      command.name.includes(normalizedQuery),
  ).sort((left, right) => {
    const leftPrefix = left.name.startsWith(normalizedQuery);
    const rightPrefix = right.name.startsWith(normalizedQuery);
    if (leftPrefix !== rightPrefix) return leftPrefix ? -1 : 1;
    return 0;
  });
}

export function codexSlashCommandCompletion(
  command: CodexSlashCommand,
) {
  return `/${command.name}${command.argumentMode === "none" ? "" : " "}`;
}
