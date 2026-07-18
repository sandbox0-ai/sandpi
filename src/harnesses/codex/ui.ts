import type { OperationLanguage } from "@/lib/operation-ui";
import type { SessionStatus } from "@/lib/types";

const copy = {
  en: {
    conversation: {
      label: "Codex conversation",
      expandSidebar: "Expand sidebar",
      openNavigation: "Open navigation",
      status: (status: SessionStatus) =>
        status === "running"
          ? "Running"
          : status === "waiting"
            ? "Waiting"
            : status === "paused"
              ? "Paused"
              : status === "failed"
                ? "Failed"
                : "Completed",
      environmentRevision: (revision: number) => `Environment r${revision}`,
      terminal: "Terminal",
      activity: "Activity",
      sessionActivity: "Codex Session Activity",
      codexNativeActivity: "Harness-native record",
      sessionActivitySummary: (count: number, external: number) =>
        `${count} ${count === 1 ? "record" : "records"} · ${external} external or integration ${external === 1 ? "interaction" : "interactions"}`,
      sessionActivityFilter: "Filter Codex Session Activity",
      allSessionActivity: "All Codex activity",
      externalActivity: "External & integrations",
      commandActivity: "Commands",
      fileActivity: "File changes",
      agentActivity: "Agent collaboration",
      systemActivity: "Codex system",
      nativeActivityBoundary: "Native Codex Thread activity",
      nativeActivityBoundaryBody:
        "Attributed by native Thread and Turn IDs. Conversation items come from app-server; durable tool calls are paired from the same Thread rollout with native timestamps. This is an execution record, not signed audit. Environment network evidence stays separate and is not joined by timestamp.",
      openEnvironmentAudit: "Open Environment Audit",
      loadingSessionActivity: "Loading Codex activity…",
      noSessionActivity: "No Codex activity yet",
      noMatchingSessionActivity: "No Codex activity matches this filter",
      sessionActivityEmptyBody:
        "Tool execution appears here when it is present in the native Codex Thread or its rollout.",
      activityTurn: (index: number) => `Turn ${index}`,
      activityRecords: (count: number) =>
        `${count} ${count === 1 ? "record" : "records"}`,
      externalInteraction: "External",
      agentInteraction: "Agent",
      persistedRollout: "Durable rollout",
      nativePayload: "Native details",
      loadingPersistedActivity: "Loading durable Codex tool activity…",
      rolloutActivityIssue: "Persisted tool activity is incomplete",
      closeInspector: "Close inspector",
      openInspector: "Open inspector",
      moreSessionActions: "More session actions",
      you: "You",
      openFile: "Open file",
      copyResponse: "Copy response",
      copy: "Copy",
      forkTurnMessage: "Fork Codex turn from message",
      forkTurnHere: "Fork Codex turn from here",
      forkTurnFailed: "Could not fork this Codex turn.",
      copyMessage: "Copy message",
      messageAgent: (agent: string) => `Message ${agent}`,
      askPlaceholder: (agent: string) => `Ask ${agent} to work in this session…`,
      selectModel: (agent: string) => `Select ${agent} model`,
      modelListUnavailable: "The Codex model list is unavailable while this runtime is offline.",
      nativeRolloutUnavailableTitle: "Codex history unavailable",
      nativeRolloutUnavailableBody:
        "The native Codex rollout is no longer recoverable. Sandpi cannot safely reconstruct this conversation from a secondary transcript.",
      nativeStreamUnavailableBody:
        "The Codex event stream could not be opened. Check the Sandpi server connection and deployment configuration.",
      loadingConversation: "Loading conversation…",
      loadingConversationBody:
        "Restoring the latest native Codex session state.",
      attachFile: "Attach file",
      mentionFile: "Mention file",
      attachedImages: "Attached images",
      removeImage: (name: string) => `Remove ${name}`,
      imageLimit: (count: number) => `Up to ${count} images per message.`,
      imageTooLarge: "Each image must be 10 MB or smaller.",
      imagePasteFailed: "Could not read that clipboard image.",
      boundToEnvironment: "Bound to this Environment",
      environment: "Environment",
      durableSession: "Durable session",
      checkingRuntime: "Checking Codex runtime",
      runtimeUnavailable: "Codex runtime unavailable",
      sendMessage: "Send message",
      interruptTurn: "Interrupt running Codex turn",
      interruptingTurn: "Interrupting Codex turn",
      interruptTurnFailed: "Could not interrupt the running Codex turn.",
      turnStarting: "Starting Codex turn",
      workingInWorkspace: "Working in /workspace",
      networkInherited: (name: string) => `Network policy inherited from ${name}`,
      commandStatus: (
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
        exploration: boolean,
        waiting: boolean,
      ) =>
        waiting
          ? "Waiting for background terminal"
          : exploration
            ? status === "running"
              ? "Exploring"
              : status === "completed"
                ? "Explored"
                : "Exploration stopped"
            : status === "running"
              ? "Running"
              : status === "completed"
                ? "Ran"
                : status === "declined"
                  ? "Command declined"
                  : status === "interrupted"
                    ? "Command interrupted"
                    : "Command failed",
      fileStatus: (
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
        count: number,
      ) =>
        status === "running"
          ? `Editing ${count} ${count === 1 ? "file" : "files"}`
          : status === "completed"
            ? `Edited ${count} ${count === 1 ? "file" : "files"}`
            : status === "declined"
              ? "File changes declined"
              : status === "interrupted"
                ? "File changes interrupted"
                : "File changes failed",
      nativeItemStatus: (
        itemType: string,
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
      ) => {
        const label =
          ({
            plan: "Plan",
            reasoning: "Reasoning",
            hookPrompt: "Hook prompt",
            mcpToolCall: "MCP tool",
            dynamicToolCall: "Dynamic tool",
            collabAgentToolCall: "Collaboration tool",
            subAgentActivity: "Subagent activity",
            webSearch: "Web search",
            imageView: "Image inspection",
            sleep: "Wait",
            imageGeneration: "Image generation",
            enteredReviewMode: "Review mode",
            exitedReviewMode: "Review mode",
            contextCompaction: "Context compaction",
            rolloutToolCall: "Tool call",
          } as Record<string, string>)[itemType] ?? `Codex ${itemType}`;
        return status === "running"
          ? label
          : status === "completed"
            ? `${label} completed`
            : status === "declined"
              ? `${label} declined`
              : status === "interrupted"
                ? `${label} interrupted`
                : `${label} failed`;
      },
      fileAction: (kind: "add" | "delete" | "update") =>
        kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Edited",
      turnActivity: (
        state:
          | "working"
          | "thinking"
          | "responding"
          | "runningCommand"
          | "waitingForCommand"
          | "editingFiles",
      ) =>
        state === "thinking"
          ? "Thinking"
          : state === "responding"
            ? "Responding"
            : state === "runningCommand"
              ? "Running command"
              : state === "waitingForCommand"
                ? "Waiting for background terminal"
                : state === "editingFiles"
                  ? "Editing files"
                  : "Working",
      runningFor: (duration: string) => `Running for ${duration}`,
      workedFor: (duration: string) => `Worked for ${duration}`,
      viewTurnActivity: "View work",
      expandTurnActivity: "Expand turn activity",
      collapseTurnActivity: "Collapse turn activity",
      turnFailed: "Turn failed",
      turnInterrupted: "Turn interrupted",
      outputTruncated: "Output preview truncated",
      openChangedFiles: "Open changed files",
    },
    newSession: {
      expandSidebar: "Expand sidebar",
      openNavigation: "Open navigation",
      title: "New session",
      environmentReady: (revision: number) => `Environment r${revision} ready`,
      preparingEnvironment: "Preparing Environment Workspace…",
      environmentFailed: "Environment provisioning failed",
      retryEnvironment: "Retry",
      retryingEnvironment: "Retrying…",
      environmentSettings: (name: string) => `${name} settings`,
      terminal: "Terminal",
      question: (agent: string) => `What should ${agent} work on?`,
      introduction: (environment: string) =>
        `The first instruction starts a new Codex thread in ${environment}'s shared Sandbox and Workspace.`,
      environmentRevision: (revision: number) => `Environment r${revision}`,
      agentBound: (agent: string) => `${agent} bound`,
      sharedRuntime: "Shared Sandbox & Workspace",
      emptyInstruction: (agent: string) => `Tell ${agent} what to work on.`,
      startFailed: "Could not start the Session. Try again.",
      placeholder: (agent: string) => `Ask ${agent} to work on something…`,
      selectModel: (agent: string) => `Select ${agent} model`,
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
  },
  "zh-CN": {
    conversation: {
      label: "Codex 对话",
      expandSidebar: "展开侧边栏",
      openNavigation: "打开导航",
      status: (status: SessionStatus) =>
        status === "running"
          ? "运行中"
          : status === "waiting"
            ? "等待中"
            : status === "paused"
              ? "已暂停"
              : status === "failed"
                ? "失败"
                : "已完成",
      environmentRevision: (revision: number) => `环境 r${revision}`,
      terminal: "终端",
      activity: "活动记录",
      sessionActivity: "Codex Session 活动",
      codexNativeActivity: "Harness 原生记录",
      sessionActivitySummary: (count: number, external: number) =>
        `${count} 条记录 · ${external} 条外部或集成交互`,
      sessionActivityFilter: "筛选 Codex Session 活动",
      allSessionActivity: "全部 Codex 活动",
      externalActivity: "外部与集成",
      commandActivity: "命令",
      fileActivity: "文件修改",
      agentActivity: "Agent 协作",
      systemActivity: "Codex 系统",
      nativeActivityBoundary: "Codex 原生 Thread 活动",
      nativeActivityBoundaryBody:
        "通过原生 Thread 与 Turn ID 归属。对话内容来自 app-server；持久工具调用从同一 Thread 的 rollout 按原生时间戳配对。这是执行记录，不是签名审计；Environment 网络证据单独展示，不按时间戳关联。",
      openEnvironmentAudit: "打开 Environment 审计",
      loadingSessionActivity: "正在加载 Codex 活动…",
      noSessionActivity: "暂无 Codex 活动",
      noMatchingSessionActivity: "没有符合筛选条件的 Codex 活动",
      sessionActivityEmptyBody:
        "原生 Codex Thread 或其 rollout 中出现工具执行后，会在这里显示。",
      activityTurn: (index: number) => `Turn ${index}`,
      activityRecords: (count: number) => `${count} 条记录`,
      externalInteraction: "外部",
      agentInteraction: "Agent",
      persistedRollout: "持久 Rollout",
      nativePayload: "原生详情",
      loadingPersistedActivity: "正在加载持久 Codex 工具活动…",
      rolloutActivityIssue: "持久工具活动记录不完整",
      closeInspector: "关闭检查器",
      openInspector: "打开检查器",
      moreSessionActions: "更多会话操作",
      you: "你",
      openFile: "打开文件",
      copyResponse: "复制回复",
      copy: "复制",
      forkTurnMessage: "从消息派生 Codex Turn",
      forkTurnHere: "从这里派生 Codex Turn",
      forkTurnFailed: "无法派生这个 Codex Turn。",
      copyMessage: "复制消息",
      messageAgent: (agent: string) => `向 ${agent} 发送消息`,
      askPlaceholder: (agent: string) => `让 ${agent} 在此会话中执行任务…`,
      selectModel: (agent: string) => `选择 ${agent} 模型`,
      modelListUnavailable: "当前运行时离线，无法获取 Codex 模型列表。",
      nativeRolloutUnavailableTitle: "Codex 历史不可用",
      nativeRolloutUnavailableBody:
        "Codex 原生 rollout 已无法恢复。Sandpi 不会使用次级转录记录伪造或重建这段对话。",
      nativeStreamUnavailableBody:
        "无法打开 Codex 事件流。请检查 Sandpi 服务连接和部署配置。",
      loadingConversation: "正在加载对话…",
      loadingConversationBody:
        "正在恢复最新的 Codex 原生会话状态。",
      attachFile: "附加文件",
      mentionFile: "引用文件",
      attachedImages: "已附加图片",
      removeImage: (name: string) => `移除 ${name}`,
      imageLimit: (count: number) => `每条消息最多添加 ${count} 张图片。`,
      imageTooLarge: "每张图片不能超过 10 MB。",
      imagePasteFailed: "无法读取剪贴板中的图片。",
      boundToEnvironment: "绑定到此环境",
      environment: "环境",
      durableSession: "持久会话",
      checkingRuntime: "正在检查 Codex 运行时",
      runtimeUnavailable: "Codex 运行时不可用",
      sendMessage: "发送消息",
      interruptTurn: "中断正在运行的 Codex Turn",
      interruptingTurn: "正在中断 Codex Turn",
      interruptTurnFailed: "无法中断正在运行的 Codex Turn。",
      turnStarting: "正在启动 Codex Turn",
      workingInWorkspace: "工作目录 /workspace",
      networkInherited: (name: string) => `网络策略继承自 ${name}`,
      commandStatus: (
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
        exploration: boolean,
        waiting: boolean,
      ) =>
        waiting
          ? "正在等待后台终端"
          : exploration
            ? status === "running"
              ? "正在检查"
              : status === "completed"
                ? "已检查"
                : "检查已停止"
            : status === "running"
              ? "正在运行"
              : status === "completed"
                ? "已运行"
                : status === "declined"
                  ? "命令已拒绝"
                  : status === "interrupted"
                    ? "命令已中断"
                    : "命令失败",
      fileStatus: (
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
        count: number,
      ) =>
        status === "running"
          ? `正在编辑 ${count} 个文件`
          : status === "completed"
            ? `已编辑 ${count} 个文件`
            : status === "declined"
              ? "文件修改已拒绝"
              : status === "interrupted"
                ? "文件修改已中断"
                : "文件修改失败",
      nativeItemStatus: (
        itemType: string,
        status: "running" | "completed" | "failed" | "declined" | "interrupted",
      ) => {
        const label =
          ({
            plan: "计划",
            reasoning: "推理摘要",
            hookPrompt: "Hook 提示",
            mcpToolCall: "MCP 工具",
            dynamicToolCall: "动态工具",
            collabAgentToolCall: "协作工具",
            subAgentActivity: "子 Agent 活动",
            webSearch: "网页搜索",
            imageView: "图片检查",
            sleep: "等待",
            imageGeneration: "图片生成",
            enteredReviewMode: "审查模式",
            exitedReviewMode: "审查模式",
            contextCompaction: "上下文压缩",
            rolloutToolCall: "工具调用",
          } as Record<string, string>)[itemType] ?? `Codex ${itemType}`;
        return status === "running"
          ? label
          : status === "completed"
            ? `${label}已完成`
            : status === "declined"
              ? `${label}已拒绝`
              : status === "interrupted"
                ? `${label}已中断`
                : `${label}失败`;
      },
      fileAction: (kind: "add" | "delete" | "update") =>
        kind === "add" ? "新增" : kind === "delete" ? "删除" : "编辑",
      turnActivity: (
        state:
          | "working"
          | "thinking"
          | "responding"
          | "runningCommand"
          | "waitingForCommand"
          | "editingFiles",
      ) =>
        state === "thinking"
          ? "正在思考"
          : state === "responding"
            ? "正在回复"
            : state === "runningCommand"
              ? "正在运行命令"
              : state === "waitingForCommand"
                ? "正在等待后台终端"
                : state === "editingFiles"
                  ? "正在编辑文件"
                  : "正在工作",
      runningFor: (duration: string) => `已运行 ${duration}`,
      workedFor: (duration: string) => `工作了 ${duration}`,
      viewTurnActivity: "查看工作过程",
      expandTurnActivity: "展开 Turn 过程",
      collapseTurnActivity: "折叠 Turn 过程",
      turnFailed: "Turn 执行失败",
      turnInterrupted: "Turn 已中断",
      outputTruncated: "输出预览已截断",
      openChangedFiles: "打开已修改文件",
    },
    newSession: {
      expandSidebar: "展开侧边栏",
      openNavigation: "打开导航",
      title: "新建会话",
      environmentReady: (revision: number) => `环境 r${revision} 已就绪`,
      preparingEnvironment: "正在准备环境工作区…",
      environmentFailed: "环境创建失败",
      retryEnvironment: "重试",
      retryingEnvironment: "正在重试…",
      environmentSettings: (name: string) => `${name} 设置`,
      terminal: "终端",
      question: (agent: string) => `希望 ${agent} 做什么？`,
      introduction: (environment: string) =>
        `第一条指令会在 ${environment} 共享的 Sandbox 与工作区中启动新的 Codex Thread。`,
      environmentRevision: (revision: number) => `环境 r${revision}`,
      agentBound: (agent: string) => `已绑定 ${agent}`,
      sharedRuntime: "共享 Sandbox 与工作区",
      emptyInstruction: (agent: string) => `请告诉 ${agent} 要完成什么任务。`,
      startFailed: "无法启动会话，请重试。",
      placeholder: (agent: string) => `让 ${agent} 执行任务…`,
      selectModel: (agent: string) => `选择 ${agent} 模型`,
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
  },
} as const;

export function getCodexUiCopy(language: OperationLanguage) {
  return copy[language];
}
