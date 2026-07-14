import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(
  new URL("../node_modules/monaco-editor/min/vs/", import.meta.url),
);
const target = fileURLToPath(new URL("../public/monaco/vs/", import.meta.url));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
