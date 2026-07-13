import type { SandpiPreferences } from "./types";

export type OperationLanguage = SandpiPreferences["general"]["language"];
export type SendShortcut = SandpiPreferences["general"]["sendShortcut"];

export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}

export function shouldSubmitComposer(
  input: ComposerKeyInput,
  shortcut: SendShortcut,
) {
  if (input.key !== "Enter" || input.isComposing || input.shiftKey) {
    return false;
  }

  if (shortcut === "mod-enter") {
    return input.metaKey || input.ctrlKey;
  }

  return true;
}

export function getAuditTimeFormatOptions(timeZone: string) {
  return {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone === "auto" ? {} : { timeZone }),
  } satisfies Intl.DateTimeFormatOptions;
}

export function formatAuditTime(
  timestamp: string,
  language: OperationLanguage,
  timeZone: string,
) {
  const date = new Date(timestamp);

  try {
    return new Intl.DateTimeFormat(
      language,
      getAuditTimeFormatOptions(timeZone),
    ).format(date);
  } catch {
    return new Intl.DateTimeFormat(
      language,
      getAuditTimeFormatOptions("auto"),
    ).format(date);
  }
}

const copy = {
  en: {
    sidebar: {
      navigation: "Sandpi navigation",
      collapse: "Collapse sidebar",
      close: "Close navigation",
      newEnvironment: "New environment",
      searchSessions: "Search sessions",
      environments: "Environments",
      newSession: "New session",
      newSessionIn: (name: string) => `New session in ${name}`,
      environmentSettings: "Environment settings",
      environmentSettingsFor: (name: string) => `${name} settings`,
      pinned: "Pinned",
      renameSession: (title: string) => `Rename ${title}`,
      sessionActions: (title: string) => `Session actions for ${title}`,
      actionsFor: (title: string) => `Actions for ${title}`,
      forkSession: "Fork session",
      unpin: "Unpin",
      pin: "Pin",
      rename: "Rename",
      archive: "Archive",
      preferences: "Preferences",
      help: "Help & feedback",
      accountMenu: "Open account menu",
      accountActions: "Account actions",
      personalTeam: "Personal team",
    },
    inspector: {
      label: "Session inspector",
      views: "Inspector views",
      files: "Files",
      audit: "Audit",
      metrics: "Metrics",
      close: "Close inspector",
      workspaceFiles: "Workspace files",
      shareFile: (name: string) => `Share ${name}`,
      openNewView: "Open in Sandpi Cloud IDE (coming later)",
      volumeLive: (volumeId: string) => `Volume live · ${volumeId}`,
      sandboxActivity: "Sandbox activity",
      auditEvents: "Audit events",
      allSources: "All sources",
      recentEvents: "Recent events",
      blocked: "Blocked",
      sources: "Sources",
      auditBoundary:
        "Sandbox0 supplies lifecycle and network audit events. Supervisor session events are shown as a separate source; file audit is not inferred from Volume access.",
      lastHour: "Last hour",
      runtimeMetrics: "Runtime metrics",
      oneHour: "1 hour",
      metricChart: "Metric values over the last hour",
      average: (value: number) => `avg ${value}%`,
      peak: (value: number) => `peak ${value}%`,
      memory: "Memory",
      percentOfLimit: (value: number) => `${value}% of limit`,
      memoryLimit: (value: number) => `${value} GiB limit`,
      sandbox: "Sandbox",
      supervisorSession: "Supervisor session",
      runtimeGeneration: "Runtime generation",
      metricsBoundary:
        "Chart-ready runtime series from Sandbox0 observability. Billing and metering remain a separate usage-truth path.",
      volumeFile: "Volume file",
      share: (name: string) => `Share ${name}`,
      closeDialog: "Close",
      permission: "Permission",
      canView: "Can view",
      canDownload: "Can view & download",
      linkExpires: "Link expires",
      hours24: "24 hours",
      days7: "7 days",
      days30: "30 days",
      privateLink: "Private link",
      copied: "Copied",
      copy: "Copy",
      shareBoundary:
        "The control plane validates this grant before proxying read-only Volume access. The sandbox is never exposed directly.",
    },
  },
  "zh-CN": {
    sidebar: {
      navigation: "Sandpi 导航",
      collapse: "收起侧边栏",
      close: "关闭导航",
      newEnvironment: "新建环境",
      searchSessions: "搜索会话",
      environments: "环境",
      newSession: "新建会话",
      newSessionIn: (name: string) => `在 ${name} 中新建会话`,
      environmentSettings: "环境设置",
      environmentSettingsFor: (name: string) => `${name} 设置`,
      pinned: "已置顶",
      renameSession: (title: string) => `重命名 ${title}`,
      sessionActions: (title: string) => `${title} 的会话操作`,
      actionsFor: (title: string) => `${title} 的操作`,
      forkSession: "派生会话",
      unpin: "取消置顶",
      pin: "置顶",
      rename: "重命名",
      archive: "归档",
      preferences: "偏好设置",
      help: "帮助与反馈",
      accountMenu: "打开账户菜单",
      accountActions: "账户操作",
      personalTeam: "个人团队",
    },
    inspector: {
      label: "Session 检查器",
      views: "检查器视图",
      files: "文件",
      audit: "审计",
      metrics: "指标",
      close: "关闭检查器",
      workspaceFiles: "Workspace 文件",
      shareFile: (name: string) => `分享 ${name}`,
      openNewView: "在 Sandpi Cloud IDE 中打开（后续支持）",
      volumeLive: (volumeId: string) => `Volume 在线 · ${volumeId}`,
      sandboxActivity: "Sandbox 活动",
      auditEvents: "审计事件",
      allSources: "全部来源",
      recentEvents: "近期事件",
      blocked: "已阻止",
      sources: "来源",
      auditBoundary:
        "Sandbox0 提供生命周期和网络审计事件。Supervisor Session 事件单独标记来源；不会根据 Volume 访问推断文件审计。",
      lastHour: "最近一小时",
      runtimeMetrics: "运行时指标",
      oneHour: "1 小时",
      metricChart: "最近一小时的指标值",
      average: (value: number) => `平均 ${value}%`,
      peak: (value: number) => `峰值 ${value}%`,
      memory: "内存",
      percentOfLimit: (value: number) => `占上限 ${value}%`,
      memoryLimit: (value: number) => `上限 ${value} GiB`,
      sandbox: "Sandbox",
      supervisorSession: "Supervisor Session",
      runtimeGeneration: "运行时世代",
      metricsBoundary:
        "运行时序列来自 Sandbox0 可观测性数据。Billing 与 metering 仍使用独立的用量事实链路。",
      volumeFile: "Volume 文件",
      share: (name: string) => `分享 ${name}`,
      closeDialog: "关闭",
      permission: "权限",
      canView: "可查看",
      canDownload: "可查看和下载",
      linkExpires: "链接有效期",
      hours24: "24 小时",
      days7: "7 天",
      days30: "30 天",
      privateLink: "私密链接",
      copied: "已复制",
      copy: "复制",
      shareBoundary:
        "控制面会先验证授权，再代理只读 Volume 访问；Sandbox 不会直接暴露。",
    },
  },
} as const;

export function getOperationUiCopy(language: OperationLanguage) {
  return copy[language];
}
