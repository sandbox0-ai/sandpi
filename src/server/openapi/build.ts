import fastifySwagger from "@fastify/swagger";
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
} from "@fastify/type-provider-zod";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifySchema,
} from "fastify";
import type { OpenAPIV3 } from "openapi-types";

import packageJson from "../../../package.json" with { type: "json" };
import {
  openApiContractKey,
  openApiRouteContractMap,
} from "@/server/openapi/contracts";
import {
  registerApiRoutes,
  registerAuthRoutes,
  registerHealthRoutes,
  SESSION_COOKIE,
} from "@/server/server";

const TAGS: OpenAPIV3.TagObject[] = [
  { name: "Health", description: "Deployment health probes." },
  {
    name: "Authentication",
    description: "Browser-cookie authentication and OIDC redirects.",
  },
  { name: "Bootstrap", description: "Initial cross-client application state." },
  { name: "Billing", description: "Optional deployment billing state." },
  { name: "Environments", description: "Shared Sandpi workspaces and runtimes." },
  {
    name: "Egress credentials",
    description: "Environment-scoped secret injection without secret readback.",
  },
  {
    name: "Workspace backups",
    description: "Persistent Workspace snapshots and restore.",
  },
  { name: "Schedules", description: "Durable Environment automations." },
  {
    name: "Codex",
    description: "Environment-scoped native Codex capabilities.",
  },
  {
    name: "Sessions",
    description: "Product Sessions backed by harness-native history.",
  },
  { name: "Workspace", description: "Harness-neutral Workspace file access." },
  {
    name: "Workspace IDE",
    description: "Cross-client editor snapshots, mutations and invalidations.",
  },
  {
    name: "Browser",
    description:
      "The embedded, shared human-and-agent Playwright Browser session.",
  },
  { name: "Metrics", description: "Environment runtime metrics." },
  { name: "Terminal", description: "The shared Environment terminal." },
  { name: "Preferences", description: "Authenticated viewer preferences." },
];

export interface BuiltOpenApi {
  document: OpenAPIV3.Document;
  yaml: string;
}

export async function buildOpenApi(): Promise<BuiltOpenApi> {
  const app = Fastify({ logger: false });
  const coveredContracts = new Set<string>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook("onRoute", (routeOptions) => {
    if (
      !routeOptions.url.startsWith("/api/v1") &&
      !routeOptions.url.startsWith("/health/")
    ) {
      return;
    }
    for (const method of normalizeMethods(routeOptions.method)) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      const key = openApiContractKey(method, routeOptions.url);
      const contract = openApiRouteContractMap.get(key);
      if (!contract) {
        throw new Error(`OpenAPI contract missing for ${key}.`);
      }
      routeOptions.schema = { ...contract.schema } as FastifySchema;
      coveredContracts.add(key);
    }
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Sandpi API",
        version: packageJson.version,
        description:
          "The public Sandpi server contract. JSON endpoints use a data envelope and errors use an error envelope. Unix timestamps are seconds. Browser-cookie authentication is deployment-scoped; native harness payloads and opaque Browser dashboard frames are identified explicitly.",
        license: {
          name: "Apache-2.0",
          url: "https://www.apache.org/licenses/LICENSE-2.0",
        },
      },
      servers: [
        {
          url: "/",
          description: "The Sandpi deployment serving this contract.",
        },
      ],
      tags: TAGS,
      security: [{ cookieAuth: [] }],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE,
            description:
              "OIDC-backed deployments use the HttpOnly Sandpi session cookie. Built-in-admin deployments authenticate the local administrator implicitly unless signed out.",
          },
        },
      },
      externalDocs: {
        description: "Sandpi source and architecture documentation",
        url: "https://github.com/sandbox0-ai/sandpi",
      },
    },
    transform: jsonSchemaTransform,
    transformObject: (input) =>
      finalizeOpenApi(
        jsonSchemaTransformObject(input) as OpenAPIV3.Document,
      ),
  });
  await app.register(fastifyWebsocket);
  app.addHook("onRoute", (routeOptions) => {
    const schema = routeOptions.schema as
      | (FastifySchema & { "x-sandpi-websocket"?: unknown; hide?: boolean })
      | undefined;
    if (schema?.["x-sandpi-websocket"]) schema.hide = false;
  });

  registerContractRoutes(app);
  await app.ready();

  const missingRoutes = [...openApiRouteContractMap.keys()].filter(
    (key) => !coveredContracts.has(key),
  );
  if (missingRoutes.length > 0) {
    throw new Error(
      `OpenAPI contracts do not map to server routes:\n${missingRoutes.join("\n")}`,
    );
  }

  const document = app.swagger() as OpenAPIV3.Document;
  const yaml = app.swagger({ yaml: true }) as string;
  await app.close();
  return { document, yaml };
}

function registerContractRoutes(app: FastifyInstance) {
  const placeholder = recursivePlaceholder() as never;
  registerHealthRoutes(app, placeholder, placeholder);
  registerAuthRoutes(
    app,
    placeholder,
    placeholder,
    placeholder,
    undefined,
  );
  registerApiRoutes(app, placeholder);
}

