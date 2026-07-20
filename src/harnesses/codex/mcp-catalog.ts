import type {
  CodexMcpApprovalMode,
  CodexMcpServerInput,
  CodexMcpTransport,
} from "@/harnesses/codex/environment-tools";

export type CodexMcpPresetCategory = "aggregators" | "remote" | "local";
export type CodexMcpAuthRequirement = "none" | "optional" | "required";
export type CodexMcpPresetAuthMethod = "oauth" | "bearer" | "header";

export interface CodexMcpPresetAuth {
  requirement: CodexMcpAuthRequirement;
  methods: readonly CodexMcpPresetAuthMethod[];
  headerName?: string;
  valueTemplate?: string;
  scopes?: readonly string[];
}

export interface CodexMcpPresetNetwork {
  endpointDomains: readonly string[];
  oauthDomains?: readonly string[];
}

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
  auth: CodexMcpPresetAuth;
  network: CodexMcpPresetNetwork;
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
      description:
        "Trusted packages launched beside Codex with access to this Environment and workspace.",
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
      "This shortcut uses OOMOL's SaaS endpoint, the hosted counterpart to OpenConnector. Its API key is injected only for connector.oomol.com; use Custom server for a self-hosted OpenConnector /mcp URL.",
    docsUrl: "https://console.oomol.com/install?target=mcp",
    auth: {
      requirement: "required",
      methods: ["bearer"],
      headerName: "Authorization",
      valueTemplate: "Bearer {{ .token }}",
    },
    network: { endpointDomains: ["connector.oomol.com"] },
  },
  {
    id: "composio-connect",
    category: "aggregators",
    name: "composio",
    title: "Composio Connect",
    description: "Connect many SaaS apps through Composio's hosted MCP gateway.",
    transport: "streamable-http",
    url: "https://connect.composio.dev/mcp",
    connectionLabel: "OAuth / API key",
    setupHint:
      "Composio supports native OAuth or a consumer API key. Sandpi injects API keys as x-consumer-api-key only for connect.composio.dev.",
    docsUrl: "https://docs.composio.dev/docs/composio-connect",
    auth: {
      requirement: "required",
      methods: ["header", "oauth"],
      headerName: "x-consumer-api-key",
      valueTemplate: "{{ .token }}",
    },
    network: { endpointDomains: ["connect.composio.dev"] },
  },
  {
    id: "github",
    category: "remote",
    name: "github",
    title: "GitHub",
    description: "Work with repositories, issues, pull requests and Actions.",
    transport: "streamable-http",
    url: "https://api.githubcopilot.com/mcp/",
    connectionLabel: "PAT",
    setupHint:
      "This shortcut uses a personal access token because GitHub's remote server does not support dynamic client registration and Sandpi does not ship a deployment GitHub OAuth app. Use the /readonly endpoint when only read access is needed.",
    docsUrl:
      "https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md",
    auth: {
      requirement: "required",
      methods: ["bearer"],
      headerName: "Authorization",
      valueTemplate: "Bearer {{ .token }}",
    },
    network: { endpointDomains: ["api.githubcopilot.com"] },
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
      "Notion's hosted MCP server uses OAuth. Sandpi starts Codex's native authorization flow and never receives the account token in the browser.",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    auth: { requirement: "required", methods: ["oauth"] },
    network: { endpointDomains: ["mcp.notion.com"] },
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
      "Linear supports OAuth or a Bearer token. OAuth uses Codex's native flow; tokens are injected at the sandbox egress boundary.",
    docsUrl: "https://linear.app/docs/mcp",
    auth: {
      requirement: "required",
      methods: ["oauth", "bearer"],
      headerName: "Authorization",
      valueTemplate: "Bearer {{ .token }}",
    },
    network: { endpointDomains: ["mcp.linear.app"] },
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
      "Sentry account authorization is completed through Codex's native OAuth flow after the server is saved.",
    docsUrl: "https://github.com/getsentry/sentry-mcp",
    auth: { requirement: "required", methods: ["oauth"] },
    network: { endpointDomains: ["mcp.sentry.dev"] },
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
      "Basic public access works without authentication. Add an API key for higher limits and private repositories.",
    docsUrl: "https://github.com/upstash/context7",
    auth: {
      requirement: "optional",
      methods: ["header"],
      headerName: "CONTEXT7_API_KEY",
      valueTemplate: "{{ .token }}",
    },
    network: { endpointDomains: ["mcp.context7.com"] },
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
    auth: { requirement: "none", methods: [] },
    network: { endpointDomains: ["learn.microsoft.com"] },
  },
  {
    id: "playwright",
    category: "local",
    name: "playwright",
    title: "Playwright",
    description: "Automate and inspect web pages through a headless browser.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.78", "--headless", "--no-sandbox"],
    connectionLabel: "STDIO",
    setupHint:
      "Trusted code: runs beside Codex and can access this Environment and workspace. The first launch needs npm registry access, and the runtime must provide a compatible Chromium or Chrome binary.",
    docsUrl: "https://github.com/microsoft/playwright-mcp",
    auth: { requirement: "none", methods: [] },
    network: { endpointDomains: ["registry.npmjs.org"] },
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
    args: [
      "-y",
      "@modelcontextprotocol/server-filesystem@2026.7.10",
      "/workspace",
    ],
    connectionLabel: "STDIO",
    setupHint:
      "Trusted code: can read and write /workspace beside Codex and overlaps with native file tools. The first launch needs npm registry access; tool approval remains set to prompt.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md",
    auth: { requirement: "none", methods: [] },
    network: { endpointDomains: ["registry.npmjs.org"] },
  },
  {
    id: "sequential-thinking",
    category: "local",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    description: "Add a structured, revisable problem-solving tool.",
    transport: "stdio",
    command: "npx",
    args: [
      "-y",
      "@modelcontextprotocol/server-sequential-thinking@2026.7.4",
    ],
    connectionLabel: "STDIO",
    setupHint:
      "Trusted code: runs beside Codex with this Environment's process privileges. The first launch downloads the pinned package from npm.",
    docsUrl:
      "https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking/README.md",
    auth: { requirement: "none", methods: [] },
    network: { endpointDomains: ["registry.npmjs.org"] },
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
    scopes: preset.auth.scopes ? [...preset.auth.scopes] : undefined,
    enabledTools: [],
    disabledTools: [],
  };
}
