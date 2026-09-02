# Migrate a local coding-agent environment to Sandpi

> **v2 compatibility note.** Environment creation, Workspace files, lifecycle,
> network, and egress credentials remain supported. Skill, MCP, memory, Session,
> and Turn migration commands target the retired v1 Codex app-server API and
> return HTTP 410 on a v2 server. Native agent login is now completed in the
> Environment TUI; Codex also retains the explicit server-side auth import shown
> in the project README.

The `sandpi` CLI lets a user or a local coding agent inspect a local setup and apply selected configuration to a Sandpi Environment. Migration is resource-oriented: there is no proprietary bundle, no whole-Workspace upload, and no command that guesses how every coding-agent product should be converted.

This model supports both an empty target and an Environment that already contains instructions, Skills, MCP servers, memory settings, or credentials.

## Install the CLI

Install the latest checksummed Linux or macOS binary into `$HOME/.local/bin`:

```bash
curl -fsSL https://github.com/sandbox0-ai/sandpi/releases/latest/download/install.sh | sh
```

Pin a version or choose another destination when an automated workflow needs a reproducible toolchain:

```bash
curl -fsSL https://github.com/sandbox0-ai/sandpi/releases/latest/download/install.sh |
  sh -s -- --version 0.1.0 --install-dir "$HOME/bin"
```

On Windows PowerShell, download the installer so it can be inspected and passed explicit parameters:

```powershell
Invoke-WebRequest https://github.com/sandbox0-ai/sandpi/releases/latest/download/install.ps1 -OutFile install.ps1
.\install.ps1 -Version 0.1.0
Remove-Item .\install.ps1
```

The PowerShell installer defaults to `%LOCALAPPDATA%\Programs\Sandpi` and adds that directory to the user PATH. Pass `-NoModifyPath` to leave PATH unchanged. Both installers download `checksums.txt`, verify the selected release archive, and replace the binary only after verification succeeds.

With Go 1.22 or newer, source installation is also available:

```bash
go install github.com/sandbox0-ai/sandpi/cli/cmd/sandpi@latest
```

## Authenticate to Sandpi

```bash
sandpi auth login
sandpi auth status
```

For a terminal or coding agent that cannot open a browser, use:

```bash
sandpi auth login --no-open
```

Open the printed verification URL, confirm its user code, and leave the CLI running while it polls the configured OIDC provider. The provider tokens are exchanged immediately for a Sandpi session and are not retained. This signs the CLI into Sandpi only. It does not import a Codex account, copy `auth.json`, or add a Codex login command.

Use `--endpoint` or `SANDPI_ENDPOINT` for a self-hosted deployment. Successful output is JSON, and `--compact` produces one-line JSON for agent workflows.

## Inventory before writing

The user or local agent owns the migration decision. First identify the local sources, normalize them into Sandpi resources, and inspect the target before changing it.

| Local capability | Sandpi target | Migration rule |
| --- | --- | --- |
| Stable project or user instructions | `/workspace/AGENTS.md` | Review and merge text; do not concatenate blindly |
| A directory containing `SKILL.md` | One named user Skill | Apply only the selected directory |
| A local MCP definition | One native user-layer MCP server | Convert one server at a time and remove inline secrets |
| Memory preferences | Native Environment memory policy | Migrate settings only; do not copy private memory databases |
| API keys, passwords, certificates, or SSH keys | One Environment egress credential | Re-enter material through create or rotate; secret values are never read back |

Do not assume that a local repository or home directory should be copied. Workspace source code should move through its normal Git or artifact workflow, independently from coding-agent configuration.

## Choose the target workflow

List existing Environments before deciding whether to create one:

```bash
sandpi environment list
```

### Empty target

Create and wait for an Environment, then apply only the resources selected during local inventory:

```bash
sandpi environment create --name "Imported project" > environment.json
ENVIRONMENT_ID="$(jq -r .id environment.json)"
sandpi environment wait "$ENVIRONMENT_ID"

sandpi agents set --environment "$ENVIRONMENT_ID" --file ./AGENTS.md
sandpi skill put --environment "$ENVIRONMENT_ID" release-helper ./release-helper
sandpi mcp put --environment "$ENVIRONMENT_ID" docs --file ./docs-mcp.json
sandpi memory set --environment "$ENVIRONMENT_ID" --file ./memory-settings.json
```

Environment creation and configuration writes are separate operations. If one resource needs human judgment, stop there; already completed named writes remain visible and can be inspected or retried.

### Existing target

An Environment already in use must be inspected before writes:

```bash
sandpi environment get "$ENVIRONMENT_ID"
sandpi agents get --environment "$ENVIRONMENT_ID" > remote-agents.json
sandpi skill list --environment "$ENVIRONMENT_ID" --force > remote-skills.json
sandpi mcp list --environment "$ENVIRONMENT_ID" --full > remote-mcp.json
sandpi memory get --environment "$ENVIRONMENT_ID" > remote-memory.json
sandpi credential list --environment "$ENVIRONMENT_ID" > remote-credentials.json
```

