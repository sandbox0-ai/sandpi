import type { CodexComposerImage } from "./types";
import { createId } from "@/lib/id";

export const MAX_CODEX_COMPOSER_IMAGES = 6;
export const MAX_CODEX_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_COMPOSER_TOTAL_BYTES = 25 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type CodexImageSelectionIssue =
  | "too-large"
  | "too-many"
  | "total-too-large"
  | "unsupported";

export interface EncodedCodexImage {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export function selectCodexImageFiles(
  files: readonly File[],
  current: readonly CodexComposerImage[],
) {
  const availableSlots = MAX_CODEX_COMPOSER_IMAGES - current.length;
  if (availableSlots <= 0) {
    return { files: [] as File[], issue: "too-many" as const };
  }

  const supported = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  const perFile = supported.filter(
    (file) => file.size <= MAX_CODEX_COMPOSER_IMAGE_BYTES,
  );
  const accepted: File[] = [];
  let totalBytes = current.reduce((total, image) => total + image.sizeBytes, 0);
  for (const file of perFile.slice(0, availableSlots)) {
    if (totalBytes + file.size > MAX_CODEX_COMPOSER_TOTAL_BYTES) break;
    accepted.push(file);
    totalBytes += file.size;
  }

  let issue: CodexImageSelectionIssue | undefined;
  if (supported.length !== files.length) issue = "unsupported";
  else if (perFile.length !== supported.length) issue = "too-large";
  else if (files.length > availableSlots) issue = "too-many";
  else if (accepted.length !== perFile.slice(0, availableSlots).length) {
    issue = "total-too-large";
  }
  return { files: accepted, issue };
}

export function clipboardCodexImageFiles(clipboard: DataTransfer) {
  return Array.from(clipboard.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export function readCodexComposerImage(file: File): Promise<CodexComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Image did not produce a data URL."));
        return;
      }
      resolve({
        id: createId("image", 16),
        name: file.name || "clipboard-image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: reader.result,
      });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

export function encodeCodexComposerImage(
  image: CodexComposerImage,
): EncodedCodexImage {
  const marker = ";base64,";
  const markerIndex = image.previewUrl.indexOf(marker);
  if (
    markerIndex < 0 ||
    image.previewUrl.slice(0, markerIndex) !== `data:${image.mimeType}`
  ) {
    throw new Error("Image preview is not a matching base64 data URL.");
  }
  return {
    name: image.name,
    mimeType: image.mimeType,
    dataBase64: image.previewUrl.slice(markerIndex + marker.length),
  };
}
