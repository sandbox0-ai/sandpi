import type { SandpiPreferences } from "./types";
import { formatUnixTimestamp, type UnixTimestamp } from "./time";

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
  timestamp: UnixTimestamp,
  language: OperationLanguage,
  timeZone: string,
) {
  return formatUnixTimestamp(
    timestamp,
    language,
    timeZone,
    getAuditTimeFormatOptions("auto"),
  );
}

export function formatAuditDateTime(
  timestamp: UnixTimestamp,
  language: OperationLanguage,
  timeZone: string,
) {
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...getAuditTimeFormatOptions("auto"),
  };
  return formatUnixTimestamp(timestamp, language, timeZone, options);
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
      switchTeam: "Switch team",
      teams: "Available teams",
      noTeam: "No team",
      currentTeam: "Current team",
      members: (count: number) => `${count} ${count === 1 ? "member" : "members"}`,
      weeklyExecution: (usedHours: number, limitHours: number) =>
        `${usedHours} of ${limitHours} execution hours this week`,
      teamSettings: "Team settings",
    },
    inspector: {
      label: "Environment inspector",
      views: "Inspector views",
      files: "Files",
      metrics: "Metrics",
      close: "Close inspector",
      loadingView: (view: string) => `Loading ${view.toLowerCase()}…`,
      workspaceFiles: "Workspace files",
      shareFile: (name: string) => `Share ${name}`,
      openNewView: "Open in Sandpi Cloud IDE (coming later)",
      binaryFilePreview: "Binary files cannot be previewed here.",
      volumeLive: (volumeId: string) => `Volume live · ${volumeId}`,
      auditEvents: "Environment audit",
      activitySummary: (count: number, attention: number) =>
        attention > 0
          ? `${count} ${count === 1 ? "activity" : "activities"} · ${attention} needs attention`
          : `${count} ${count === 1 ? "activity" : "activities"} · No issues detected`,
      activityFilter: "Filter Environment audit",
      allActivity: "All records",
      attentionOnly: "Needs attention",
      networkActivity: "Network",
      runtimeActivity: "Runtime operations",
      sandboxLifecycle: "Sandbox operations",
      auditDataVerified: "Audit data verified",
      recordsNeedVerification: (count: number) =>
        `${count} signed ${count === 1 ? "record needs" : "records need"} verification`,
      connectedTo: (endpoint: string) => `Connected to ${endpoint}`,
      connectionAllowed: "Allowed by this Environment's network policy.",
      blockedConnection: (endpoint: string) => `Blocked connection to ${endpoint}`,
      connectionBlocked: "Denied by this Environment's network policy.",
      sandboxResumed: "Sandbox resumed",
      sandboxReady: "The Environment runtime is ready.",
      recordedActivity: (resource: string) => `Activity on ${resource}`,
      recordedBy: (source: string) => `Recorded by ${source}`,
      activityTrail: (count: number) =>
        `${count} signed ${count === 1 ? "record" : "records"}`,
      phaseLabel: (phase: "attempt" | "result" | "effect") =>
        ({ attempt: "Requested", result: "Request completed", effect: "Observed" })[
          phase
        ],
      outcomeLabel: (
        outcome:
          | "completed"
          | "denied"
          | "error"
          | "succeeded"
          | "failed"
          | "accepted"
          | "unknown",
      ) =>
        ({
          completed: "Completed",
          succeeded: "Completed",
          accepted: "Accepted",
          denied: "Blocked",
          failed: "Failed",
          error: "Failed",
          unknown: "Unknown",
        })[outcome],
      technicalDetails: "Technical details",
      signatureVerified: "Signature verified",
      signatureInvalid: "Invalid signature",
      signatureUnavailable: "Verification unavailable",
      eventIdConflict: "Event ID conflict",
      copyEvent: "Copy event JSON",
      noAuditEvents: "No signed audit events yet",
      noMatchingAuditEvents: "No events match these filters",
      asynchronousAudit:
        "Canonical events can appear shortly after the observed sandbox activity.",
      lastHour: "Last hour",
      last15Minutes: "Last 15 minutes",
      last6Hours: "Last 6 hours",
      last24Hours: "Last 24 hours",
      last7Days: "Last 7 days",
      runtimeMetrics: "Runtime metrics",
      metricsRange: "Metrics time range",
      fifteenMinutes: "15 minutes",
      oneHour: "1 hour",
      sixHours: "6 hours",
      twentyFourHours: "24 hours",
      sevenDays: "7 days",
      metricChart: "Metric values over the last hour",
      metricChartInstructions:
        "Hover to inspect a sample. With the chart focused, use the left and right arrow keys to move between samples.",
      metricSeries: "Metric series",
      showMetricSeries: (label: string) => `Show ${label}`,
      hideMetricSeries: (label: string) => `Hide ${label}`,
      average: (value: number) => `avg ${value}%`,
      peak: (value: number) => `peak ${value}%`,
      memory: "Memory",
      networkTraffic: "Network traffic",
      received: "Received",
      sent: "Sent",
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
      switchTeam: "切换团队",
      teams: "可用团队",
      noTeam: "无团队",
      currentTeam: "当前团队",
      members: (count: number) => `${count} 位成员`,
      weeklyExecution: (usedHours: number, limitHours: number) =>
        `本周已用 ${usedHours} / ${limitHours} 执行小时`,
      teamSettings: "团队设置",
    },
    inspector: {
      label: "环境检查器",
      views: "检查器视图",
      files: "文件",
      metrics: "指标",
      close: "关闭检查器",
      loadingView: (view: string) => `正在加载${view}…`,
      workspaceFiles: "Workspace 文件",
      shareFile: (name: string) => `分享 ${name}`,
      openNewView: "在 Sandpi Cloud IDE 中打开（后续支持）",
      binaryFilePreview: "暂不支持在这里预览二进制文件。",
      volumeLive: (volumeId: string) => `Volume 在线 · ${volumeId}`,
      auditEvents: "Environment 审计",
      activitySummary: (count: number, attention: number) =>
        attention > 0
          ? `${count} 项活动 · ${attention} 项需关注`
          : `${count} 项活动 · 未发现问题`,
      activityFilter: "筛选 Environment 审计",
      allActivity: "全部记录",
      attentionOnly: "需要关注",
      networkActivity: "网络",
      runtimeActivity: "运行时操作",
      sandboxLifecycle: "Sandbox 操作",
      auditDataVerified: "审计数据已验证",
      recordsNeedVerification: (count: number) =>
        `${count} 条签名记录需要验证`,
      connectedTo: (endpoint: string) => `已连接 ${endpoint}`,
      connectionAllowed: "该连接符合当前 Environment 的网络策略。",
      blockedConnection: (endpoint: string) => `已阻止连接 ${endpoint}`,
      connectionBlocked: "当前 Environment 的网络策略拒绝了该连接。",
      sandboxResumed: "Sandbox 已恢复",
      sandboxReady: "Environment 运行时已就绪。",
      recordedActivity: (resource: string) => `${resource} 活动`,
      recordedBy: (source: string) => `由 ${source} 记录`,
      activityTrail: (count: number) => `${count} 条签名记录`,
      phaseLabel: (phase: "attempt" | "result" | "effect") =>
        ({ attempt: "已请求", result: "请求已完成", effect: "已观察到结果" })[
          phase
        ],
      outcomeLabel: (
        outcome:
          | "completed"
          | "denied"
          | "error"
          | "succeeded"
          | "failed"
          | "accepted"
          | "unknown",
      ) =>
        ({
          completed: "已完成",
          succeeded: "已完成",
          accepted: "已接受",
          denied: "已阻止",
          failed: "失败",
          error: "失败",
          unknown: "未知",
        })[outcome],
      technicalDetails: "技术详情",
      signatureVerified: "签名已验证",
      signatureInvalid: "签名无效",
      signatureUnavailable: "无法验证签名",
      eventIdConflict: "事件 ID 冲突",
      copyEvent: "复制事件 JSON",
      noAuditEvents: "暂无签名审计事件",
      noMatchingAuditEvents: "没有符合筛选条件的事件",
      asynchronousAudit: "Sandbox 活动发生后，规范事件可能需要短暂时间才会出现。",
      lastHour: "最近一小时",
      last15Minutes: "最近 15 分钟",
      last6Hours: "最近 6 小时",
      last24Hours: "最近 24 小时",
      last7Days: "最近 7 天",
      runtimeMetrics: "运行时指标",
      metricsRange: "指标时间范围",
      fifteenMinutes: "15 分钟",
      oneHour: "1 小时",
      sixHours: "6 小时",
      twentyFourHours: "24 小时",
      sevenDays: "7 天",
      metricChart: "最近一小时的指标值",
      metricChartInstructions:
        "悬浮可查看采样点；聚焦图表后，可使用左右方向键切换采样点。",
      metricSeries: "指标序列",
      showMetricSeries: (label: string) => `显示${label}`,
      hideMetricSeries: (label: string) => `隐藏${label}`,
      average: (value: number) => `平均 ${value}%`,
      peak: (value: number) => `峰值 ${value}%`,
      memory: "内存",
      networkTraffic: "网络流量",
      received: "接收",
      sent: "发送",
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
