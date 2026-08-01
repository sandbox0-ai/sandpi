# Sandpi CLI and configuration migration

## Decision

Sandpi ships one Go CLI from `cli/` in this repository. The CLI mirrors Sandpi
HTTP resources and leaves migration policy to the user or the user's local
coding agent. It does not define an Environment archive, copy an entire local
Workspace, or guess how artifacts from every coding-agent product should be
merged.

This keeps the server contract useful outside the CLI and handles two different
targets without separate migration systems:

- A new Environment can be created, awaited and populated resource by resource.
- An Environment already in use can be inspected first, then changed only at
  selected resource boundaries.

Go produces self-contained binaries for the supported desktop and server
platforms. The nested module path is
`github.com/sandbox0-ai/sandpi/cli`; release tags use the Go-compatible
`cli/vX.Y.Z` form.

## Resource boundaries

| Resource | Sandpi authority | Write semantics | Existing-Environment protection |
| --- | --- | --- | --- |
| Environment | Sandpi store and lifecycle service | Create one empty Environment; get and wait by id | No implicit Environment creation during a resource write |
| `AGENTS.md` | Workspace File API at `/workspace/AGENTS.md` | Replace one file with a base revision | Existing content requires an explicit read/merge revision or `--force` |
| Skill | One directory below `/workspace/.agents/skills/{name}` plus native Codex discovery | Replace or delete one user-owned skill | Validate at a temporary path before replacing; never rewrite the complete skill root |
| MCP server | Native Codex user configuration at `mcp_servers.{name}` | Replace, delete or toggle one server | Managed/project-layer definitions cannot be replaced or deleted |
| Memories | Native Codex memory settings and reset RPC | Replace the three policy booleans or explicitly reset | No direct writes to Codex private memory files or databases |
| Egress credential | Sandpi metadata plus Sandbox0 credential source | Create/update/rotate/delete one credential | Reads are secret-free; secret material is write-only and destination-scoped |

The generic `sandpi api` command exposes current JSON `/api/v1/` operations to
agent-driven workflows without expanding this resource model into a migration
language.

## Server contract additions

The CLI reuses existing APIs wherever they already express the right boundary.
This change adds only missing resource operations:

- `GET /api/v1/environments/{environmentId}`
- `GET /api/v1/environments/{environmentId}/egress-credentials/{credentialId}`
- `PUT|DELETE /api/v1/environments/{environmentId}/harnesses/codex/skills/{name}`
- `PUT|DELETE /api/v1/environments/{environmentId}/harnesses/codex/mcp-servers/{name}`

The committed generated OpenAPI document remains the public contract. CLI code
uses these stable JSON resources rather than importing server implementation
packages or maintaining a second generated contract.

## Merge and replacement behavior

`AGENTS.md` is the only resource in this scope with byte-level concurrent edit
semantics. A normal update uses the revision returned by the Workspace IDE file
read. A stale revision fails instead of silently replacing newer instructions.

A skill is a multi-file resource, so one `PUT` contains one directory's files.
The runtime preserves executable bits, rejects symlinks and traversal, stages
the replacement on the same Workspace filesystem, and rolls back a failed move.
Before the requested path is changed, the service asks native Codex to discover
the exact staged bytes. This prevents malformed input from replacing a working
skill.

An MCP `PUT` writes only `mcp_servers.{name}` through native
`config/value/write`, then invokes `config/mcpServer/reload`. `DELETE` uses a
native null replacement for the user-layer table. Higher configuration layers
remain authoritative.

These APIs intentionally do not add a cross-resource transaction. A local agent
can order calls, inspect every result, retry an idempotent `PUT`, and stop when a
resource requires human merge judgment.

## Credentials and authentication

CLI authentication is Sandpi authentication. The CLI uses the deployment's
public OIDC Device Authorization configuration and contains no client secret.
After approval, Sandpi validates the ID token issuer, signature and Native
Application audience, then binds the access token to the same subject through
OIDC UserInfo and returns a normal Sandpi session. Neither side retains the
provider tokens; the CLI stores only the resulting Sandpi session with
user-only filesystem permissions. There are no CLI commands for Codex login,
Codex `auth.json`, or provider-account migration.

MCP definitions exclude inline secret fields. Service credentials belong in
Environment egress credentials, where Sandpi sends secret material directly to
Sandbox0 and returns only a public projection. Configuration updates and secret
rotation remain separate operations so an agent can change destinations or
policy without reading or replaying a secret.

## Memory content boundary

Native Codex currently exposes settings and `memory/reset`, but no supported
content export/import RPC. Its local memory implementation includes private Git
and SQLite state whose compatibility and indexing semantics are owned by Codex.
Sandpi therefore does not copy those files through the Workspace API or infer a
database format.

The current CLI can migrate memory policy. A local agent may separately review
stable guidance and merge it into the Environment's root `AGENTS.md`. Content
migration should become a new native-backed resource only after the harness
publishes a supported import contract.

## Distribution and validation

Pull requests run Go tests and a CLI build alongside the existing server,
OpenAPI and Web validation. A `cli/v*` tag builds amd64 and arm64 archives for
Linux, macOS and Windows and publishes checksums in a GitHub release. The
release also publishes stable `install.sh` and `install.ps1` assets. Each
installer resolves a selected archive, verifies its SHA-256 digest from the
release checksum manifest, and stages the verified binary before replacing the
user-level installation. Installer integration tests use a local release
server; PowerShell execution runs when `pwsh` is available.

Tagging and release creation are separate maintainer actions; adding the
workflow does not create a release by itself. The latest stable CLI release is
marked as the repository's latest release so the stable installer URLs remain
usable; SemVer prerelease tags remain prereleases and do not replace that
stable channel.
