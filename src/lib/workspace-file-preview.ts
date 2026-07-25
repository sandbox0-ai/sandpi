import type { WorkspaceIdeFilePreview } from "./types";

type WorkspacePreviewKind = WorkspaceIdeFilePreview["kind"];

const PREVIEW_EXTENSIONS: Readonly<Record<string, WorkspacePreviewKind>> = {
  aac: "audio",
  aif: "audio",
  aiff: "audio",
  flac: "audio",
  m4a: "audio",
  m4b: "audio",
  mid: "audio",
  midi: "audio",
  mp3: "audio",
  oga: "audio",
  ogg: "audio",
  opus: "audio",
  wav: "audio",
  weba: "audio",
  avif: "image",
  bmp: "image",
  gif: "image",
  ico: "image",
  jpeg: "image",
  jpg: "image",
  png: "image",
  webp: "image",
  pdf: "pdf",
  m4v: "video",
  mov: "video",
  mp4: "video",
  ogv: "video",
  webm: "video",
};

const MP4_AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P "]);
const MP4_VIDEO_BRANDS = new Set([
  "3gp4",
  "3gp5",
  "3gp6",
  "avc1",
  "dash",
  "iso2",
  "iso5",
  "iso6",
  "isom",
  "M4V ",
  "mp41",
  "mp42",
  "MSNV",
]);

function extensionOf(fileName: string) {
  const baseName = fileName.split("/").at(-1) ?? fileName;
  const separator = baseName.lastIndexOf(".");
  return separator < 0 ? "" : baseName.slice(separator + 1).toLowerCase();
}

function bytesEqual(
  content: Uint8Array,
  expected: readonly number[],
  offset = 0,
) {
  return (
    content.byteLength >= offset + expected.length &&
    expected.every((value, index) => content[offset + index] === value)
  );
}

function asciiEqual(content: Uint8Array, value: string, offset = 0) {
  return (
    content.byteLength >= offset + value.length &&
    [...value].every(
      (character, index) =>
        content[offset + index] === character.charCodeAt(0),
    )
  );
}

function containsAscii(
  content: Uint8Array,
  value: string,
  maximumBytes = 4_096,
) {
  const end = Math.min(
    content.byteLength - value.length,
    maximumBytes - value.length,
  );
  for (let offset = 0; offset <= end; offset += 1) {
    if (asciiEqual(content, value, offset)) return true;
  }
  return false;
}

function uint32BigEndian(content: Uint8Array, offset: number) {
  return (
    (content[offset] ?? 0) * 0x1_00_00_00 +
    (content[offset + 1] ?? 0) * 0x1_00_00 +
    (content[offset + 2] ?? 0) * 0x1_00 +
    (content[offset + 3] ?? 0)
  );
}

function asciiAt(content: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...content.subarray(offset, offset + length));
}

function isoBaseMediaBrands(content: Uint8Array) {
  const searchEnd = Math.min(content.byteLength, 4_096);
  let offset = 0;

  while (offset + 12 <= searchEnd) {
    const boxSize = uint32BigEndian(content, offset);
    const boxType = asciiAt(content, offset + 4, 4);
    if (boxType === "ftyp" && boxSize >= 12) {
      const boxEnd = Math.min(
        boxSize === 0 ? content.byteLength : offset + boxSize,
        content.byteLength,
      );
      const brands = new Set([asciiAt(content, offset + 8, 4)]);
      for (
        let brandOffset = offset + 16;
        brandOffset + 4 <= boxEnd;
        brandOffset += 4
      ) {
        brands.add(asciiAt(content, brandOffset, 4));
      }
      return brands;
    }
    if (boxSize < 8 || offset + boxSize > searchEnd) break;
    offset += boxSize;
  }
  return undefined;
}

function hasId3Header(content: Uint8Array) {
  return (
    content.byteLength >= 10 &&
    asciiEqual(content, "ID3") &&
    content[3] !== 0xff &&
    content[4] !== 0xff &&
    ((content[6] ?? 0) & 0x80) === 0 &&
    ((content[7] ?? 0) & 0x80) === 0 &&
    ((content[8] ?? 0) & 0x80) === 0 &&
    ((content[9] ?? 0) & 0x80) === 0
  );
}

function hasMpegAudioFrame(content: Uint8Array) {
  if (
    content.byteLength < 3 ||
    content[0] !== 0xff ||
    ((content[1] ?? 0) & 0xe0) !== 0xe0
  ) {
    return false;
  }
  const version = ((content[1] ?? 0) >> 3) & 0x03;
  const layer = ((content[1] ?? 0) >> 1) & 0x03;
  const bitrate = ((content[2] ?? 0) >> 4) & 0x0f;
  const sampleRate = ((content[2] ?? 0) >> 2) & 0x03;
  return (
    version !== 0x01 &&
    layer !== 0 &&
    bitrate !== 0 &&
    bitrate !== 0x0f &&
    sampleRate !== 0x03
  );
}

