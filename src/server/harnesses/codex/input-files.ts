/**
 * Browser upload handling for the Codex composer. Ordinary files return to the
 * browser as visible path text; only verified images cross the app-server
 * boundary as structured localImage inputs. Filesystem paths must never be
 * converted into app/plugin `mention` inputs or hidden prompt instructions.
 */
import path from "node:path";

import type { CodexComposerUpload } from "@/harnesses/codex/types";
import {
  MAX_CODEX_COMPOSER_UPLOAD_FILES,
  MAX_CODEX_COMPOSER_UPLOAD_BYTES,
} from "@/harnesses/codex/types";
import {
  normalizeWorkspacePath,
  WORKSPACE_INTERNAL_ROOT,
} from "@/lib/workspace-path-policy";
import { matchesPreviewableFileSignature } from "@/lib/workspace-file-preview";
import { HttpError } from "@/server/http-error";

export const CODEX_COMPOSER_UPLOAD_ROOT =
  `${WORKSPACE_INTERNAL_ROOT}/uploads`;
export const MAX_CODEX_INPUT_LOCAL_IMAGES = MAX_CODEX_COMPOSER_UPLOAD_FILES;
export { MAX_CODEX_COMPOSER_UPLOAD_BYTES };
export const MAX_CODEX_COMPOSER_UPLOAD_BASE64_LENGTH =
  Math.ceil((MAX_CODEX_COMPOSER_UPLOAD_BYTES * 4) / 3) + 4;

export interface EncodedCodexLocalImage {
  name: string;
  path: string;
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

export function codexComposerLocalImage(input: EncodedCodexLocalImage) {
  const name = input.name.trim();
  if (!name || name.length > 512 || /[\u0000\r\n]/.test(name)) {
    throw invalidReference("A local image has an invalid name.");
  }
  const normalized = normalizeWorkspacePath(input.path);
  if (!normalized) {
    throw invalidReference("Local images must stay under /workspace.");
  }
  if (!isCodexComposerUploadPath(normalized)) {
    throw invalidReference(
      "Local image inputs must come from Sandpi's protected upload directory.",
    );
  }
  return { type: "localImage" as const, path: normalized };
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

export function codexComposerUpload(input: {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  content: Uint8Array;
}): CodexComposerUpload {
  const mimeType = input.mimeType.toLowerCase();
  const nativeLocalImage = isNativeLocalImage(mimeType);
  if (
    nativeLocalImage &&
    !matchesPreviewableFileSignature(mimeType, input.content)
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
    kind: nativeLocalImage ? "localImage" : "file",
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

function invalidReference(message: string) {
  return new HttpError(400, "invalid_codex_file_reference", message);
}

function invalidUpload(message: string) {
  return new HttpError(400, "invalid_codex_file_upload", message);
}
