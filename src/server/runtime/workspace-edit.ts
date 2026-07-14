import { createHash } from "node:crypto";

import { HttpError } from "@/server/http-error";

export function workspaceFileRevision(content: Uint8Array) {
  return `sha256:${createHash("sha256").update(content).digest("base64url")}`;
}

export function requireWorkspaceFileRevision(
  content: Uint8Array,
  expectedRevision: string,
) {
  const currentRevision = workspaceFileRevision(content);
  if (currentRevision !== expectedRevision) {
    throw new HttpError(
      409,
      "workspace_file_conflict",
      "The file changed after it was opened. Compare or reload the latest version before saving.",
      { currentRevision },
    );
  }
  return currentRevision;
}
