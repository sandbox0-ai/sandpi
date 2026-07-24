# DigitalOcean Kubernetes deployment

The production deployment uses the shared DigitalOcean nginx ingress, one
Sandpi server replica, and one PostgreSQL 16 StatefulSet. PostgreSQL data uses a
10 GiB `do-block-storage-retain` volume. Sandpi Workspaces and coding-agent
processes remain in Sandbox0 rather than this cluster.

`bootstrap.yaml` is an operator-owned, one-time bootstrap. It creates the
`sandpi` namespace, empty runtime secrets, and a GitHub deployer whose Role is
limited to application resources in that namespace. The GHCR pull secret is
also bootstrapped by an operator and is intentionally not stored in Git.

TLS is issued and renewed through a namespace-scoped Let's Encrypt `Issuer`.
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
`ghcr.io/sandbox0-ai/sandpi:<commit>` image, patches the two pre-created
Kubernetes secrets, renders `app/` with that exact image, and waits for both
rollouts and the production TLS certificate. It then verifies HTTPS health and
the HTTP-to-HTTPS redirect through the ingress address. Pull requests run the
same code and manifest validation without receiving deployment credentials.

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

The apex `sandpi.ai` DNS record must be an A record for the ingress address in
`SANDPI_INGRESS_IP`. No AAAA record is published while the ingress has no IPv6
address.
