import type { Environment } from "@/lib/types";

export function moveEnvironment(
  environments: Environment[],
  sourceId: string,
  targetId: string,
): Environment[] {
  const sourceIndex = environments.findIndex(({ id }) => id === sourceId);
  const targetIndex = environments.findIndex(({ id }) => id === targetId);
  if (
    sourceIndex < 0 ||
    targetIndex < 0 ||
    sourceIndex === targetIndex
  ) {
    return environments;
  }
  const next = [...environments];
  const [source] = next.splice(sourceIndex, 1);
  if (!source) return environments;
  next.splice(targetIndex, 0, source);
  return next;
}

export function moveEnvironmentByOffset(
  environments: Environment[],
  environmentId: string,
  offset: -1 | 1,
): Environment[] {
  const sourceIndex = environments.findIndex(({ id }) => id === environmentId);
  const target = environments[sourceIndex + offset];
  return target
    ? moveEnvironment(environments, environmentId, target.id)
    : environments;
}
