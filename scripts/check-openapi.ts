import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import SwaggerParser from "@apidevtools/swagger-parser";

import { buildOpenApi } from "../src/server/openapi/build";

const openApiPath = fileURLToPath(
  new URL("../openapi.yaml", import.meta.url),
);
const [committed, generated] = await Promise.all([
  readFile(openApiPath, "utf8"),
  buildOpenApi(),
]);
await SwaggerParser.validate(generated.document);

if (committed !== generated.yaml) {
  process.stderr.write(
    "openapi.yaml is out of date. Run `npm run openapi:generate` and commit the result.\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Validated ${openApiPath} (${operationCount(generated.document)} operations).\n`,
  );
}

function operationCount(document: {
  paths: Record<string, Record<string, unknown> | undefined>;
}) {
  const methods = new Set(["get", "post", "put", "delete", "patch"]);
  return Object.values(document.paths).reduce(
    (count, path) =>
      count +
      Object.keys(path ?? {}).filter((method) => methods.has(method)).length,
    0,
  );
}
