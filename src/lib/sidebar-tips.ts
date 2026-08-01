import type { OperationLanguage } from "./operation-ui";

export interface SidebarTip {
  id: string;
  title: string;
  description: string;
  prompt: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailed: string;
  dismissLabel: string;
}

const LOCAL_ENVIRONMENT_MIGRATION_TIP_ID = "local-environment-migration:v1";

const sidebarTipsByLanguage: Record<OperationLanguage, SidebarTip[]> = {
  en: [
    {
      id: LOCAL_ENVIRONMENT_MIGRATION_TIP_ID,
      title: "Migrate Your Local Environment",
      description:
        "Copy this prompt into your local coding agent to migrate your environment to Sandpi.",
      prompt:
        "Read sandpi.ai/llms.txt and use the Sandpi CLI to migrate my local coding-agent environment to Sandpi.",
      copyLabel: "Copy Prompt",
      copiedLabel: "Prompt Copied",
      copyFailed: "Copy failed. Select the prompt and copy it manually.",
      dismissLabel: "Dismiss Migration Tip",
    },
  ],
  "zh-CN": [
    {
      id: LOCAL_ENVIRONMENT_MIGRATION_TIP_ID,
      title: "迁移本地环境",
      description:
        "复制以下 Prompt，让你的本地 coding agent 将环境迁移到 Sandpi。",
      prompt:
        "阅读 sandpi.ai/llms.txt，使用 Sandpi CLI 将我的本地 coding-agent 环境迁移到 Sandpi。",
      copyLabel: "复制 Prompt",
      copiedLabel: "Prompt 已复制",
      copyFailed: "复制失败，请选中 Prompt 后手动复制。",
      dismissLabel: "关闭迁移提示",
    },
  ],
};

export function sidebarTips(language: OperationLanguage) {
  return sidebarTipsByLanguage[language];
}

export function firstVisibleSidebarTip(
  language: OperationLanguage,
  dismissedTipIds: readonly string[],
) {
  const dismissed = new Set(dismissedTipIds);
  return sidebarTips(language).find((tip) => !dismissed.has(tip.id));
}
