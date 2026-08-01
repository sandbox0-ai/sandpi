# DigitalOcean Kubernetes deployment

The production deployment uses the shared DigitalOcean nginx ingress, one
steady-state Sandpi server replica, and one PostgreSQL 16 StatefulSet.
Application rollouts temporarily add one surge replica, wait for it to remain
ready, and only then terminate the previous replica so image pulls and startup
do not leave the Service without an endpoint. PostgreSQL data uses a 10 GiB
`do-block-storage-retain` volume. Sandpi Workspaces and coding-agent processes
remain in Sandbox0 rather than this cluster.

`bootstrap.yaml` is an operator-owned, one-time bootstrap. It creates the
`sandpi` namespace, empty runtime secrets, and a GitHub deployer whose Role is
limited to application resources in that namespace. The GHCR pull secret is
also bootstrapped by an operator and is intentionally not stored in Git.

TLS is issued and renewed through namespace-scoped Let's Encrypt `Issuer`
resources. The apex certificate uses HTTP-01. The wildcard Preview certificate
uses Cloudflare DNS-01 because ACME HTTP-01 cannot authorize a wildcard.
The shared cluster has cert-manager `v1.21.0` installed once from its official
OCI Helm chart with the resource settings in `cert-manager-values.yaml`:

```bash
KUBECONFIG=/root/.kube/do-config helm upgrade --install cert-manager \
  oci://quay.io/jetstack/charts/cert-manager \
  --version v1.21.0 \
  --namespace cert-manager \
  --create-namespace \
  --values deploy/kubernetes/cert-manager-values.yaml \
  --wait \
  --timeout 5m
```

Every push to `main` runs tests, builds an immutable
`ghcr.io/sandbox0-ai/sandpi:<commit>` image, patches the three pre-created
Kubernetes secrets, renders `app/` with that exact image, and waits for both
rollouts and both production TLS certificates. It then verifies HTTPS health,
the HTTP-to-HTTPS redirect, and wildcard Preview routing through the ingress
address. Pull requests run the same code and manifest validation without
receiving deployment credentials.

Required repository variables:

- `SANDBOX0_API_HOST`
- `SANDPI_AUTH_MODE`
- `SANDPI_BILLING_MODE`
- `SANDPI_INGRESS_IP`
- `SANDPI_OIDC_CLIENT_ID`
- `SANDPI_OIDC_ISSUER`
- `SANDPI_OIDC_SCOPES`
- `SANDPI_OIDC_TOKEN_ENDPOINT_AUTH_METHOD`
- `SANDPI_PUBLIC_URL`
- `SANDPI_PREVIEW_URL`
- `SANDPI_STRIPE_PLUS_PRICE_ID`
- `SANDPI_STRIPE_PRO_PRICE_ID`
- `SANDPI_STRIPE_ULTRA_PRICE_ID`

Required repository secrets:

- `SANDBOX0_API_KEY`
- `SANDPI_CLOUDFLARE_API_TOKEN`
- `SANDPI_COOKIE_SECRET`
- `SANDPI_KUBE_CONFIG`
- `SANDPI_OIDC_CLIENT_SECRET`
- `SANDPI_POSTGRES_PASSWORD`
- `SANDPI_SECRET_KEY`
- `SANDPI_STRIPE_SECRET_KEY`
- `SANDPI_STRIPE_WEBHOOK_SECRET`

Optional production Environment variables:

- `NEXT_PUBLIC_CLARITY_PROJECT_ID` — a public Microsoft Clarity project ID
  compiled into the browser bundle. Leave it unset to disable Clarity,
  including for self-hosted deployments.
- `NEXT_PUBLIC_GA_MEASUREMENT_ID` — a public Google Analytics 4 measurement
  ID compiled into the browser bundle. Leave it unset to disable analytics,
  including for self-hosted deployments.

The production workflow requires `SANDPI_BILLING_MODE=stripe`. Configure the
Stripe webhook endpoint as
`https://sandpi.ai/api/v1/billing/webhook`. Sandpi verifies the raw request
body with `SANDPI_STRIPE_WEBHOOK_SECRET`; the endpoint intentionally bypasses
OIDC, while every summary, Checkout and Customer Portal route remains
user-authenticated.

`SANDPI_STRIPE_SECRET_KEY` authenticates Sandpi's outbound server calls for
Customers, Checkout, Subscriptions and Customer Portal sessions. Prefer a
restricted key with only those runtime resources; keep it separate from the
webhook signing secret, which authenticates inbound Stripe callbacks.

Before enabling Stripe mode, publish and install a Sandbox0 JavaScript SDK
release that exposes `client.usage.listWindows()`. Sandpi deliberately fails
startup with an older SDK instead of bypassing the public SDK boundary.

The apex `sandpi.ai` record and wildcard `*.preview.sandpi.ai` record must be A
records for the ingress address in `SANDPI_INGRESS_IP`. Keep the Preview
wildcard record DNS-only unless Cloudflare is separately configured with an
edge certificate that covers `*.preview.sandpi.ai`. No AAAA record is published
while the ingress has no IPv6 address. Set
`SANDPI_PREVIEW_URL=https://preview.sandpi.ai`; Preview allocates exactly one
additional label beneath that root for each Environment/port origin.
Keep the Preview root on the same registrable site as `SANDPI_PUBLIC_URL` so its
host-only session cookie remains available inside the embedded Preview frame.

`SANDPI_CLOUDFLARE_API_TOKEN` is used only by cert-manager's
`letsencrypt-dns` Issuer. Give it `Zone / DNS / Edit` and `Zone / Zone / Read`
for the `sandpi.ai` zone. The operator must apply the updated `bootstrap.yaml`
before enabling this deployment so the namespace contains the empty
`sandpi-cloudflare` Secret and the GitHub deployer can patch only that named
Secret. cert-manager reads its `api-token` key to complete DNS-01; the
application Deployment never mounts it.

See the official
[cert-manager Cloudflare solver](https://cert-manager.io/docs/configuration/acme/dns01/cloudflare/)
and [Cloudflare Universal SSL hostname coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
documentation.
