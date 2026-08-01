# Sandpi CLI

`sandpi` is a Go client for operating Sandpi Environments from a terminal or a
local coding agent. It deliberately exposes small Environment resources instead
of defining a proprietary migration archive or a one-size-fits-all import plan.

A local agent can inspect its own setup, inspect the target Environment, decide
what to merge, and call only the commands it needs. This works for both a new
Environment and an Environment that already contains useful configuration.

For complete source-to-target workflows, see the
[local coding-agent environment migration guide](../docs/local-environment-migration.md).

## Install

Linux and macOS users can install the latest checksummed release without
administrator privileges:

```bash
curl -fsSL https://github.com/sandbox0-ai/sandpi/releases/latest/download/install.sh | sh
```

On Windows PowerShell:

```powershell
Invoke-WebRequest https://github.com/sandbox0-ai/sandpi/releases/latest/download/install.ps1 -OutFile install.ps1
.\install.ps1
Remove-Item .\install.ps1
```

Both installers accept a pinned version and a custom destination. Run the
downloaded script with `--help` or `-Help` for details. Release archives and
`checksums.txt` remain available from the same GitHub release.

Go 1.22 or newer can install the nested module directly:

```bash
go install github.com/sandbox0-ai/sandpi/cli/cmd/sandpi@latest
```

To build the current checkout:

```bash
cd cli
go build -o ./bin/sandpi ./cmd/sandpi
```

Tagged `cli/v*` releases publish Linux, macOS and Windows binaries for amd64 and
arm64. The CLI remains in this repository and uses the nested
`github.com/sandbox0-ai/sandpi/cli` Go module.

## Authenticate

```bash
sandpi auth login
sandpi auth status
```

The CLI discovers the deployment's public OIDC Device Authorization settings,
prints a verification URL and user code, and polls the identity provider while
you approve the device in a browser. No callback URL needs to be copied back to
the terminal. Use `--no-open` when the CLI should print the verification URL
without opening a browser.

The short-lived provider tokens are exchanged for a normal Sandpi session and
are not stored by Sandpi or the CLI. Sandpi validates the ID token against the
public Native Application and binds UserInfo to the same subject. This does not
log Codex in or import a Codex account. Codex account connection remains an
Environment-scoped Sandpi product flow.

The CLI stores its endpoint and Sandpi session in the operating system user
configuration directory under `sandpi/config.json`, with mode `0600` on Unix.
`SANDPI_ENDPOINT` and `SANDPI_SESSION_COOKIE` override the stored values.

All successful command output is JSON. API errors are also emitted as stable
JSON on stderr. Add `--compact` for one-line output.

## Resource commands

```text
sandpi environment list|get|create|delete|wait
sandpi agents      get|set
sandpi skill       list|put|delete|enable|disable
sandpi mcp         list|get|put|delete|enable|disable|oauth-login
sandpi memory      get|set|reset
sandpi credential  list|get|create|update|rotate|delete
sandpi api         METHOD /api/v1/...
```

Run `sandpi <resource> <command> --help` for flags and input details.

### AGENTS.md

Each Environment has one root instruction file at exactly
`/workspace/AGENTS.md`.

For a new Environment where the file does not exist, `set` creates it:

```bash
sandpi agents set --environment "$ENVIRONMENT_ID" --file ./AGENTS.md
```

An existing file is never replaced implicitly. Read its JSON projection,
decode and merge the content, then write against the revision you read:

```bash
sandpi agents get --environment "$ENVIRONMENT_ID" > remote-agents.json
jq -r .content remote-agents.json | base64 --decode > remote-AGENTS.md
revision="$(jq -r .revision remote-agents.json)"

# Merge remote-AGENTS.md and the local instructions into merged-AGENTS.md.
sandpi agents set \
  --environment "$ENVIRONMENT_ID" \
  --file ./merged-AGENTS.md \
  --base-revision "$revision"
```

If the file changes after the read, Sandpi returns a revision conflict. Fetch
and merge again. `--force` is available only for an intentional current-value
replacement.

