# maple-mcp

MCP server (stdio + Streamable HTTP) that lets an LLM work with a **locally
installed Maple**. No external dependencies — just Node.js.

Tested on **Maple 18.00** (`X86 64 LINUX, Feb 10 2014, Build ID 922027`),
CLI `/opt/maple18/bin/maple`.

## Tools (14)

| Tool | Purpose |
|---|---|
| `maple_health` | version, platform, latency, session directory |
| `maple_evaluate_code` | run Maple code in a session; state and journal — see below |
| `maple_check_code` | check syntax **without executing** (`maple -P`) |
| `maple_to_latex` | expression → LaTeX (`latex(..., output=string)`; the agent is obliged to put formulas in the answer through it) |
| `maple_plot` | plot → image (gif / jpeg / bmp) + a file on disk |
| `maple_session_list` | live sessions and saved journals (including from past chats) |
| `maple_session_resume` | bring a session up from a journal (usually not needed — see auto-recovery) |
| `maple_session_history` | what exactly was computed in the session, step by step |
| `maple_session_reset` | restart the kernel, **keeping** the journal |
| `maple_session_forget` | erase the session and journal entirely |
| `maple_worksheet_read` | read a `.mw`: groups, labels, sections, input, the output flag |
| `maple_worksheet_create` | create a `.mw` from an array of cells (and check it with Maple) |
| `maple_worksheet_edit_cell` | replace the input of one group |
| `maple_worksheet_run_cell` | execute one group from a `.mw` |

## Long computations and sessions between chats

The pi → MCP bridge starts this process for the duration of a chat and kills it at the end. That's why
session state lives **not in memory but in the journal**:

- the server has no storage of its own: journals and plots live in the working folder
  of the conversation, in a hidden `.maple/` (pi starts the server with cwd = workspace);
- everything that ran successfully is appended to `.maple/<session>.jsonl`;
- on the first access to a session in a new process, the journal is replayed into a fresh
  kernel — variables, functions and `assume` come back (the response will have the marker
  `[session "…" restored from journal: N steps]`);
- `restart` in the code clears the journal — as it should;
- when the kernel isn't touched for **5 minutes** (`MAPLE_IDLE_SECONDS`), it's killed, the journal
  remains; the next call brings it up and restores the state.

Typical scenario: in one chat we enter data and solve a diff eq, in another —
"let's continue" and the agent simply continues with the same session name.

```text
chat 1:  maple_evaluate_code(session="osc", code="m:=2: k:=3: ic:={y(0)=1, D(y)(0)=0}:")
        maple_evaluate_code(session="osc", code="sol:=dsolve(...);")
        → the MCP process dies with the chat, the journal is on disk

chat 2:  maple_evaluate_code(session="osc", code="eval(rhs(sol), x=1);")
        → [session "osc" restored from journal: 3 steps]
          cos(3)
```

Session names are best given by meaning (`osc`, `statmech`, `optics`) — then different
computations don't get mixed up.

## Quick start

```bash
node tools/maple-mcp/server.mjs              # stdio
node tools/maple-mcp/server.mjs --http 8770  # Streamable HTTP on /mcp
node tools/maple-mcp/test.mjs                # 27 checks of basic capabilities
node tools/maple-mcp/test-sessions.mjs       # 25 checks of the journal, idling and process leaks
```

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `MAPLE_BIN` | `/opt/maple18/bin/maple` | path to the Maple CLI |
| `MAPLE_ARGS` | — | extra arguments (added to `-q -s -t`) |
| `MAPLE_TIMEOUT_SECONDS` | `60` | timeout of a single computation, sec |
| `MAPLE_IDLE_SECONDS` | `300` | idle time after which the kernel is shut down |
| `MAPLE_MAX_SESSIONS` | `4` | maximum number of simultaneous kernels |
| `MAPLE_SESSION_DIR` | `<working folder>/.maple` | session journals |
| `MAPLE_PLOT_DIR` | `<SESSION_DIR>/plots` | where to store plots |
| `MAPLE_JOURNAL_MAX_BYTES` | `524288` | journal limit (older entries beyond it are dropped) |
| `MAPLE_WORKSPACE_ROOT` | current directory | base for relative `.mw` paths |
| `MAPLE_HTTP_PORT` / `MAPLE_HTTP_HOST` | `8770` / `0.0.0.0` | HTTP mode address |
| `MAPLE_MCP_DEBUG` | — | `1` — debug messages to stderr |

## How it works

- A long-lived console Maple (`maple -q -s -t`): no prompt and no "bytes used",
  `prettyprint=0`, output flushed immediately, startup ~50 ms, kernel RSS ~5 MB.
- We write code to stdin, read stdout up to a sentinel marker
  (`printf("__MAPLE_MCP_<random>\n")`).
- **Syntax is checked by a separate process** (`maple -P`): a raw syntax
  error in a live REPL hangs the stream parsing, whereas this way the session stays intact.