function hasAacAdtsFrame(content: Uint8Array) {
  return (
    content.byteLength >= 2 &&
    content[0] === 0xff &&
    ((content[1] ?? 0) & 0xf6) === 0xf0
  );
}

export function workspacePreviewKindForName(
  fileName: string,
): WorkspacePreviewKind | undefined {
  return PREVIEW_EXTENSIONS[extensionOf(fileName)];
}

export function matchesPreviewableFileSignature(
  mimeType: string,
  content: Uint8Array,
) {
  return detectWorkspaceFilePreview("", content)?.mimeType === mimeType;
}

/**
 * Recognizes only browser-previewable containers whose content signature
 * matches. A filename may choose between audio/video variants of a verified
 * container, but an extension by itself never enables a preview.
 */
export function detectWorkspaceFilePreview(
  fileName: string,
  content: Uint8Array,
): WorkspaceIdeFilePreview | undefined {
  const extension = extensionOf(fileName);

  if (
    bytesEqual(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (bytesEqual(content, [0xff, 0xd8, 0xff])) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (asciiEqual(content, "GIF87a") || asciiEqual(content, "GIF89a")) {
    return { kind: "image", mimeType: "image/gif" };
  }
  if (
    asciiEqual(content, "RIFF") &&
    asciiEqual(content, "WEBP", 8)
  ) {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (
    content.byteLength >= 14 &&
    asciiEqual(content, "BM") &&
    bytesEqual(content, [0, 0, 0, 0], 6)
  ) {
    return { kind: "image", mimeType: "image/bmp" };
  }
  if (
    content.byteLength >= 6 &&
    bytesEqual(content, [0, 0, 1, 0]) &&
    ((content[4] ?? 0) !== 0 || (content[5] ?? 0) !== 0)
  ) {
    return { kind: "image", mimeType: "image/x-icon" };
  }
  if (asciiEqual(content, "%PDF-")) {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (
    asciiEqual(content, "RIFF") &&
    asciiEqual(content, "WAVE", 8)
  ) {
    return { kind: "audio", mimeType: "audio/wav" };
  }
  if (
    asciiEqual(content, "FORM") &&
    (asciiEqual(content, "AIFF", 8) || asciiEqual(content, "AIFC", 8))
  ) {
    return { kind: "audio", mimeType: "audio/aiff" };
  }
  if (asciiEqual(content, "fLaC")) {
    return { kind: "audio", mimeType: "audio/flac" };
  }
  if (asciiEqual(content, "MThd")) {
    return { kind: "audio", mimeType: "audio/midi" };
  }
  if (asciiEqual(content, "OggS")) {
    if (extension === "ogv" || containsAscii(content, "theora")) {
      return { kind: "video", mimeType: "video/ogg" };
    }
    if (
      ["oga", "ogg", "opus"].includes(extension) ||
      containsAscii(content, "OpusHead") ||
      containsAscii(content, "vorbis") ||
      containsAscii(content, "Speex   ")
    ) {
      return { kind: "audio", mimeType: "audio/ogg" };
    }
  }
  if (bytesEqual(content, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (extension === "weba") {
      return { kind: "audio", mimeType: "audio/webm" };
    }
    if (extension === "webm" || containsAscii(content, "webm")) {
      return { kind: "video", mimeType: "video/webm" };
    }
  }

  const brands = isoBaseMediaBrands(content);
  if (brands) {
    if (brands.has("avif") || brands.has("avis")) {
      return { kind: "image", mimeType: "image/avif" };
    }
    if (
      extension === "m4a" ||
      extension === "m4b" ||
      [...brands].some((brand) => MP4_AUDIO_BRANDS.has(brand))
    ) {
      return { kind: "audio", mimeType: "audio/mp4" };
    }
    if (extension === "mov" || brands.has("qt  ")) {
      return { kind: "video", mimeType: "video/quicktime" };
    }
    if (
      extension === "mp4" ||
      extension === "m4v" ||
      [...brands].some((brand) => MP4_VIDEO_BRANDS.has(brand))
    ) {
      return { kind: "video", mimeType: "video/mp4" };
    }
  }
  if (hasAacAdtsFrame(content)) {
    return { kind: "audio", mimeType: "audio/aac" };
  }
  if (hasId3Header(content) || hasMpegAudioFrame(content)) {
    return { kind: "audio", mimeType: "audio/mpeg" };
  }

  return undefined;
}