function recursivePlaceholder(): object {
  const placeholder: object = new Proxy(
    {},
    {
      get: () => placeholder,
    },
  );
  return placeholder;
}

function normalizeMethods(method: string | string[]): string[] {
  return (Array.isArray(method) ? method : [method]).map((value) =>
    value.toUpperCase(),
  );
}

function finalizeOpenApi(document: OpenAPIV3.Document): OpenAPIV3.Document {
  normalizeTransportResponses(document);
  addBrowserAssetProxy(document);
  pruneUnusedSchemas(document);
  sortOpenApiCollections(document);
  return document;
}

function normalizeTransportResponses(document: OpenAPIV3.Document) {
  for (const pathItem of Object.values(document.paths)) {
    if (!pathItem) continue;
    for (const method of [
      "get",
      "post",
      "put",
      "delete",
      "patch",
    ] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      const extendedOperation = operation as OpenAPIV3.OperationObject &
        Record<string, unknown>;
      if (
        extendedOperation["x-sandpi-optional-request-body"] === true &&
        operation.requestBody &&
        !("$ref" in operation.requestBody)
      ) {
        operation.requestBody.required = false;
      }
      const defaultResponse = operation.responses.default;
      if (
        extendedOperation["x-sandpi-proxy-protocol"] ===
          "opaque-playwright-dashboard" &&
        defaultResponse &&
        !("$ref" in defaultResponse)
      ) {
        defaultResponse.description =
          "Opaque dashboard response or Sandpi error.";
        defaultResponse.content = {
          "*/*": {
            schema: { type: "string", format: "binary" },
          },
        };
      }
      for (const status of ["101", "204", "302"]) {
        const response = operation.responses[status];
        if (response && !("$ref" in response)) delete response.content;
      }
      for (const [status, description] of Object.entries({
        "101": "Switching protocols.",
        "200": "Successful response.",
        "201": "Created.",
        "202": "Accepted.",
        "204": "No content.",
        "302": "Redirect.",
        default: "Sandpi error.",
      })) {
        const response = operation.responses[status];
        if (response && !("$ref" in response)) response.description = description;
      }
      const success = operation.responses["200"];
      if (!success || "$ref" in success) continue;
      if ("x-sandpi-sse" in extendedOperation) {
        success.content = {
          "text/event-stream": {
            schema: { type: "string" },
          },
        };
      } else if (
        extendedOperation["x-sandpi-content-type"] === "text/html"
      ) {
        success.content = {
          "text/html": {
            schema: { type: "string" },
          },
        };
      }
    }
  }
}

function addBrowserAssetProxy(document: OpenAPIV3.Document) {
  const operation: OpenAPIV3.OperationObject & Record<string, unknown> = {
    operationId: "getEnvironmentBrowserDashboardAsset",
    summary: "Load an embedded Browser dashboard asset",
    description:
      "Transparent, authenticated proxy for the built-in shared Playwright Browser dashboard. The asset protocol is owned by the pinned dashboard and is not a JSON application API.",
    tags: ["Browser"],
    parameters: [
      {
        name: "environmentId",
        in: "path",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "assetPath",
        in: "path",
        required: true,
        description: "A slash-containing dashboard asset path.",
        schema: { type: "string", minLength: 1 },
        "x-sandpi-greedy": true,
      } as OpenAPIV3.ParameterObject,
    ],
    responses: {
      "200": {
        description: "Dashboard asset.",
        content: {
          "application/octet-stream": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
      "3XX": {
        description: "Dashboard-relative redirect.",
        headers: {
          Location: {
            schema: { type: "string" },
          },
        },
      },
      default: {
        description: "Opaque dashboard response or Sandpi error.",
        content: {
          "*/*": {
            schema: { type: "string", format: "binary" },
          },
        },
      },
    },
    "x-sandpi-shared-browser": true,
    "x-sandpi-proxy-protocol": "opaque-playwright-dashboard",
  };
  document.paths[
    "/api/v1/environments/{environmentId}/browser/{assetPath}"
  ] = { get: operation };
}

function pruneUnusedSchemas(document: OpenAPIV3.Document) {
  const schemas = document.components?.schemas;
  if (!schemas) return;
  const used = new Set<string>();
  collectSchemaRefs(document.paths, used);
  let previousSize = -1;
  while (used.size !== previousSize) {
    previousSize = used.size;
    for (const name of [...used]) {
      const schema = schemas[name];
      if (schema) collectSchemaRefs(schema, used);
    }
  }
  document.components!.schemas = Object.fromEntries(
    Object.entries(schemas).filter(([name]) => used.has(name)),
  );
}

function collectSchemaRefs(value: unknown, target: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, target);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "$ref" &&
      typeof child === "string" &&
      child.startsWith("#/components/schemas/")
    ) {
      target.add(child.slice("#/components/schemas/".length));
      continue;
    }
    collectSchemaRefs(child, target);
  }
}

function sortOpenApiCollections(document: OpenAPIV3.Document) {
  document.paths = sortedRecord(document.paths);
  if (document.components?.schemas) {
    document.components.schemas = sortedRecord(document.components.schemas);
  }
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}
