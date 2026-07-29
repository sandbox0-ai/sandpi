# OpenAPI Contract

`openapi.yaml` is Sandpi's generated public HTTP contract. It targets OpenAPI
3.0.3 so downstream client generators can consume it without depending on the
Sandpi TypeScript source tree.

## Source of truth

The generated document combines three code-owned inputs:

- `registerHealthRoutes`, `registerAuthRoutes`, and `registerApiRoutes` remain
  the source of truth for HTTP methods and paths.
- `src/server/openapi/contracts.ts` supplies operation metadata and connects
  each real route to request and response schemas.
- `src/server/api-schemas.ts` contains request schemas shared by runtime Zod
  validation and OpenAPI generation. Public response models live in
  `src/server/openapi/models.ts` and are compile-time checked against Sandpi's
  public TypeScript response types.

The contract builder registers the real route functions against inert service
placeholders. Route handlers are never invoked, so generation needs neither
PostgreSQL nor Sandbox0. Generation fails if a real API route has no contract
or a contract no longer maps to a real route.

`openapi.yaml` is an artifact and must not be edited directly:

```bash
npm run openapi:generate
npm run openapi:check
```

The check rebuilds the file byte-for-byte, validates the OpenAPI document and
is required by CI. The npm package includes the generated file. Sandpi does not
commit generated platform SDKs; those can be produced later from a released
contract.

## Streaming and proxy transports

OpenAPI describes HTTP request/response operations directly. Sandpi retains the
same paths for its non-JSON transports and adds explicit extensions:

- `x-sandpi-sse` lists the named events on the native Session event stream.
- `x-sandpi-websocket` describes Workspace IDE, Browser dashboard and terminal
  WebSocket message directions.
- `x-sandpi-native-schema` marks payloads whose extensible fields remain owned
  by the pinned native harness protocol.

The Browser dashboard HTTP and WebSocket bodies are an opaque, authenticated
proxy protocol. They are not normalized into a second Sandpi browser model.
The built-in Browser uses one persistent Chromium browser instance and profile
per Environment, plus one fixed page attachment per Sandpi Session that uses it.
Browser request bodies and embedded HTML identify that product Session, and
the server verifies its Environment membership. A human and agent within one
Session share the assigned page; Sessions share cookies and login state
without sharing a current-tab pointer or launching separate Chromium
browser instances. URLs using `localhost`, `127.0.0.1`, or `::1` resolve
inside the Environment sandbox, never on the client device. The contract marks
these operations with `x-sandpi-shared-browser`.

## Authentication

The current API uses the deployment's Sandpi browser session cookie. Login and
callback operations model the OIDC redirect flow; built-in-admin deployments
authenticate the local administrator implicitly until logout. OpenAPI's
`cookieAuth` scheme documents this current behavior and does not claim a bearer
token flow that Sandpi has not implemented.
