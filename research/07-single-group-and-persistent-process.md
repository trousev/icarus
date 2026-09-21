# 07 — Running ONE execution group of a worksheet, and a persistent request/response Maple process

**Purpose.** This file finishes the two topics that `01-cli-batch.md` left as placeholders:

* **§3** — how (and whether) you can run **only part** of a Maple worksheet (`.mw`) — a single
  execution group — from an external, GUI-less process; and
* **§4** — whether the command-line Maple process (`maple` on Linux/macOS, `cmaple.exe` on
  Windows) can be used as a **long-lived request/response server over stdin/stdout**, and how
  real wrappers do it.

It is written for an MCP server that drives a *locally installed* **Maple 2018 or Maple 2022**.
Everything is tagged with the version(s) it was verified against. Anything I could not confirm
from a primary source is marked **UNVERIFIED**.

**Cross-references to the sibling research files (read them; this file does not repeat them):**

| Topic | File |
|---|---|
| CLI launchers, full option list, exit codes, errorbreak, resource limits, licensing | `01-cli-batch.md` §1–§2, §5–§6 |
| OpenMaple (C API) and how to build against `libmaple`/`libmaplec` | `02-openmaple-c.md` |
| OpenMaple Java/.NET, and the **Maple Kernel for Jupyter (Maple 2022+)** | `03-openmaple-java-dotnet.md` §5.1 |
| `.mw` XML in detail: element vocabulary, `Group`/`Input`, `labelreference`, 2-D input as opaque base64, `mw2txt.py` | `04-file-formats.md` §2, §4.1, §5.2, §5.4, §9 |

**Source provenance used throughout.** Maplesoft's *online* help is served as the **current**
(Maple 2026) documentation; version-specific behaviour comes from the versioned Programming
Guides and User Manuals. When `www.maplesoft.com` returned a rate-limit / truncation, I used the
localized mirrors `fr.`/`de.`/`jp.`/`cn.maplesoft.com` **with the same `?path=`** and recorded
which source was actually read (`cn.maplesoft.com` was used for `fflush`; everything else here is
from `www.`).

| Label | What it is | URL |
|---|---|---|
| **HELP-CUR** | Live Maple online help (reflects Maple 2026 unless stated) | `https://www.maplesoft.com/support/help/maple/view.aspx?path=…` |
| **PG2018** | *Maple 2018 Programming Guide*, §14.4 "The Maple Command-line Interface", §14.3 OpenMaple, §16.6 | `https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf` (mirror used: `https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf`) |
| **M2018 / M2022 / CUR** | The `maple` help page archived 2018-06-01 / 2022-06-01 / live | see `01-cli-batch.md` provenance table |

> **Caution on version scoping.** `DocumentTools:-RunWorksheet` and the `Worksheet` package are
> documented on the **current** help pages; some of their parameters are newer than Maple 2022.
> Where that matters it is called out and marked **UNVERIFIED** for 2018/2022.

---

## 0. TL;DR — the actionable facts

**A. Partial worksheet execution**

1. **There is NO documented API that executes one execution group of an unopened `.mw`
   headlessly.** No command in the `Worksheet` package, and none in `DocumentTools`, takes a
   group identifier or index. There is also **no command-line option** to run a group or a label.
2. The only *documented, headless, whole-worksheet* executor is
   **`DocumentTools:-RunWorksheet(ws, …)`** — *"invokes the worksheet specified by `ws` as if it
   were a procedure"*; *"The invoked worksheet runs "headless", meaning that it will not appear
   with a user interface."* It runs **all** groups in a **new engine** (no sharing with the
   caller's kernel). You can truncate execution by putting a **top-level `return`** at the end of
   the last group you want (documented early-exit), or feed inputs / extract outputs via
   `var_init` / `outputs`.
3. The only *label-addressable* API is **`DocumentTools:-Retrieve(filename, label)`**:
   *"scans a document file for the given label and returns the corresponding expression"* — it
   **returns** the expression, it does **not execute** it. Labels are *internal* (`L6`, and in the
   XML `Group/@labelreference`) and are created by **Insert > Reference** in the GUI.
