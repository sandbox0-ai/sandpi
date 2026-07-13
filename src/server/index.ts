import { pathToFileURL } from "node:url";

import { createSandpiServer } from "./server";

export { createSandpiServer } from "./server";
export type { SandpiServer, SandpiServerOptions } from "./server";

async function main() {
  const server = await createSandpiServer();
  const shutdown = async (signal: string) => {
    server.app.log.info({ signal }, "Stopping Sandpi");
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  await server.app.listen({ host: server.config.host, port: server.config.port });
  server.app.log.info(
    { url: server.config.publicUrl.toString() },
    "Sandpi is ready",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
