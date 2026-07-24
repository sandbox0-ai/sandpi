# DigitalOcean Kubernetes deployment

The production deployment uses the shared DigitalOcean nginx ingress, one
Sandpi server replica, and one PostgreSQL 16 StatefulSet. PostgreSQL data uses a
10 GiB `do-block-storage-retain` volume. Sandpi Workspaces and coding-agent
processes remain in Sandbox0 rather than this cluster.

`bootstrap.yaml` is an operator-owned, one-time bootstrap. It creates the
`sandpi` namespace, empty runtime secrets, and a GitHub deployer whose Role is
limited to application resources in that namespace. The GHCR pull secret is
also bootstrapped by an operator and is intentionally not stored in Git.

Every push to `main` runs tests, builds an immutable
`ghcr.io/sandbox0-ai/sandpi:<commit>` image, patches the two pre-created
Kubernetes secrets, renders `app/` with that exact image, and waits for both
rollouts. Pull requests run the same code and manifest validation without
receiving deployment credentials.

Required repository variables:

- `SANDBOX0_API_HOST`
- `SANDPI_AUTH_MODE`
- `SANDPI_INGRESS_IP`
- `SANDPI_OIDC_CLIENT_ID`
- `SANDPI_OIDC_ISSUER`
- `SANDPI_OIDC_SCOPES`
- `SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD`
- `SANDPI_PUBLIC_URL`

Required repository secrets:

- `SANDBOX0_API_KEY`
- `SANDPI_COOKIE_SECRET`
- `SANDPI_KUBE_CONFIG`
- `SANDPI_OIDC_CLIENT_SECRET`
- `SANDPI_POSTGRES_PASSWORD`
- `SANDPI_SECRET_KEY`

The initial ingress is intentionally HTTP-only. The existing cluster wildcard
certificate covers `sandbox0.ai` and `*.sandbox0.ai`, not `sandpi.ai`. Add the
`sandpi.ai` TLS certificate and ingress `tls` block only after its DNS points to
the ingress address.
