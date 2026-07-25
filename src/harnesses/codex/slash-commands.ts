import type { OperationLanguage } from "@/lib/operation-ui";

export type CodexSlashCommandContext = "new-session" | "session";

export type CodexSlashCommandName =
  | "agent"
  | "archive"
  | "clear"
  | "compact"
  | "copy"
  | "diff"
  | "fork"
  | "goal"
  | "init"
  | "ide"
  | "logout"
  | "mcp"
  | "mention"
  | "model"
  | "new"
  | "permissions"
  | "plan"
  | "rename"
  | "review"
  | "skills"
  | "subagents"
  | "usage";

export const CODEX_INIT_COMMAND_PROMPT =
  "Inspect this repository and create or improve AGENTS.md with concise, actionable instructions for future coding agents. Preserve useful existing instructions, avoid unsupported assumptions, and document the build, test, architecture, and project conventions you can verify from the repository.";

export interface CodexSlashCommand {
  name: CodexSlashCommandName;
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
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Start a new Sandpi Session",
      "zh-CN": "新建一个 Sandpi Session",
    },
  },
  {
    name: "fork",
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
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Start a clean Sandpi Session",
      "zh-CN": "新建一个干净的 Sandpi Session",
    },
  },
  {
    name: "compact",
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
    contexts: ["session"],
    argumentMode: "optional",
    description: {
      en: "Show, set, or clear the native Codex goal",
      "zh-CN": "查看、设置或清除 Codex 原生目标",
    },
    argumentHint: {
      en: "objective | clear",
      "zh-CN": "目标 | clear",
    },
  },
  {
    name: "rename",
    contexts: ["session"],
    argumentMode: "required",
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
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    unavailableWhileTurnRunning: true,
    description: {
      en: "Create or improve AGENTS.md instructions",
      "zh-CN": "创建或完善 AGENTS.md 项目说明",
    },
  },
  {
    name: "model",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Choose a model reported by Codex",
      "zh-CN": "选择 Codex 提供的模型",
    },
  },
  {
    name: "mention",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Mention files from the Environment Workspace",
      "zh-CN": "引用环境工作区中的文件",
    },
  },
  {
    name: "diff",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open changed Workspace files",
      "zh-CN": "打开工作区改动文件",
    },
  },
  {
    name: "ide",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open the Sandpi Workspace IDE",
      "zh-CN": "打开 Sandpi 工作区 IDE",
    },
  },
  {
    name: "agent",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open native Codex agent activity",
      "zh-CN": "打开 Codex 原生 agent activity",
    },
  },
  {
    name: "subagents",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Open native Codex sub-agent activity",
      "zh-CN": "打开 Codex 原生 sub-agent activity",
    },
  },
  {
    name: "copy",
    contexts: ["session"],
    argumentMode: "none",
    description: {
      en: "Copy the latest assistant response",
      "zh-CN": "复制最近一条助手回复",
    },
  },
  {
    name: "skills",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Environment Skills",
      "zh-CN": "打开环境 Skills",
    },
  },
  {
    name: "mcp",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Environment MCP servers",
      "zh-CN": "打开环境 MCP servers",
    },
  },
  {
    name: "permissions",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Environment network permissions",
      "zh-CN": "打开环境网络权限",
    },
  },
  {
    name: "usage",
    contexts: BOTH_CONTEXTS,
    argumentMode: "none",
    description: {
      en: "Open Codex account usage and limits",
      "zh-CN": "打开 Codex 账户用量与限制",
    },
  },
  {
    name: "logout",
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
