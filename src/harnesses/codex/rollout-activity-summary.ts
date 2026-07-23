import JSON5 from "json5";

import type { CodexRolloutToolActivity } from "./rollout-activity";

export type CodexRolloutActionKind =
  | "command"
  | "fileChange"
  | "backgroundWait"
  | "backgroundCheck"
  | "backgroundInput"
  | "web"
  | "integration"
  | "agent"
  | "image"
  | "tool";

export interface CodexRolloutActivitySummary {
  kind: CodexRolloutActionKind;
  toolName: string;
  subject: string;
  detail: string | null;
  command: string | null;
  commands: string[];
  cwd: string | null;
  output: string;
  exitCode: number | null;
  filePaths: string[];
  external: boolean;
  startsBackgroundHandle: string | null;
  followsBackgroundHandle: string | null;
}

const COMMAND_TOOLS = new Set([
  "command",
  "exec",
  "exec_command",
  "local_shell",
  "shell_command",
  "unified_exec",
]);
const FILE_TOOLS = new Set(["apply_patch", "file_change", "write_file"]);
const AGENT_TOOLS = new Set([
  "close_agent",
  "followup_task",
  "interrupt_agent",
  "resume_agent",
  "send_input",
  "send_message",
  "spawn_agent",
  "wait_agent",
]);
const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_STATIC_COMMANDS = 32;
const MAX_STATIC_COMMAND_CHARS = 32 * 1024;
const SUMMARY_CACHE = new WeakMap<
  CodexRolloutToolActivity,
  CodexRolloutActivitySummary
>();

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function leafToolName(name: string) {
  return name.split(".").at(-1) ?? name;
}

export function displayCodexCommand(command: string) {
  const match = command.match(/^\/bin\/(?:ba|z|)sh\s+-lc\s+(["'])([\s\S]*)\1$/);
  return (match?.[2] ?? command).trim();
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return objectRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return objectRecord(value);
}

function staticCodeModeObject(source: string, start: number) {
  if (source[start] !== "{") return null;
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character !== "}") continue;
    depth -= 1;
    if (depth !== 0) continue;

    let cursor = index + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ")") return null;
    try {
      return objectRecord(JSON5.parse(source.slice(start, index + 1)));
    } catch {
      // JSON5 accepts data-only JavaScript literals, never executable expressions.
      return null;
    }
  }
  return null;
}

/**
 * Code-mode input is arbitrary JavaScript. Only accept a static object literal
 * passed directly to a known tools call; never evaluate the source.
 */
function staticCodeModeArguments(input: string, toolName: string) {
  const candidates = [
    toolName,
    leafToolName(toolName),
  ].filter((candidate, index, values) => values.indexOf(candidate) === index);
  for (const candidate of candidates) {
    const marker = `tools.${candidate}`;
    let offset = 0;
    while (offset < input.length) {
      const markerIndex = input.indexOf(marker, offset);
      if (markerIndex < 0) break;
      let cursor = markerIndex + marker.length;
      while (/\s/.test(input[cursor] ?? "")) cursor += 1;
      if (input[cursor] !== "(") {
        offset = cursor + 1;
        continue;
      }
      cursor += 1;
      while (/\s/.test(input[cursor] ?? "")) cursor += 1;
      const parsed = staticCodeModeObject(input, cursor);
      if (parsed) return parsed;
      offset = cursor + 1;
    }
  }
  return null;
}

function skipCodeModeTrivia(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "/") {
      cursor += 2;
      while (
        cursor < source.length &&
        source[cursor] !== "\n" &&
        source[cursor] !== "\r"
      ) {
        cursor += 1;
      }
      continue;
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) return source.length;
      cursor = end + 2;
      continue;
    }
    break;
  }
  return cursor;
}

