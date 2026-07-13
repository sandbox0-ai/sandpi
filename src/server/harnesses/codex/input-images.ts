import { HttpError } from "@/server/http-error";

export const MAX_CODEX_INPUT_IMAGES = 6;
export const MAX_CODEX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_CODEX_INPUT_TOTAL_BYTES = 25 * 1024 * 1024;
export const MAX_CODEX_INPUT_BASE64_LENGTH = Math.ceil(
  (MAX_CODEX_INPUT_IMAGE_BYTES * 4) / 3,
) + 4;

export interface EncodedCodexInputImage {
  name: string;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
}

export function nativeCodexTurnInput(
  text: string,
  images: readonly EncodedCodexInputImage[],
) {
  if (!text.trim() && images.length === 0) {
    throw invalidImage("A Turn requires text or at least one image.");
  }
  if (images.length > MAX_CODEX_INPUT_IMAGES) {
    throw invalidImage(`A Turn accepts at most ${MAX_CODEX_INPUT_IMAGES} images.`);
  }

  let totalBytes = 0;
  const nativeImages = images.map((image) => {
    if (!isCanonicalBase64(image.dataBase64)) {
      throw invalidImage(`${image.name} is not valid base64 image data.`);
    }
    const bytes = Buffer.from(image.dataBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CODEX_INPUT_IMAGE_BYTES) {
      throw invalidImage(`${image.name} exceeds the per-image size limit.`);
    }
    if (!matchesImageSignature(image.mimeType, bytes)) {
      throw invalidImage(`${image.name} does not match its declared image type.`);
    }
    totalBytes += bytes.byteLength;
    return {
      type: "image" as const,
      url: `data:${image.mimeType};base64,${image.dataBase64}`,
    };
  });
  if (totalBytes > MAX_CODEX_INPUT_TOTAL_BYTES) {
    throw invalidImage("The combined image size exceeds the Turn limit.");
  }

  return [
    ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
    ...nativeImages,
  ];
}

function isCanonicalBase64(value: string) {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function matchesImageSignature(mimeType: EncodedCodexInputImage["mimeType"], bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
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

function invalidImage(message: string) {
  return new HttpError(400, "invalid_codex_image", message);
}