Compare these projections with the local inventory. Preserve unrelated remote resources, merge shared instruction content, and issue `put` only for a name the user intends to replace. Delete commands require `--yes` and should not be part of a default migration plan.

## Merge `/workspace/AGENTS.md`

Each Environment has exactly one root instruction file at `/workspace/AGENTS.md`. A missing file can be created directly. Existing content is protected from implicit replacement.

Read the content and the revision that identifies it:

```bash
sandpi agents get --environment "$ENVIRONMENT_ID" > remote-agents.json
jq -r .content remote-agents.json | base64 --decode > remote-AGENTS.md
revision="$(jq -r .revision remote-agents.json)"
```

Review the local instructions and `remote-AGENTS.md`, resolve contradictions, and write the merged file against the revision that was read:

```bash
sandpi agents set \
  --environment "$ENVIRONMENT_ID" \
  --file ./merged-AGENTS.md \
  --base-revision "$revision"
```

If another Session changes the file first, Sandpi returns a revision conflict. Read and merge again. `--force` is reserved for an intentional replacement using the current remote revision; it is not a migration default.

## Apply selected Skills

A Skill source must be one directory containing `SKILL.md`:

```bash
sandpi skill put \
  --environment "$ENVIRONMENT_ID" \
  release-helper \
  "$HOME/.agents/skills/release-helper"
```

The client excludes `.git`, rejects symlinks and non-regular files, and preserves whether files are executable. Sandpi stages the supplied bytes and asks native Codex to discover the Skill before replacing the requested name. One Skill write never rewrites the complete Skill root.

When the same name exists locally and remotely, inspect both versions before choosing the replacement. Use distinct names when both should remain available.

## Convert MCP servers one at a time

Create a typed JSON definition for each selected server. A streamable HTTP example is:

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

Apply and, when required, authenticate that server:

```bash
sandpi mcp put --environment "$ENVIRONMENT_ID" docs --file ./docs-mcp.json
sandpi mcp oauth-login --environment "$ENVIRONMENT_ID" docs
```

`mcp put` writes only `mcp_servers.<name>` in the native user layer. Sandpi refuses to replace a definition supplied only by a managed or project layer. The typed input deliberately excludes bearer tokens, static authorization headers, and direct environment-variable values.

## Keep secrets in egress credentials

Do not move local secrets into MCP JSON, `AGENTS.md`, a Skill, shell history, or command-line arguments. Model each required destination and projection as an Environment egress credential.

```bash
sandpi credential create --environment "$ENVIRONMENT_ID" --file - < credential.json
```

Credential material is accepted only during `create` or `rotate`. List, get, update, and mutation responses contain public metadata but never return the secret or the Sandbox0 source reference. Pass secret-bearing JSON over stdin or a mode-`0600` temporary file, and delete that temporary file after use.

See the [CLI credential example](../cli/README.md#egress-credentials) and [egress credential architecture](./architecture/environment-egress-credentials.md) for the supported shapes and security boundary.

## Memory boundary

The CLI can migrate native memory policy:

```json
{
  "featureEnabled": true,
  "useMemories": true,
  "generateMemories": true
}
```

```bash
sandpi memory set --environment "$ENVIRONMENT_ID" --file ./memory-settings.json
```

Native Codex does not expose a supported memory-content import contract. The CLI therefore does not copy private Git or SQLite memory storage. Review stable, durable guidance and merge it into `/workspace/AGENTS.md`; leave private memory implementation files untouched.

## Agent-driven migration contract

A local coding agent can execute the workflow without a Sandpi-specific archive. Give it the target Environment id and a narrow instruction such as:

```text
Inspect my local coding-agent configuration and Sandpi Environment ENVIRONMENT_ID.
Propose a resource-by-resource migration for instructions, selected Skills, MCP
servers, memory policy, and credentials. Read existing Sandpi state first. Do not
copy the local Workspace, overwrite AGENTS.md without a revision-aware merge,
embed secrets in configuration, migrate private memory files, or run deletes.
Show me conflicts and secret-bearing credential requests before applying them.
```

The agent can use `sandpi api METHOD /api/v1/...` as a JSON escape hatch for a current Sandpi API that does not yet have a typed command. That escape hatch is not permission to broaden the migration scope; it remains limited to the resources the user selected.

## Completion checklist

- Confirm `sandpi auth status` reports the intended Sandpi deployment and user.
- Confirm the target Environment is the intended empty or existing Environment.
- Re-read `/workspace/AGENTS.md` and every named Skill or MCP server that changed.
- Confirm memory policy, credential destination rules, and enabled states.
- Run a new Sandpi Session that exercises the migrated instructions and tools.
- Keep the local source configuration until the Environment has been verified.

For the full command reference, see [`cli/README.md`](../cli/README.md). For API and implementation boundaries, see [CLI architecture](./architecture/cli.md) and the committed [OpenAPI contract](../openapi.yaml).
