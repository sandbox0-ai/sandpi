import path from "node:path";

import type {
  CodexComposerReference,
  CodexComposerReferenceKind,
} from "@/harnesses/codex/types";
import {
  MAX_CODEX_COMPOSER_REFERENCES,
  MAX_CODEX_COMPOSER_UPLOAD_BYTES,
} from "@/harnesses/codex/types";
import {
  isWorkspaceInternalPath,
  normalizeWorkspacePath,
  userVisibleWorkspacePath,
  WORKSPACE_INTERNAL_ROOT,
} from "@/lib/workspace-path-policy";
import { HttpError } from "@/server/http-error";

export const CODEX_COMPOSER_UPLOAD_ROOT =
  `${WORKSPACE_INTERNAL_ROOT}/uploads`;
export const MAX_CODEX_INPUT_REFERENCES = MAX_CODEX_COMPOSER_REFERENCES;
export { MAX_CODEX_COMPOSER_UPLOAD_BYTES };
export const MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH =
  Math.ceil((MAX_CODEX_COMPOSER_UPLOAD_BYTES * 4) / 3) + 4;

export interface EncodedCodexInputReference {
  name: string;
  path: string;
  kind: CodexComposerReferenceKind;
}

export function codexComposerUploadPath(
  uploadId: string,
  fileName: string,
) {
  return path.posix.join(
    CODEX_COMPOSER_UPLOAD_ROOT,
    uploadId,
    safeUploadFileName(fileName),
  );
}

export function codexComposerReference(
  input: EncodedCodexInputReference,
) {
  const name = input.name.trim();
  if (!name || name.length > 512 || /[\u0000\r\n]/.test(name)) {
    throw invalidReference("A referenced file has an invalid name.");
  }
  const normalized = normalizeWorkspacePath(input.path);
  if (!normalized) {
    throw invalidReference("Referenced files must stay under /workspace.");
  }

  if (input.kind === "localImage") {
    if (!isCodexComposerUploadPath(normalized)) {
      throw invalidReference(
        "Local image inputs must come from Sandpi's protected upload directory.",
      );
    }
    return { type: "localImage" as const, path: normalized };
  }

  if (
    !userVisibleWorkspacePath(normalized) &&
    !isCodexComposerUploadPath(normalized)
  ) {
    throw invalidReference(
      isWorkspaceInternalPath(normalized)
        ? "Sandpi-managed Workspace state cannot be referenced."
        : "Referenced files must stay under /workspace.",
    );
  }
  return { type: "mention" as const, name, path: normalized };
}

export function isCodexComposerUploadPath(candidate: string) {
  const normalized = normalizeWorkspacePath(candidate);
  if (!normalized) return false;
  const relative = path.posix.relative(CODEX_COMPOSER_UPLOAD_ROOT, normalized);
  return relative !== "" && relative !== ".." && !relative.startsWith("../");
}

export function decodeCodexComposerUpload(dataBase64: string) {
  if (
    !dataBase64 ||
    dataBase64.length > MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH ||
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
  ) {
    throw invalidUpload("The uploaded file is not valid base64 data.");
  }
  const content = Buffer.from(dataBase64, "base64");
  if (
    content.byteLength === 0 ||
    content.byteLength > MAX_CODEX_COMPOSER_UPLOAD_BYTES ||
    content.toString("base64") !== dataBase64
  ) {
    throw invalidUpload("Uploaded files must be between 1 byte and 20 MiB.");
  }
  return content;
}

export function codexComposerUploadReference(input: {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  content: Uint8Array;
}): CodexComposerReference {
  const mimeType = input.mimeType.toLowerCase();
  const nativeLocalImage = isNativeLocalImage(mimeType);
  if (
    nativeLocalImage &&
    !matchesNativeImageSignature(mimeType, Buffer.from(input.content))
  ) {
    throw invalidUpload(
      "The uploaded image does not match its declared file type.",
    );
  }
  return {
    id: input.id,
    name: input.name,
    path: input.path,
    mimeType: input.mimeType,
    sizeBytes: input.content.byteLength,
    kind: nativeLocalImage ? "localImage" : "mention",
    source: "upload",
  };
}

function safeUploadFileName(fileName: string) {
  const baseName = path.posix.basename(fileName.trim().replaceAll("\\", "/"));
  const safe = baseName
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/]/g, "_")
    .replace(/^\.+$/, "file")
    .slice(0, 180);
  return safe || "file";
}

function isNativeLocalImage(mimeType: string) {
  return new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]).has(mimeType.toLowerCase());
}

function matchesNativeImageSignature(mimeType: string, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  return (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function invalidReference(message: string) {
  return new HttpError(400, "invalid_codex_file_reference", message);
}

function invalidUpload(message: string) {
  return new HttpError(400, "invalid_codex_file_upload", message);
}
