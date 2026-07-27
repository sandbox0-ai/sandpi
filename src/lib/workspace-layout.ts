export const DEFAULT_INSPECTOR_WIDTH_RATIO = 0.5;
export const MIN_STORED_INSPECTOR_WIDTH_RATIO = 0.2;
export const MAX_STORED_INSPECTOR_WIDTH_RATIO = 0.8;
export const MIN_WORKSPACE_PANE_WIDTH = 360;

function roundedRatio(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

export function normalizeInspectorWidthRatio(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_INSPECTOR_WIDTH_RATIO;
  }
  return roundedRatio(
    Math.min(
      MAX_STORED_INSPECTOR_WIDTH_RATIO,
      Math.max(MIN_STORED_INSPECTOR_WIDTH_RATIO, value),
    ),
  );
}

export function clampInspectorWidthRatioForAvailableWidth(
  ratio: number,
  availableWidth: number,
) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    return normalizeInspectorWidthRatio(ratio);
  }

  const minimumPaneWidth = Math.min(
    MIN_WORKSPACE_PANE_WIDTH,
    availableWidth / 2,
  );
  const minimumRatio = Math.max(
    MIN_STORED_INSPECTOR_WIDTH_RATIO,
    minimumPaneWidth / availableWidth,
  );
  const maximumRatio = Math.min(
    MAX_STORED_INSPECTOR_WIDTH_RATIO,
    1 - minimumPaneWidth / availableWidth,
  );

  return roundedRatio(Math.min(maximumRatio, Math.max(minimumRatio, ratio)));
}

export function inspectorWidthRatioFromPointer(input: {
  pointerX: number;
  shellLeft: number;
  shellWidth: number;
  sidebarWidth: number;
}) {
  const availableWidth = Math.max(0, input.shellWidth - input.sidebarWidth);
  if (availableWidth === 0) return DEFAULT_INSPECTOR_WIDTH_RATIO;

  const inspectorWidth =
    input.shellLeft + input.shellWidth - input.pointerX;
  return clampInspectorWidthRatioForAvailableWidth(
    inspectorWidth / availableWidth,
    availableWidth,
  );
}
