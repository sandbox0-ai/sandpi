import type {
  CodexMcpApprovalMode,
  CodexMcpServerInput,
  CodexMcpTransport,
} from "@/harnesses/codex/environment-tools";

export type CodexMcpPresetCategory = "aggregators" | "remote" | "local";

export interface CodexMcpPresetCategoryDefinition {
  id: CodexMcpPresetCategory;
  label: string;
  description: string;
}

interface CodexMcpPresetBase {
  id: string;
  name: string;
  title: string;
  description: string;
  connectionLabel: string;
  setupHint: string;
  docsUrl: string;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  defaultToolsApprovalMode?: CodexMcpApprovalMode;
}

export type CodexMcpPreset =
  | (CodexMcpPresetBase & {
      category: Exclude<CodexMcpPresetCategory, "local">;
      transport: Extract<CodexMcpTransport, "streamable-http">;
      url: string;
      command?: never;
      args?: never;
    })
  | (CodexMcpPresetBase & {
      category: Extract<CodexMcpPresetCategory, "local">;
      transport: Extract<CodexMcpTransport, "stdio">;
      command: string;
      args: readonly string[];
      url?: never;
    });

export const CODEX_MCP_PRESET_CATEGORIES: readonly CodexMcpPresetCategoryDefinition[] =
  [
    {
      id: "aggregators",
      label: "Aggregator services",
      description: "Hosted multi-app gateways with fixed SaaS endpoints.",
    },
    {
      id: "remote",
      label: "Third-party MCP servers",
      description: "Official hosted endpoints for common developer services.",
    },
    {
      id: "local",
      label: "Local MCP servers",
      description: "Processes launched by Codex inside this Environment sandbox.",
    },
  ];

export const CODEX_MCP_PRESETS: readonly CodexMcpPreset[] = [
  {
    id: "openconnector",
    category: "aggregators",
    name: "openconnector",
    title: "OpenConnector",
    description: "Use connected-app actions through OOMOL's hosted Connector gateway.",
    transport: "streamable-http",
    url: "https://connector.oomol.com/v1/mcp",
    connectionLabel: "API key",
    setupHint:
      "This shortcut uses OOMOL's SaaS endpoint, the hosted counterpart to OpenConnector. It requires an OOMOL API key in the Authorization header; use Custom server instead for your own OpenConnector /mcp URL.",
    docsUrl: "https://console.oomol.com/install?target=mcp",
  },
  {
    id: "composio-rube",
    category: "aggregators",
    name: "composio",
    title: "Composio Rube",
    description: "Connect many SaaS apps through Composio's hosted universal MCP server.",
    transport: "streamable-http",
    url: "https://rube.app/mcp",
    connectionLabel: "OAuth / token",
    setupHint:
      "Rube uses OAuth 2.1 or an authorization token. Sandpi can save the endpoint, but it does not currently broker MCP OAuth callbacks or custom authorization headers.",
    docsUrl: "https://composio.dev/content/rube-mcp-solving-context-overload",
  },
  {
    id: "github",
    category: "remote",
    name: "github",
    title: "GitHub",
    description: "Work with repositories, issues, pull requests and Actions.",
    transport: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    connectionLabel: "OAuth / PAT",
    setupHint:
      "GitHub requires OAuth or a personal access token. Use https://api.githubcopilot.com/mcp/readonly when only read access is needed.",
    docsUrl:
      "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    defaultToolsApprovalMode: "writes",
  },
  {
    id: "notion",
    category: "remote",
    name: "notion",
    title: "Notion",
    description: "Search and update pages, databases and workspace content.",
    transport: "streamable-http",
    url: "https://mcp.notion.com/mcp",
    connectionLabel: "OAuth",
    setupHint:
      "Notion's hosted MCP server supports OAuth only. Sandpi can save the endpoint, but account connection needs native MCP OAuth support.",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "linear",
    category: "remote",
    name: "linear",
    title: "Linear",
    description: "Work with issues, projects and team workflows.",
    transport: "streamable-http",
    url: "https://mcp.linear.app/mcp",
    connectionLabel: "OAuth / token",
    setupHint:
      "Linear supports OAuth or a Bearer token. Sandpi does not currently broker MCP OAuth callbacks or custom authorization headers.",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "sentry",
    category: "remote",
    name: "sentry",
    title: "Sentry",
    description: "Investigate errors, issues, traces and project health.",
    transport: "streamable-http",
    url: "https://mcp.sentry.dev/mcp",
    connectionLabel: "OAuth",
    setupHint:
      "Sentry account authorization is required after the endpoint is added. Sandpi does not currently broker the MCP OAuth callback.",
    docsUrl: "https://github.com/getsentry/sentry-mcp",
  },
  {
    id: "context7",
    category: "remote",
    name: "context7",
    title: "Context7",
    description: "Retrieve current library and framework documentation.",
    transport: "streamable-http",
    url: "https://mcp.context7.com/mcp",
    connectionLabel: "Optional API key",
    setupHint:
      "Basic public access works without authentication. Higher limits and private repositories require an API-key header that Sandpi does not currently configure.",
    docsUrl: "https://github.com/upstash/context7",
  },
  {
    id: "microsoft-learn",
    category: "remote",
    name: "microsoft-learn",
    title: "Microsoft Learn",
    description: "Search official Microsoft technical documentation.",
    transport: "streamable-http",
    url: "https://learn.microsoft.com/api/mcp",
    connectionLabel: "No auth",
    setupHint:
      "Microsoft Learn exposes a public Streamable HTTP endpoint and does not require authentication.",
    docsUrl:
      "https://learn.microsoft.com/en-us/training/support/mcp-developer-reference",
  },
  {
    id: "playwright",
    category: "local",
    name: "playwright",
    title: "Playwright",
    description: "Automate and inspect web pages through a headless browser.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--no-sandbox"],
    connectionLabel: "STDIO",
    setupHint:
      "Runs inside the Environment sandbox. The first launch needs npm registry access, and the runtime must provide a compatible Chromium or Chrome binary.",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    startupTimeoutSec: 120,
    toolTimeoutSec: 120,
  },
  {
    id: "filesystem",
    category: "local",
    name: "filesystem",
    title: "Filesystem",
    description: "Expose read and write operations scoped to /workspace.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    connectionLabel: "STDIO",
    setupHint:
      "Runs inside the Environment sandbox and overlaps with Codex's native file tools. The first launch needs npm registry access; tool approval remains set to prompt.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md",
  },
  {
    id: "sequential-thinking",
    category: "local",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    description: "Add a structured, revisable problem-solving tool.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    connectionLabel: "STDIO",
    setupHint:
      "Runs inside the Environment sandbox. The first launch downloads the package with npx and therefore needs npm registry access.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/README.md",
  },
];

export function codexMcpInputFromPreset(
  preset: CodexMcpPreset,
): CodexMcpServerInput {
  return {
    transport: preset.transport,
    command: preset.command,
    args: [...(preset.args ?? [])],
    url: preset.url,
    enabled: true,
    required: false,
    startupTimeoutSec: preset.startupTimeoutSec,
    toolTimeoutSec: preset.toolTimeoutSec,
    defaultToolsApprovalMode: preset.defaultToolsApprovalMode ?? "prompt",
    enabledTools: [],
    disabledTools: [],
  };
}
