# Public content routing

The open-source Sandpi application remains the canonical application at
`https://sandpi.ai/`. Public marketing and editorial content can be built and
deployed independently without placing that content in this repository.

## Route ownership

The Sandpi deployment owns the application and API surfaces:

- `/`
- `/ide/*`
- `/preferences/*`
- `/api/*`
- `/health/*`
- `/_next/*`
- `/llms.txt`

An independently deployed content service may own more-specific routes on the
same host:

- `/features/*`
- `/use-cases/*`
- `/compare/*`
- `/blog/*`
- `/_site-assets/*`
- `/robots.txt`
- `/sitemap.xml`

The production ingress keeps Sandpi's `/` route as the fallback and routes the
content prefixes to their separate service. The content build uses the
`/_site-assets` namespace so its Next.js assets cannot collide with Sandpi's
`/_next` assets.

`/llms.txt` is an operational coding-agent guide shipped with the Sandpi
application rather than editorial content. The product-owned
`sandpi-environment` Skill links to that stable URL, while the guide changes
with the application release. It remains public and contains no deployment,
Environment, identity or credential data.

`robots.txt` is host-scoped, so the production content deployment owns the
single root file and the aggregate sitemap. Application-only pages such as the
Web IDE and Preferences declare page-level `noindex` metadata instead of being
blocked from crawling.

## Authentication boundary

Sandpi authenticates only `/api/v1` requests. Its session and built-in sign-out
cookies therefore use `Path=/api/v1`; browsers do not send them to public
content routes on the same host. Any new authenticated endpoint must remain
under that path or explicitly revisit the cookie boundary.

The content service does not receive Sandpi database, runtime, OIDC, billing, or
Sandbox0 credentials. Its build and rollout are independent from the Sandpi
application image.