Use `agents get --raw` when only decoded content is needed and no later
optimistic write depends on its revision.

### Skills

`skill put` replaces one named user-owned skill, not the complete skill set:

```bash
sandpi skill list --environment "$ENVIRONMENT_ID" --force
sandpi skill put \
  --environment "$ENVIRONMENT_ID" \
  release-helper \
  ~/.agents/skills/release-helper
```

The source directory must contain `SKILL.md`. Symlinks and non-regular files are
rejected, `.git` is excluded, and executable bits are preserved. Sandpi first
asks native Codex to discover the supplied skill at a temporary path. Only a
valid skill replaces the requested directory.

### MCP servers

`mcp put` accepts one typed definition. A stdio example:

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp"],
  "enabled": true,
  "required": false,
  "startupTimeoutSec": 20,
  "toolTimeoutSec": 60
}
```

A streamable HTTP example:

```json
{
  "transport": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "auth": "oauth",
  "scopes": ["read:docs"],
  "enabledTools": ["search"],
  "defaultToolsApprovalMode": "prompt"
}
```

Apply only that server and, when needed, start its native MCP OAuth flow:

```bash
sandpi mcp put --environment "$ENVIRONMENT_ID" docs --file ./docs-mcp.json
sandpi mcp oauth-login --environment "$ENVIRONMENT_ID" docs
```

The API refuses to replace a server supplied by a managed or project layer.
Static secrets should not be embedded in MCP JSON; use Environment egress
credentials for destination-scoped injection.

### Memories

The supported native Codex memory resource is its Environment policy:

```json
{
  "featureEnabled": true,
  "useMemories": true,
  "generateMemories": true
}
```

```bash
sandpi memory get --environment "$ENVIRONMENT_ID"
sandpi memory set --environment "$ENVIRONMENT_ID" --file ./memory-settings.json
```

Codex currently exposes memory policy and `memory/reset`, but no native
content-import contract. The CLI therefore does not copy Codex's private Git or
SQLite memory storage. Stable instructions can be reviewed and merged into
`/workspace/AGENTS.md`; native memory content migration can be added when the
harness exposes a supported import API.

### Egress credentials

Credential material is accepted only by `create` and `rotate`. List, get and
mutation responses are secret-free. For example, a destination-scoped bearer
header credential uses this shape:

```json
{
  "name": "GitHub API",
  "resolverKind": "static_headers",
  "projection": {
    "type": "http_headers",
    "headers": [
      {
        "name": "Authorization",
        "valueTemplate": "Bearer {{ .token }}"
      }
    ]
  },
  "rule": {
    "protocol": "https",
    "domains": ["api.github.com"],
    "ports": [{ "port": 443, "protocol": "tcp" }],
    "failurePolicy": "fail-closed"
  },
  "enabled": true,
  "material": {
    "type": "static_headers",
    "values": { "token": "replace-with-secret" }
  }
}
```

Pass secret-bearing JSON over stdin or from a mode-`0600` temporary file rather
than putting material in command-line arguments:

```bash
sandpi credential create --environment "$ENVIRONMENT_ID" --file -
```

### Low-level API access

The typed commands cover common Environment operations. A local agent can use
the JSON escape hatch for another current API without waiting for a bundled
migration format:

```bash
sandpi api GET /api/v1/environments
sandpi api PUT /api/v1/environments/ENVIRONMENT_ID/provisioning \
  --file ./request.json
```

Only `/api/v1/` paths and GET, POST, PUT or DELETE are accepted.

## Migration workflows

The [migration guide](../docs/local-environment-migration.md) covers source
inventory, empty and already-used targets, merge behavior, credentials, memory
boundaries, and a workflow that a local coding agent can execute. The CLI
intentionally has no `migrate-all`, archive import, or hidden overwrite
behavior.

## Development

```bash
cd cli
go test ./...
go vet ./...
go build ./cmd/sandpi
```

The server contract and CLI are versioned in the same Sandpi pull request. See
[`../docs/architecture/cli.md`](../docs/architecture/cli.md) for API boundaries
and migration decisions.
