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

The Workspace IDE socket accepts a bounded `subscribe` message containing the
currently expanded shallow directories. The server always watches
`/workspace` and replaces only the additional non-recursive subscriptions;
clients treat server change messages as invalidations, not as a durable
file-event log.

The Browser dashboard HTTP and WebSocket bodies are an opaque, authenticated
proxy protocol. They are not normalized into a second Sandpi browser model.
The built-in Browser is one Playwright session and profile shared by the human
and the agent. A human can take over the embedded tab to complete an
interactive login, then the agent continues in that same authenticated
profile. URLs using `localhost`, `127.0.0.1`, or `::1` resolve inside the
Environment sandbox, never on the client device. The contract marks these
operations with `x-sandpi-shared-browser`.

Dashboard HTML, redirects and control responses remain `no-store`.
Fingerprint-named Dashboard assets use a bounded private immutable cache, and
Sandpi preserves their explicit cache policy through the final response hook.
The embedded Browser remains mounted for a short grace period after the
Inspector closes, while large unmodified assets stream through the proxy
instead of being buffered in full. Sandpi's own content-addressed Next assets
are public immutable resources; stable HTML and Monaco loader paths retain
revalidation semantics.

## Authentication

The current API uses the deployment's Sandpi browser session cookie. Login and
callback operations model the OIDC redirect flow; built-in-admin deployments
authenticate the local administrator implicitly until logout. OpenAPI's
`cookieAuth` scheme documents this current behavior and does not claim a bearer
token flow that Sandpi has not implemented.

The CLI reads a public Device Authorization configuration from Sandpi, talks
directly to the configured OIDC provider, and exchanges the resulting
short-lived tokens once through `/api/v1/auth/device/complete`. Sandpi validates
the ID token issuer, signature and Native Application audience, binds UserInfo
to the same subject, creates the same HttpOnly session used by other clients,
and retains no provider token. The public Native Application client has no
secret.

Native clients start account authentication in the system browser rather than
inside their WebView. The client prepares a ten-minute handoff with a random
state and PKCE verifier; Sandpi stores only its SHA-256 challenge. After the
browser completes OIDC, Sandpi redirects a one-time code through the fixed
`sandpi://auth/callback` application deep link. The originating WebView exchanges
that code and verifier once for its own HttpOnly Sandpi session cookie. Return
locations remain on the deployment origin, and the prepare and exchange
operations require the deployment Origin.
