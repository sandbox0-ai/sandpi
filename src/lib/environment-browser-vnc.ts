export interface EnvironmentBrowserRfbClient {
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  showDotCursor: boolean;
  qualityLevel: number;
  compressionLevel: number;
}

export function configureEnvironmentBrowserRfb(
  rfb: EnvironmentBrowserRfbClient,
) {
  // Remote resize fills the human-control panel when TigerVNC is available.
  // Scaling stays enabled so older Xvfb/x11vnc Environments remain usable.
  rfb.scaleViewport = true;
  rfb.resizeSession = true;
  rfb.focusOnClick = true;
  rfb.showDotCursor = true;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
}
