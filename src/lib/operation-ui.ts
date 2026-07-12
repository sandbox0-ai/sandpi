import type { SandpiPreferences, SessionStatus } from "./types";

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
      personalTeam: "Personal team",
    },
    conversation: {
      label: "Coding agent conversation",
      expandSidebar: "Expand sidebar",
      openNavigation: "Open navigation",
      status: (status: SessionStatus) =>
        status === "running"
          ? "Running"
          : status === "waiting"
            ? "Waiting"
            : status === "paused"
              ? "Paused"
              : "Completed",
      environmentRevision: (revision: number) => `Environment r${revision}`,
      terminal: "Terminal",
      closeInspector: "Close inspector",
      openInspector: "Open inspector",
      moreSessionActions: "More session actions",
      sessionForkFrom: (label: string) => `Session fork from ${label}`,
      turnForkFrom: (label: string) => `Turn fork from ${label}`,
      forkedFrom: (label: string) => `Forked from ${label}`,
      sessionForkDetail: "Sandbox rootfs · private Workspace Volume",
      turnForkDetail: (revision: number) =>
        `Workspace Volume only · Environment r${revision}`,
      environmentForkDetail: (revision: number, credentialRevision: number) =>
        `Revision ${revision} · private Workspace Volume · credential revision ${credentialRevision}`,
      you: "You",
      openFile: "Open file",
      copyResponse: "Copy response",
      copy: "Copy",
      confirmDelete: "Confirm delete",
      deleteFromHere: "Delete from here?",
      delete: "Delete",
      cancelDelete: "Cancel delete",
      cancel: "Cancel",
      editMessage: "Edit message",
      editFromHere: "Edit from here",
      forkTurnMessage: "Fork turn from message",
      forkTurnHere: "Fork turn from here",
      copyMessage: "Copy message",
      deleteMessage: "Delete message",
      editing: "Editing from this message",
      descendantsHidden: "This turn and later messages are hidden",
      cancelEditing: "Cancel editing",
      messageAgent: (agent: string) => `Message ${agent}`,
      editPlaceholder: "Edit this instruction…",
      askPlaceholder: (agent: string) =>
        `Ask ${agent} to work in this session…`,
      attachFile: "Attach file",
      mentionFile: "Mention file",
      boundToEnvironment: "Bound to this Environment",
      environment: "Environment",
      durableSession: "Durable session",
      sendMessage: "Send message",
      workingInWorkspace: "Working in /workspace",
      networkInherited: (name: string) =>
        `Network policy inherited from ${name}`,
    },
    newSession: {
      expandSidebar: "Expand sidebar",
      openNavigation: "Open navigation",
      title: "New session",
      readyToFork: (revision: number) =>
        `Ready to fork Environment r${revision}`,
      environmentSettings: (name: string) => `${name} settings`,
      question: (agent: string) => `What should ${agent} work on?`,
      introduction: (environment: string) =>
        `The first instruction creates an isolated Sandbox from ${environment} and starts its bound native coding agent.`,
      environmentRevision: (revision: number) => `Environment r${revision}`,
      agentBound: (agent: string) => `${agent} bound`,
      hardTtl: "30-day hard TTL",
      emptyInstruction: (agent: string) => `Tell ${agent} what to work on.`,
      startFailed: "Could not start the Session. Try again.",
      placeholder: (agent: string) => `Ask ${agent} to work on something…`,
      attachFile: "Attach file",
      mentionFile: "Mention file",
      environment: "Environment",
      starting: "Starting Session",
      sendAndStart: "Send instruction and start Session",
      starterLabel: "Starter instructions",
      starters: [
        "Inspect this workspace and explain its structure",
        "Find the highest-risk bug and fix it",
        "Run the tests and resolve any failures",
      ],
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
      personalTeam: "个人团队",
    },
    conversation: {
      label: "Coding Agent 对话",
      expandSidebar: "展开侧边栏",
      openNavigation: "打开导航",
      status: (status: SessionStatus) =>
        status === "running"
          ? "运行中"
          : status === "waiting"
            ? "等待中"
            : status === "paused"
              ? "已暂停"
              : "已完成",
      environmentRevision: (revision: number) => `环境 r${revision}`,
      terminal: "终端",
      closeInspector: "关闭检查器",
      openInspector: "打开检查器",
      moreSessionActions: "更多会话操作",
      sessionForkFrom: (label: string) => `从会话 ${label} 派生`,
      turnForkFrom: (label: string) => `从轮次 ${label} 派生`,
      forkedFrom: (label: string) => `派生自 ${label}`,
      sessionForkDetail: "Sandbox rootfs · 私有 Workspace Volume",
      turnForkDetail: (revision: number) =>
        `仅 Workspace Volume · 环境 r${revision}`,
      environmentForkDetail: (revision: number, credentialRevision: number) =>
        `修订 ${revision} · 私有 Workspace Volume · 凭证修订 ${credentialRevision}`,
      you: "你",
      openFile: "打开文件",
      copyResponse: "复制回复",
      copy: "复制",
      confirmDelete: "确认删除",
      deleteFromHere: "从这里开始删除？",
      delete: "删除",
      cancelDelete: "取消删除",
      cancel: "取消",
      editMessage: "编辑消息",
      editFromHere: "从这里开始编辑",
      forkTurnMessage: "从消息派生轮次",
      forkTurnHere: "从这里派生轮次",
      copyMessage: "复制消息",
      deleteMessage: "删除消息",
      editing: "正在从这条消息编辑",
      descendantsHidden: "当前轮次及后续消息已隐藏",
      cancelEditing: "取消编辑",
      messageAgent: (agent: string) => `向 ${agent} 发送消息`,
      editPlaceholder: "编辑这条指令…",
      askPlaceholder: (agent: string) => `让 ${agent} 在此会话中执行任务…`,
      attachFile: "附加文件",
      mentionFile: "引用文件",
      boundToEnvironment: "绑定到此环境",
      environment: "环境",
      durableSession: "持久会话",
      sendMessage: "发送消息",
      workingInWorkspace: "工作目录 /workspace",
      networkInherited: (name: string) => `网络策略继承自 ${name}`,
    },
    newSession: {
      expandSidebar: "展开侧边栏",
      openNavigation: "打开导航",
      title: "新建会话",
      readyToFork: (revision: number) => `已准备从环境 r${revision} 派生`,
      environmentSettings: (name: string) => `${name} 设置`,
      question: (agent: string) => `希望 ${agent} 做什么？`,
      introduction: (environment: string) =>
        `第一条指令会从 ${environment} 创建隔离的 Sandbox，并启动该环境绑定的原生 Coding Agent。`,
      environmentRevision: (revision: number) => `环境 r${revision}`,
      agentBound: (agent: string) => `已绑定 ${agent}`,
      hardTtl: "30 天硬性 TTL",
      emptyInstruction: (agent: string) => `请告诉 ${agent} 要完成什么任务。`,
      startFailed: "无法启动会话，请重试。",
      placeholder: (agent: string) => `让 ${agent} 执行任务…`,
      attachFile: "附加文件",
      mentionFile: "引用文件",
      environment: "环境",
      starting: "正在启动会话",
      sendAndStart: "发送指令并启动会话",
      starterLabel: "入门指令",
      starters: [
        "检查此工作区并说明其结构",
        "找出风险最高的缺陷并修复",
        "运行测试并解决所有失败",
      ],
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
