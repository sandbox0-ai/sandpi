import { createHash } from "node:crypto";

import type { SandpiCloudSnapshot } from "@/lib/types";

export function cloudSnapshotEtag(snapshot: SandpiCloudSnapshot) {
  const digest = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("base64url");
  return `"${digest}"`;
}

export function requestEtagMatches(
  requested: string | string[] | undefined,
  current: string,
) {
  const normalizedCurrent = current.replace(/^W\//, "");
  const values = Array.isArray(requested) ? requested : [requested ?? ""];
  return values.some((value) =>
    value
      .split(",")
      .map((candidate) => candidate.trim())
      .some(
        (candidate) =>
          candidate === "*" ||
          candidate.replace(/^W\//, "") === normalizedCurrent,
      ),
  );
}