- Runtime errors are visible by `Error,` and are returned as `isError`.
- `quit`/`done`/`stop` at the top level are blocked — otherwise the session would die.
- A timeout kills the kernel; the journal remains, the state will come back.
- **Maple is two processes**: the wrapper `cmaple` (its pid is returned by `spawn`) and the kernel
  `mserver`, which the wrapper spawns itself. That's why we shut down not a process but a **process
  group**: Maple starts with `detached: true` (that's `setsid`), and stopping sends the
  signal to the whole group. Otherwise the kernel outlives the wrapper, gets orphaned, and in the person's
  container (PID 1 is `sleep infinity`, it doesn't adopt orphans) a zombie `[mserver] <defunct>` remains
  forever — hundreds of them accumulated per conversation. On exit the server
  finishes off the leftover groups, and people's containers additionally have `init: true` enabled.
- The HTTP transport is the standard MCP Streamable HTTP (POST `/mcp`, response is JSON or
  SSE depending on `Accept`, header `Mcp-Session-Id`). Verified with the official
  `@modelcontextprotocol/sdk` — the same one `pi-mcp-extension` uses.

## Connecting to Icarus

A separate compose service and systemd aren't needed: **Maple 18 works right inside the
agent container** — verified, the license isn't tied to hardware
(`HOSTID=INTERNET=*.*.*.*`). The service does the mounts itself: enabling `mcp.maple` —
and it mounts `${MAPLE_DIR}` (at the same path as on the host) and the `tools/maple-mcp`
directory of the repository into `/opt/icarus/tools/maple-mcp`. Only the server itself
remains in the config:

```yaml
mcp:
  maple:
    command: node
    args:
      - /opt/icarus/tools/maple-mcp/server.mjs
    env:
      MAPLE_BIN: ${MAPLE_DIR}/bin/maple
      MAPLE_TIMEOUT_SECONDS: "25"
    lifecycle: eager
    hidden: true      # built-in capability: it's not in the panel, can't be turned off
```

The server has no directory of its own in `dataDir`: it keeps journals and plots in the working
folder of the conversation (`.maple/`). That's why neither `MAPLE_SESSION_DIR` nor `MAPLE_PLOT_DIR`
needs to be written in Icarus's config — the defaults are already correct.

`MAPLE_DIR=/opt/maple18` lives in `.env` (see `.env.example`); in production the same
value arrives from `vars.MAPLE_DIR` via `script/redeploy`, and an unset
variable means the default `/opt/maple18`, not an empty path. Both sides of the
mount must match: the Maple launcher looks for libraries at the path recorded
inside itself.

Without `MAPLE_SESSION_DIR`/`MAPLE_PLOT_DIR` the server writes to `<current directory>/.maple`.
In Icarus that's exactly the working folder of the conversation: it's mounted from the host, so the
journal survives both the end of the chat and a rebuild of the container.

Then `./script/server -d`. Verification in a live container:

```bash
docker exec -u node icarus-user-probe node /opt/icarus/tools/maple-mcp/test.mjs
```

The instructions for the agent live in the server itself: a short rule — in the `instructions`
of the MCP handshake, the details — in the tool descriptions (`maple_evaluate_code`
says that you can't compute in your head and what an honest refusal looks like, `maple_to_latex`
— that formulas for the human are always in LaTeX, `maple_plot` — that the markdown line must
be inserted verbatim). There's no separate instruction file in the repository anymore: no matter how much
you write it, the model reads it only if someone reminds it, whereas the tool descriptions
it sees in every conversation.

## Limitations and gotchas (verified on Maple 18)

- **If `dsolve`/`pdsolve` fail with `external library libmodLA.so could not be
  found/used`** — that's not the server but old Maple libraries: `libatlas.so` and
  `libmsp.so` from 2014 require an executable stack, and glibc 2.41+ (Ubuntu
  26.04) rejects such `dlopen`. It's fixed by clearing the flag:

  ```bash
  python3 tools/maple-mcp/fix-execstack.py                 # preview
  sudo python3 tools/maple-mcp/fix-execstack.py --apply    # backups *.bak-execstack
  ```

  After that `dsolve`, `pdsolve`, numerical ODEs work. Rollback — `--restore`.
- **Images.** `pi-mcp-extension` replaces image content with the text
  `[Image: image/gif, base64 encoded]`, so the image block itself doesn't reach the human.
  The fix: the MCP puts the plot in `.maple/plots` of the working folder and returns a
  markdown link `![plot](/workspaces/<workspace>/.maple/plots/<16hex>.gif)`.
  Icarus serves such files via the route `GET /panel/api/chat/image?path=…`: it lets through
  images from attachments and people's working folders. The agent must insert this line
  into the answer verbatim — that's what the `maple_plot` description says.
- **Graphics** are served via `plottools:-exportplot`: `gif`, `jpeg`, `bmp`;
  **Maple 18 can't do `png` and `tiff`**.
- `DocumentTools:-ContentToString`, `Tabulate` and
  `Worksheet:-WorksheetToMapleText` are **absent** in Maple 18 — `.mw`
  is generated by its own XML code, 2-D input is read via the `input-equation` attribute.
- **`-c` can't be used via the launcher**: the script `/opt/maple18/bin/maple`
  does `eval` of the arguments. Inside the server everything goes via stdin or a file.
- **Client timeout.** Icarus generates `requestTimeoutMs: 30000`
  (`packages/service/src/workspace.ts`), this value is hardcoded. That's why
  `MAPLE_TIMEOUT_SECONDS=25`.
- **Security.** Maple code can read/write files and call `system()`.
  The boundary is the container/OS user. If necessary, add `-z` and `--secure-*`
  to `MAPLE_ARGS` (not tested with the server).
- A journal is a **replay of executed commands**, not a memory snapshot: if a step was
  long, recovery takes just as long. For heavy computations it's better to
  save results to a file and continue from the file.