function hasIndirectCodeModeCall(input: string, toolName: string) {
  const candidates = [toolName, leafToolName(toolName)].filter(
    (candidate, index, values) => values.indexOf(candidate) === index,
  );
  for (const candidate of candidates) {
    const marker = `tools.${candidate}`;
    let offset = 0;
    while (offset < input.length) {
      const markerIndex = input.indexOf(marker, offset);
      if (markerIndex < 0) break;
      let cursor = skipCodeModeTrivia(input, markerIndex + marker.length);
      if (input[cursor] !== "(") {
        offset = cursor + 1;
        continue;
      }
      cursor = skipCodeModeTrivia(input, cursor + 1);
      if (!/[$A-Z_a-z]/.test(input[cursor] ?? "")) {
        offset = cursor + 1;
        continue;
      }
      cursor += 1;
      while (/[$\w]/.test(input[cursor] ?? "")) cursor += 1;
      while (true) {
        cursor = skipCodeModeTrivia(input, cursor);
        if (input[cursor] !== ".") break;
        cursor = skipCodeModeTrivia(input, cursor + 1);
        if (!/[$A-Z_a-z]/.test(input[cursor] ?? "")) break;
        cursor += 1;
        while (/[$\w]/.test(input[cursor] ?? "")) cursor += 1;
      }
      if (input[skipCodeModeTrivia(input, cursor)] === ")") return true;
      offset = cursor + 1;
    }
  }
  return false;
}

function decodeStaticTemplateLiteral(raw: string) {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escaped = raw[index + 1];
    if (escaped === undefined) return null;
    index += 1;
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (raw[index + 1] === "\n") index += 1;
      continue;
    }
    const simple =
      ({
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
      } as Record<string, string>)[escaped];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    if (escaped === "x") {
      const value = raw.slice(index + 1, index + 3);
      if (!/^[\da-f]{2}$/i.test(value)) return null;
      decoded += String.fromCodePoint(Number.parseInt(value, 16));
      index += 2;
      continue;
    }
    if (escaped === "u") {
      const value = raw.slice(index + 1, index + 5);
      if (!/^[\da-f]{4}$/i.test(value)) return null;
      decoded += String.fromCodePoint(Number.parseInt(value, 16));
      index += 4;
      continue;
    }
    decoded += escaped;
  }
  return decoded;
}

function staticCodeModeStringLiteral(source: string, start: number) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let escaped = false;
  let interpolated = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      interpolated = true;
      continue;
    }
    if (character !== quote) continue;
    const literal = source.slice(start, index + 1);
    if (quote === "`") {
      return {
        end: index + 1,
        value: interpolated
          ? null
          : decodeStaticTemplateLiteral(literal.slice(1, -1)),
      };
    }
    try {
      const value = JSON5.parse(literal);
      return {
        end: index + 1,
        value: typeof value === "string" ? value : null,
      };
    } catch {
      return { end: index + 1, value: null };
    }
  }
  return null;
}

/**
 * Recover data-only string properties from code-mode orchestration such as
 * a static jobs array consumed through `jobs.map(...)`. The source is scanned
 * as text and string literals are decoded without executing JavaScript.
 */
function staticCodeModeStringProperties(input: string, property: string) {
  const values: string[] = [];
  let cursor = 0;
  while (cursor < input.length && values.length < MAX_STATIC_COMMANDS) {
    cursor = skipCodeModeTrivia(input, cursor);
    const character = input[cursor];
    if (character === undefined) break;

    let key: string | null = null;
    let tokenEnd = cursor + 1;
    if (/[$A-Z_a-z]/.test(character)) {
      tokenEnd = cursor + 1;
      while (/[$\w]/.test(input[tokenEnd] ?? "")) tokenEnd += 1;
      key = input.slice(cursor, tokenEnd);
    } else if (character === '"' || character === "'") {
      const literal = staticCodeModeStringLiteral(input, cursor);
      if (!literal) break;
      tokenEnd = literal.end;
      key = literal.value;
    } else if (character === "`") {
      const literal = staticCodeModeStringLiteral(input, cursor);
      cursor = literal?.end ?? input.length;
      continue;
    } else {
      cursor += 1;
      continue;
    }

    const colon = skipCodeModeTrivia(input, tokenEnd);
    if (key !== property || input[colon] !== ":") {
      cursor = tokenEnd;
      continue;
    }
    const valueStart = skipCodeModeTrivia(input, colon + 1);
    const literal = staticCodeModeStringLiteral(input, valueStart);
    if (!literal) {
      cursor = valueStart + 1;
      continue;
    }
    cursor = literal.end;
    const value = literal.value?.trim();
    if (value) values.push(value.slice(0, MAX_STATIC_COMMAND_CHARS));
  }
  return values;
}

