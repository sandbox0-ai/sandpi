import { rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { buildOpenApi } from "../src/server/openapi/build";

const OPENAPI_PATH = fileURLToPath(
  new URL("../openapi.yaml", import.meta.url),
);

const { yaml } = await buildOpenApi();
const temporaryPath = `${OPENAPI_PATH}.${process.pid}.tmp`;
try {
  await writeFile(temporaryPath, yaml, "utf8");
  await rename(temporaryPath, OPENAPI_PATH);
} finally {
  await rm(temporaryPath, { force: true });
}
process.stdout.write(`Generated ${OPENAPI_PATH}\n`);
