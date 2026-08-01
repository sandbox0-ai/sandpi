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
- `x-sandpi-websocket` describes Workspace IDE and terminal
  WebSocket message directions.
- `x-sandpi-native-schema` marks payloads whose extensible fields remain owned
  by the pinned native harness protocol.

The Workspace IDE socket accepts a bounded `subscribe` message containing the
currently expanded shallow directories. The server always watches
`/workspace` and replaces only the additional non-recursive subscriptions;
clients treat server change messages as invalidations, not as a durable
file-event log.

`POST /api/v1/environments/{environmentId}/preview/session` is the only public
Preview control operation. It accepts a constrained HTTP loopback target and
returns a short-lived URL on the deployment's isolated wildcard Preview
origin. `x-sandpi-loopback-scope: environment` identifies where loopback
resolves and `x-sandpi-preview-origin: isolated` records the browser security
boundary. The proxied application protocol itself is host-routed transport,
not a second JSON API or Playwright model, and is therefore not published as a
set of OpenAPI paths. Preview session responses remain `no-store`.

Sandpi's content-addressed Next assets are public immutable resources; stable
HTML and Monaco loader paths retain revalidation semantics.

## Authentication

The current API uses the deployment's Sandpi browser session cookie. Login and
callback operations model the OIDC redirect flow; built-in-admin deployments
authenticate the local administrator implicitly until logout. OpenAPI's
`cookieAuth` scheme documents this current behavior and does not claim a bearer
token flow that Sandpi has not implemented.

Native clients start account authentication in the system browser rather than
inside their WebView. The client prepares a ten-minute handoff with a random
state and PKCE verifier; Sandpi stores only its SHA-256 challenge. After the
browser completes OIDC, Sandpi redirects a one-time code through the fixed
`sandpi://auth/callback` application deep link. The originating WebView exchanges
that code and verifier once for its own HttpOnly Sandpi session cookie. Return
locations remain on the deployment origin, and the prepare and exchange
operations require the deployment Origin.