function callInput(activity: CodexRolloutToolActivity) {
  const payload = objectRecord(activity.callPayload);
  return typeof payload?.input === "string" ? payload.input : "";
}

function callArguments(
  activity: CodexRolloutToolActivity,
  toolName: string,
) {
  const payload = objectRecord(activity.callPayload);
  return (
    parseJsonRecord(payload?.arguments) ??
    (typeof payload?.input === "string"
      ? staticCodeModeArguments(payload.input, toolName)
      : null)
  );
}

function collectOutputText(
  value: unknown,
  output: string[],
  seen: WeakSet<object>,
  depth = 0,
) {
  if (output.join("\n").length >= MAX_OUTPUT_CHARS || depth > 6) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectOutputText(item, output, seen, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "output")) {
    collectOutputText(record.output, output, seen, depth + 1);
    return;
  }
  if (typeof record.text === "string") {
    collectOutputText(record.text, output, seen, depth + 1);
  }
}

function activityOutput(activity: CodexRolloutToolActivity) {
  const parts: string[] = [];
  for (const output of activity.outputs) {
    collectOutputText(output.payload, parts, new WeakSet());
  }
  const joined = parts.join("\n").trim();
  return joined.length <= MAX_OUTPUT_CHARS
    ? joined
    : `${joined.slice(0, MAX_OUTPUT_CHARS)}…`;
}

