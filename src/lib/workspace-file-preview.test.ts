import assert from "node:assert/strict";
import test from "node:test";

import {
  detectWorkspaceFilePreview,
  matchesPreviewableFileSignature,
  workspacePreviewKindForName,
} from "./workspace-file-preview";

function bytes(...values: number[]) {
  return Uint8Array.from(values);
}

function ascii(value: string) {
  return Buffer.from(value, "ascii");
}

test("detects previewable images from content rather than their extension", () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

  assert.deepEqual(detectWorkspaceFilePreview("renamed.txt", png), {
    kind: "image",
    mimeType: "image/png",
  });
  assert.equal(
    detectWorkspaceFilePreview("spoofed.png", ascii("plain text")),
    undefined,
  );
  assert.equal(matchesPreviewableFileSignature("image/png", png), true);
  assert.equal(matchesPreviewableFileSignature("image/jpeg", png), false);
});

test("recognizes the supported browser image signatures", () => {
  const bmp = Buffer.alloc(14);
  bmp.write("BM");
  const cases = [
    {
      name: "photo.jpg",
      content: bytes(0xff, 0xd8, 0xff),
      mimeType: "image/jpeg",
    },
    {
      name: "animation.gif",
      content: ascii("GIF89a"),
      mimeType: "image/gif",
    },
    {
      name: "image.webp",
      content: Buffer.concat([
        ascii("RIFF"),
        bytes(0, 0, 0, 0),
        ascii("WEBP"),
      ]),
      mimeType: "image/webp",
    },
    { name: "bitmap.bmp", content: bmp, mimeType: "image/bmp" },
    {
      name: "favicon.ico",
      content: bytes(0, 0, 1, 0, 1, 0),
      mimeType: "image/x-icon",
    },
    {
      name: "modern.avif",
      content: Buffer.concat([
        bytes(0, 0, 0, 20),
        ascii("ftyp"),
        ascii("avif"),
        bytes(0, 0, 0, 0),
        ascii("mif1"),
      ]),
      mimeType: "image/avif",
    },
  ];

  for (const candidate of cases) {
    assert.deepEqual(
      detectWorkspaceFilePreview(candidate.name, candidate.content),
      { kind: "image", mimeType: candidate.mimeType },
      candidate.name,
    );
  }
});

test("recognizes browser audio and video containers with valid signatures", () => {
  const wav = Buffer.concat([ascii("RIFF"), bytes(0, 0, 0, 0), ascii("WAVE")]);
  const oggVideo = Buffer.concat([ascii("OggS"), ascii("\u0000theora")]);
  const mp4 = Buffer.concat([
    bytes(0, 0, 0, 20),
    ascii("ftyp"),
    ascii("isom"),
    bytes(0, 0, 0, 0),
    ascii("mp42"),
  ]);

  assert.deepEqual(detectWorkspaceFilePreview("sound.wav", wav), {
    kind: "audio",
    mimeType: "audio/wav",
  });
  assert.deepEqual(detectWorkspaceFilePreview("clip.ogv", oggVideo), {
    kind: "video",
    mimeType: "video/ogg",
  });
  assert.deepEqual(detectWorkspaceFilePreview("clip.mp4", mp4), {
    kind: "video",
    mimeType: "video/mp4",
  });
});

test("distinguishes verified audio and video container variants", () => {
  const cases = [
    {
      name: "track.aiff",
      content: Buffer.concat([
        ascii("FORM"),
        bytes(0, 0, 0, 0),
        ascii("AIFF"),
      ]),
      preview: { kind: "audio", mimeType: "audio/aiff" },
    },
    {
      name: "track.flac",
      content: ascii("fLaC"),
      preview: { kind: "audio", mimeType: "audio/flac" },
    },
    {
      name: "track.mid",
      content: ascii("MThd"),
      preview: { kind: "audio", mimeType: "audio/midi" },
    },
    {
      name: "track.opus",
      content: Buffer.concat([ascii("OggS"), ascii("OpusHead")]),
      preview: { kind: "audio", mimeType: "audio/ogg" },
    },
    {
      name: "track.weba",
      content: Buffer.concat([
        bytes(0x1a, 0x45, 0xdf, 0xa3),
        ascii("webm"),
      ]),
      preview: { kind: "audio", mimeType: "audio/webm" },
    },
    {
      name: "track.m4a",
      content: Buffer.concat([
        bytes(0, 0, 0, 20),
        ascii("ftyp"),
        ascii("M4A "),
        bytes(0, 0, 0, 0),
        ascii("isom"),
      ]),
      preview: { kind: "audio", mimeType: "audio/mp4" },
    },
    {
      name: "track.aac",
      content: bytes(0xff, 0xf1),
      preview: { kind: "audio", mimeType: "audio/aac" },
    },
    {
      name: "clip.webm",
      content: Buffer.concat([
        bytes(0x1a, 0x45, 0xdf, 0xa3),
        ascii("webm"),
      ]),
      preview: { kind: "video", mimeType: "video/webm" },
    },
    {
      name: "clip.mov",
      content: Buffer.concat([
        bytes(0, 0, 0, 20),
        ascii("ftyp"),
        ascii("qt  "),
        bytes(0, 0, 0, 0),
        ascii("qt  "),
      ]),
      preview: { kind: "video", mimeType: "video/quicktime" },
    },
  ] as const;

  for (const candidate of cases) {
    assert.deepEqual(
      detectWorkspaceFilePreview(candidate.name, candidate.content),
      candidate.preview,
      candidate.name,
    );
  }
});

test("treats ASCII-compatible PDF and ID3 containers as previews", () => {
  assert.deepEqual(
    detectWorkspaceFilePreview("guide.pdf", ascii("%PDF-1.7\n")),
    {
      kind: "pdf",
      mimeType: "application/pdf",
    },
  );
  assert.deepEqual(
    detectWorkspaceFilePreview(
      "voice.mp3",
      bytes(0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0),
    ),
    {
      kind: "audio",
      mimeType: "audio/mpeg",
    },
  );
});

test("keeps SVG and arbitrary UTF-8 files in the text editor", () => {
  assert.equal(
    detectWorkspaceFilePreview("icon.svg", ascii("<svg></svg>")),
    undefined,
  );
  assert.equal(
    detectWorkspaceFilePreview("notes.md", ascii("# Notes\n")),
    undefined,
  );
});

test("provides extension hints for file-tree icons only", () => {
  assert.equal(workspacePreviewKindForName("cover.avif"), "image");
  assert.equal(workspacePreviewKindForName("voice.m4a"), "audio");
  assert.equal(workspacePreviewKindForName("demo.webm"), "video");
  assert.equal(workspacePreviewKindForName("guide.pdf"), "pdf");
  assert.equal(workspacePreviewKindForName("server.ts"), undefined);
});
