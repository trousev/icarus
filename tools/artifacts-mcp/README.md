# artifacts-mcp

MCP server (stdio) for the **shared artifact library** `/artifacts`: it creates a folder
with permissions, reads `index.ai.md` instead of HTML and returns a link. No external
dependencies — just Node.js.

## What an artifact is

The folder `/artifacts/<slug>/` in the global library (it's mounted into every
person's container):

```text
/artifacts/plan-na-chetverg/
  index.md            # what the human sees: index.html | index.md | index.png|jpg|svg
  index.ai.md         # required description for the AI
  images/standup.png
  .folder-acl.json    # owner and permissions
  .artifact.json      # publicId, if the link was already requested
```

The type is determined by the index file. The other files are assets, links inside HTML
are relative. `index.ai.md` is not for the human: H1 heading, what the artifact is,
what's inside, what can be changed.

## Permissions

`.folder-acl.json` is a common format for any folders, not just artifacts:

```json
{ "version": 1, "owner": "probe", "acl": { "me": "admin", "family": "none" } }
```

- `me` — the owner, `family` — everyone else;
- `none ⊂ read ⊂ write ⊂ admin`: `none` — the artifact is absent from the panel's and MCP's lists,
  no read, no write; write can read, admin can also change permissions, delete
  the artifact and make a public link;
- by default `me=admin`, `family=none`: a new artifact is personal until the owner
  opens it to the family in the panel under "Permissions". The owner always controls their artifact,
  even if they set `read` for themselves; they can't set `none` for themselves.

Permissions are checked not only by the MCP: the generic `folder-guard` in the container blocks
`read`/`write`/`edit`/`grep`/`find`/`ls` in others' folders, and `bash` with an absolute path to `/artifacts`
is forbidden entirely. That's why a new artifact is created via `artifact_new`, and not with a random
`write`: otherwise a folder without an ACL simply doesn't exist for the tools.

## Tools (5)

| Tool | Purpose |
|---|---|
| `artifact_new` | create a folder and `.folder-acl.json` (owner=current, me=admin, family=none — personal) |
| `artifact_list` | available artifacts: type, size, owner, your level, description, links |
| `artifact_read` | `index.ai.md` + owner/level + files + links; for markdown — also the text |
| `artifact_link` | by default an internal link in the panel; `public: true` — public (admin) |
| `artifact_check` | structure: ACL, index, `index.ai.md`, extra index files |

## Running

```bash
node /opt/icarus/tools/artifacts-mcp/server.mjs     # stdio
```

The server reads environment variables:

| Variable | Why |
|---|---|
| `ICARUS_ARTIFACTS_DIR` | the library root; default `/artifacts` |
| `ICARUS_USER_ID` | whose permissions to check and whose artifact this is |
| `ICARUS_URL` | the external address of the panel; links are assembled from it |

The service puts all this into the person's container (`containerEnv`), no need to write it in the MCP config.

## Connecting to Icarus

```yaml
mcp:
  artifacts:
    command: node
    args: ['/opt/icarus/tools/artifacts-mcp/server.mjs']
    lifecycle: lazy
    hidden: true
    description: "Artifacts: shared library /artifacts — pages, documents and images with permissions for the family"
```

`hidden: true` removes the server from the MCP section and forbids turning it off. `lifecycle: lazy`
keeps the instructions out of the prompt: a short trigger goes into `AGENTS.md`, the full rules
arrive in `instructions` after `mcp_connect`.

## Version history

Every folder has a hidden git repository, but the human doesn't know about it: in the panel,
"History" opens as a side panel with a version preview, and "Restore this version" changes
the artifact only after confirmation. Snapshots are made by the pi extension (`extensions/artifact-git.ts`) after
every successful `write`/`edit`, and `turn_end` picks up changes from the MCP. The service
`.folder-acl.json` and `.artifact.json` are not versioned; `.git` is hidden from the panel,
public links and file tools. The agent doesn't need to create repositories,
commit or touch `.git` — the system does that.

## Links

`artifact_link` without `public` returns an internal `/panel/artifacts?artifact=…` — that's
what you should give the human by default. `artifact_link` with `public: true` (admin required)
writes `.artifact.json`:

```json
{ "version": 1, "publicId": "random-18-bytes", "createdAt": "…", "updatedAt": "…" }
```

The public address is `<ICARUS_URL>/a/<artifact>/<publicId>/`. `?bare=1` — without the panel,
a direct path to the index file — the file itself. Old links
`/a/<person>/<workspace>/<artifact>/<id>/` redirect to the new address.

## Verification

```bash
node tools/artifacts-mcp/test.mjs
```

The test starts the server as a separate process, does a real `initialize` and
checks `artifact_new`, the list, reading, permissions, the link and the structure on a temporary
folder. No model, network or docker needed.