4. The only documented **headless lineariser** of a worksheet is
   **`Worksheet:-WorksheetToMapleText`** (Maple 2017+, so present in 2018 and 2022): it turns a
   `.mw` into a string of 1-D Maple commands. `Worksheet:-ReadFile` parses a `.mw` into an
   **XML tree** without a GUI. `Worksheet:-Display`/`DisplayFile` are explicitly
   **GUI-only** (*"Important: The Display function cannot be used in the Command-line version of
   Maple."*).
5. **Practical answer:** extract the target group's
   `<Group><Input><Text-field style="Maple Input" prompt="&gt; ">…</Text-field></Input></Group>`
   text and feed it to a kernel (`read`, stdin, `-c`, or OpenMaple). One execution group is just
   one **statement block**; there is nothing magic about it in the file format.
6. **Semantic caveats of doing that:** a group is designed to run in a **shared kernel state, in
   document order**. Running group *k* alone is only meaningful if it is self-contained; the
   faithful "run part of a worksheet" operation is **run the prefix groups 1…k in order**.
   `restart` inside a group must be honoured (it resets everything and must be on its own line).
   2-D (typeset) input is stored as opaque base64 and is **not externally readable** — use
   `WorksheetToMapleText` to linearise those. Running a fragment does **not** produce equation
   labels and does **not** touch the `.mw` file.
7. Because the file format is explicitly *"not documented, and is subject to change"*, parse it
   defensively and prefer the official `Worksheet` package where it works (**UNVERIFIED** in the
   command-line kernel for 2018/2022).

**B. Persistent request/response process**

8. **Yes, the CLI is a REPL** (*"when used interactively, displays an input prompt (`>`), runs
   commands, and displays the output as text-based results"*) and stays alive as long as stdin
   stays open. At EOF it **exits** by default; **`-F`** makes it continue
   (*"prevents Maple from exiting when the standard input has been redirected from a file … If
   `-F` is specified, Maple instead continues interactively"*).
9. **Prompt:** default `"> "` (`interface(prompt)`); **`-q` does NOT suppress the prompt**;
   `interface(quiet=true)` does. **`-t` (test mode) is the machine-friendly choice:** it changes
   the prompt to **`#-->`** and disables prettyprinting. Real wrappers key on this.
10. **There is no documented stdout-flush control on a pipe.** `interface` has no `flush`
    variable; `kernelopts` has no flush; `fflush`/`FileTools:-Flush` are documented only for
    *files* opened via `fopen`/`popen`/`FileTools`. Whether Maple's stdout is line- or
    block-buffered on a pipe is **UNVERIFIED**. Every real wrapper therefore either uses a **pty**
    (SageMath/pexpect, Emacs `comint`) or reads until an **explicit sentinel** appears
    (TeXmacs' `printf(\`tmstart\n\`)`/`printf(\`tmend\n\`)`; old `maplev`'s
    `lprint(END_OF_OUTPUT);`).
11. **End-of-output detection:** prompt sentinel (`-t` → expect `#-->`; SageMath does exactly
    this), or an explicit marker statement (`printf`/`lprint`). Both are used in production code.
12. **Errors:** `interface(errorbreak)` governs *file* input, not *user* input — *"When reading
    from the user, reading and processing continues after any error"* for every value 0–3. For
    **redirected stdin** / `read`, `errorbreak=0` continues after any error, `1` (default) stops
    on syntax errors, `2`/`3` stop on any error. Which branch a **pipe** takes is **UNVERIFIED**;
    set `interface(errorbreak=0)` (as TeXmacs does) to be safe.
13. **`quit`/`done`/`stop` terminate the CLI session and are language keywords** — nothing
    documents trapping them. A server must not forward them blindly; expect the process to die
    and respawn (startup is officially ~0.1 s).
14. **`restart`** clears the kernel and re-reads initialization files; it *"only works at the top
    level … It must be executed in a separate prompt (or line) from all other commands."* With
    `-c`, the `-c` commands are **re-executed after restart** — handy for re-establishing
    interface options.
15. **Killing a runaway:** `timelimit(N, …)` (catchable `"time expired"`), `kernelopts(cpulimit)`,
    `-T`; from outside, SIGINT (documented Ctrl+C) then SIGTERM/SIGKILL. On Linux `bin/maple`
    **is a shell script** (it sets env and invokes `${MAPLE}/$MAPLE_SYS_BIN/cmaple`); whether it
    `exec`s is **UNVERIFIED**, so start it in its own **process group**/session and signal the
    **group** (TeXmacs does `setsid()` + `killpg()`).
16. **Long-lived alternatives:** OpenMaple (in-process; `02-…`, `03-…`) and the **Maple Kernel
    for Jupyter** (bundled with **Maple 2022+**, built on OpenMaple) — both avoid the
    stdin/stdout framing problem entirely.

---

## 3. Running only PART of a worksheet / a single execution group

### 3.1 The short answer

There are four documented, *headless* things you can do with an unopened `.mw` file, and none of
them is "run group *n*":

| Capability | Documented command | Executes? | Scope | GUI needed? |
|---|---|---|---|---|
| Run the **whole** worksheet as a procedure | `DocumentTools:-RunWorksheet(ws, …)` | **yes** | every group, in a **new engine** | no (explicitly: *"command-line Maple"*) |
| Convert the whole worksheet to **1-D Maple text** | `Worksheet:-WorksheetToMapleText("f.mw")` | no | all input groups | **UNVERIFIED** in CLI (no GUI note; pure XML/text) |
| Parse the worksheet to an **XML tree** | `Worksheet:-ReadFile("f.mw")` | no | all nodes | **UNVERIFIED** in CLI |
| Resolve an **internal label** to an expression | `DocumentTools:-Retrieve("f.mw", L6)` | **no** | one labelled output | **UNVERIFIED** in CLI |
| Open the worksheet in the GUI | `Worksheet:-Display` / `DisplayFile` | GUI | — | **yes — explicitly forbidden headless** |

> *"Important: The Display function cannot be used in the Command-line version of Maple."*
> — `Worksheet/Display`, HELP-CUR.

Everything else (`DocumentTools:-GetProperty`, `:-SetProperty`, `:-Do`, the `Components`/`Actions`
subpackages) is bound to **embedded components in an open document** and is not a headless
group-execution route.

**There is no** `DocumentTools:-Run` and **no** `DocumentTools:-Evaluate`: both help paths return
**HTTP 410** ("The Help Document that you have requested was not found"). The documented
`DocumentTools` command list is
`AddIcon, AddPalette, AddPaletteEntry, ContentToString, CreateTask, Do, GetDocumentProperty,
GetProperty, InsertContent, InsertTask, RemovePalette, RemovePaletteEntry, RemoveTask, Retrieve,
RunWorksheet, SetDocumentProperty, SetProperty, Tabulate` (HELP-CUR `DocumentTools`).

**No Maple command-line option selects a group or a label.** The full option list (see
`01-cli-batch.md` §1) contains nothing of the sort; the "script" is a whole file (trailing
positional argument) or `-c` start-up commands.

### 3.2 `DocumentTools:-RunWorksheet` — whole worksheet, headless

Help: `https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/RunWorksheet`
(HELP-CUR). Calling sequence and key verbatim text:

```
RunWorksheet(ws, var_init)
```

> *"The RunWorksheet function invokes the worksheet specified by ws as if it were a procedure."*
>
> *"ws is the filename, either fully qualified or relative to the value of currentdir, of the
> worksheet to execute."*
>
> *"The invoked worksheet runs "headless", meaning that it will not appear with a user
> interface."*
>
> *"The invoked worksheet runs in a new engine, so expressions whose subsequent evaluation may
> depend on the state of the engine in the calling worksheet cannot be passed in var_init. This
> includes procedures and modules which are not lexically closed (for example, which use global
> or environment variables in their bodies). To pass a procedure, table, matrix, vector, or array
> defined elsewhere in the calling worksheet, it is necessary to apply eval to the expression
> first."*
>
> *"inheritlibname — (optional, **command-line Maple** and Maple worksheet only) truefalse ;
> indicate whether the worksheet process should inherit the current value of libname. The default
> is true."*

The `inheritlibname` parameter's own text is the direct evidence that `RunWorksheet` is intended
to work in **command-line Maple**, i.e. headless. Parameters (HELP-CUR):

* `var_init` — *"(optional) list(symbol=anything) ; list of equations of the form symbol =
  expression, specifying the initial values for the corresponding variables in ws"*.
  *"The variables appearing on the left-hand sides of equations in the var_init parameter are
  initialized to their corresponding right-hand side values."* This requires the worksheet to
  declare an input section in **Document Properties**: *"within the Document Properties there
  must be an attribute with Attribute Name InputSectionTitle and whose value is the section
  name."*
* `outputs` — *"(optional) list({symbol,string}) ; list of variables and/or command strings"*.
  *"Values can be extracted from the worksheet by specifying outputs=[list of names]. In addition
  to the names specified in outputs, command strings can be given in the outputs list. These
  commands will be evaluated as a post-processing step after the worksheet is finished executing
  but while the worksheet state is still active."*

**Two documented tricks that approximate "run only part of a worksheet":**

1. **Early exit.** *"If the invoked worksheet ws includes a return statement at the top level (not
   inside a procedure), the expression given in that return statement will be returned as the
   output of the RunWorksheet command. Execution of the invoked worksheet ws stops when a
   top-level return is evaluated."* → Editing a **copy** of the worksheet and appending a
   top-level `return` after group *k* gives you "run groups 1…k". Because `.mw` is plain XML and
   adding a 1-D input group is straightforward (`04-file-formats.md` §2, §4.5), this is
   mechanically feasible; it is a **composition of documented primitives**, not a documented
   feature.
2. **Parameterised partial runs.** With `var_init` + an `InputSectionTitle` section, you can call
   the same worksheet repeatedly as a function of its declared inputs. This does not stop
   intermediate groups from running, but it makes "compute just this scenario" cheap.

**Version caveats (important).** The HELP-CUR page says:

> *"The `DocumentTools[RunWorksheet]` command was updated in Maple 2025."*
> *"The `ws` parameter was updated in Maple 2025."*

The page is archived as existing on 2019-12-10
(`https://web.archive.org/web/20191210010501/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools/RunWorksheet`),
so the command exists in the 2018/2022 era, but **which parameters (`outputs`,
`inheritlibname`, `all`) existed in 2018 vs 2022 is UNVERIFIED** — the Compatibility history
could not be read in full on any mirror. **Smoke-test on the target install** with
`DocumentTools:-RunWorksheet("abs/path/f.mw")` before relying on the optional parameters.

### 3.3 `DocumentTools:-Retrieve` — the only label-addressable API (does not execute)

Help: `https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools/Retrieve`
(HELP-CUR):

```
Retrieve(filename, label)
```

> *"The Retrieve command scans a document file for the given label and returns the corresponding
> expression."*
>
> *"label is an internal label for the expression in the document and does not correspond to
> equation numbers."*
>
> *"In order to create a such a reference, use Insert>Reference in the Standard Worksheet
> Interface. This will allow you to look up an expression based on its equation number and
> automatically generate the internal label."*

Official example: `Retrieve(src, L6)` returns the (un-evaluated) expression stored under the
internal label `L6`. So `Retrieve` gives you **label → expression**, never **label → execution**.

### 3.4 The `Worksheet` package — headless XML/text manipulation

Help: `https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet` (HELP-CUR):

> *"The Worksheet package provides an infrastructure for generating and manipulating Maple
> worksheets using the Maple language. The package is conceived as a programmer's toolkit, as
> opposed to a tool for interactive exploration."*
>
> *"This package makes it unnecessary to know the storage format for the Maple worksheet by
> providing access to its XML representation. This allows you to use existing and new tools for
> manipulating XML documents. (For details, see XMLTools.) **The storage format for Maple
> worksheets is not documented, and is subject to change.**"*

Documented commands (verbatim list): `Comparator, Convert, Display, DisplayFile, FromString,
ReadFile, RemoveSection, TableOfContents, ToString, WorksheetToJupyter, WorksheetToMapleText,
WriteFile`. **None of them runs anything** (only `Display` shows a worksheet, and it is GUI-only).

The two that matter for partial execution:

* **`Worksheet:-WorksheetToMapleText(worksheet)` / `(worksheet, includeoutput)`**
  (`…?path=Worksheet/WorksheetToMapleText`):
  > *"The command WorksheetToMapleText converts a Maple worksheet in .mw format into a string
  > containing the equivalent commands as 1-D Maple text. It is similar in functionality to the
  > Maple Text format in the File > Export As menu."*
  >
  > *"If the first argument worksheet is a string then it is treated as a filename. Otherwise, a
  > worksheet as an XML tree data structure is expected."*
  >
  > Notes: *"This command only fully supports worksheets. It may not work properly for Maple
  > documents with tables or components."*

  This is the **documented way to get readable 1-D source out of a `.mw`, including 2-D input**
  (which is otherwise opaque base64 — see `04-file-formats.md` §2.5). It produces **all** groups,
  in order, as one text blob; `includeoutput` additionally emits the stored outputs as
  `# out_1> …` comment lines. Getting **one** group still requires splitting (by XML node or by
  re-parsing the text).
* **`Worksheet:-ReadFile(filename, format=… )`** (`…?path=Worksheet/ReadFile`):
  > *"The ReadFile command parses a worksheet, returning an XML data structure that represents
  > the worksheet. … The parsed worksheet is converted to an XML data structure that can be used
  > with the XMLTools package. The XML document structure returned by this procedure is of type
  > Worksheet:-worksheet."*

  `format` is `"maple8_xml"` or `"mw"` (default `"mw"`). The help page's own element statistics is
  a useful confirmation of the vocabulary:
  `Styles=1,Task=1,Version=1,Label-Scheme=1,View-Properties=1,Worksheet=1,Hyperlink=5,Section=8,
  Title=10,Layout=33,Group=104,Input=104,Font=110,Text-field=146`.

Also: `Worksheet:-ToString(xmlTree, format="mws"|"maple8_xml"|"mw")`,
`Worksheet:-FromString`, `Worksheet:-Convert(worksheet, format=…)` (formats include `mapletext`,
`mw`, `workbook`, `procedure`, `jupyter`), `Worksheet:-WriteFile`, `Worksheet:-TableOfContents`
(Maple 2020+), `Worksheet:-WorksheetToJupyter` (Maple 2022+). See `04-file-formats.md` §5.2 for the
full command-by-command detail and version gates.

> ***UNVERIFIED (highest-value test):*** whether `Worksheet:-ReadFile/ToString/Convert/
> WorksheetToMapleText/WorksheetToJupyter` actually run under **command-line** `maple`/`cmaple` in
> 2018/2022. Only `Display` carries an explicit GUI prohibition; the others are pure XML/text
> manipulation and are documented under the "Connectivity : Web Features" help tree, which
> suggests server-side use. Nothing in the docs *guarantees* it. Test on the target install.

### 3.5 `read` — the documented way to feed a fragment into a live kernel

Help: `https://www.maplesoft.com/support/help/maple/view.aspx?path=read` (HELP-CUR):

```
read filename
read(filename, options)
```

> *"The read statement is used to read Maple language files into Maple."*
>
> *"If the file is in Maple language format, the statements in the file are read and executed as
> if they were being entered into Maple interactively, except that they are not echoed to the
> display unless interface(echo) is set to two or higher."*
>
> *"If an error occurs while evaluating the given file, the behavior of read is determined by the
> value of interface(errorbreak) and the propagateerrors option."*

Options: `encoding="utf-8"|"latin-1"` (*"The encoding option was introduced in Maple 2018."*) and
`propagateerrors=true|false` (*"introduced in Maple 2025"*, so **not** in 2018/2022).

**Consequences for group execution:**

* A fragment read with `read` (or typed at the prompt) executes in the **current kernel**, in
  file order, sharing all prior assignments — exactly the semantics a worksheet's groups assume.
* `.mpl` files are plain text, easy to generate; a **whole worksheet** can be linearised to an
  `.mpl` with `WorksheetToMapleText` and then `read`, but per-group you must split it yourself.
* The `.mw`→`.mpl` export can drop **statement terminators**: `04-file-formats.md` §5.4 warns that
  a worksheet saved with 2-D input and without explicit semicolons exports to `.mpl` without
  semicolons, which then fails in command-line Maple. If the MCP writes the `.mpl`, always end
  statements with `;`/`:`.

### 3.6 The practical route: extract the group, feed the kernel

This is the route the earlier researcher asked about, and it is the one every real external tool
uses (see `04-file-formats.md` §4.1: `mw2txt.py` — *"View Maple worksheets (.mw) from the command
line (without X)"*, usage `./mw2txt.py -m input.mw | /opt/maple15/bin/maple | less`).

**The XML shape you are extracting** (real Maple 2022.2 file; from `04-file-formats.md` §2.3):

```xml
<Group hide-input="false" labelreference="L23" drawlabel="true" applyint="true" ...>
  <Input><Text-field prompt="&gt; " style="Maple Input" layout="Normal">X := &lt;&lt;0,0,0&gt;|...&gt;;</Text-field>
  </Input>
  <Output><Text-field style="2D Output" layout="Maple Output"><Equation .../></Text-field></Output>
</Group>
```

* **One group = one `<Group>`**; its source = the text of `Group/Input/Text-field` whose `style`
  is `Maple Input` (attribute `prompt="> "` is cosmetic and must be ignored; XML entities must be
  unescaped).
* **`Group/@labelreference`** (e.g. `L23`) is the **internal label** consumed by
  `DocumentTools:-Retrieve`. That is the only “label” in the file. The worksheet-level
  `<Label-Scheme value="2" prefix=""/>` element is the display scheme, not a group index.
* **There are no group numbers in the file.** "Group *n*" can only mean "the *n*-th `<Group>` in
  document order" — and groups live inside `<Section>`s, so you must decide whether a section
  title counts as a boundary (`Worksheet:-TableOfContents` can enumerate sections, not groups).
* **2-D input is not externally readable.** Measured over 26 real worksheets, **190 of 566
  non-empty input regions (~34%) are 2-D-only**, and some real worksheets are 100% 2-D
  (`04-file-formats.md` §2.5). For those, the only documented lineariser is
  `Worksheet:-WorksheetToMapleText` (which works on the whole file). A regex/XML extractor
  silently yields an empty string for those groups — a correctness trap.
* Prefer `Worksheet:-ReadFile` (documented, supported) over hand-rolled parsing, and prefer
  `XMLTools` for traversal, exactly as the help page demonstrates.

**Semantic subtleties when you feed the extracted fragment to a kernel** (these are the real
answers to the earlier researcher's question 3):

1. **Shared kernel state.** Running group *k* alone against a fresh kernel is a *different
   computation* from pressing Enter on group *k* in the GUI, because earlier groups' assignments
   are absent. If you want "the state of the worksheet up to group *k*", run groups **1…k in
   order**. There is no dependency analysis available; the file does not record it.
2. **Execution order.** Groups execute top-to-bottom in **document order**. The GUI “execute
   whole worksheet” action is sequential; nothing in the file implies parallelism.
3. **`restart`.** If a group contains `restart`, it must be handled specially: *"The restart
   command only works at the top level. It cannot be executed within a procedure, or from a file
   being read by the read statement … It must be executed in a separate prompt (or line) from all
   other commands"* (`restart`, HELP-CUR). In a fragment-fed kernel, give `restart` its own line.
   A `restart` in group *k* invalidates all earlier-group state — exactly as in the GUI.
4. **Labels.** Equation labels are a **GUI/document** feature: *"The label is associated with the
   last output within an execution group and with all of the input in the execution group"*
   (`worksheet/expressions/equationlabels`, HELP-CUR). Feeding source to a bare kernel does not
   create equation labels in any file. If you need label→expression, you are back to
   `DocumentTools:-Retrieve`, which reads the **stored** output of a saved `.mw`.
5. **`Label-Scheme`.** A worksheet-level element (`<Label-Scheme value="2" prefix=""/>`), emitted
   as part of the fixed file prologue; it controls how labels are *displayed/renumbered*, not how
   groups are identified. **UNVERIFIED:** whether any headless API exposes it (none documented).
6. **Outputs are not updated.** The `<Output>` nodes hold Maple's saved 2-D/base64 renderings.
   Running the fragment in a kernel produces fresh *stdout* text; it does not rewrite the `.mw`.
   The persisted output and the recomputed result can therefore diverge — relevant if the MCP
   shows both.
7. **1-D vs 2-D input.** Only 1-D `Text-field` input is round-trippable externally
   (`04-file-formats.md` §2.5–2.6). If the MCP generates `.mw` content, it should emit 1-D
   `<Text-field style="Maple Input">` groups and let Maple do the typesetting.

**Suggested MCP-facing model** (composition of documented primitives):

```
list_groups(f.mw)      -> ordered [{index, labelreference?, source_1d?, is_2d_only, section}]
run_groups(f.mw, i..j) -> linearise (WorksheetToMapleText or ReadFile) or read raw XML
                          -> concatenate source of groups i..j (or 1..j for "prefix" mode)
                          -> feed to a kernel (see §4 / OpenMaple)
run_worksheet(f.mw)    -> DocumentTools:-RunWorksheet(path)   # whole file, new engine
get_by_label(f.mw,Ln)  -> DocumentTools:-Retrieve(path, Ln)   # expression only, not executed
```

### 3.7 Running a worksheet *by label* or *by group number* from the GUI-less command line

* **By group number:** impossible as a documented feature. There is no group number in the file
  format and no CLI option/API accepting one. Enumerate `Group` nodes yourself and index them.
* **By label:** the only mapping is `Group/@labelreference` (an internal `Lnn`) →
  `DocumentTools:-Retrieve`, which **returns the expression without executing it**. There is no
  "evaluate label" API. Labels are created in the GUI (*"use Insert>Reference in the Standard
  Worksheet Interface"*), so a `.mw` produced by a non-Maple writer may have no usable labels at
  all.
* **By worksheet-level “equation number”:** `Retrieve` deliberately does **not** use equation
  numbers (*"does not correspond to equation numbers"*).

### 3.8 Maple 2018 vs Maple 2022 deltas relevant to §3

| Item | 2018 | 2022 | Evidence |
|---|---|---|---|
| `Worksheet:-WorksheetToMapleText` | **yes** (introduced 2017) | **yes** | `04-file-formats.md` §5.2 |
| `Worksheet:-ReadFile` / `ToString` / `FromString` / `Convert` / `WriteFile` | yes | yes | HELP-CUR + `04-…` §5.2 |
| `Worksheet:-WorksheetToJupyter` | **no** | **yes** (introduced 2022) | `Worksheet/WorksheetToJupyter` Compatibility |
| `Worksheet:-TableOfContents`, `RemoveSection` | **no** (2020+) | yes | `04-file-formats.md` §5.2 |
| `Worksheet:-Display`/`DisplayFile` | GUI-only | GUI-only | `Worksheet/Display` |
| `read(..., encoding=…)` | introduced 2018 | yes | `read` Compatibility |
| `read(..., propagateerrors=…)` | **no** | **no** (2025+) | `read` Compatibility |
| `DocumentTools:-RunWorksheet` | exists | exists | Wayback 2019-12-10; exact parameter set **UNVERIFIED** |
| `DocumentTools:-Run` / `:-Evaluate` | never existed | never existed | HTTP 410 |

---

## 4. A persistent Maple process controlled from outside (request/response over stdin/stdout)

### 4.1 Does it read stdin continuously? Prompt? EOF? `-q`/`-t`?

**Yes, it is a REPL.** PG2018 §14.4 (p. 487), verbatim:

> "The command-line version of Maple is a simple interface that, when used interactively,
> displays an input prompt (>), runs commands, and displays the output as text-based results.
> You can use this interface in batch mode to direct input to an application, specify a text file
> to run, or evaluate a command using the -c option."

Official pipeline example (PG2018 §14.4 "Directing Input to a Pipeline", p. 488; identical text
in the 2021/2022-era Guide):

> "To avoid using the file system, input to the command-line interface can be directed to a
> pipeline. The following example shows how to perform this task at a command prompt.
> `echo "int(x,x);" | cmaple`"

**Prompt.** `interface` (HELP-CUR) documents `prompt` as `string or symbol`, *"The string that is
printed when user input is expected"*, default **`"> "`**. `-q` does **not** suppress it:

> "-q (quiet): The -q (quiet) option suppresses the printing of the Maple startup message, various
> informational messages (bytes used messages and garbage collection messages), and the signoff
> message. Maple is better suited for use as a filter when these messages are suppressed."
> — `maple` help

`interface(quiet=true)` **does** suppress it, together with other auxiliary printing:

> "quiet | true or false | An interface constant that will suppress all auxiliary printing (logo,
> garbage collection messages, bytes used messages, **and prompt**). | false"
> — `interface` help

**`-t` (test mode) is the best machine setting.** `maple` help, verbatim:

> "The -t (test mode) option causes Maple to change its configuration to one suitable for running
> the Maple test suite. Specifically, **the prompt is changed to "#-->"**, prettyprinting is
> disabled, and all but the last "bytes used" messages are suppressed. The final "bytes used"
> message is printed to stderr. This option is not normally needed by Maple users."

So `-t` gives you (a) a distinctive, unlikely-to-collide prompt, and (b) `prettyprint=0` for free.

**EOF.** By default the process exits at end of (redirected) stdin. `maple` help, verbatim:

> "-F (no filter): The -F (no Filter) option prevents Maple from exiting when the standard input
> has been redirected from a file, and the end of the file is encountered. By default, Maple
> exits. If -F is specified, Maple instead continues interactively at that point."

Related exit codes (same page): `0` normal; `3` *"After successfully reading a script specified
on the command line, Maple failed to re-open the standard input stream for interactive input.
This can happen only if the -F option was specified."* A long-lived server therefore just has to
**keep the write end of the pipe open**; `-F` matters only for the "run a script first, then
serve" pattern.

> ***UNVERIFIED:*** whether the prompt is printed when stdout is a **pipe** rather than a tty
> (the docs only describe the interactive case; `-t`'s `#-->` is likewise only documented as a
> prompt change). TeXmacs does not rely on the prompt on its pipes; SageMath/Emacs use a **pty**.
> Treat "prompt appears on a pipe" as untested and design for both.

**Building blocks if you want your own loop.** `readstat` (HELP-CUR) is documented for 2018/2022-era
CLIs (PG2018 "Interactive Input": *"The readline and readstat commands are also available for
interactive input … the readstat command reads the next statement from the terminal and returns
the value of that statement."*):

> "The function readstat reads the next statement from the input stream (the terminal or a file)
> and returns the value of that statement."
>
> "If an incomplete statement is entered, readstat will redisplay the prompt to allow further
> input. This will continue until a complete statement is entered."
>
> "If a syntax error is discovered, readstat will produce a syntax error message, and redisplay
> the prompt, expecting a new statement."
>
> "The readstat function always reads as many entire lines as needed to parse a complete
> statement. If the last line contains additional characters after the end of the complete
> statement, a warning is generated, and the remaining input is discarded. **Therefore, multiple
> statements per line are not permitted.**"

`readline` (HELP-CUR) is the line-oriented sibling and **documents its EOF sentinel**:

> "If there are no more lines left to read, readline returns 0 instead of a string to indicate
> that the end of the file has been reached."

> ***UNVERIFIED:*** `readstat`'s return value at EOF is not documented. A `readline`-based driver
> loop is the safer primitive if you build your own protocol. Also note `readline(default)` reads
> from the current input stream, and *"readline(-1) is similar to readline(default), except that
> the Maple input preprocessor is invoked."*

### 4.2 stdout buffering on a pipe, and flushing

**No documented stdout-flush primitive exists.**

* The complete `interface` variable table (HELP-CUR) contains **no `flush`** variable. (Checked
  the full list; `flush` does not appear.)
* The `kernelopts` page (HELP-CUR) contains **no `flush`** either.
* The two documented flush functions target **files**, not the default/terminal stream:

> "fflush(file …) — Ensures that any output which has been written to the specified file, which is
> assumed to have been opened either implicitly or by fopen or popen, is actually written to
> disk." — `fflush` help (fetched from **cn.maplesoft.com**; same content on `www.`)

> "The Flush(file1, file2, …) command ensures that output, which has been written to the specified
> files that are assumed to have been opened either implicitly, by Text[Open] or by
> Binary[Open], is written to disk." — `FileTools/Flush` help

`file_types` (HELP-CUR) says the special names `'default'` and `'terminal'` refer to **DIRECT**
files ("direct access to Maple's current (default) or top-level (terminal) input or output
stream"), and `fopen` says they "refer to the current and top-level input or output streams".
Neither `fflush` nor `FileTools:-Flush` lists DIRECT files, so **`fflush(default)` /
`fflush(0)` is UNVERIFIED** (it may work, it is not documented).

**Whether Maple's stdout is line- or block-buffered when it is a pipe is UNVERIFIED** — it is
nowhere documented. The practical evidence is:

* The community answer on Stack Overflow (Alex Martelli) explicitly warns about it:
  > "Trying to drive a subprocess "interactively" more often than not runs into issues with the
  > subprocess doing some buffering, which blocks things. That's why for such purposes I suggest
  > instead using pexpect (everywhere but Windows: wexpect on Windows), which is designed exactly
  > for this purpose — letting your program simulate (from the subprocess's viewpoint) a human
  > user typing input/commands and looking at results at a terminal/console."
* **SageMath** drives Maple through a **pseudo-terminal** (`pexpect.spawn`), so the child sees a
  terminal.
* **Emacs `inferior-maple-mode`** runs `maple` via `comint` (also a pty) and syncs on the `^> `
  prompt regex.
* **TeXmacs** does drive Maple over **plain pipes** (`pipe()` + `dup2`), and it works by reading
  until an explicit `printf` sentinel — empirical evidence that statement-boundary output does
  reach a pipe (see §4.3).
* **Old `maplev`** (pre-3.0) drove `cmaple` over a process and used an `lprint` sentinel; the
  current `maplev` 3.x abandoned that for a custom **OpenMaple** binary (`pmaple`) whose C code
  calls `fflush(NULL)` — "The NULL means flush all open output streams" (`pmaple.nw`).

**Recommendation.** Do not bet on line flushing. Either (a) give the child a **pty**
(Linux/macOS: `pty`/`pexpect`; Windows: ConPTY/`winpty`, or a Python pty emulation), or (b) keep
plain pipes but bound every read with a **timeout** and sync on an **explicit sentinel** the
kernel prints, and never assume partial output is complete.

### 4.3 Known request/response idioms in real code

#### (a) Prompt-sentinel: `maple -t` and expect `#-->` (SageMath, 2005 → today)

`src/sage/interfaces/maple.py` (`https://github.com/sagemath/sage/blob/develop/src/sage/interfaces/maple.py`),
verbatim:

```python
__maple_iface_opts = [
    'screenwidth=infinity',
    'errorcursor=false']
__maple_command = 'maple -t -c "interface({})"'.format(
    ','.join(__maple_iface_opts))
# errorcursor=false avoids maple command line interface to dump
# into the editor when an error occurs. Thus pexpect interface
# is not messed up if a maple error occurs.
# screenwidth=infinity prevents maple command interface from cutting
# your input lines. ...
Expect.__init__(self,
                name='maple',
                prompt='#-->',
                command=__maple_command,
                ...
                restart_on_ctrlc=False,
                verbose_start=False,
                logfile=logfile,
                eval_using_file_cutoff=2048)
```

Sage launches with `-t` precisely so that the child prints `#-->`, then synchronises with
`E.expect(self._prompt)` after each line it sends. Interrupts are done by **sending Ctrl-C into
the pty and re-expecting the prompt**:

```python
def _keyboard_interrupt(self):
    print(f"Interrupting {self}...")
    self._expect.sendline(chr(3))  # send ctrl-c
    self._expect.expect(self._prompt)
    raise RuntimeError("Ctrl-c pressed while running %s" % self)
```

and shutdown is the bare keyword statement (`_quit_string` returns `'quit'`).

The same idiom appears in the accepted Stack Overflow answer
(`https://stackoverflow.com/questions/2053231/grabbing-the-output-of-maple-via-python/2059211`),
verbatim:

```python
import pexpect
MW = "/usr/local/maple12/bin/maple -tu"
X = '1+1;'
child = pexpect.spawn(MW)
child.expect('#--')
child.sendline(X)
child.expect('#--')
out = child.before
out = out[out.find(';')+1:].strip()
out = ''.join(out.split('\r\n'))
print out
```

plus the note: *"This approach has the advantage of keeping a connection open to MAPLE for future
computation."* (`-tu` = test mode + UNIX line endings; `-u` is *"UNIX line endings"*, **not**
"unbuffered" — `maple` help.)

#### (b) Explicit `printf` sentinel over plain pipes (TeXmacs)

`plugins/maple/src/tm_maple_5.cpp` (`https://github.com/texmacs/texmacs`, path
`plugins/maple/src/tm_maple_5.cpp`; built into `bin/tm_maple_5` by `plugins/maple/Makefile`).
This is the most complete open-source example of a *plain-pipe* Maple driver, and it is
instructive in almost every dimension:

* Launch: `fork()`, child does `setsid()`, `dup2` of two pipes onto stdin/stdout, **stderr merged
  into stdout** (`dup2 (STDOUT, STDERR);`), then `execve (maple_bin, argv, environ)` with
  `argv = {"maple", "-q", NULL}`.
* Init: `send ("interface(errorbreak=0,screenheight=9999):\n");` and `read
  "$TEXMACS_PATH/plugins/maple/maple/init-maple.mpl"`.
* **Request framing with markers**, verbatim:

```cpp
void maple_input () {
  string input= get_line ();
  send ("printf(`tmstart\\n`):\n");
  ...
  send ("printf(`tmend\\n`):\n");
}
```

  and the reader waits for the exact output line `tmend`:

```cpp
if (outbuf[i]=='\n') {
  if (output == "tmstart\n")      show_flag= true;
  else if (output == "tmend\n") { next_input (); cout << DATA_END; cout.flush (); return; }
  else if (show_flag)           { cout << output; cout.flush (); }
  output= string ();
}
```

* Result capture: it wraps user input so the *displayed* result is re-printed (`tmresult :=
  tmdummy:` … `if "" <> tmdummy then tmprint("") fi:`), and detects errors by `ends(output,
  "error")`.
* Interrupt / teardown: `maple_interrupt` does `killpg (pid, sig)`; on child EOF it does
  `killpg (pid, SIGKILL)`.

This is a working existence proof for a **pipe-only** protocol; it also shows the cost: the
wrapper is a non-trivial C program that owns framing, error detection and process groups.

#### (c) `lprint` sentinel over `cmaple` (old `maplev`, Emacs)

The pre-3.0 `maplev` (mirrored in `manateelazycat/lazycat-emacs`, `site-lisp/extensions/lazycat/
maplev.el`) used `cmaple` plus a marker, verbatim:

```elisp
(defcustom maplev-cmaple-end-notice "END_OF_OUTPUT"
  "*Message used to indicate the end of Maple output." ...)

(defun maplev-cmaple--send-end-notice (process)
  "Send a command to PROCESS \(cmaple\) to print `maplev-cmaple-end-notice'."
  (comint-simple-send process (concat "lprint(" maplev-cmaple-end-notice ");")))

(defun maplev-cmaple--ready (process)
  ...
  (when (re-search-backward (concat maplev-cmaple-end-notice "\n") nil t)
    (delete-region (match-beginning 0) (match-end 0)) ...))
```

i.e. after each submission it appends `lprint(END_OF_OUTPUT);` and considers the request finished
when the literal line `END_OF_OUTPUT` appears in the output.

#### (d) Emacs `comint` + prompt (current `inferior-maple-mode`)

`https://github.com/jmbr/inferior-maple-mode` (`inferior-maple-mode.el`), verbatim:

```elisp
(defcustom inferior-maple-program "maple" ...)
(defcustom inferior-maple-prompt "^> "
  "Regular expression to match the Maple prompt." ...)
(defcustom inferior-maple-init-string "interface(ansi=false, screenheight=infinity):" ...)
...
(setq comint-process-echoes t
      comint-prompt-regexp inferior-maple-prompt)
```

This is the cheapest wrapper shape: a pty + `interface(ansi=false, screenheight=infinity)` + a
`^> ` prompt regex.

> **Note on the *current* `maplev` (3.x).** It no longer drives the CLI at all. Its README states:
> *"To interact with the Maple engine, display help pages, and view library procedures, the
> **pmaple** binary executable is required; this is a change from pre 3.0 versions of MapleV which
> used cmaple, a part of the Maple distribution. The pmaple binary can be compiled from source
> using Maple's **OpenMaple** package."* `pmaple.nw` shows an `StartMaple(...)` callback program
> that ends each interaction with `fflush(NULL);` — *"The NULL means flush all open output
> streams."* It frames requests with a **NUL byte** (`maplev-cmaple--send-string` appends
> `(string ?\0)`: *"the null character is the delimiter used by pmaple"*) and sets
> `process-connection-type 'pty`. This is the strongest signal that a mature tool eventually
> abandons CLI stdout parsing for OpenMaple.

#### (e) Recommended protocol shape for the MCP server

Compose only documented primitives:

```text
start:   maple -q -t          # #--> prompt, prettyprint off, quiet banner
                            #  (keep stdin open; no -F needed unless you run a script first)
pty:     yes (best) | plain pipes + sentinel + read timeouts (acceptable)
prologue:
    interface(ansi=false): interface(echo=0): interface(prettyprint=0):
    interface(printbytes=false): interface(warnlevel=0): interface(errorbreak=0):
per request (id = unique token):
    printf("MAPLE_BEGIN_%s\n", id):            # optional
    try
      <user statement(s), each terminated with ; or :>
    catch:
      printf("MAPLE_ERR_%s %s\n", id, <escaped message>):
    end try:
    printf("MAPLE_END_%s\n", id):
read:    until the exact MAPLE_END_<id> line (or the #--> prompt) arrives; strip prompts;
         treat output as opaque; surface anything matching /^Error,/
bounds:  wrap user work in timelimit(N, …); backstop with kernelopts(cpulimit=…) / -T
kill:    SIGINT to the process group → wait → SIGTERM → SIGKILL (start the child in its own
         session/process group)
restart: send `restart:` on its own line (it "must be executed in a separate prompt (or line)")
```

Notes: `interface(prettyprint=0)`/`-t` keeps results 1-D; `printf("%a", expr)` or `lprint(expr)`
is the reliable per-value serialisation (`01-cli-batch.md` §2.6). Do **not** set
`interface(quiet=true)` if you use the prompt as the delimiter; do set it if you use explicit
sentinels and want zero prompt noise.

### 4.4 Error recovery, end-of-output, and `quit`/`done`/`stop` in the stream

**Error recovery.** `interface(errorbreak)` (HELP-CUR), verbatim:

> "interface(errorbreak=0) — When reading from the user, reading and processing continues after
> any error. When reading a redirected file from stdin (UNIX), reading and processing of the file
> continues after any error. When reading from a file through the "read" command, reading and
> processing of the file continues after any error."
>
> "interface(errorbreak=1) — When reading from the user, reading and processing continues after
> any error. When reading a redirected file from stdin, reading and processing of the file
> continues after any computation error, but stops after any syntax error. …"
>
> "interface(errorbreak=2) — When reading from the user, reading and processing continues after
> any error. When reading a redirected file from stdin, reading and processing of the file stops
> after any error. …"
>
> "interface(errorbreak=3) — The behavior is the same as for interface(errorbreak=2), except that
> a tracelast command is issued to display a trace of the Maple function stack."

CLI equivalents (`maple` help, verbatim):

> "-e0 tells Maple to report the error and keep reading the file. -e1 (the default) tells Maple to
> stop reading the file (and to skip to the end) when a syntax error is encountered. Both -e2 and
> -e3 tell Maple to stop reading and to skip to the end when any type of error is encountered. In
> addition, -e3 will also print a Maple function stack trace after the error. This behavior can
> also be changed in Maple by using the command interface(errorbreak = n) where n is 0, 1, 2, or 3."

**Key nuance:** *"When reading from the user, reading and processing continues after any error"*
for **all** values — the errorbreak settings only bite for **redirected stdin** and `read`.
Whether a **pipe** counts as "a redirected file from stdin (UNIX)" or as "the user" is
**UNVERIFIED**. Since `errorbreak=0` is safe in both interpretations, set it (TeXmacs does).
`-e0` is the corresponding command-line flag for scripted runs.

**End-of-output detection.** Reliable options, in order of preference:

1. **Distinctive prompt** with `-t` (`#-->`) — SageMath's approach; requires that the prompt
   actually be emitted (pty guarantees it).
2. **Explicit marker statement** — `printf("MAPLE_END_<id>\n"):` or `lprint(END_OF_OUTPUT);`
   (old `maplev`); robust to prompt suppression, needs output to be flushed (plain pipes —
   TeXmacs shows it works, but bound the read with a timeout).
3. **Read bounded by the prompt regex** (`^> `) — Emacs `comint`.

Do **not** rely on "output stopped arriving" (that is exactly the buffering failure mode), and do
not treat the absence of `Error,` as success if `errorbreak` is 1 and a syntax error killed the
stream.

**`quit` / `done` / `stop` inside the stream.** From the `quit` help page (`01-cli-batch.md` §5.1
quotes it in full): they are synonyms, terminate the Command-line session, and the function form
`` `quit`(n) `` sets the return status (0–255; non-integer/out-of-range raises an exception and
*"Maple will not terminate"*). They are **language keywords** and nothing documents trapping them
(the `interface(errorbreak)` page never mentions them). `restart` cannot be used to unload them,
and the debugger is not a way to catch them.

**Practical consequence for an MCP server:** a client that sends `quit;` (or an assignment that
happens to evaluate to a top-level `quit`) will kill the session. Either (a) sanitize the input
(reject statements whose parsed form is a bare `quit`/`done`/`stop`, and prefer
`parse`+`eval` inside `try` for evaluation), or (b) accept it and **respawn** — the documented
startup cost is only ~0.1 s (PG2018 §14.4: *"Starting the Maple command-line interface,
automatically executing a command file, and stopping the Maple session can take about one tenth of
a second"*). State loss on respawn is usually acceptable for a CAS tool.

### 4.5 Startup/shutdown, state, timeouts, and killing a runaway

**`restart`** (HELP-CUR), verbatim:

> "The restart command causes the Maple kernel to clear its internal memory so that Maple acts
> (almost) as if just started."
>
> "On restart, the Maple kernel returns most of the memory it has allocated to the operating
> system. …"
>
> "The settings of all identifiers (variables and procedures) are reset, libname is reset to its
> initial state, names read from any repositories are marked as unread, and then the Maple
> initialization files are reread."
>
> "Shared libraries loaded for external_calling are unloaded on restart. The Java Virtual Machine
> that is started for Java external calling is terminated on restart."
>
> "The restart command only works at the top level. It cannot be executed within a procedure, or
> from a file being read by the read statement; this would cause Maple to be in an inconsistent
> state. It must be executed in a separate prompt (or line) from all other commands, since all
> commands in a prompt are passed to the kernel at once …"
>
> "When Command-line Maple is started with the -c option, the specified commands are re-executed
> after a restart."

So: use `restart` for a clean slate; it is *not* free (it re-reads init files and drops JVM/loaded
libraries), and interface options are reset — which is why `-c "interface(…)"` (re-executed after
`restart`) or re-sending the prologue after every `restart` is the right pattern. Give `restart`
its **own line**. Whether `-i` files are re-read on `restart` is **UNVERIFIED** (the page says
"the Maple initialization files are reread"; `-i` files are defined as *additional* ones).

**Timeouts.** `timelimit(N, expr)` is the only *catchable* limit: PG2018 §16.6 / `timelimit`
help — PG2018: *"If the time limit is reached before the expression is evaluated, timelimit raises
an exception"*, with the error string **`time expired`** (`01-cli-batch.md` §5.3 has the verbatim
official `try/catch "time expired"` example). `kernelopts(cpulimit=…)`, `datalimit`, `stacklimit`
are *hard* limits: *"once one of these limits is reached, Maple may shut down without warning"*
(PG2018 §16.6). `-T cpu,data,stack,core` applies OS rlimits at startup. Belt and braces: wrap in
`timelimit`, set `kernelopts(cpulimit)`, and pass `-T`.

**Interrupting from outside.** The command-line interface documents Ctrl+C:

> `Ctrl + C` — "Interrupt the Currently Executing Command" — *Keyboard Shortcuts for Command-Line
> Maple* (`…?path=commandline/reference/shortcutkeys`)

PG2018 warns it is best-effort: *"Maple may not always respond immediately to an interrupt request
if it is performing a complex computation."* SageMath implements it as **write `chr(3)` to the
pty and wait for the prompt**, then raises. For an MCP server: send SIGINT to the **process
group**, wait briefly for the prompt (or for the session to die), then escalate to SIGTERM and
SIGKILL. TeXmacs' `maple_interrupt` does `killpg(pid, sig)` and its EOF path does
`killpg(pid, SIGKILL)`.

**Process tree — why the process group matters.** PG2018 §14.4, verbatim:

> "In Windows, the command-line interface is called cmaple.exe. You can run this file from either
> the bin.win or bin.X86_64_WINDOWS directory of your Maple installation, depending on your
> platform. On other platforms, you can start the command-line interface by running the **maple
> script** located in the bin directory of your Maple installation."

and PG2018 §14.3 shows the same launcher being used purely for environment setup:

```
#!/bin/sh
export MAPLE="/usr/local/maple"
. $MAPLE/bin/maple -norun
```
> "These commands run the **maple launch script** to configure your environment without starting
> Maple."

Real-world confirmation that the script dispatches to a versioned binary: TeXmacs'
`plugins/maple/Makefile` rewrites the shipped script with
`sed 's%$${MAPLE}/$$MAPLE_SYS_BIN/cmaple%…%'`, and a TeXmacs forum post notes *"maple is a shell
script that reads in `$MAPLE/bin/maple.system.type`"*. The versioned bin dir is
`$MAPLE/bin.$SYS` (e.g. `bin.X86_64_LINUX`); `kernelopts(bindir)` reports it.

> ***UNVERIFIED:*** whether the Linux `maple` script `exec`s the kernel (so signals reach it
> directly) or spawns it as a child. I found no published script body or `pstree` transcript.
> **Design assumption:** the PID you spawn may be a wrapper shell — start the child in its **own
> session/process group** (`setsid` / `start_new_session=True` / Windows Job Object) and signal
> the **group**, exactly as TeXmacs does. Verify on the target install with `pstree -p`.

**Windows caveat.** `cmaple.exe` is a real executable (not a shell script), but there is no
POSIX process group; use a Windows Job Object or `taskkill /T /F` to take down the tree.
**UNVERIFIED** for 2018/2022 details.

### 4.6 Documented alternatives to a CLI request/response protocol

* **OpenMaple (in-process).** A C API (and Java/.NET bindings) that links the Maple engine into
  your process — no stdin/stdout framing, no prompt parsing, no buffering question. See
  `02-openmaple-c.md` and `03-openmaple-java-dotnet.md`. This is what current `maplev` (`pmaple`)
  uses. The cost is a native build and a library-path setup.
* **Maple Kernel for Jupyter (new in Maple 2022).** Official, bundled with Maple:
  *"The new Maple Kernel for Jupyter is a program bundled with Maple which allows Maple to be used
  as the computation engine in a session of the Jupyter computation environment."* (Maple 2022
  New Features, *Connectivity*, p. 2). Help: *"Configuring the Maple Kernel for Jupyter is
  required to make Maple available as a kernel within a Jupyter session"* — generate config with
  `Jupyter[GenerateKernelConfiguration](somepath)` then `jupyter kernelspec install
  somepath/maple` (`…?path=Jupyter/MapleKernel/Configuring`). It *"connects to Maple using the
  OpenMaple C API"* (`…?path=Jupyter/MapleKernel`) and, per the same help tree, *"uses the REPL
  (Read, Evaluate, Print, Loop) paradigm"*. **Not available in Maple 2018**; no separate public
  GitHub repo was found — it ships inside licensed Maple. See `03-openmaple-java-dotnet.md` §5.1.
* **GUI-less REPL.** The command-line `maple`/`cmaple` *is* the documented GUI-less REPL; `maple
  -t` is the closest thing to a protocol-friendly mode. There is no separate "server mode".

### 4.7 What I would actually build (summary)

1. **Primary:** OpenMaple (Java or C) or the Maple Jupyter kernel if the target install allows —
   it removes every §4.2–§4.4 failure mode.
2. **Fallback (pure external process):** `maple -q -t` (prompt `#-->`, prettyprint off) on a
   **pty**, prologue with `interface(ansi=false, echo=0, printbytes=false, warnlevel=0,
   errorbreak=0)`, one request per statement, sync on the `#-->` prompt **and** a
   `printf` sentinel, `timelimit` around user code, `restart` on its own line, process-group
   SIGINT→SIGTERM→SIGKILL on timeout, respawn on death (~0.1 s).
3. **Partial worksheet execution:** parse with `Worksheet:-ReadFile` when available
   (**UNVERIFIED** in CLI) or defensive XML, list groups in document order using
   `Group/Input/Text-field[style="Maple Input"]` and `Group/@labelreference`, use
   `Worksheet:-WorksheetToMapleText` to linearise 2-D input, and execute **prefixes** (1…k) for
   faithful state. Use `DocumentTools:-RunWorksheet` for whole-file, new-engine runs, and
   `DocumentTools:-Retrieve` only for label→expression lookup.

---

## 5. Explicit open questions / UNVERIFIED items (this file)

1. Whether `Worksheet:-ReadFile/ToString/Convert/WorksheetToMapleText` run under command-line
   `maple`/`cmaple` in 2018 and 2022 (only `Display` is explicitly GUI-prohibited). **Highest
   value test.**
2. Whether the `#-->` prompt (or the `"> "` prompt) is emitted when stdout is a **pipe** rather
   than a pty, in 2018/2022.
3. Whether a **pipe** counts as "reading from the user" or as "a redirected file from stdin" for
   `interface(errorbreak)` purposes.
4. Whether stdout is line- or block-buffered on a pipe, and whether `fflush(default)` /
   `fflush(0)` flushes it (the documented `fflush`/`FileTools:-Flush` cover file streams, not
   DIRECT streams).
5. `readstat`'s return value at EOF (documented for `readline` — returns `0` — not for `readstat`).
6. `DocumentTools:-RunWorksheet`'s exact parameter set in Maple 2018 vs Maple 2022 (the live page
   only records "updated in Maple 2025"; the 2019-12-10 archive proves the command existed).
7. Whether the Linux `maple` launcher script `exec`s the kernel (signals) or leaves a wrapper
   process; the exact script body / process tree for 2018/2022.
8. Whether `-i` initialization files are re-read by `restart`, and how expensive a `restart` is
   in practice on the target install.
9. Whether a `.mw` written by Maple 2022 opens in Maple 2018 (and vice versa) — relevant when a
   single MCP server must serve both.
10. Whether equation labels / `Group/@labelreference` survive (or are regenerated) after an
    external edit that inserts groups — not documented.

---

## Sources

**Official Maplesoft — online help.** All under `https://www.maplesoft.com/support/help/maple/view.aspx?path=`
unless noted; live pages reflect **Maple 2026** unless a version is stated.

* `maple` (launchers, `-q`, `-s`, `-i`, `-t`, `-u`, `-F`, `-e`, exit codes):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=maple
  (archived 2018-06-01: https://web.archive.org/web/20180601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple ;
  archived 2022-06-01: https://web.archive.org/web/20220601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple)
* `interface` (`prompt`, `quiet`, `errorbreak` 0–3, `echo`, `prettyprint`; **no** `flush`):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=interface
* `Worksheet` package overview (command list; "storage format … not documented"):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet
* `Worksheet/WorksheetToMapleText`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText
* `Worksheet/ReadFile`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FReadFile
* `Worksheet/ToString`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FToString
* `Worksheet/Display` ("cannot be used in the Command-line version"):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay
* `Worksheet/WorksheetToJupyter` (introduced Maple 2022):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter
* `DocumentTools` overview (command list; no `Run`/`Evaluate`):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools
  (`path=DocumentTools,Run` and `path=DocumentTools,Evaluate` → HTTP 410 "Help Document not found")
* `DocumentTools/RunWorksheet`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRunWorksheet
  (archived 2019-12-10:
  https://web.archive.org/web/20191210010501/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools/RunWorksheet)
* `DocumentTools/Retrieve`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRetrieve
* `read`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=read
* `readstat`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=readstat
* `readline`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=readline
* `fopen` (`'default'`/`'terminal'`):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=fopen
* `file_types` (STREAM buffered vs DIRECT):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=file_types
* `fflush` (**cn.maplesoft.com** mirror used):
  https://cn.maplesoft.com/support/help/Maple/view.aspx?path=fflush&cid=474
* `FileTools/Flush`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=FileTools%2FFlush
* `restart`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=restart
* `quit` / `done` / `stop`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=quit
* `timelimit`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=timelimit
* `kernelopts` (resource limits; **no** `flush`):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=kernelopts
* Using Equation Labels (label ↔ execution group):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fexpressions%2Fequationlabels
* Keyboard Shortcuts for Command-Line Maple (Ctrl+C):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=commandline/reference/shortcutkeys
* Jupyter package / Maple Kernel for Jupyter:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Jupyter%2FMapleKernel ,
  https://www.maplesoft.com/support/help/maple/view.aspx?path=Jupyter%2FMapleKernel%2FConfiguring
* Maple 2022 New Features — *Connectivity* (PDF; "The new Maple Kernel for Jupyter is a program
  bundled with Maple"):
  https://www.maplesoft.com/products/maple/new_features/Maple2022/PDFs/Connectivity.pdf
  (mirror used: https://jp.maplesoft.com/products/maple/new_features/Maple2022/PDFs/Connectivity.pdf)
* Maple 2018 Programming Guide (PDF), §14.4 The Maple Command-line Interface, §14.3 OpenMaple,
  §16.6 Managing Resources:
  https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf
  (mirror used: https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf)
* Programming Guide linked by Maplesoft as the Maple 2022 guide (© 1996-2020):
  https://www.maplesoft.com/documentation_center/maple2021/ProgrammingGuide.pdf

**Real code (all fetched and read; verbatim snippets above):**

* SageMath — `src/sage/interfaces/maple.py` (`maple -t`, prompt `#-->`, Ctrl-C, `quit`):
  https://github.com/sagemath/sage/blob/develop/src/sage/interfaces/maple.py
* SageMath — `src/sage/interfaces/expect.py` (prompt-sentinel synchronisation):
  https://github.com/sagemath/sage/blob/develop/src/sage/interfaces/expect.py
* TeXmacs — `plugins/maple/src/tm_maple_5.cpp` (`maple -q`, `printf(\`tmstart\`/\`tmend\`)`
  sentinels, `interface(errorbreak=0,…)`, `setsid`, `killpg`, stderr→stdout):
  https://github.com/texmacs/texmacs/blob/svn_mirror/plugins/maple/src/tm_maple_5.cpp
  (build rule: https://github.com/texmacs/texmacs/blob/svn_mirror/plugins/maple/Makefile )
* TeXmacs — `plugins/maple/maple/init-maple.mpl`:
  https://github.com/texmacs/texmacs/blob/svn_mirror/plugins/maple/maple/init-maple.mpl
* `maplev` (Emacs), version 3.x — README ("pmaple … compiled … using Maple's OpenMaple
  package"; a change from pre-3.0 which used `cmaple`):
  https://github.com/JoeRiel/maplev
  and `pmaple/pmaple.nw` (`StartMaple(...)`, `fflush(NULL)`):
  https://github.com/JoeRiel/maplev/blob/master/pmaple/pmaple.nw
* Old `maplev` (`lprint(END_OF_OUTPUT);` sentinel over `cmaple`), mirrored copy:
  https://raw.githubusercontent.com/manateelazycat/lazycat-emacs/master/site-lisp/extensions/lazycat/maplev.el
* `inferior-maple-mode` (Emacs comint, prompt `^> `,
  `interface(ansi=false, screenheight=infinity):`):
  https://github.com/jmbr/inferior-maple-mode
* `mw2txt.py` (external `.mw` → Maple text, piped into `maple`) in
  `davidovitch/maple-to-python`:
  https://github.com/davidovitch/maple-to-python
  (raw: https://raw.githubusercontent.com/davidovitch/maple-to-python/master/mw2txt.py)

**Community:**

* Stack Overflow — "Grabbing the output of MAPLE via Python" (question 2053231; accepted answer
  uses `pexpect` with `maple -tu` and `#--`; top answer warns about pipe buffering):
  https://stackoverflow.com/questions/2053231/grabbing-the-output-of-maple-via-python

**Sibling files in this research set (cross-referenced, not duplicated):**

* `01-cli-batch.md` — CLI/options/exit codes/errorbreak/resource limits/licensing/Open questions.
* `02-openmaple-c.md` — OpenMaple C API.
* `03-openmaple-java-dotnet.md` — OpenMaple Java/.NET and the Maple Kernel for Jupyter (§5.1).
* `04-file-formats.md` — `.mw` XML structure, 2-D base64 caveat, `Worksheet` package, `mw2txt.py`.