function structuredExitCode(value: unknown, seen = new WeakSet<object>()): number | null {
  if (value === null || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = structuredExitCode(item, seen);
      if (result !== null) return result;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["exit_code", "exitCode"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(record)) {
    const result = structuredExitCode(candidate, seen);
    if (result !== null) return result;
  }
  return null;
}

function activityExitCode(
  activity: CodexRolloutToolActivity,
  output: string,
) {
  for (const item of activity.outputs) {
    const structured = structuredExitCode(item.payload);
    if (structured !== null) return structured;
  }
  const declaresExitTrailer =
    /exit=\$\{\s*[$A-Z_a-z][$\w]*\.(?:exit_code|exitCode)\s*\}/.test(
      callInput(activity),
    );
  if (!declaresExitTrailer) return null;
  const trailer = output.match(/(?:^|\n)exit=(-?\d+)\s*$/);
  return trailer ? Number(trailer[1]) : null;
}

function patchPaths(input: string, args: Record<string, unknown> | null) {
  const sources = [
    input,
    ...Object.values(args ?? {}).filter(
      (value): value is string => typeof value === "string",
    ),
  ];
  const paths: string[] = [];
  const pattern =
    /\*\*\* (?:Add|Delete|Update) File:\s*([^\\\r\n"]+)|\*\*\* Move to:\s*([^\\\r\n"]+)/g;
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const path = (match[1] ?? match[2])?.trim();
      if (path && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

function safeSubject(args: Record<string, unknown> | null) {
  for (const key of [
    "query",
    "url",
    "path",
    "repo",
    "target",
    "task_name",
    "ref_id",
  ]) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function externalTool(names: string[], activity: CodexRolloutToolActivity) {
  return (
    names.some(
      (name) =>
        name.startsWith("mcp__") ||
        name.startsWith("web.") ||
        name.startsWith("browser.") ||
        name.startsWith("image_gen.") ||
        name.startsWith("image_gen__") ||
        name.includes("web_search") ||
        name.includes("imagegen") ||
        name.includes("image_generation"),
    ) ||
    activity.callType === "web_search_call" ||
    activity.callType === "image_generation_call"
  );
}

function toolKind(
  name: string,
  names: string[],
  activity: CodexRolloutToolActivity,
): CodexRolloutActionKind {
  const leaf = leafToolName(name);
  if (COMMAND_TOOLS.has(leaf)) return "command";
  if (FILE_TOOLS.has(leaf)) return "fileChange";
  if (leaf === "wait") return "backgroundWait";
  if (leaf === "write_stdin") return "backgroundCheck";
  if (AGENT_TOOLS.has(leaf) || names.some((item) => item.startsWith("collaboration."))) {
    return "agent";
  }
  if (
    names.some((item) => item.startsWith("web.") || item.includes("web_search")) ||
    activity.callType === "web_search_call"
  ) {
    return "web";
  }
  if (
    names.some(
      (item) =>
        item.startsWith("image_gen.") ||
        item.startsWith("image_gen__") ||
        item.includes("imagegen") ||
        item.includes("image_generation"),
    ) ||
    activity.callType === "image_generation_call"
  ) {
    return "image";
  }
  if (names.some((item) => item.startsWith("mcp__") || item.startsWith("browser."))) {
    return "integration";
  }
  return "tool";
}

function backgroundHandleFromOutput(output: string) {
  const cell = output.match(
    /^Script running with cell ID\s+([^\s"'},]+)\s*$/im,
  );
  if (cell?.[1]) return `cell:${cell[1]}`;
  for (const line of output.split("\n")) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const record = objectRecord(JSON.parse(candidate));
      const sessionId = record?.session_id;
      if (
        typeof sessionId === "string" ||
        (typeof sessionId === "number" && Number.isFinite(sessionId))
      ) {
        return `session:${sessionId}`;
      }
    } catch {
      // Only an explicit top-level JSON runtime envelope is accepted.
    }
  }
  return null;
}

function argumentString(
  args: Record<string, unknown> | null,
  key: string,
) {
  const value = args?.[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}

function commonStaticStringProperty(input: string, ...keys: string[]) {
  const values = keys.flatMap((key) =>
    staticCodeModeStringProperties(input, key),
  );
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0]! : null;
}

function commandSubject(commands: string[]) {
  if (commands.length === 1) return displayCodexCommand(commands[0]!);
  const headlines = commands.slice(0, 2).map((command) => {
    const displayed = displayCodexCommand(command);
    const firstLine =
      displayed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? displayed;
    return firstLine.length <= 120
      ? firstLine
      : `${firstLine.slice(0, 119)}…`;
  });
  if (commands.length > headlines.length) {
    headlines.push(`+${commands.length - headlines.length}`);
  }
  return headlines.join(" · ");
}

function localShellCommand(activity: CodexRolloutToolActivity) {
  const payload = objectRecord(activity.callPayload);
  const action = objectRecord(payload?.action);
  if (action?.type !== "exec" || !Array.isArray(action.command)) return null;
  const command = action.command.filter(
    (part): part is string => typeof part === "string",
  );
  return command.length > 0 ? command.join(" ") : null;
}

function localShellWorkingDirectory(activity: CodexRolloutToolActivity) {
  const payload = objectRecord(activity.callPayload);
  const action = objectRecord(payload?.action);
  return typeof action?.working_directory === "string"
    ? action.working_directory
    : null;
}

function webActionSubject(activity: CodexRolloutToolActivity) {
  const payload = objectRecord(activity.callPayload);
  const action = objectRecord(payload?.action);
  if (!action) return null;
  if (typeof action.query === "string") return action.query;
  if (
    Array.isArray(action.queries) &&
    typeof action.queries[0] === "string"
  ) {
    return action.queries.length === 1
      ? action.queries[0]
      : `${action.queries[0]} +${action.queries.length - 1}`;
  }
  if (typeof action.url === "string") return action.url;
  return null;
}

export function summarizeCodexRolloutActivity(
  activity: CodexRolloutToolActivity,
): CodexRolloutActivitySummary {
  const cached = SUMMARY_CACHE.get(activity);
  if (cached) return cached;
  const detectedNames =
    activity.codeModeTools.length > 0
      ? activity.codeModeTools
      : [activity.namespace, activity.name].filter(
          (name): name is string => Boolean(name),
        );
  const names = [...new Set(detectedNames)];
  const toolName = names[0] ?? activity.callType;
  const leaf = leafToolName(toolName);
  let kind =
    names.length > 1 ? "tool" : toolKind(toolName, names, activity);
  const args =
    names.length === 1 ? callArguments(activity, toolName) : null;
  const input = callInput(activity);
  const output = activityOutput(activity);
  const exitCode = activityExitCode(activity, output);
  const filePaths = kind === "fileChange" ? patchPaths(input, args) : [];
  const localCommand = localShellCommand(activity);
  const directCommand =
    kind === "command" ? argumentString(args, "cmd") ?? localCommand : null;
  const recoverStaticBatch =
    kind === "command" &&
    !directCommand &&
    hasIndirectCodeModeCall(input, toolName);
  const commands =
    kind !== "command"
      ? []
      : directCommand
        ? [directCommand]
        : recoverStaticBatch
          ? staticCodeModeStringProperties(input, "cmd")
          : [];
  const command = commands.length === 1 ? commands[0]! : null;
  const cwd =
    argumentString(args, "workdir") ??
    argumentString(args, "working_directory") ??
    localShellWorkingDirectory(activity) ??
    (recoverStaticBatch && commands.length > 0
      ? commonStaticStringProperty(input, "workdir", "working_directory")
      : null);
  const cellId = argumentString(args, "cell_id");
  const sessionId = argumentString(args, "session_id");
  const chars = typeof args?.chars === "string" ? args.chars : "";
  if (leaf === "write_stdin" && chars) kind = "backgroundInput";
  const subject =
    (commands.length > 0 ? commandSubject(commands) : null) ??
    (filePaths.length > 0 ? filePaths.slice(0, 2).join(", ") : null) ??
    (cellId ? `#${cellId}` : null) ??
    (sessionId ? `#${sessionId}` : null) ??
    webActionSubject(activity) ??
    safeSubject(args) ??
    (names.length > 1 ? names.join(" · ") : toolName);
  const detail =
    kind === "backgroundInput"
      ? chars === "\u0003"
        ? "Ctrl-C"
        : chars === "\r" || chars === "\n"
          ? "Enter"
          : chars.replace(/[\u0000-\u001f\u007f]/g, "�").slice(0, 80)
      : cwd;
  const followsBackgroundHandle =
    cellId && kind === "backgroundWait"
      ? `cell:${cellId}`
      : sessionId &&
          (kind === "backgroundCheck" || kind === "backgroundInput")
        ? `session:${sessionId}`
        : null;

  const summary: CodexRolloutActivitySummary = {
    kind,
    toolName,
    subject,
    detail,
    command,
    commands,
    cwd,
    output,
    exitCode,
    filePaths,
    external: externalTool(names, activity),
    startsBackgroundHandle:
      kind === "command" ? backgroundHandleFromOutput(output) : null,
    followsBackgroundHandle,
  };
  // Normalized rollout DTOs are immutable for one snapshot. A WeakMap lets
  // summary, grouping, filtering and rendering share the bounded parse.
  SUMMARY_CACHE.set(activity, summary);
  return summary;
}

export function codexRolloutActivityFailed(
  activity: CodexRolloutToolActivity,
) {
  const summary = summarizeCodexRolloutActivity(activity);
  return activity.status === "failed" || (summary.exitCode ?? 0) !== 0;
}
