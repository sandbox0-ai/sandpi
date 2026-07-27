"use client";

import { environmentResourceMetricPercent } from "@/lib/environment-metrics";
import type { OperationLanguage } from "@/lib/operation-ui";
import { useEnvironmentResourceMetrics } from "@/lib/use-environment-resource-metrics";

const resourceCopy = {
  en: {
    cpu: (percent: number) => `CPU ${percent}%`,
    memory: (percent: number) => `MEM ${percent}%`,
    cpuTitle: (percent: number) => `Sandbox CPU utilization: ${percent}%`,
    memoryTitle: (percent: number) => `Sandbox memory utilization: ${percent}%`,
  },
  "zh-CN": {
    cpu: (percent: number) => `CPU ${percent}%`,
    memory: (percent: number) => `内存 ${percent}%`,
    cpuTitle: (percent: number) => `Sandbox CPU 使用率：${percent}%`,
    memoryTitle: (percent: number) => `Sandbox 内存使用率：${percent}%`,
  },
} as const;

function ResourceMeter({
  label,
  title,
  percent,
}: {
  label: string;
  title: string;
  percent: number;
}) {
  return (
    <span
      className="composer-resource-metric"
      role="meter"
      aria-label={title}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      title={title}
    >
      {label}
    </span>
  );
}

export function EnvironmentResourceStatus({
  environmentId,
  language,
}: {
  environmentId: string;
  language: OperationLanguage;
}) {
  const metrics = useEnvironmentResourceMetrics(environmentId);
  const cpuPercent = environmentResourceMetricPercent(
    metrics?.cpuUtilization,
  );
  const memoryPercent = environmentResourceMetricPercent(
    metrics?.memoryUtilization,
  );
  if (cpuPercent === null && memoryPercent === null) return null;

  const copy = resourceCopy[language];
  return (
    <span className="composer-resource-metrics">
      {cpuPercent === null ? null : (
        <ResourceMeter
          label={copy.cpu(cpuPercent)}
          title={copy.cpuTitle(cpuPercent)}
          percent={cpuPercent}
        />
      )}
      {memoryPercent === null ? null : (
        <ResourceMeter
          label={copy.memory(memoryPercent)}
          title={copy.memoryTitle(memoryPercent)}
          percent={memoryPercent}
        />
      )}
    </span>
  );
}
