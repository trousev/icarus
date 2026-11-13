# Maple → MCP: research (draft)

Goal: figure out how to "bolt" a locally installed Maple 2018/2022 onto Icarus
(and onto an LLM in general) via our own MCP server. Questions: how to create,
inspect and edit `.mw` worksheets, how to execute a single cell, how to start a
Maple process and control it from outside.

Status: **draft, almost ready**. Key sections are confirmed by primary sources
(links throughout the text); detailed reports are in `research/01-*.md` …
`research/07-*.md`. Items that cannot be closed without a live Maple installation
are collected in §9 ("smoke tests").

Date: 2026-09-21. Target versions: Maple 2018 and Maple 2022 (thin prod).

---

## 1. The essentials you need to know right away

1. **Maplesoft has an official Maple MCP** — but it is a 2025/2026 product,
   shipped *inside the current Maple* for Elite Maintenance Program subscribers,
   or as a separate enterprise deployment. It is not meant for Maple 2018/2022.
   → [Maple MCP (EN)](https://www.maplesoft.com/products/maplemcp/index.aspx)
2. **Maple has 4 official external APIs (OpenMaple): C, Java, Python, VB6.**
   The Python API is built on top of the C API. An installed Maple and a license
   are required; the terms are in `extern/OpenMapleLicensing.txt` in the
   distribution.
   → [OpenMaple: Overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple)
3. **`.mw` is an XML format** (introduced in Maple 9, replaced the classic
   `.mws`). Maple can hand out a worksheet as an XML document via the `Worksheet`
   package (`ReadFile`, `ToString`, `Convert`, `WriteFile`, `WorksheetToJupyter`,
   `WorksheetToMapleText`, …), while the storage format is officially
   **not documented and subject to change** — the right thing is to go through
   the XML layer, not to parse bytes by hand.
   → [Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW),
   [Worksheet](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)
4. **Icarus already has a slot for MCP**: servers are described in `config.yaml`
   (`mcp:`), transports `stdio` / `streamable-http` / `sse`, read by
   `pi-mcp-extension`. An example of a custom server is `docker/user/mcp/echo-server.mjs`.
   So Maple-MCP hooks in **without touching the core**.
   → `README.md`, `PLAN.md` (the "M3 summary" section), `packages/service/src/config.ts`

### 1.1 Answers to the original questions (briefly)

**Can access to a local Maple 2018/2022 be bolted on?** Yes. The official
cloud Maple MCP is no good for us, but Maple has everything we need locally:
the console CLI, OpenMaple and (in 2022) the Jupyter kernel. There is no
community MCP for Maple — this will be the first, but there is something to lean
on (Wolfram/Matlab MCP servers as a model of the form).

| Question | Answer |
|---|---|
| **How to create a `.mw` in code?** | `.mw` is ordinary plain-text XML; we generate it ourselves, only 1-D: `<Group><Input><Text-field style="Maple Input">code</Text-field></Input></Group>`. There are no third-party writer libraries in npm, PyPI, or Pandoc. **The official headless path:** the `DocumentTools:-Layout:-*` / `Components:-*` constructors → `DocumentTools:-ContentToString` (returns the worksheet XML string) → `FileTools:-Text:-WriteFile`. Plus the `printf` specifier `%Zm` prints the worksheet XML. |
| **How to inspect it?** | The same XML (parse defensively: the format is officially "subject to change"), or `Worksheet:-ReadFile` (XML tree), `Worksheet:-WorksheetToMapleText` (the whole worksheet into 1-D text), `DocumentTools:-Retrieve(file, L6)` (expression by label). **2-D input is unreadable from outside** (~34% of real inputs) — only via linearization by Maple itself. |
| **How to edit?** | Edit the XML + write the file. We aim at the **document level**, not "cell by cell" (that is how Wolfram and MathCAD do it). Inside Maple — `DocumentTools:-InsertContent`/`SetProperty` (verify headless). |
| **How to execute a single cell?** | There is no documented API. In practice: extract the text of a group from the XML and feed it to the kernel; the semantically honest thing is to execute the **prefix 1…k** (groups rely on shared state and order). The whole worksheet — `DocumentTools:-RunWorksheet` (headless, fresh kernel, early exit via `return`). |
| **How to start the process and control it from outside?** | `<maple>/bin/maple -q -s -t` is a REPL; keep stdin open, read until a marker (`#-->` in `-t` mode or our own `printf` sentinel), through a pty if needed. `errorbreak=0`, strip `quit`, kill the process group. More robust — **OpenMaple** (C or our own ctypes wrapper around Maplesoft's MIT code); on Maple 2022 there is the **Jupyter kernel**. |

**Verdict:** feasible even without the official MCP. A sensible minimum is an
MCP server (stdio) on the machine with Maple: the kernel via a CLI process
(fallback — a process per request), worksheets via our own XML code,
`-e2`/`errorbreak=0`, `-T` limits, honest result status. Java and .NET are not
needed.

---

## 2. The official Maple MCP (what we copy, what is unavailable)

Confirmed by the product page ([EN](https://www.maplesoft.com/products/maplemcp/index.aspx),
[CN](https://www.maplesoft.com.cn/products/MapleMCP/)) and by a breakdown of the
PDF instructions (see `research/06-mcp-prior-art.md`):

- It is an MCP server that gives an LLM access to the "Maple Math Engine" (exact
  symbolic/numeric computation instead of probabilistic guessing).
- **It is a cloud service, not a local server.** Verbatim from the PDF "Setting up
  Maple MCP for Copilot Studio": endpoint
  `https://cloud-api.maplenet.cloud/api/v2/mcp`.
  Live probe: AWS API Gateway/Lambda behind CloudFront, MCP Streamable HTTP,
  `protocolVersion 2025-06-18`, `serverInfo = {name:"Maplesoft",
  title:"Maple Server", version:"2026.1"}`, capabilities — tools+resources
  (no prompts), server instruction — "Use Maple for all math calculations".
- **Authentication is an API key in the `auth` query parameter** (in Copilot
  Studio: Authentication = API key, Type = Query, Label = `auth`). The key is
  issued only from the "My Maple" feed inside Maple and requires an active
  **Elite Maintenance Program** subscription; Maple MCP is advertised as a new
  EMP benefit in Maple 2026.
- The list of tools of the official server is **not publicly available**:
  `tools/list` without a key returns HTTP 401; there is no entry in the MCP
  registries. So we cannot rely on the "official" tool names — they simply are
  not in the open.
- The best public reference for the form is the official **Wolfram MCP**
  (`https://agenttools.wolfram.com/mcp`): exactly 3 tools —
  `WolframContext{context}`, `WolframLanguageEvaluator{code, timeConstraint=60s}`,
  `WolframAlpha{query}`. An important detail of the description: "This is a
  stateless kernel, so you cannot reuse definitions from previous evaluations" —
  that is, the session state must be honestly stated in the tool description.

**Takeaway for us:** the official server is (a) cloud, (b) requires Maple 2026 +
EMP, (c) has no compatibility mode with 2018/2022. There is no community MCP for
Maple CAS (a GitHub search returns only MapleStory/Maple Finance) — we are making
the first. We take the Wolfram MCP as the guide for tool form.

---

## 3. File formats: how to create / read / edit worksheets

Confirmed ([Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW)):

- `MW` (Maple Worksheet, `.mw`) is the native document/worksheet format,
  **XML-based**, introduced in Maple 9, replaced `MWS` (the classic worksheet).
- Maple has built-in export to other formats
  ([Exporting Worksheets to Other Formats](https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2fmanaging%2fexport)).
- "The `DocumentTools` package has several utilities for interacting with MW
  files" — the example on the page shows extracting an expression from a
  worksheet **by label**:
  ```maple
  MWFile := FileTools:-JoinPath("example/BesselsEquation.mw", base=datadir):
  DocumentTools:-Retrieve(MWFile, L6);
  ```

The `Worksheet` package ([overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)):

- Purpose: "infrastructure for generating and manipulating Maple worksheets
  using the Maple language", a programmer's toolkit.
- Access to a worksheet is **through its XML representation** using
  `XMLTools`; "The storage format for Maple worksheets is not documented, and
  is subject to change" — a direct warning not to parse the storage by hand.
- Commands (current version): `Comparator`, `Convert`, `Display`,
  `DisplayFile`, `FromString`, `ReadFile`, `RemoveSection`, `TableOfContents`,
  `ToString`, `WorksheetToJupyter`, `WorksheetToMapleText`, `WriteFile`.
- There are published [Worksheet/DTD](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fDTD)
  and [Worksheet/Schema](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fSchema).

From the [WorksheetPackage example](https://www.maplesoft.com/support/help/maple/view.aspx?path=examples/WorksheetPackage):

```maple
with(Worksheet);
wname := FileTools:-JoinPath([kernelopts(mapledir), "examplesclassic","WorksheetPackage.mws"]):
doc  := ReadFile(wname);                      # XML document, format="mw" by default
doc2 := ReadFile(wname, format = "maple8_xml");
doc3 := Convert(doc, format="maple8_xml");
str  := ToString(doc, format = "mws");        # back to classic .mws
```

In the worksheet XML you can see version attributes, e.g.
`_XML_Element(_XML_ElementType("Version"), ... major=12, minor=0 ...)` —
that is, the format has a version number (`major`/`minor`), and it must be taken
into account when generating files "from outside".

**Status:** the format has been worked out on live files (see §3.1). One item
remains open — whether the `Worksheet` package works in headless mode (see §9,
smoke test 2).

### 3.1 What is actually inside a `.mw` (verified on live files)

- A `.mw` for 2018/2022 is **a single plain-text UTF-8 XML file**. It is **not**
  ZIP/OPC: `unzip -l` fails, `zipfile.is_zipfile()` → `False`, there is no
  `maple.xml`, `_rels/.rels`, `[Content_Types].xml`. The beginning of the file:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <Worksheet>
  ```
  Holds even on 258-KB worksheets with 124 formulas and plots.
- The root `<Worksheet>` has no attributes/namespace; the first three children
  are always `Version`, `Label-Scheme`, `View-Properties`.
  `<Version major="2022" minor="2"/>` — major = release (2018/2022), minor = point.
  Stable from Maple 13 to 2024 (26 sampled files).
- Cells: `<Group>`; input —
  `<Group><Input><Text-field style="Maple Input">1-D code as plain text</Text-field>`;
  output — `<Output>` with `<Equation>` (base64 in the `display` attribute +
  base64 body) and `<Plot>` (base64 body); sections — `<Section><Title>`.
- **2-D math and plots are opaque base64 of Maple's internal format.** From
  outside they can be saved/moved but not synthesized. So we only need to
  generate 1-D `<Text-field style="Maple Input">`.
- **Measured constraint (26 real worksheets):** 2-D (typeset) input is an empty
  `Text-field` + `<Equation>` with private nested base64.
  **190 of 566 non-empty input regions (~34%) are 2-D-only and unreadable from
  outside**; there are worksheets where 100% of the input is 2-D. To read them
  anyway, you have to let Maple itself linearize the worksheet:
  `Worksheet:-WorksheetToMapleText` (2017+, present in both of our versions).
- Important invariants: `major` in `<Version>` is the **release year**
  (`major="2018"`, `major="2022"`), while Maple 18 (2014) writes `major="18"` —
  don't confuse them.
- **There is no ecosystem.** The only confirmed third-party reader of `.mw` is
  `davidovitch/maple-to-python` (`mw2txt.py`, dead since 2015, GPL-3.0/LGPL);
  the agent ran it unmodified against a real 2022.2 file — it extracted 1-D
  input correctly. **Not a single `.mw` writer package, nor an `.mws` parser;
  there are no packages for Maple worksheets in npm or PyPI; Pandoc has neither
  a reader nor a writer.** Conclusion: the MCP server implements format handling
  itself.
- Open question: `.mwz` (a possible compressed variant) — UNVERIFIED; `.mw`
  2018 ↔ 2022 compatibility (forward/backward) has not been tested on live
  versions.
- The published `Worksheet/DTD` and `Worksheet/Schema` describe **NOT `.mw`**,
  but the legacy Maple 8 vocabulary (`maple8_xml`: `worksheet/version/section/exchange/
  para/text/mapletext`, all lowercase). `.mw` does **not validate** against this
  schema. The official position: the storage format is not documented and may
  change.
- `.mws` is a text format in curly braces:
  `{VERSION 6 0 "IBM INTEL LINUX" "6.0" }…{SECT 0 {EXCHG {PARA 0 "> " 0 "" {MPLTEXT …}}}}`.
  Maple 2018 can still do Classic Worksheet (open/save `.mws`),
  in Maple 2022 the classic interface is **already gone** — only migration
  `.mws`→`.mw`.
- The `Worksheet` package by version. **2018:** `Comparator`, `Convert`,
  `Display`/`DisplayFile`, `FromString`, `ReadFile`, `ToString`,
  `WorksheetToMapleText` (2017+), `WriteFile`. **2022 adds**
  `RemoveSection` and `TableOfContents` (both 2020+) and `WorksheetToJupyter`
  (2022+). In `Convert`, the `outputfilename` argument is 2025+ only (not present
  in 2018/2022).
- **What is headless and what is not.** The only explicit prohibition for the
  command line is for `Display`/`DisplayFile` ("cannot be used in the Command-line
  version of Maple"); `Comparator` launches a Maplet (GUI), and
  `TableOfContents`/`RemoveSection` open the GUI, **unless `destination=` is
  passed**. `ReadFile`/`WriteFile`/`FromString`/`ToString`/`Convert`/
  `WorksheetToMapleText` have no GUI caveat — they are pure file and XML work,
  but Maplesoft does not state that the package loads in the CLI at all →
  smoke test §9.
- Signatures: `ReadFile(filename, format="mw"|"maple8_xml")`;
  `WriteFile(fileName, xmlTree, …)` — **note the argument order**;
  `FromString(str, …)`; `ToString(tree, …)`;
  `Convert(worksheet, [outputfilename], format=…)`;
  `WorksheetToMapleText(ws[, includeoutput])`;
  `WorksheetToJupyter(ws, outputfile=…)`;
  `RemoveSection`/`TableOfContents(target[, destination])`.
- **`DocumentTools` exists in 2018 and 2022:** `InsertContent`, `GetProperty`,
  `SetProperty`, `Do`, `Tabulate`, `Components`, `Layout`, `ContentToString`,
  `Retrieve`, `RunWorksheet`. `GetDocumentProperty(attr, mwfile)` — 2017+;
  `SetDocumentProperty(…, mwfile, outfile)` — 2021+ (i.e. only 2022).
  **`GetContent` does not exist** (the help page 404s, not in the lists).
  Headless: `ContentToString`, the `Layout:-*`/`Components:-*` constructors,
  `GetDocumentProperty`, `SetDocumentProperty` (2022), `Tabulate(…, output=XML)`;
  while `InsertContent`/`Tabulate`/`GetProperty`/`SetProperty`/`Do` require an
  **open document** (PG2018 §13.2 verbatim: "the Do command must query
  the GUI").
- "Export As…" in 2018 and 2022 is the same: HTML(+MathML), LaTeX, Maple input,
  Maplet, Maple text, plain text, PDF, RTF.
- Misc: `.maple` (Maple Workbook) is an SQLite database, not a worksheet; `.mla`
  is a binary repository; `.lib`+`.ind` is the old pair; `.m` is internal binary;
  `.mpl` is plain text.
- The only confirmed third-party reader of `.mw` is
  `davidovitch/maple-to-python` (`mw2txt.py`, lxml, GPL-3.0/LGPL header,
  abandoned since 2015): it reads `Text-field` with `style=="Maple Input"`.

**The main unresolved point:** whether the `Worksheet` package
(`ReadFile`/`WriteFile`/`ToString`/`Convert`/`WorksheetToMapleText`) really works
under the command-line `maple`/`cmaple` in 2018/2022 — according to the docs only
`Display` is GUI-only, but a smoke test on a real installation is needed.

---

## 4. External APIs: OpenMaple

Confirmed ([OpenMaple: Overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple),
details — `research/02-openmaple-c.md`):

- OpenMaple is an **in-process embedding API**: our process itself becomes the
  Maple kernel; there is no separate `maple` process. The header is **`maplec.h`**
  in `$MAPLE/extern/include` (not `maple.h`!). The libraries are in
  `$MAPLE/bin.<SYS>` (`bin.X86_64_LINUX` / `bin.APPLE_UNIVERSAL_OSX` /
  `bin.X86_64_WINDOWS`), and **not** in `extern/lib`:
  Linux `libmaplec.so` (+`libmaple.so`, `libhf.so`), macOS `libmaplec.dylib`,
  Windows `maplec.dll`/`maplec.lib`.
- Java: `$MAPLE/java/{jopenmaple.jar,externalcall.jar}`;
  C#/.NET: `$MAPLE/extern/include/maple.cs` (`MapleEngine`); VB6 exists too.
- Runtime: `MAPLE=<install root>` + `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` with
  the bin directory (Windows: `PATH`). The official bootstrap:
  `export MAPLE=...; . $MAPLE/bin/maple -norun`.
  A wrong `MAPLE` ⇒ `StartMaple` returns NULL with "license.dat does not exist".
- Entry points:
  `StartMaple(argc,argv,&cb,user_data,info,err)` → `EvalMapleStatement(kv,str)`
  → `MapleToString(kv,algeb)` → `StopMaple(kv)`; for a cheap reset —
  `RestartMaple(kv,err)`. The function `MapleOpenMaple` does not exist. `argv[0]`
  must be `"maple"`, the `err` buffer ≥ 2048 bytes, `info` = NULL,
  `StopMaple` is irreversible (you cannot call `StartMaple` again in the same
  process).
- Results: a text callback (the result arrives **in fragments**, one result ≠ one
  call) and structured `ALGEB` (`MapleToString`,
  `MapleToInteger64`, `IsMaple*`).
- **Threading:** the API can only be called from the thread that called
  `StartMaple`; one kernel per thread ⇒ one OS process per session.
- Limits are just CLI flags in `argv`: `-T cpu,data,stack,core`,
  `--init-reserve-mem`, `--init-commit-mem`.
- License: a full locally installed licensed Maple is required; there is no
  separate free runtime; additional terms are in
  `$MAPLE/extern/OpenMapleLicensing.txt` (the content is not published online →
  UNVERIFIED).
- **Stability:** the OpenMaple chapter is textually identical in the official
  Programming Guides for 2018, 2021 and 2023 — the C API is stable, no ABI
  changes or deprecations are documented. For 2022 ProgrammingGuide.pdf is not
  published (404), so 2022 is squeezed between 2021 and 2023.

### Python: an important correction

- The official **"OpenMaple for Python" appeared only in Maple 2023**
  (verbatim from the Maple 2023 Connectivity update). In 2023 the module was
  called `import maple`, since 2024 — `maplesoft.maple`, and the README on GitHub
  directly says "requires an installation of Maple 2024 or later".
  → **it does not exist in 2018 and 2022.**
- The repository `github.com/Maplesoft/openmaple` (MIT, created 2024-08-21,
  alive) contains `maplesoft/maple/maplec_ctypes.py` — a ready set of ctypes
  declarations that we can **adapt to 2018/2022**
  (nuances: there the `err` buffer is only 1024 bytes while 2048 is required;
  `c_int64` is hardcoded for `M_INT`).
- There are no other working Python wrappers: the PyPI `PyMaple` is not what we
  need, `openmaple`/`pyopenmaple`/`maplebridge` do not exist. The only live
  non-Python wrapper is `mezzarobba/openmaple-ocaml` (public domain, pre-alpha)
  as a reference.
- **Resolving the uncertainty:** the OpenMaple C API is documented already in the
  Maple 2018 Programming Guide (the OpenMaple chapter, p. 476) and was textually
  identical to 2021/2023 ⇒ `libmaplec` **exists** in 2018 and 2022, and a thin
  ctypes wrapper of our own for the old versions is a workable path.
- The session model of the official Python binding is **persistent, stateful**:
  the module-level global `Session` holds one live kernel, variables survive
  calls. That is exactly the semantics we need.
- Another reference for the result model is the **MapleNet Compute API**
  (protobuf Request/Reply, `Session{id,timeout}`, `OutputOptions TEXT|MATHML`,
  `PlotOptions IMAGE|PROTOBUFFER` with dimensions in pixels and a typed stream of
  events `result/printf/print/lprint/error/warning/server_error/image_plot/plot`).
  It requires a MapleNet server, not desktop Maple, but as a model of
  "result + output + plot" it is very useful.

**Conclusion:** for 2018/2022 the path is either a C/C++ helper, or a **ctypes
wrapper based on Maplesoft's MIT code**, or (simplest) a separate `cmaple`/`maple`
process, see `research/01-cli-batch.md`.

---

## 5. Running Maple from outside: CLI and batch

(Section being expanded; below is what is confirmed by the official help and the
2018/2022 Programming Guide, details in `research/01-cli-batch.md`.)

**Command names — important not to mix up:**

- Linux/macOS: the console Maple is `maple` (a script in the install's `bin/`),
  the GUI is `xmaple`.
- Windows: console — `cmaple(.exe)`, GUI — `maplew`.
- Officially: "To start the Command-line version in Mac or Linux, use the
  `maple` command. In Windows, use the `cmaple` command"
  ([Maple Versions](https://www.maplesoft.com/support/help/maple/view.aspx?path=versions));
  Maple 2018 Programming Guide §14.4 — the same.
  → The MCP server on Linux must call `<maple>/bin/maple`, not `cmaple`.

**Running a script:**

```bash
maple -q -s script.mpl        # positional file after the options
maple < script.mpl            # that's how it's done on HPC clusters (NCSU)
```

- **`-f` is NOT "execute file"** but "use the specified license file". The
  executable script is the positional `file` at the end of the command line.
- `-c <command>` — execute a command before reading input; the option can be
  repeated, they run in order. The classic pattern:
  `cmaple -q -b <libdir> -cread(...) -cquit`.
- `-w` is the **warning level**, not "worksheet".
- By calling sequence: `-B` is batch mode, `-b libname` is the path to the main
  library (to be confirmed).

**Return codes (the same in 2018 and 2022):**

| Code | Meaning |
|---|---|
| 0 | normal termination |
| 1 | initialization error |
| 2 | the script broke off (e.g. an unclosed delimiter) |
| 3 | failed to reopen stdin after a script with `-F` |
| 4 | error while processing the script (the threshold depends on `interface(errorbreak)`) |
| 5 | the kernel terminated unexpectedly |
| n | the result of `quit(n)` / `done(n)` / `stop(n)` |

**Critical for automation:** with the default `errorbreak=1` only a **syntax**
error aborts (code 4), while a **runtime error does not stop the script and the
code stays 0**. To make any error produce code 4, you need to run with `-e2`
(in 2022+ there is also `-e3` — with stack trace printing). This must either be
baked into our launch or the output must be explicitly checked for errors.

**2018 ↔ 2022 option differences:** 2018 has `-cw` (Classic Worksheet) and does
not have `--echofile`/`--strip-debug-info`; 2022 is the opposite. `-noAI` is only
in recent versions (2024+).

### 5.1 Backend options: comparison

| Variant | Versions | Session state | Startup/memory | Complexity | Comment |
|---|---|---|---|---|---|
| CLI `maple -q -s -e2 file.mpl` (process per request) | 2018, 2022 | no (stateless) | the process lives only for the request; Maplesoft claims ~0.1 s to start (verify on site) | low | the most predictable; we parse stdout/stderr and the return code |
| Long-lived `maple` + stdin/stdout with a sentinel marker | 2018, 2022 | yes | a resident kernel (hundreds of MB) | medium | fragile: buffering, partial reads, mixed output |
| OpenMaple C via our own ctypes wrapper | 2018, 2022 (API stable 2018→2023) | yes | in-process; one kernel per thread ⇒ one process per session | medium-high | structured `ALGEB`; reference — Maplesoft's MIT code |
| OpenMaple Java | 2018, 2022 | yes | +JVM; **`-Xss100M` is mandatory** (otherwise segfault); one `Engine` per JVM; `stop()` is terminal, reset — `restart()`; `dispose()` on every result | high | only if typed objects are needed |
| **Official Maple Jupyter kernel (ZeroMQ)** | **2022+** | yes | like an ordinary Jupyter kernel | medium (the protocol is ready-made) | `Jupyter[GenerateKernelConfiguration](dir)` + `jupyter kernelspec install dir/maple` |
| OpenMaple for Python | 2023+ | yes | — | — | not our case |
| MapleNet (server) | separate | yes | — | high | not for a thin local box |

A nuance on Java: the JAR names in the docs diverge — the 2018/2021/2023
Programming Guides say `$MAPLE/java/{externalcall.jar,jopenmaple.jar}`, while the
current help says `Maple.jar` + `externalcall.jar` (the class
`com.maplesoft.openmaple` inside `Maple.jar`). There is no official
`openmaple.jar`. On site you just have to look at `ls $MAPLE/java`. The bootstrap
from the 2018 Guide:

```java
Engine t = new Engine(new String[]{"java"}, new EngineCallBacksDefault(), null, null);
t.evaluate("int(x,x);");
```

(`args[0]` must be `"java"`, the fourth argument is `null`.)

**Recommendation:** the base backend is the CLI (works in both 2018 and 2022,
without a JVM and without native dependencies); on Maple 2022 we optionally hook
up the official Jupyter kernel; Java — only if typed Maple objects are really
needed, and then a single long-lived helper JVM (a per-request JVM is
unacceptable).

### 5.2 Recommended architecture (draft)

**Where the server lives.** Only on the machine where Maple is installed and
licensed: the kernel, libraries and license are local, and there is no cloud
workaround for 2018/2022. We hook it into Icarus as `stdio` (if it is the same
host) or `streamable-http`.

**The process.** Console Maple is a **REPL**: it lives as long as stdin is open
and keeps session state. On EOF it **exits** by default; `-F` makes it continue.
We set it up like this:

- launch `<maple>/bin/maple -q -s -t` (Linux/macOS) or `cmaple.exe …` (Windows);
  **`-t` is machine mode**: the prompt becomes `#-->`, prettyprint is disabled;
- `-q` does **not** remove the `"> "` prompt — it does `interface(quiet=true)`;
- **there is no documented flush control for stdout** (`interface` and
  `kernelopts` have no `flush`; `fflush`/`FileTools:-Flush` are for files only).
  Therefore real wrappers either work through a **pty** (SageMath: `maple -t` +
  waiting for `#-->`; Emacs comint: `^> `), or read until an **explicit marker**
  (TeXmacs: `printf(\`tmstart\n\`)` / `printf(\`tmend\n\`)`; the old maplev:
  `lprint(END_OF_OUTPUT);`);
- we set `interface(errorbreak=0)`: when reading from a user, processing
  continues after any error, but for redirected stdin values 1–3 stop parsing,
  and the behavior of the "pipe" branch is undocumented;
- `quit`/`done`/`stop` are keywords, they kill the session and are not
  intercepted: they must be stripped from incoming code, or be ready to restart
  the process (startup ~0.1 s);
- `restart` is only on a separate line; it resets `interface` options too, but
  with `-c` the `-c` commands are re-executed (convenient for reinstalling
  settings);
- to kill a hung process — `timelimit(N, …)` + `kernelopts(cpulimit)`/`-T`, from
  outside SIGINT→SIGTERM→SIGKILL **to the process group** (on Linux `bin/maple`
  is a shell script, the `exec` behavior is unconfirmed; TeXmacs does `setsid()` +
  `killpg()`).

**Why this is fragile.** The lack of guaranteed flush and the reliance on markers
is exactly why the current maplev moved from `cmaple` to its own OpenMaple binary
(`pmaple` with `fflush(NULL)`), while SageMath/Emacs sit on a pty. If the
persistent mode turns out to be unstable, we switch to OpenMaple or the Jupyter
kernel.

- `-e2` is **mandatory**: otherwise a runtime error does not change the return
  code and a failure is easily "lost".
- Before requests we set machine-readable output, otherwise the result comes as
  typeset text and with ANSI color (on UNIX ANSI is **on by default**):
  ```maple
  interface(prettyprint=0):
  interface(ansi=false):
  interface(quiet=true):
  ```
  Without `ansi=false` the parser is forced to strip escape sequences.
- "Execute one cell" = send the cell's code as is and collect: stdout, the error
  stream, the result of the last expression, and if needed — LaTeX/MathML/PNG
  dumped to a temp file.

**Fallback.** For isolating a "clean" run — a process per request
(`maple -q -s -e2 tmp.mpl`), at the cost of startup. On Maple 2022 — an optional
backend on the official Jupyter kernel.

**Worksheet format.** `.mw` is ordinary XML, so we read/write it ourselves,
without third-party libraries: we parse `<Group><Input><Text-field style="Maple Input">`
and generate only 1-D. 2-D input is unreadable from outside — for it we call
`Worksheet:-WorksheetToMapleText` (if the package works headless; if not — we
honestly report that the cell is 2-D and cannot be read from outside). We do not
synthesize base64 outputs (`<Equation>`, `<Plot>`).

**Thin prod resources.** Kernel limits via `-T` (cpu/data/stack/core);
`lifecycle: lazy` in the Icarus config; an idle timeout that shuts the kernel
down; one session per user, no kernel pool.

**What we don't do.** Per-request JVM; multiple kernels on a thin box;
GUI/X11 — unless it turns out that the `Worksheet` package does not work without a
GUI (then either Xvfb or we live with the XML path only).

### 5.3 How to execute a single cell (execution group)

**Short answer: there is no documented API to "execute a single group from an
unopened `.mw`".** Neither in `Worksheet` nor in `DocumentTools` is there a
command that takes a group number/identifier; on the command line there is no
option to select a group or label (`DocumentTools:-Run` and `:-Evaluate` do not
exist).

What actually exists (details — `research/07-…md`):

| Capability | Command | Executes? | Scope | GUI? |
|---|---|---|---|---|
| Execute the **whole** worksheet as a procedure | `DocumentTools:-RunWorksheet(ws, …)` | yes | all groups, in a **fresh kernel** | no — explicitly supports "command-line Maple" |
| Worksheet → **1-D text** | `Worksheet:-WorksheetToMapleText("f.mw")` (2017+) | no | all input groups | UNVERIFIED in CLI |
| Worksheet → **XML tree** | `Worksheet:-ReadFile("f.mw")` | no | all nodes | UNVERIFIED in CLI |
| Internal label → expression | `DocumentTools:-Retrieve("f.mw", L6)` | **no** (only returns) | one labeled output | UNVERIFIED in CLI |
| Open the worksheet in the GUI | `Worksheet:-Display` / `DisplayFile` | GUI | — | **yes** — "cannot be used in the Command-line version" |

About `RunWorksheet`: a new engine (state is not shared with the caller), there
are `var_init`/`outputs`, and **early exit is a top-level `return`** at the end of
the last group needed. It **already existed in 2018** (PG2018, p. 190); in the
2022 help the `inheritlibname` parameter has the note "(optional, cmaple only)",
and it says directly that the worksheet "runs headless". Some parameters are newer
than 2022, so the set for 2018 needs to be checked.
`DocumentTools:-Retrieve(filename, label)` addresses by
`labelreference` (`L1`, `L6`; in a real `.mw`
`<Label-Scheme value="2"/>` is confirmed), but it only **returns** the expression
without executing it. `WorksheetToMapleText` outputs the whole file **without
group separators**. Hence the practical trick: **one execution group — one file**
+ `RunWorksheet`, or extracting the N-th group from the XML (our main path).

**The practical path (what we will actually do):** pull out the text
`<Group><Input><Text-field style="Maple Input" prompt="&gt; ">…</Text-field></Input></Group>`
and feed it to the kernel (`read`, stdin, `-c` or OpenMaple). One execution group
is just one block of statements; there is nothing "magical" about it in the file
format.

**Semantic caveats:**

- A group relies on the **shared kernel state and document order**, so executing
  group *k* alone makes sense only if it is self-contained. The honest operation
  "execute part of the worksheet" is to **execute the prefix 1…k in order**.
- `restart` inside a group must be respected: it resets everything (including
  `interface` options) and must be on a separate line; with `-c` the `-c` commands
  are re-executed after it.
- **~34% of real inputs are 2-D-only** and unreadable from outside; we linearize
  them via `Worksheet:-WorksheetToMapleText`.
- Executing a fragment **does not create equation labels** and **does not modify
  the `.mw`** on disk.
- The format is officially "not documented, and is subject to change" — we parse
  defensively.

### 5.4 Operations: limits, license, diagnostics

- **Memory/CPU.** `-T cpu,data,stack,core` are OS limits, values in
  **kilobytes**, any prefix out of the four can be given. Example "60 s CPU,
  4 GiB": `maple -q -s -T 60,4194304 job.mpl`. `--init-reserve-mem=` sets
  the size of the virtual map (and that is also the session's maximum memory);
  on conflict **`-T` takes priority**. There is also `kernelopts(datalimit=…)`.
- **Limit per computation.** `timelimit(seconds, expr)` inside the code, while
  `-T` is the external fuse.
- **How to kill a hung process.** The signal (SIGINT/SIGTERM) must be sent
  **to the kernel process or the process group**, not to the `maple` wrapper
  script: on Linux `maple` is a shell wrapper (the exact `exec` behavior is on the
  unverified list). **Verified (see §10.1.1):** `bin/maple` does `exec cmaple`,
  but the `mserver` kernel is a separate child process of the wrapper, and killing
  the wrapper alone does not touch it. The working approach is our own process
  group per session (`spawn(..., {
  detached: true })`) and a signal to the whole group.
- **License.** For batch, nothing beyond an ordinary activated license is needed:
  a single-user `license.dat` in `<maple>/license/` or a network FlexNet server
  (`lmgrd` + `maplelmg`). **Every live Maple process is a separate license
  instance**, so a kernel pool is bad for licensing too. The sign of trouble is
  return code `1`.
- **Startup probe** (version/platform/license):
  ```sh
  /opt/maple2022/bin/maple -q -s -e2 \
    -c 'printf("PROBE %a %a %a\n", kernelopts(version), kernelopts(platform), kernelopts(wordsize)):'
  ```
- **Syntax check without execution** (a separate useful tool):
  `maple -q -s -P -e0 file.mpl`.
- **Official startup estimate** (PG2018 §14.4, the same text in 2021/2022):
  "Starting the Maple command-line interface, automatically executing a command
  file, and stopping the Maple session can take about **one tenth of a second**"
  — Maplesoft itself positions the CLI as suitable for being called from other
  applications "even for quick computations". Verify on site.

### 5.5 Result serialization (what actually exists)

| What is needed | How to do it | Status |
|---|---|---|
| machine-readable text | `interface(prettyprint=0)`, `lprint`, `printf`/`sprintf` (`%a %A %q %m`) | confirmed |
| expression value as a string | `convert(expr, string)` | confirmed |
| writing output to a file | `writeto`, `FileTools`; in the CLI also `interface(echofile)` | confirmed |
| worksheet XML from Maple | `printf("%Zm", …)`; `DocumentTools:-ContentToString` | confirmed |
| LaTeX | `latex(expr, output=string)` | `latex` was **rewritten in 2021** → the option sets for 2018 and 2022 differ (UNVERIFIED for 2018) |
| MathML | `MathML:-ExportContent(expr)` | confirmed; **`convert(expr,'MathML')` is not documented** |
| plot to file | `plotsetup(png\|gif\|jpeg\|postscript, plotoutput=…)`, then `plot(...)`; `Export(…, format="PNG"\|"GIF"\|"JPEG")`; `plottools:-exportplot` (GIF/JPEG/TIFF + vector) | confirmed |
| plot to SVG/EPS | — | **SVG is not supported**, `plot(..., output=…)` — **there is no such option** |

Important CLI defaults: `;` shows the value, `:` suppresses it; `interface(echo)`
defaults to 1, that is **input is echoed back** when it is not a tty
(`quiet=true` overrides); `prettyprint` defaults to 1 in the CLI (in the GUI — 3);
**`printbytes` defaults to true → junk "bytes used=…" gets into the output**
(must be turned off); `warnlevel` 3; `errorbreak` 1. Therefore we build the
protocol on **sentinel frames via `printf` and colon terminators**, not on
positional parsing.

---

## 6. How this fits with Icarus

The exact slot schema (`packages/service/src/config.ts`):

```ts
export type McpServerConfig = {
  transport?: 'stdio' | 'streamable-http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  lifecycle?: 'eager' | 'lazy';
};
```

- In `config.yaml` it is `mcp: { <name>: {...} }`; in the README the example is
  `mcp: {}`.
- `pi-mcp-extension` reads `~/.pi/agent/mcp.json`; the service generates
  `settings.json` + `mcp.json` from the config.
- There is a sample minimal stdio server: `docker/user/mcp/echo-server.mjs`
  (raw JSON-RPC line by line; `initialize` / `notifications/initialized` /
  `tools/list` / `tools/call`; protocol `2024-11-05`).
- `lifecycle: eager|lazy` — you can keep the Maple kernel warm (`eager`) or bring
  it up on demand (`lazy`); for "thin prod" this is a memory lever.

Consequence: Maple-MCP is a separate process that is most conveniently run
**where Maple is installed** (on mom's machine), and hooked into Icarus either as
a local stdio server or as `streamable-http` (if Maple is on another machine).
The Icarus core does not need to be modified.

**What needs to be confirmed with the owner of the hardware:** the OS and version
(2018 or 2022). This determines the name of the executable (`cmaple.exe` on
Windows vs `bin/maple` on Linux/macOS), the paths (on Windows something like
`C:\Program Files\Maple 2022\bin.X86_64_WINDOWS\cmaple.exe`), the presence of the
Jupyter kernel (2022 only), and in general where the MCP server can physically
live. Until then, all specific commands in the report are given in two variants.

---

## 7. MCP tool set (proposal)

The list of the official Maple MCP is unknown (§2), so this is a **proposal**
assembled from vendor and community surfaces (details —
`research/06-mcp-prior-art.md` §3.7). The `maple_` prefix is mandatory: without it,
names like `matrix_operation` conflict with SymPy/Sage servers.

**Tier 1 — core (do first):**

| Tool | Purpose | Parameters | Modeled after |
|---|---|---|---|
| `maple_evaluate_code` | execute code in the session, return the results | `code`, `timeout_seconds?`, `session?` | Wolfram `WolframLanguageEvaluator` |
| `maple_check_code` | static analysis **without execution** | `code` or `path` | MathWorks `check_matlab_code` |
| `maple_help` | help on a command/topic | `topic` | Wolfram `WolframContext` |
| `maple_health` | check that computation works: version + latency | — | sagemath `check_sage_health` |

**Tier 2 — sessions and output quality:**

| Tool | Purpose |
|---|---|
| `maple_verify` | independent re-verification of a statement: proved / refuted / supported / undecided (native `verify`/`is`) |
| `maple_validate_code` | normalization/parsing of code and clear syntax errors **without execution** |
| `maple_start_session` / `maple_list_sessions` / `maple_stop_session` | named workspaces with independent state |
| `maple_reset_session` / `maple_interrupt_session` / `maple_cancel_session` | reset / interrupt preserving state / cancel |
| `maple_to_latex` | expression → LaTeX or MathML |
| `maple_plot` | plot as an image (`png`/`svg`, width/height) |

**Tier 3 — documents: document level only, NOT per cell.** This is the most
important correction that the prior art gives: both vendors that actually ship
document work (Wolfram `ReadNotebook`/`WriteNotebook`, MathCAD
`open_worksheet`/`calculate_worksheet`/`save_as_pdf`) provide **operations over a
whole document with a text exchange format**, not `create_cell`/`edit_cell`/
`run_cell`. There is no need to invent a per-cell API — there is no precedent, and
the surface grows. If it turns out that local Maple does not offer convenient
document work, Tier 3 can be thrown out entirely without touching Tiers 1–2.

| Tool | Purpose |
|---|---|
| `maple_read_document` | read a worksheet as markdown/text |
| `maple_write_document` | write markdown/text as a Maple document |
| `maple_run_document` | execute the document and return the results |
| `maple_export_document` | export to PDF/LaTeX/… |

**The broad tier of operations (`maple_solve`, `maple_dsolve`, `maple_int`, …) —
not now.** Vendor servers have a small surface; but the nearest community
analogue (`maxima-mcp`) has 133 operations, and there empirically a separate
routing document "task type → tool" is required, otherwise tool selection
degrades. Recommendation: start with Tiers 1–2, measure, and add the broad tier
only if the generic evaluator is not enough.

**Cross-cutting rules (all backed by sources in §3.7 of report 06):**

- A machine-readable **result status**: `exact` / `approximate` /
  `unevaluated` / `no_closed_form` / `error` / `timeout` + warning text.
  This protects against the model presenting "Maple returned `int(...)` unchanged"
  as an answer.
- `isError: true` for Maple errors, not a JSON-RPC error; a timeout must not
  look like a mathematical answer.
- Hard timeouts with a documented default + a memory limit where possible.
- **Output truncation with an explicit marker** — Maple symbolic output can be
  huge.
- **Pass big integers as strings**: JSON numbers in JS clients are IEEE doubles,
  so a 30-digit integer will be silently rounded before it even reaches us.
- A warning in the description about commands that kill the session (`restart`,
  `quit`, overriding built-in names).
- Effect annotations: read-only for `check`/`help`/`health`/`read`, destructive
  for anything that writes or executes.
- Honesty about the sandbox: Maple executes arbitrary code (files, `system()`,
  sockets), so "forbidden substring lists" are protection against accidents, not
  against malicious code; the boundary is an OS restriction (a separate user, a
  container), and this must be written in the docs.
- Transport is **stdio** for a local server (and no API keys in query parameters,
  like the cloud Maple MCP).

---

## 8. Detailed reports (in this same worktree)

| File | Topic | State |
|---|---|---|
| `research/01-cli-batch.md` | CLI `maple`/`cmaple`, headless, batch, return codes, limits, license | ready (except §3/§4 — see 07) |
| `research/02-openmaple-c.md` | OpenMaple C API + Python bindings | ready |
| `research/03-openmaple-java-dotnet.md` | Java/.NET, bridge cost, Jupyter | ready |
| `research/04-file-formats.md` | `.mw`/`.mws`/`.mpl`, XML, third-party parsers | ready |
| `research/05-in-maple-worksheet-api.md` | `Worksheet`/`DocumentTools`, one cell, serialization | ready |
| `research/06-mcp-prior-art.md` | official Maple MCP, CAS-MCP, tool set | ready |
| `research/07-single-group-and-persistent-process.md` | one execution group + long-lived process | ready |

## 9. What to run on a live installation (smoke tests)

The order is from cheap to expensive. All of this must be done **on the machine
with Maple**, before writing the MCP server.

1. **License and version.**
   `maple -q -s -e2 -c 'printf("%a %a\n", kernelopts(version), kernelopts(wordsize)):'`
   (Linux: `<maple>/bin/maple`, Windows: `cmaple.exe`). A return code of 1 is a
   license/installation problem.
2. **The headless `Worksheet` package** (the main unresolved point): whether
   `Worksheet:-ReadFile` / `Worksheet:-ToString` / `Worksheet:-WriteFile` /
   `Worksheet:-WorksheetToMapleText` work under the command-line `maple` without a
   GUI. Only `Display` is known to be GUI-only (confirmed verbatim). If the rest
   works, reading and generating worksheets is done "from inside Maple" rather
   than with our own XML code.
3. **`DocumentTools` headless:** `InsertContent`, `Retrieve(path, label)`,
   `GetProperty`/`SetProperty` — what works without an open window.
4. **Persistent protocol:** launch `maple -q -s -t` as a long-lived process
   (and separately through a pty), send two requests with a sentinel marker,
   check: (a) whether state persists between requests, (b) whether output is
   flushed when stdout=pipe, (c) what happens after a syntax and a runtime error
   with `errorbreak=0`, (d) whether the `#-->` prompt is visible and whether it
   works as a sentinel.
5. **Startup and memory measurement:** time to first result and kernel RSS (idle
   and after heavy computation) — this determines whether the kernel can be kept
   warm on a thin box.
6. **`.mw` round trip:** generate a minimal `.mw` with our XML code, open it in
   Maple 2018 and 2022 — verify that the format is accepted; then read into Maple
   a file created by the GUI and compare the structure.
7. **One cell:** extract the text `<Group><Input><Text-field style="Maple Input">`
   from a real worksheet, execute the prefix 1…k, compare with the result of
   executing the same cells in the GUI (order, state, output). Separately test
   `DocumentTools:-RunWorksheet` (the whole worksheet headless, fresh engine,
   early exit via top-level `return`) — whether these parameters exist in
   2018/2022. And test 2-D linearization via `Worksheet:-WorksheetToMapleText`.
8. **Serialization:** `latex(expr, output=string)` (and which options exist
   specifically in 2018 — `latex` was rewritten in 2021), `MathML:-ExportContent`,
   `plotsetup(png, plotoutput=…)`, `Export(…, format="PNG")`, writing to a file —
   all headless. Verify that `printf("%Zm", …)` and
   `DocumentTools:-ContentToString` produce a valid `.mw`.
9. **Version gotchas:** `.mws` in 2022 (migration only), `-e3` in 2022 vs
   `-e2` in 2018, the presence of `--echofile`, the behavior of
   `interface(ansi=false)`, turning off `printbytes` and `echo`.
10. **Creating a `.mw` from inside Maple (headless):** `DocumentTools:-Layout:-*` →
    `ContentToString` → `FileTools:-Text:-WriteFile`; open the result in the GUI
    of both versions.

---

## 10. What was confirmed on a live installation (Maple 18.00)

The machine turned out to have **Maple 18.00** (`X86 64 LINUX, Feb 10 2014, Build
ID 922027`, `/opt/maple18`), not "Maple 2018". This matters: part of the API that
we considered available "in 2018" is absent in 18.0.

Verified live:

- `Worksheet:-ReadFile/WriteFile/FromString/ToString/Convert` exist and
  **work headless**; `Worksheet:-WorksheetToMapleText` — **absent** (2017+).
- `DocumentTools:-InsertContent/GetProperty/SetProperty/Do/Retrieve/RunWorksheet/GetDocumentProperty`
  exist; **`Tabulate` and `ContentToString` — absent**.
- `Worksheet:-Display` — GUI only (as the help said).
- `latex(expr, output=string)`, `MathML:-ExportContent` work; graphics is
  provided by `plottools:-exportplot` in **gif/jpeg/bmp**, while `png`/`tiff` —
  **not**. `Export(..., format="PNG")` in 18.0 simply returns an unevaluated call.
- **`maple -c` must not be used**: the `maple` launcher is a shell script that
  does `eval` on the arguments, so code and paths with quotes and slashes break.
  Reliable — via stdin or a script file.
- **A syntax error in a live REPL hangs the stream**: subsequent statements are
  not executed. Runtime errors are safe. A preliminary syntax check in a separate
  process (`maple -P`) saves it — then the session is not corrupted.
- `maple -q -s -t` gives clean output without a prompt and without "bytes used";
  output is flushed immediately; startup ~50 ms; kernel RSS ~5 MB.
- `.mw` in Maple 18 is the same plain-text XML; the examples contain
  `<Version major="11" …>` (a file not re-saved since Maple 11), i.e. `major` is
  the format version, not the release year.
- 2-D input can be read from the `input-equation` attribute (Maple's linear
  form), not only as "opaque base64".
- **Maple 18 external libraries do not load on a modern glibc:**
  `libatlas.so` and `libmsp.so` (from 2014) require an executable stack, and
  `dlopen` in glibc 2.41+ (Ubuntu 26.04) rejects such objects. The symptom is
  `Error, (in dsolve) external library libmodLA.so could not be found/used`,
  i.e. `dsolve`, `pdsolve`, numeric ODEs and everything that pulls in ATLAS
  silently break. It is fixed by clearing the `PT_GNU_STACK RWE` flag:
  `tools/maple-mcp/fix-execstack.py` (with `*.bak-execstack` backups, there is
  `--restore`). After the fix, `dsolve` gives `y(x) = 1/k*sin(k*x)` and
  `pdsolve` solves the heat equation.

Implementation based on the results: **`tools/maple-mcp/`** — the server
(stdio + Streamable HTTP) and self-tests (27 + 25 checks, all green).

### 10.1 Sessions across chats: how it actually works

- **The pi bridge kills our MCP process at the end of the chat**
  (`session_shutdown` → `manager.shutdownAll()`), so state cannot be held in
  kernel memory. Therefore state lives in a **journal**:
  `$MAPLE_SESSION_DIR/<name>.jsonl`, and on the first access to a session in a
  new process the journal is replayed into a fresh kernel (the response has a note
  "session restored from journal: N steps").
- Verified across **three consecutive** MCP processes: in the first we enter data
  and solve an ODE, in the second we continue (`m=2 k=3`, `y(1)`) and append a
  step, in the third we read the state again. And separately — **in two different
  containers**: `q:=5:` in one, `q*100` → `500` in the other (the journal landed
  in the persistent mount `~/.pi/agent/maple-mcp`).
- The kernel is shut down after **5 minutes** idle (`MAPLE_IDLE_SECONDS`), the
  journal remains — the next call brings the kernel up and restores the state.
- `restart` in the code clears the journal; `maple_session_forget` erases it
  entirely.
- `pi-mcp-extension` **discards images**, replacing them with the text
  `[Image: image/gif, base64 encoded]`. That is why `maple_plot` returns both
  image content (for clients that support it) and the file path on disk.
- The journal is a replay of commands, not a memory snapshot: a heavy step is
  re-executed on restore. For long computations it is better to save results to a
  file.

### 10.1.1 Process leak: an abandoned kernel stays a zombie

Verified on Maple 18 (X86 64 Linux) and in the owner's container:

- In CLI mode `bin/maple` does `exec cmaple`, and `cmaple` spawns a **second**
  process — the `mserver` kernel (in the same session and process group as the
  wrapper). `child.kill()` in Node hits only the wrapper, and the kernel survives
  it: `mserver` lives for a few more seconds (under heavy computation —
  indefinitely), then crashes with SIGSEGV (you can see `apport` in the log),
  already an orphan.
- In the owner's container PID 1 is `sleep infinity` from the image, and it does
  not call `wait()`. Therefore every orphaned `mserver`, once it exits, stays a
  zombie (`[mserver] <defunct>`) **forever**: the session is shut down on timeout,
  `reset`, idle, and on `session_shutdown` — hundreds accumulated over a single
  conversation.
- The fix is two-sided. (1) `maple-mcp` launches Maple in a separate **process
  group** (`spawn(..., { detached: true })` — that is `setsid`, the leader = the
  wrapper's pid) and shuts down the whole group (`process.kill(-pgid, SIG)`), and
  on process exit finishes off the remaining groups; this way the kernel does not
  stay alive without the wrapper. (2) `init: true` was added to the owners'
  containers — tini as PID 1 reaps orphans if they do appear anyway (for example,
  the MCP was killed with SIGKILL and there was no one to finish off the group).
- Locked in by tests: `tools/maple-mcp/test-sessions.mjs` (§6 — the kernel starts
  in its own group, the group empties after the timeout and after MCP shutdown)
  and `packages/service/test/containers.test.ts` (`init: true` on the owner's
  container).

### 10.2 Agent instructions: in the tool descriptions, not a separate file

At first the detailed instruction lived in a separate `MAPLE.md`, and `AGENTS.md`
had a pointer to it. Then it was removed: a file that the model reads only when
reminded loses to the tool descriptions that it sees in every conversation. Now
the short rule sits in the MCP handshake `instructions`, and the details are in
the descriptions of `maple_evaluate_code` ("you cannot compute in your head", as
the honest refusal sounds), `maple_to_latex` (formulas for a human are always
LaTeX) and `maple_plot` (insert the markdown string verbatim). The server is an
ordinary built-in MCP: `hidden: true` removes it from the panel, and it keeps
journals and plots in the working folder's `.maple/`.

---

## 11. Sources

Official (Maplesoft):

- https://www.maplesoft.com/products/maplemcp/index.aspx — the official Maple MCP
- https://www.maplesoft.com.cn/products/MapleMCP/ — the same (CN)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=maple — the `maple` command and options
- https://www.maplesoft.com/support/help/maple/view.aspx?path=versions — `maple` vs `cmaple` vs `xmaple`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW — the `.mw` format
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2fMWS — the `.mws` format
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet — the `Worksheet` package
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fConvert — `Convert`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=examples/WorksheetPackage — examples
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2fDTD and `.../Worksheet%2fSchema` — legacy Maple-8 XML (not `.mw`)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple — OpenMaple overview
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API and `.../OpenMaple/C/Examples` — the C API
- https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/Python/API — the Python API (2023+)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Jupyter/MapleKernel/Configuring — the Maple Jupyter kernel (2022+)
- https://www.maplesoft.com/documentation_center/ — Programming Guides (2018/2021/2023), User Manual
- https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf — mirror of the 2018 Guide (§14.3–14.4)
- https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf — the MapleNet result model

Third-party and practice:

- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/RunWorksheet — execute the whole worksheet headless
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/Retrieve — label → expression (without execution)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/ContentToString — worksheet XML as a string (headless)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/GetDocumentProperty and `.../SetDocumentProperty` — document properties from a file (2017+/2021+)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=latex — LaTeX (rewritten in 2021)
- https://www.maplesoft.com/support/help/maple/view.aspx?path=plotsetup and `.../Export` — plot output
- https://www.maplesoft.com/support/help/maple/view.aspx?path=printf — specifiers, incl. `%Zm`
- https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet/Display — "cannot be used in the Command-line version"
- https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet/expressions/equationlabels — equation labels
- https://github.com/Maplesoft/openmaple — the official ctypes binding (MIT, Maple 2024+), a reference for our own wrapper
- https://github.com/mezzarobba/openmaple-ocaml — an OCaml wrapper for OpenMaple (public domain, reference)
- https://github.com/davidovitch/maple-to-python — `mw2txt.py`, the only external reader of `.mw`
- https://agenttools.wolfram.com/mcp — Wolfram MCP, a reference for the tool form
- https://hpc.ncsu.edu/Software/Apps.php?app=Maple — a real batch run `maple < script.mpl`
- http://ftp.informatik.rwth-aachen.de/maple/mplbatch.htm — the historical `-c`/`-q`/`-b` pattern
- SageMath (the `maple` interface via pexpect/`maple -t`), TeXmacs (the Maple plugin: `tmstart`/`tmend`, `errorbreak=0`, `setsid`+`killpg`), maplev (Emacs; in 3.x it moved to its own OpenMaple binary `pmaple`) — real examples of CLI wrapping
