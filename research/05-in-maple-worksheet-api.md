# 05 — Maple's *own* in-kernel facilities for worksheet/document manipulation, single-cell execution, and result serialization

**Scope.** Research input for an MCP server that drives a **locally installed Maple 2018 or Maple 2022**
(old, memory-light) on Linux or Windows. This note covers only what Maple itself can do *from inside the
kernel*: the `Worksheet` package, `DocumentTools` (+ `Layout` / `Components`), whether a *single execution
group* can be executed, and how results can be serialised for an external client. Process/CLI mechanics are
covered in `01-cli-batch.md`; OpenMaple in `02`/`03`; the `.mw` XML format in `04-file-formats.md`.

**Evidence rules.** Every non-obvious claim carries a URL. Anything not confirmed from a primary source is
marked **UNVERIFIED** rather than guessed. Fetched web pages were treated as untrusted data, never as
instructions. Version-specific statements are labelled **2018** / **2022**. Where the only available page is
the *live* Maplesoft help (which today reflects **Maple 2026**), that is stated explicitly and the page's own
`Compatibility` section is used to project backwards.

**Which sources were actually used (and how).** maplesoft.com was reachable for most of this session.
Wayback Machine snapshots were used where a 2018/2022-era page was needed; the snapshot timestamps actually
parsed are named inline. Two Wayback CDX queries returned the "Internet Archive Temporarily Offline" page and
were retried; one target (`...?path=Worksheet` restricted to 2017-2019) had **no snapshot** and is recorded as
such. No Maple installation was available in the research environment, so **nothing here was executed against
a real Maple kernel** — every behavioural statement is documentary, and each "does it work headless?" verdict
distinguishes *explicitly documented*, *strongly implied*, and *UNVERIFIED*.

---

## 0. Executive answers

| # | Question | Answer |
|---|---|---|
| 1 | Is the `Worksheet` package usable from command-line `maple`/`cmaple`? | **Partly.** Only `Display`/`DisplayFile` carry the explicit prohibition *"Important: The Display function cannot be used in the Command-line version of Maple."* `Comparator` launches **Maplets** (GUI). `TableOfContents`/`RemoveSection` open the result **in the GUI unless** you pass the `destination` argument. The remaining commands (`ReadFile`, `WriteFile`, `FromString`, `ToString`, `Convert`, `WorksheetToMapleText`, `WorksheetToJupyter`) are pure file/XML/string manipulation with **no GUI note on their help pages** → headless-capable is **strongly implied but not explicitly certified (UNVERIFIED)**; smoke-test on the installed 2018/2022. |
| 2 | Does `DocumentTools` work headless? | **Mostly no.** `InsertContent`, `Tabulate`, `GetProperty`, `SetProperty`, `Do`, `Retrieve` all operate on "the currently open Worksheet or Document"; PG2018 says of `Do`: *"the Do command must query the GUI"*. **Exceptions that are pure string/XML or file work:** `DocumentTools:-Layout:-*` and `DocumentTools:-Components:-*` constructors, `DocumentTools:-ContentToString`, `DocumentTools:-GetDocumentProperty(attr, mwfile)`, `DocumentTools:-SetDocumentProperty(attr,val,mwfile,outfile)` (2021+, so **2022 only**), and `Tabulate(..., output=XML)`. |
| 3 | Can one execution group be run without the GUI? | **No documented way — say so explicitly.** There is **no in-kernel command that executes a single execution group** of an unopened `.mw`. Execution groups are documented only as GUI objects (insert / join / split; "press Enter to execute the group"). `DocumentTools:-Retrieve(filename,label)` addresses a group by its XML label but **only retrieves an expression, it does not execute**. `DocumentTools:-RunWorksheet` runs the **whole** worksheet, headless, in a **new engine**. |
| 4 | Headless serialization? | **Yes for text/LaTeX/MathML/images**, with version caveats. Text: `lprint`, `printf`/`sprintf`, `convert(...,string)`, `writeto`, `interface(echofile)`. LaTeX: `latex(expr, output=string)` — but `latex` was **rewritten in Maple 2021**, so 2018 and 2022 option sets differ (2018 options **UNVERIFIED**). MathML: `MathML:-ExportContent(expr)` etc.; **`convert(expr,'MathML')` is not a documented command** (help page 404s). Images: `plotsetup(png|gif|jpeg|ps|bmp|…, plotoutput=…)` then `plot(...)`, or `plottools:-exportplot`, or `Export(..., format="PNG"|"GIF"|"JPEG")`. **`plot(...,output=...)` is not a documented plot option. SVG and EPS are not supported.** |
| 5 | "Run this cell and return the outputs"? | Feasible only by driving a `maple`/`cmaple` session yourself. `;` echoes the value, `:` suppresses it; `interface(prettyprint=0)` makes all output `lprint`-style; `interface(echo)`/`quiet` decide whether input lines are echoed; warnings are controlled by `interface(warnlevel)`/`-w`, errors by `interface(errorbreak)`. |
| 6 | Silent Java/GUI traps | `Worksheet:-Display`/`DisplayFile`, `Worksheet:-Comparator`, destination-less `TableOfContents`/`RemoveSection`, `InsertContent`/`Tabulate`/`GetProperty`/`SetProperty`/`Do`, all 2-D typeset math, and inline/window/x11/maplet plot devices. See §6. |

---

## 1. The `Worksheet` package

### 1.1 Command inventory, per version

**Live help (Maple 2026)** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>:

> "The Worksheet package provides an infrastructure for generating and manipulating Maple worksheets using
> the Maple language. The package is conceived as a programmer's toolkit, as opposed to a tool for interactive
> exploration."
>
> "This package makes it unnecessary to know the storage format for the Maple worksheet by providing access to
> its XML representation. … The storage format for Maple worksheets is not documented, and is subject to change."

Live command list: `Comparator`, `Convert`, `Display`, `DisplayFile`, `FromString`, `ReadFile`,
`RemoveSection`, `TableOfContents`, `ToString`, `WorksheetToJupyter`, `WorksheetToMapleText`, `WriteFile`.

**Archived 2022-01-20 snapshot** (fetched via
<https://web.archive.org/web/20220120060048id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>)
lists exactly: `Comparator`, `Convert`, `Display`, `DisplayFile`, `FromString`, `ReadFile`, `RemoveSection`,
`TableOfContents`, `ToString`, `WorksheetToMapleText`, `WriteFile` — i.e. **no `WorksheetToJupyter`**
(consistent with that page's own statement that `WorksheetToJupyter` was *introduced in Maple 2022*; the
2022‑01 snapshot predates the Maple 2022 release, so it reflects Maple 2021).

Combining that with each page's `Compatibility` section gives:

| Command | 2018 | 2022 | First documented version |
|---|---|---|---|
| `ReadFile` | yes | yes | (no compatibility note → long-standing) |
| `WriteFile` | yes | yes | (no compatibility note) |
| `FromString` | yes | yes | (no compatibility note) |
| `ToString` | yes | yes | (no compatibility note) |
| `Convert` | yes | yes | (no compatibility note; **updated 2025**) |
| `WorksheetToMapleText` | **yes** | yes | **Maple 2017** |
| `RemoveSection` | **NO** | yes | **Maple 2020** |
| `TableOfContents` | **NO** | yes | **Maple 2020** |
| `WorksheetToJupyter` | **NO** | **yes** | **Maple 2022** |
| `Display` / `DisplayFile` | yes (GUI only) | yes (GUI only) | (no compatibility note) |
| `Comparator` | yes (GUI only) | yes (GUI only) | (no compatibility note) |

Citations for the introduction versions (each is the page's own `Compatibility` section):

* `WorksheetToMapleText` — "The Worksheet:-WorksheetToMapleText command was introduced in Maple 2017."
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText>
* `RemoveSection` — "The Worksheet:-RemoveSection command was introduced in Maple 2020."
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FRemoveSection>
* `TableOfContents` — "The Worksheet:-TableOfContents command was introduced in Maple 2020."
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FTableOfContents>
* `WorksheetToJupyter` — "The Worksheet:-WorksheetToJupyter command was introduced in Maple 2022."
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter>
* `Convert` — "The Worksheet[Convert] command was updated in Maple 2025. The outputfilename option was
  introduced in Maple 2025. The format option was updated in Maple 2025."
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FConvert>

> **UNVERIFIED:** the exact 2018 *package overview* page could not be retrieved (Wayback had no snapshot of
> that URL in 2017‑2019). The 2018 row above is a **deduction** from (a) the `Compatibility` notes, which
> prove `RemoveSection`/`TableOfContents`/`WorksheetToJupyter` did not exist in 2018, and (b) the 2022‑01
> snapshot, which proves the other nine did. It should be confirmed by running `with(Worksheet)` (or
> `exports(Worksheet)`) on the installed Maple 2018.

Syntax detail: the modern help overview shows `Worksheet:-command(arguments)`; the 2022‑01 snapshot shows
`Worksheet[command](arguments)` and adds "As the underlying implementation of the Worksheet package is a
module, it is also possible to use the form `Worksheet:-command`". Both forms work in 2018 and 2022.

### 1.2 Exact signatures and documented behaviour

Signatures below are verbatim from the Calling Sequence blocks of the live pages (page URL suffix given).

#### `Worksheet:-ReadFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FReadFile>

```
ReadFile( filename, format=output_format )
```
* `filename` — "string; name of a worksheet file"
* `format=output_format` — "(optional) equation; output_format can be either \"maple8_xml\" or \"mw\" (default)"
* "The ReadFile command parses a worksheet, returning an XML data structure that represents the worksheet.
  … The XML document structure returned by this procedure is of type `Worksheet:-worksheet`."
* "You can save a worksheet in XML format by using the procedure WriteFile in the **XMLTools** package."
  (documentation slip: the Worksheet-package procedure is meant)
* "**Note:** Maple worksheets (.mw) files are saved in an XML-based format. You can display the structure of a
  Maple worksheet in XML applications."

#### `Worksheet:-WriteFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWriteFile>

```
WriteFile(fileName, xmlTree, format=output_format)
```
* `fileName` — "string; name of file" · `xmlTree` — "Maple XML tree; worksheet" · `format` — `"maple8_xml"` or `"mw"` (default)
* "The WriteFile command writes the specified XML document xmlTree to the file fileName in the specified format."
* Same page, further down (recorded in `04-file-formats.md`): *"It is assumed that the XML document that is
  written to the file represents a valid worksheet. (Maple performs only a surface check.)"*
* ⚠️ Argument order is **(fileName, xmlTree)** — *not* (tree, name).
* Documentation inconsistency worth remembering: the page's prose/example use `format = mws`, which
  contradicts the parameter list; prefer `format="mw"`.

#### `Worksheet:-FromString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FFromString>

```
FromString(str, format=output_format)
```
* `str` — "string; mws or xml string representing Maple worksheet"; `format` — `"maple8_xml"` or `"mw"` (default)
* "The FromString(str) calling sequence parses the input string str, which is assumed to be a valid Maple
  worksheet. It then converts it to a Maple XML tree."
* "Errors detected by the parser in this routine are reported, but the parser does not validate the worksheet.
  Only errors that prevent this routine from converting the input string into an internal XML format are detected."
* "FromString maps automatically over its arguments, returning an expression sequence of results."

#### `Worksheet:-ToString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FToString>

```
ToString(xmlTree, format=output_format)
```
* `format` — "(optional) equation; output_format can be one of `\"mws\"`, `\"maple8_xml\"`, or `\"mw\"` (default)"
* "The ToString(xmlTree) calling sequence formats the XML document xmlTree representing a Maple worksheet as a
  **MWS** document (stored as a Maple string)." *(prose says MWS, parameter list defaults to `mw` — another
  documentation wrinkle; pass `format="mw"` explicitly.)*
* "The xmlTree argument can either be the full document as read from a worksheet file, or a worksheet resulting
  from a call to **`DocumentTools:-Layout:-Worksheet`** (containing calls to other DocumentTools:-Layout and
  DocumentTools:-Components commands)."
* "It is assumed that the XML document that is written to a string represents a valid worksheet. (Maple performs
  only a surface check.)"

#### `Worksheet:-Convert` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FConvert>

```
Convert( worksheet, opts )
Convert( worksheet, outputfilename, opts )
```
* `worksheet` — "Maple XML data structure; valid Maple worksheet"; `outputfilename` — "(optional) string or none"
* "The Convert command converts a worksheet to the specified format. The worksheet may be given as a filepath or
  a Maple XML data structure. The output format is controlled by the `format` option. If the optional input
  outputfilename is provided, the converted data is written to this file in the specified format. Otherwise, the
  data is returned directly by the command."
* Documented `format` values (live page): `_Inert` (Maple inert form), `jupyter`, `maple`, `workbook`,
  `maple8` (Legacy Maple 8 file format), `mapletext` (MPL format), `mw`, `procedure`.
  "The default is inferred from the output filename, if given. Otherwise Maple worksheet format is assumed."
* Verbatim example from the page:
  ```maple
  > doc := ReadFile( cat(dir, "/examplesclassic/obj.mws"), format=maple8_xml ):
  > mws := Convert( doc, format=mw ):
  ```
* Compatibility: "The Worksheet[Convert] command was updated in Maple 2025. The `outputfilename` option was
  introduced in Maple 2025. The `format` option was updated in Maple 2025."
  → **`outputfilename` does not exist in 2018/2022**; and the *set* of format values that existed in 2018/2022
  is **UNVERIFIED** (the 2025 "format option was updated" implies some values are new). `format=mapletext`
  is safe for both versions because it mirrors `WorksheetToMapleText` (2017).

#### `Worksheet:-WorksheetToMapleText` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText>

```
WorksheetToMapleText( worksheet )
WorksheetToMapleText( worksheet, includeoutput )
```
* `worksheet` — "string or XML tree data structure"
* "The command WorksheetToMapleText converts a Maple worksheet in .mw format into a string containing the
  equivalent commands as **1-D Maple text**. It is similar in functionality to the Maple Text format in the
  File > Export As menu."
* "If the first argument worksheet is a string then it is treated as a filename. Otherwise, a worksheet as an
  XML tree data structure is expected."
* Notes: "This command only fully supports worksheets. It may not work properly for Maple documents with tables
  or components."
* **Introduced in Maple 2017** → available in 2018 and 2022.
* Verbatim example (page), showing what the output looks like:
  ```maple
  > printf( WorksheetToMapleText( filename ) );
  m := Matrix(2,2,[[-4, sqrt(17)], [ln(45), 61/4]]);
  m[1,1]*m[2,2]-m[1,2]*m[2,1];

  > printf( WorksheetToMapleText( filename, includeoutput ) );
  m := Matrix(2,2,[[-4, sqrt(17)], [ln(45), 61/4]]);
  # out_1> Typesetting:-mfenced(Typesetting:-mtable( … ))
  m[1,1]*m[2,2]-m[1,2]*m[2,1];
  # out_2> -61-sqrt(17)*ln(45)
  ```

#### `Worksheet:-WorksheetToJupyter` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter>

```
WorksheetToJupyter( worksheet, opts )
```
* `worksheet` — "string or XML tree data structure"; `opts` — "(optional) options of the form `outputfile = ~path`"
* "`WorksheetToJupyter(worksheet)` converts a Maple worksheet in .mw format into a Jupyter notebook containing
  the equivalent input commands suitable for use with the Maple Kernel for Jupyter."
* "If an output file is specified with option outputfile, the notebook is written to outputfile and the number of
  bytes written to the file is returned. Otherwise the output is a string which encodes the generated notebook."
* "Output saved in the original worksheet is not translated to output in the Jupyter workbook. To see output in
  the Jupyter notebook, execute the notebook using the Maple Kernel for Jupyter."
* **Introduced in Maple 2022 → NOT available in Maple 2018.**

#### `Worksheet:-RemoveSection` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FRemoveSection>

```
RemoveSection( target )
RemoveSection( target , destination )
```
* `target` — "string; name of file to read in .mw format"; `destination` — "string; name of file to write in .mw format"
* "The command RemoveSection removes all the sections from a Maple document in .mw format."
* **"If the second argument destination is omitted then the target file without sections is opened in the Maple
  GUI. Otherwise, the target file is written without sections to the destination file in .mw format."**
* **Introduced in Maple 2020 → NOT available in Maple 2018.**
* Verbatim example:
  ```maple
  > file := cat(kernelopts(datadir), "/help/Worksheet/SimpleSectionDocument.mw"):
  > Worksheet:-RemoveSection(file):
  ```

#### `Worksheet:-TableOfContents` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FTableOfContents>

```
TableOfContents( target )
TableOfContents( target , destination )
TableOfContents( target , opts )
TableOfContents( target , destination , opts )
```
* "The command TableOfContents adds a table of contents of the section headings to the beginning of a Maple
  document (.mw). All headings in the table of contents are links to the corresponding section in the Maple document."
* **"If the second argument destination is omitted then the generated file with a table of contents is opened in
  the Maple GUI. Otherwise, the generated file is written with a table of contents to the destination file in .mw format."**
* Options: `depth` (default 2), `startingsize` (12), `sizeincrement` (2), `bullets`, `nosection`, `columns`
  (default 0), `color`, `nounderline`.
* **Introduced in Maple 2020 → NOT available in Maple 2018.**

#### `Worksheet:-Comparator` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FComparator>

```
Comparator(fn1, fn2)
```
* "The Comparator command **launches a Maplet interface** that compares the output in two Maple worksheets
  (typically the same worksheet executed in two different versions of Maple). This tool can also be used to
  execute a worksheet created in an earlier version of Maple and compare the new output with the one included in
  the original worksheet. (This includes both .mws and .mw files.)"
* "If fn1 is not specified, Comparator uses the current directory."
* Maplets are Java GUI applications → **GUI-only**. (Compare `03-openmaple-java-dotnet.md` §Maplets.)

#### `Worksheet:-Display` / `Worksheet:-DisplayFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay>

```
Display( fileString )
DisplayFile( fileName )
```
* `fileString` — "string; contain Maple worksheet or XML tree"; `fileName` — "string; name of file"
* **"Important: The Display function cannot be used in the Command-line version of Maple."** ← the single most
  important GUI-only statement in the whole package, and the only one Maplesoft states this bluntly.
* "The Display(fileString) function accepts a Maple worksheet as a text string in either native or XML format, or
  as an XML tree, and **displays (opens) the worksheet in the GUI**. The value NULL is returned."
* "The DisplayFile(fileName) command accepts the name of a worksheet file … and displays (opens) the worksheet in
  the GUI. If the name fileName of the file ends with the substring `.xml`, the file is taken to be a Maple
  worksheet saved in XML format. Otherwise, the file is assumed to be a Maple worksheet saved in native format.
  The value NULL is returned."
* "The name of the worksheet has the form ``display[N]'', where `N' is an integer."

### 1.3 Worksheet package — headless verdict

| Command | Runs headless in `maple`/`cmaple`? | Evidence |
|---|---|---|
| `Display`, `DisplayFile` | **NO — documented** | "cannot be used in the Command-line version of Maple" (help page) |
| `Comparator` | **NO — GUI** | "launches a Maplet interface" (help page); Maplets are Java GUI apps |
| `TableOfContents`, `RemoveSection` | **YES *only* with `destination`** | "If the second argument destination is omitted then … opened in the Maple GUI. Otherwise, … written to the destination file" |
| `ReadFile`, `WriteFile`, `FromString`, `ToString`, `Convert`, `WorksheetToMapleText`, `WorksheetToJupyter` | **Strongly implied YES; UNVERIFIED** | No interface caveat anywhere on their pages; all are file/XML/string transforms. The package is filed by Maplesoft under **Connectivity → Web Features → Worksheet Package** (breadcrumb on the Display page: <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay>), i.e. the server-side/headless use case is the intended one. `WorksheetToJupyter`'s whole purpose is to feed a *headless* Jupyter kernel. |

> **Actionable:** the MCP server can **probably** rely on `ReadFile`/`Convert`/`WorksheetToMapleText`/
> `ToString`/`FromString`/`WriteFile` in a `maple -q -s` batch session, but because Maplesoft never states it,
> the very first smoke test on the real 2018 and 2022 installs must be:
> ```bash
> maple -q -s -i /tmp/smoke.mpl
> # /tmp/smoke.mpl:
> # with(Worksheet): printf("%s\n", WorksheetToMapleText("/abs/path/x.mw"));
> ```
> Do **not** build the MCP's core conversion path on this without that test.

---

## 2. `DocumentTools` (and `Layout` / `Components`)

### 2.1 Inventory, per version

**Live help (Maple 2026)** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools>:

> "The DocumentTools package is a collection of commands that allow programmatic access to Maple documents."
> "The package provides commands for access to properties of embedded components such as buttons or slider bars,
> in a Standard Maple document or worksheet."
> "The package also provides commands for accessing mathematical expressions contained in document or worksheet
> files, as well as the ability to query or change the properties of the document or worksheet file."

Live command list: `AddIcon`, `AddPalette`, `AddPaletteEntry`, `ContentToString`, `CreateTask`, `Do`,
`GetDocumentProperty`, `GetProperty`, `InsertContent`, `InsertTask`, `RemovePalette`, `RemovePaletteEntry`,
`RemoveTask`, `Retrieve`, `RunWorksheet`, `SetDocumentProperty`, `SetProperty`, `Tabulate`.
Live subpackages: `Components`, `Layout`, `Actions`, `Canvas`.

**Archived 2019-10-19 snapshot** (nearest available to 2018; fetched via
<https://web.archive.org/web/20191019223718id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools>)
lists: `AddIcon`, `AddPalette`, `AddPaletteEntry`, `Components`, `ContentToString`, `CreateTask`, `Do`,
`GetDocumentProperty`, `GetProperty`, `InsertContent`, `InsertTask`, `Layout`, `RemovePalette`,
`RemovePaletteEntry`, `RemoveTask`, `Retrieve`, `RunWorksheet`, `SetDocumentProperty`, `SetProperty`, `Tabulate`
— i.e. the **same set** as today minus nothing important, and with `Components`/`Layout` shown as top-level names
rather than as a separate "subpackages" table.

**`DocumentTools:-GetContent` does not exist.** The live help page
<https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetContent> answers
*"The Help Document that you have requested was not found."*, and no `GetContent` appears in the live or the
2019-10-19 command lists; `DocumentTools:-Components:-GetContent` likewise 404s. There is **no evidence it ever
existed**; treat it as non-existent in 2018 and 2022 (2018 itself UNVERIFIED, but a command cannot have been
removed without a `Compatibility` entry).

Per-version table for the commands the MCP asks about:

| Command | 2018 | 2022 | Evidence |
|---|---|---|---|
| `InsertContent` | yes | yes | "introduced in Maple 2015" (page `Compatibility`) |
| `Retrieve` | **UNVERIFIED for 2018** | yes | in the 2019-10-19 archived list; live page has no `Compatibility` note |
| `GetProperty` | yes | yes | documented in the 2018 Programming Guide §13.2 |
| `SetProperty` | yes | yes | documented in the 2018 Programming Guide §13.2 |
| `Do` | yes | yes | documented in the 2018 Programming Guide §13.2 |
| `GetContent` | **no** | **no** | help page 404s; absent from 2019 and 2026 lists |
| `Tabulate` | yes | yes | "introduced in Maple 2015" |
| `Components` (subpkg) | yes | yes | "introduced in Maple 2015" |
| `Layout` (subpkg) | yes | yes | "introduced in Maple 2015" |
| `ContentToString` | yes | yes | "introduced in Maple 2015" |
| `GetDocumentProperty` | yes | yes | `mwfile` parameter "introduced in Maple 2017" |
| `SetDocumentProperty` | **partly** | yes | `mwfile`/`outfile` "introduced in Maple 2021" → the **file-based form is 2021+**, i.e. **not in 2018** |
| `RunWorksheet` | **yes** | yes | cited by name in the **Maple 2018 Programming Guide**; 2019‑12 and 2022‑01 help snapshots both carry it |
| `RunWorksheet`'s `all` option | no | no | "The `all` option was introduced in Maple 2025" |
| `RunWorksheet`'s `outputs` option | UNVERIFIED | yes | present in the 2022-01 snapshot |

### 2.2 Signatures and verbatim examples

#### `DocumentTools:-InsertContent` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FInsertContent>

```
InsertContent(content)
InsertContent(content, opts)
```
* `content` — "{string, XML tree} ; string or XML tree structure containing a valid XML description of a
  worksheet or task template"
* Options: `minimal` (default true), `output` (`Array`|`table`, default `Array`), `state`, `replaceid`, `validate`
* Returns: "A mapping of embedded component identities in the content, which may have been substituted upon
  insertion in order to avoid conflicting with identities of embedded components already existing in the
  **currently open worksheet**."
* **"The InsertContent function inserts input worksheet content into the currently open Worksheet or Document at
  the next available cursor location."** ← requires an open document in the GUI.
* Verbatim example (page):
  ```maple
  > with(DocumentTools):
  > with(DocumentTools:-Layout):
  > InsertContent( Worksheet( Group( Textfield( InlinePlot( plot(sin) ) ) ) ) );

  > with(DocumentTools:-Components):
  > xml := Worksheet( Group( Textfield( Button("My Caption", identity=Button0) ) ) );
  > first := InsertContent(xml);
                       first := [ Button0  Button0 ]
  > lookup := InsertContent(xml, output=table);
                       lookup := table([Button0 = Button1])
  > lookup[Button0];
                       "Button1"
  > SetProperty(lookup[Button0], caption, "New Caption", refresh);
  ```

#### `DocumentTools:-Retrieve` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRetrieve>

```
Retrieve(filename, label)
```
* `filename` — "string ; filename for document to open"; `label` — "string ; label of expression to retrieve from document"
* **"The Retrieve command scans a document file for the given label and returns the corresponding expression."**
* "If filename is not an absolute filename, the setting of `currentdir` determines what directory to search."
* **"label is an internal label for the expression in the document and does not correspond to equation numbers."**
* "In order to create a such a reference, use **Insert>Reference in the Standard Worksheet Interface**. This will
  allow you to look up an expression based on its equation number and automatically generate the internal label."
* Verbatim example:
  ```maple
  > with(DocumentTools):
  > src := FileTools:-JoinPath(example/BesselsEquation.mw, base=datadir):
        src := /maple/cbat-build/active/297794/data/example/BesselsEquation.mw
  > Retrieve(src, L6);
        x^2*(diff(y(x), x, x)) + x*(diff(y(x), x)) + (-nu^2 + x^2)*y(x) = 0
  ```
* **This is the file-based, label-addressed API.** It reads an **expression from the file**; it does **not**
  execute the group and does **not** return the stored output. The `label` values are exactly the
  `labelreference` attributes seen in the XML (`L1`, `L6`, `L1168`, …; see §3.2). Whether `Retrieve` itself can
  run in a command-line session is **UNVERIFIED** — the page has no interface caveat and the operation is a file
  scan, but the only documented way to *create* the reference is the GUI menu.

#### `DocumentTools:-GetProperty` / `SetProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetProperty> · <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FSetProperty>

```
GetProperty(id, prop)
SetProperty(id, attr, val, refreshopt)
SetProperty([id1, attr1, val1], [id2,attr2,val2], ... , refreshopt)
```
* "The GetProperty function queries the desired component for the value of a property."
* "The SetProperty function sets the value of a property of an embedded component." / "If the val option is
  omitted, the referenced component is reset to its default value."
* Documented examples assume "your document has a slider component with name Slider1" / "a plot component with
  the name Plot0", i.e. an **open document containing embedded components**.
* **GUI-required** — embedded components only exist in an open Standard Worksheet/Document.

#### `DocumentTools:-Do` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FDo>

```
Do(expr)
Do(var=expr)
Do(target=expr, refreshopt)
```
* "The Do command evaluates its argument using values retrieved from specified embedded components." `%name`
  refers to component `name`.
* **Maple 2018 Programming Guide §13.2 (p. 462)** — the decisive statement:
  > "The embedded component type determines the default property retrieved or set by the Do command. This means
  > that **the Do command must query the GUI to determine which information to retrieve.** The GetProperty and
  > SetProperty commands avoid this step by requiring you to specify which property to retrieve."
  <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
* PG2018 §13.2 also gives the 2018-documented `DocumentTools` list:
  > "This package includes the following commands.
  > • **GetProperty**: Retrieve information from a component.
  > • **SetProperty**: Update a component.
  > • **Do**: An alternate interface to both GetProperty and SetProperty. This command can be used to retrieve and
  > update components."

#### `DocumentTools:-GetDocumentProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetDocumentProperty>

```
GetDocumentProperty(attr)
GetDocumentProperty(attr,mwfile)
```
* "If the option `all` is specified, all of the document properties are returned."
* **"If the second optional argument is provided, then the specified document properties are fetched from given
  mwfile on disk."** ← the **file-based, headless-capable** form; `mwfile` **introduced in Maple 2017** → present
  in both 2018 and 2022.
* Verbatim example:
  ```maple
  > with(DocumentTools):
  > GetDocumentProperty(all);
     Active=false, Keywords=<default>, Item List=true, …
  > GetDocumentProperty(Author);
     <default>
  ```
* Note this same `InputSectionTitle`-style document-property mechanism is what `RunWorksheet` looks up (§2.2.7),
  and it is exactly the `Document Properties` block an MCP could read/write **outside** the GUI.

#### `DocumentTools:-SetDocumentProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FSetDocumentProperty>

```
SetDocumentProperty(attr, val)
SetDocumentProperty(attr, val, mwfile, outfile)
```
* "The SetDocumentProperty function sets the value of a document property in the currently open document, or,
  when specified in mwfile."
* **"When mwfile is specified, it is modified in-place unless outfile is also provided, in which case, outfile is
  an identical full copy of the source worksheet, with the modified properties."**
* Compatibility: "updated in Maple 2021. The mwfile and outfile parameters were introduced in Maple 2021."
  → **file-based form available in 2022, NOT in 2018.**

#### `DocumentTools:-ContentToString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FContentToString>

```
ContentToString(content)
ContentToString(content, v)
```
* `content` — "{specfunc(_XML_Worksheet)} ; XML tree structure containing a valid XML representation of a complete
  worksheet"; `v` — "(optional) `identical(validate)=truefalse`"
* "The ContentToString command converts an XML tree structure (content) to the string form of a worksheet file."
* "The content can be generated using commands from the Component Constructors and Layout Constructors packages.
  Such content can be inserted directly into the current window using the InsertContent command. The
  ContentToString command converts the content to a worksheet string."
* "The resulting worksheet string can be saved directly as a .mw format file, launched in a new window using the
  Worksheet:-Display command, or used with the CreateTask command."
* Verbatim example (page), i.e. **the headless worksheet writer**:
  ```maple
  > with(DocumentTools): with(DocumentTools:-Layout):
  > xml := Worksheet( Group( Input( Table( Row( "Some text." ) ) ) ) );
  > str := ContentToString(xml);
      str := <?xml version="1.0" encoding="UTF-8"?><Worksheet><Group view='presentation' …>
             <Text-field alignment='centred' style='Text' layout='Normal'>Some text.</Text-field>
             </Table></Row></Table></Input></Group></Worksheet>
  > fname := FileTools:-TemporaryFilename( cat(FileTools:-TemporaryDirectory(), "/", ".mw") ):
  > FileTools:-Text:-WriteFile(fname, str):
  ```
* **`ContentToString` is pure string generation and `FileTools:-Text:-WriteFile` is pure file I/O → this is the
  single most headless-safe word-processing path in the whole `DocumentTools` package.** (Explicit GUI-free
  certification is still absent → treat as "strongly implied", but there is nothing in the command that could
  need a display.)
* `Compatibility`: "introduced in Maple 2015."

#### `DocumentTools:-Layout` / `DocumentTools:-Components` constructors

* `Layout` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FLayout>:
  "The Layout package provides commands for generating XML as function-calls which represent GUI elements."
  Commands: `Cell`, `Column`, `DocumentBlock`, `Equation`, `Font`, `Group`, `Image`, `InlinePlot`, `Input`,
  `Output`, `Row`, `Section`, `Table`, `Textfield`, `Worksheet`. "introduced in Maple 2015."
* `Components` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FComponents>:
  Commands: `Button`, `CheckBox`, `CodeEditRegion`, `ComboBox`, `DataTable`, `Dial`, `Label`, `ListBox`,
  `MathContainer`, `Meter`, `Microphone`, `Plot`, `RadioButton`, `RotaryGauge`, `Shortcut`, `Slider`, `Speaker`,
  `State`, `TextArea`, `ToggleButton`, `VideoPlayer`, `VolumeGauge`. "introduced in Maple 2015."
* These return inert `_XML_*` function calls (the help pages show e.g. `_XML_Worksheet(_XML_Group(...))`) — they
  are constructors, not GUI operations, so they should be headless; combined with `ContentToString` they let the
  MCP **synthesise a `.mw` entirely in-kernel without ever opening a window**. This mirrors what
  `04-file-formats.md` recommends for external XML generation, but with Maple guaranteeing the vocabulary.

#### `DocumentTools:-Tabulate` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FTabulate>

```
Tabulate( M, opts )
```
* "The Tabulate command **constructs and inserts** a worksheet Table from a Matrix, Vector, one or two dimensional
  Array, DataFrame, list, or list of lists."
* "This command inserts the assembly of Tables and Embedded Components into the worksheet using the
  **InsertContent** facility. The inserted content is placed after any usual output of the Execution Group in
  which this command is called. … Multiple calls to commands which utilize the InsertContent facility made within
  the same Execution Group will result in each successive inserted assembly replacing any assembly inserted
  earlier for that Execution Group." → **GUI-required for the default form.**
* **Escape hatch:** option `output: identical(XML,inline)` — "Specifies whether to insert the formatted output or
  **return the raw XML structure**." With `output=XML`, `Tabulate` returns XML instead of inserting it, and the
  page says it can then be nested with "other DocumentTools commands to construct your own content". This makes
  `Tabulate(..., output=XML)` a headless table builder.
* Compatibility: "introduced in Maple 2015"; "updated in Maple 2018. The M parameter was updated in Maple 2018.
  The `recordformat` option was introduced in Maple 2018." → all options above exist in **2018 and 2022**
  (`output`/`typesetting` since 2016, `recordformat` since 2018).

#### `DocumentTools:-RunWorksheet` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRunWorksheet>

```
RunWorksheet(ws, var_init)
```
* `ws` — "string ; name of the file containing the Maple or Maple Flow worksheet to run"
* `var_init` — "(optional) list(symbol=anything) ; list of equations of the form symbol = expression, specifying
  the initial values for the corresponding variables in ws"
* `outputs` — "(optional) list({symbol,string}) ; list of variables and/or command strings"
* `inheritlibname` — **(current help)** "(optional, **command-line Maple and Maple worksheet only**) truefalse ;
  indicate whether the worksheet process should inherit the current value of libname. The default is true."
  **(2022-01-19 snapshot, verbatim)** "(optional,**cmaple only**) truefalse ; indicate whether the worksheet
  process should inherit the current value of libname. The default is true."
* `all` — "(optional, **Maple Flow worksheet only**) truefalse ; return all variables assigned in the document"
  (2025+)
* Key Description bullets (current help; the 2022-01-19 snapshot is textually the same for these):
  * "The RunWorksheet function invokes the worksheet specified by ws as if it were a procedure."
  * "The worksheet filename ws can be either fully qualified or be relative to the value of currentdir."
  * "If the invoked worksheet ws includes a **return statement at the top level** (not inside a procedure), the
    expression given in that return statement will be returned as the output of the RunWorksheet command.
    Execution of the invoked worksheet ws stops when a top-level return is evaluated."
  * "If the invoked worksheet ws does not include such a top-level return statement, the RunWorksheet command will
    have no output. That is, the value of the RunWorksheet call will be NULL."
  * **"The invoked worksheet runs \"headless\", meaning that it will not appear with a user interface."**
  * **"The invoked worksheet runs in a new engine**, so expressions whose subsequent evaluation may depend on the
    state of the engine in the calling worksheet cannot be passed in var_init. … To pass a procedure, table,
    matrix, vector, or array defined elsewhere in the calling worksheet, it is necessary to apply eval to the
    expression first."
  * For `var_init`: "within the Document Properties there must be an attribute with Attribute Name
    **InputSectionTitle** and whose value is the section name."
* Verbatim example (page):
  ```maple
  # worksheet test.mw: section "Inputs" with a:=1; b:=2; c:=3; (one per execution group)
  #                   section "Calculation" with  return a+b^2+c^3;
  # Document Properties: InputSectionTitle = Inputs
  > DocumentTools[RunWorksheet]( "test.mw", [a=-1, b=4] );
                42
  ```
* **Version evidence.**
  * 2022-01-19 snapshot (verbatim, `inheritlibname` = "cmaple only";
    <https://web.archive.org/web/20220119111045id_/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools%2FRunWorksheet>)
    and the 2019-12-10 snapshot (same wording;
    <https://web.archive.org/web/20191210010501id_/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools/RunWorksheet>).
  * **Maple 2018 Programming Guide §5 "The return Statement", p. 189–190:**
    > "In Command-line Maple, the return statement causes an error if it is run at the top level: Error, return
    > out of context. In the Standard worksheet interface, return can be used at the top level in conjunction with
    > **DocumentTools:-RunWorksheet**."
    <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
    → `RunWorksheet` existed in **Maple 2018**, and the option name "cmaple only" is explicit documentary evidence
    that it is meant to be called from the **command-line** kernel.
  * `all` was introduced in Maple 2025 (page `Compatibility`); `outputs` is present in the 2022-01 snapshot.

> **UNVERIFIED:** *how* `RunWorksheet` starts its "new engine" (in-process OpenMaple vs. a spawned kernel) and
> whether that path ever needs the Java VM. Nothing in the help says so; the fact that `inheritlibname` is
> labelled "cmaple only" argues the command-line case is supported without the GUI, but this must be smoke-tested.

### 2.3 DocumentTools — headless verdict

| Command | Headless? | Why |
|---|---|---|
| `InsertContent` | **No** | "inserts … into the currently open Worksheet or Document at the next available cursor location" |
| `GetProperty` / `SetProperty` | **No** | operate on embedded components of the open document |
| `Do` | **No — documented** | PG2018: "the Do command must query the GUI" |
| `Tabulate` | **No** by default; **yes with `output=XML`** | inserts via `InsertContent`; `output=XML` returns raw XML |
| `GetDocumentProperty(attr, mwfile)` | **Yes (file-based)** | "fetched from given mwfile on disk" (2017+, so 2018 & 2022) |
| `SetDocumentProperty(attr,val,mwfile,outfile)` | **Yes (file-based), 2022 only** | `mwfile`/`outfile` introduced 2021 |
| `ContentToString` | **Yes (pure string)** | returns the `.mw` XML string; used with `FileTools:-Text:-WriteFile` |
| `Layout:-*`, `Components:-*` | **Yes (pure constructors)** | return `_XML_*` inert trees |
| `Retrieve(filename,label)` | **Probably yes** — UNVERIFIED | file scan by label; no interface caveat |
| `RunWorksheet` | **Yes — documented** | "runs headless, meaning that it will not appear with a user interface" |
| `CreateTask`, `InsertTask`, `*Palette*`, `AddIcon`, `Actions`, `Canvas` | **No** | task templates / palettes / canvases are GUI products |

---

## 3. Executing exactly **one** cell / execution group

### 3.1 What execution groups are, as documented

Help: *Structure Worksheets with Execution Groups* —
<https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fdocumenting%2Fexecutiongroups>:

> "An **execution group** is a grouping of Maple input with its corresponding Maple output. It is distinguished
> by a large square bracket, called a group range, at the left. An execution group may also contain any or all of
> the following: a plot, a spreadsheet, or textual commentary."
>
> "Execution groups are the fundamental computation and documentation element for the worksheet. **If you place
> the cursor in an input command and press the Enter or Return key, Maple executes all the input commands in the
> current execution group.**"

The only child pages Maplesoft offers for execution groups are *Insert an Execution Group*, *Join Execution
Groups*, *Split an Execution Group* — all **GUI editing** operations. There is also a GUI page *Execute
Selection* (<https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fexpressions%2Fexecuteselection>).

### 3.2 Addressing by label in the `.mw` XML

Real `.mw` files carry an explicit label scheme. Verified on a real worksheet (Maple 2015 writer, 224 KB, fetched
from <https://raw.githubusercontent.com/abuchel-hepth/cascading-gauge-theory-DFP-stability/refs/heads/main/attachement_formulars.mw>):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Worksheet>
<Version major="2015" minor="0"/>
<Label-Scheme value="2" prefix=""/>
<View-Properties presentation="false" …>
…
<Group labelreference="L1" drawlabel="true" applyint="true" applyrational="true" applyexponent="false">
…
<Group labelreference="L1168" drawlabel="true" …>
```

So every execution group has a **`labelreference`** attribute (`L1`, `L1168`, …) and the document declares a
`<Label-Scheme>`. **These are the labels `DocumentTools:-Retrieve(filename, label)` consumes** (the help example
uses `Retrieve(src, L6)`). But:

* `Retrieve` **returns an expression from the file**; it does not execute the group, and it does not read back the
  stored `<Output>` cells either (it "scans a document file for the given label and returns the corresponding
  expression").
* There is **no** `DocumentTools:-RetrieveOutput`, no `Worksheet:-ExecuteGroup`, no `Group`-level API in either
  the live or the 2019/2022 command lists.

### 3.3 Can `WorksheetToMapleText` be used to run one group?

`WorksheetToMapleText` linearises the **whole** worksheet into 1-D Maple text
(<https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText>). Two important
observations:

1. **It does not emit execution-group delimiters.** The documented output is just the statements, one per line
   (`m := Matrix(...);` then `m[1,1]*m[2,2]-…;`). Nothing marks where one execution group ends and the next
   begins, so you **cannot reliably split the text back into groups** from the `.mpl` alone.
2. **However**, with `includeoutput` the outputs are emitted as numbered comments — `# out_1> …`, `# out_2> …` —
   in group order. That gives an *implicit* group index for groups that produced output, but groups that produce
   no output leave no marker. **UNVERIFIED/inference:** using `out_N>` markers to recover group boundaries is
   plausible but not a documented contract; do not rely on it for correctness.

Practical readings:

* **For 1-D worksheets** the robust route is external: parse the `.mw` XML, take the *N*-th `<Group>`'s
  `<Input><Text-field style="Maple Input">…</Text-field>` text verbatim, and feed *that statement text* to a
  persistent `maple` session. (`04-file-formats.md` §2 documents that 1-D input is plain text in the XML and
  that ~34 % of real input regions are 2-D-only.)
* **For 2-D groups** the text must first be linearised by Maple. You could call
  `Worksheet:-WorksheetToMapleText` per group by passing a sub-tree — but passing a `Group` (rather than a whole
  worksheet/`Worksheet:-worksheet` tree) is **not documented**, and the command warns it "only fully supports
  worksheets". Treat per-group linearisation as **UNVERIFIED** and test it.
* **The pragmatic MCP design** (recommended): have the MCP itself write **one execution group per `.mw` file**
  (or keep one group per "cell" in a managed worksheet), then use `DocumentTools:-RunWorksheet` per cell. That is
  the only *documented, headless* "run a document and return values" primitive.

### 3.4 Verdict

> **There is no documented way — from inside Maple or from the command line — to execute a single execution group
> of a `.mw` file that is not open in the GUI.**
>
> * Per-group execution is documented only as the interactive "put the cursor in the group and press Enter" gesture.
> * Programmatic execution is per-*document* (`DocumentTools:-RunWorksheet`), not per-group, and runs the whole
>   worksheet headless in a new engine.
> * `DocumentTools:-Retrieve(path, L6)` gives **label addressing** (`Label-Scheme` / `labelreference` in the XML)
>   but only *retrieves an expression*, it does not evaluate it.
> * `Worksheet:-WorksheetToMapleText` linearises the whole worksheet and does not preserve group boundaries.
>
> The workable substitutes are (a) one group per file + `RunWorksheet`, or (b) external XML extraction of the
> *N*-th `<Group>`'s 1-D input text + execution in a driven session.

---

## 4. Result serialization for an external client (all headless)

### 4.1 Plain text

| Mechanism | Signature / exact command | Notes & source |
|---|---|---|
| `lprint` | `lprint(e1, e2, …)` | "prints its arguments in a one-dimensional format"; "**In general, the printed form produced by lprint is valid Maple input.**"; "intended for device independent printing and **makes no use of special features of the user interface**"; returns `NULL`, so `%`/`%%` cannot recall it. Also `lprint[2]` for line-broken procedures. <https://www.maplesoft.com/support/help/maple/view.aspx?path=lprint> |
| `prettyprint=0` | `interface(prettyprint=0):` | "Maple will print **all** expressions after normal evaluation using lprint if the interface variable prettyprint is set to 0." Default is **3 in the Worksheet interface, 1 in the Command-line interface**. Values ≤0 produce lprint-equivalent output; `-1`/`-2` variants documented on the `interface` page. <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface> |
| `printf` / `sprintf` | `printf(fmt, args…)`, `sprintf(fmt, args…)` | Format codes documented: `%a`, `%A`, `%q`, `%Q`, `%m`, `%v`, `%V`, `%P` plus the usual numeric C formats, and the `L` and `Z` modifiers. `Z` matters: "**`%Zm`** can be used to generate an alternate equivalent `.m` representation that is used in communication with the GUI and in DocumentTools related functionality for the creation of XML content for .mw files." <https://www.maplesoft.com/support/help/maple/view.aspx?path=printf> |
| `convert` | `convert(expr, string)` | "The convert(expr, string) calling sequence converts the expression expr to a string. To convert a string to an expression, refer to the `parse` command." <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert%2Fstring> |
| `writeto` / `appendto` | `writeto("out.txt"): … ; writeto(terminal):` | PG2018 §10.3: "If you want to redirect all output that normally goes to the screen to a file, use the writeto and appendto commands. This is an easy way to log the input and output of a Maple session, **particularly if you are using the command-line interface**." <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf> |
| `interface(echofile)` | `interface(echofile="session.txt"):` | "When set to a filename, echoes a copy of the session (both input and output) to that file. If the filename ends in \".html\" or \".htm\", the session is written in HTML format… **(Command-line interface only.)**" Default `none`. <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface> |
| `FileTools` | `FileTools:-Text:-WriteFile(name, str)`, `FileTools:-JoinPath([...], base=datadir)`, `FileTools:-TemporaryFilename`, `FileTools:-TemporaryDirectory` | Pure file I/O; used by Maplesoft's own examples to persist a worksheet string. <https://www.maplesoft.com/support/help/maple/view.aspx?path=FileTools> |

### 4.2 LaTeX

```
latex( expr, options )
LaTeX( expr, options )     # LaTeX is a synonym of latex
```
Source: <https://www.maplesoft.com/support/help/maple/view.aspx?path=latex>

* "The latex function produces output on the screen which is a translation to LaTeX of its arguments…"
* **Version-critical:** "**This command has been rewritten for Maple 2021**, and it can now translate to LaTeX
  everything that can be displayed on a Maple worksheet or document (exception made of embedded components and
  DocumentTools objects)."
* Documented options on the live page: `append`, `asinpreviousreleases` (if true, "the old latex program, of
  releases previous to Maple 2021, is used"), `breaklines`, `filename` (deprecated), `forget`, `linelength`,
  `output` ("the right-hand side can be the keyword `string`, to return a string with the latex translation, or
  `file` in which case `filename = ...` is also required (**deprecated use, superseded by writeto**)"),
  `thisisinput`, `translation` (`full` default, or `restricted`), `writeto` ("`screen` (default) or any symbol or
  string representing a filename to which the output will be written; it can be used together with `append`").
* Headless string capture:
  ```maple
  s := latex( int(f(x),x), output=string );     # classic; still documented but deprecated on the 2021+ page
  ```
  On Maple 2022 you may prefer `latex(expr, writeto=...)` (new in 2021) or `sprintf`.
* Whole-worksheet LaTeX is a **GUI** menu action — "Any Maple worksheet, say filename.mw, can be translated to
  LaTeX as a whole using the menu **File > Export As > LaTeX**." There is no documented in-kernel
  worksheet→LaTeX command (the `Worksheet` package has no `WorksheetToLaTeX`).
* **UNVERIFIED for 2018:** the exact option set of `latex` in Maple 2018. Because the command was rewritten in
  2021, the 2018 and 2022 option sets are **not** the same. The pre-2021 page could not be retrieved this session
  (Wayback served a 2017 snapshot whose content region did not render, and the CDX query timed out). **Test
  `latex` options on the installed Maple 2018 before relying on any of them.**

### 4.3 MathML

Source: <https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML%2FExportContent> and
<https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML>

```
MathML:-Export( expr )             # parallel: presentation + content + Maple annotation
MathML:-ExportContent( expr )      # content-only MathML
MathML:-ExportPresentation( expr ) # presentation-only
MathML:-ExportModified( expr )     # "similar to that which is consumed by the Maple GUI and companion products"
MathML:-FromLatex( ... )           # reverse direction (exists; see MathML package list)
MathML:-Import / ImportContent / ImportModified
```
* "Exporting a Maple expression as MathML produces a representation of the expression as **MathML-encoded text**.
  This text is produced in the form of **a Maple string** which may then be printed or otherwise processed
  further."
* "If the translation from Maple to MathML is possible, the MathML-encoded textual representation of the Maple
  expression is **returned as a string**. Otherwise, an error is returned."
* "You can use the routine `XMLTools[Print]` to format the display of the strings returned by
  `MathML[Export]`, `MathML[ExportContent]`, and `MathML[ExportPresentation]`."
* "The current MathML implementation in Maple is based on **revision 2.0** of that standard."
* Exact command:
  ```maple
  s := MathML:-ExportContent( int(f(x),x) );
  ```
* ⚠️ **`convert(expr, 'MathML')` is not a documented Maple command.** The help page
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert%2FMathML> returns "Help Document not found",
  and `MathML` is not listed among the `convert` targets on <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert>.
  Use the `MathML` package.
* The `MathML` package has no `Compatibility` note on its overview page → treat as long-standing (present in
  2018 and 2022). **UNVERIFIED** for exact 2018 behaviour of `ExportModified`, which mentions Maple Calculator /
  Maple Learn (products that post-date 2018).

### 4.4 Images / plots

**First, the interface fact.** Help: *Plotting Interfaces* —
<https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Finterface>:

> "The **command-line interface produces a simple character plot. Most plotting options are not supported in this
> interface.**"

and, from *plot/device* —
<https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Fdevice>:

> "Help pages that describe Maple's plotting features assume that plots will be displayed in the Standard
> Worksheet interface. If you are using a different interface, see plot/interface."

**`plotsetup`** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=plotsetup>:

```
plotsetup(DeviceType, TerminalType, options)
# options: plotdevice=, plotoutput=, preplot=, postplot=, plotoptions=
```
* "plotsetup sets the value of the five interface variables that control the device used for rendering graphics:
  `plotdevice`, `plotoutput`, `preplot`, `postplot`, `plotoptions`."
* "The plot device name `default` is used to set up plotting using the default values for the user interface being
  used." / "The plot device name `inline` is used, on appropriate user interfaces, to select inline plotting."
* ⚠️ Contradiction across pages: `plotsetup` says "**gdi** is not available in the Standard Worksheet interface or
  Command-Line interface", while `plot/device` says only "**gdi** is not available in the Standard Worksheet
  interface". Treat `gdi` as unavailable in the CLI.
* "specify an output file for drivers that require a file. **When creating more than one plot, be sure to change
  the plotoutput file name before writing each plot**, so that you do not write over your previous plot."

**Device list** (`plot/device`): `bmp`, `char`, `colorchar`, `cps`, `default`, `dxf`, `gdi`, `gif`, `hpgl`,
`inline`, `jpeg`, `maplet`, `pcx`, `png`, `postscript`/`ps`, `pov`, `window`, `wmf`, `x11`.
* Headless-safe (write to a file / to the terminal): `char`, `colorchar`, `gif`, `jpeg`, `png`, `bmp`, `pcx`,
  `ps`/`postscript`/`cps`, `hpgl`, `dxf`, `pov`, `wmf`.
* GUI/display required: `inline`, `window`, `x11` ("The plot appears in a separate window on the workstation
  display"), `maplet` ("The plot appears in a separate window as a Maplet application").
* **There is no `svg` device**, and `svg` does not appear in `Export`'s format list → **SVG output is
  unsupported** in 2018/2022 as documented.
* Exact headless command:
  ```maple
  plotsetup( png, plotoutput = "/tmp/out.png", plotoptions = "height=400,width=600" ):
  plot( sin(x), x = -Pi..Pi ):
  plotsetup( default ):
  ```
  For EPS (encapsulated PostScript) use `postscript`/`ps` (which writes "an encapsulated PostScript rendering …
  in the file specified by the interface variable `plotoutput`"). PNG/GIF/JPEG/BMP write raster files.
* **`plot(..., output=...)` is not a documented plot option.** The full option list on
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Foptions> is: adaptive, annotation, axes,
  axesfont, axis, axiscoordinates, background, caption, captionfont, color, colorscheme, coordinateview, coords,
  discont, filled, filledregions, font, gridlines, labeldirections, labelfont, labels, legend, legendstyle,
  linestyle, numpoints, redraw, resolution, sample, scaling, size, smartview, style, symbol, symbolsize,
  thickness, tickmarks, title, titlefont, transparency, useunits, view — **no `output`**. (The `plot` page's only
  mention of "output" is the section heading "Using different interfaces and output devices".) If you have seen
  `plot(..., output=...)` in the wild, it is not a documented Maple plotting option — use `plotsetup`,
  `plottools:-exportplot`, or `Export`.

**`plottools:-exportplot`** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=plottools%2Fexportplot>:

```
exportplot(fname, p, opts)      # opts: encoding=, format=
```
* "The exportplot command retrieves geometric data from a plot structure and exports it to a file in the
  specified data format." Returns "a number showing the count of bytes written to disk".
* Supported: "Raster Graphics formats: **GIF, JPEG, TIFF**. Vector Graphics formats: **AMF, BYU, DXF, COLLADA,
  JVX, OBJ, OFF, PLY, POV, STL, VTK, WMF**." → **no PNG, no EPS/PS, no SVG.**

**`Export`** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Export>:

```
Export( dest, data, opts )
Export( data, target=direct, opts )
```
* "The Export command exports data from Maple to an external file or to a string or ByteArray in the specified
  file format." `target=direct` "means that the data will be exported to a string or ByteArray to be returned.
  Note that target=direct requires `format` to be provided explicitly."
* Relevant formats in the documented list: **BMP, GIF, JPEG, PNG**, plus `LaTeX`, `MathML`, `MPL`, `MW`,
  `Jupyter`, `Text`, `CSV`, `JSON`, `XLSX`, `ZIP`, `Base64`, …
  **Not present: EPS, PS, SVG, PDF, HTML.**
* Compatibility: "The Export command was introduced in Maple 2015. … The `base` option was introduced in Maple
  2017." → available in 2018 and 2022. `target=direct` carries no compatibility note → inferred present since
  2015 (UNVERIFIED for 2018).
* Exact commands:
  ```maple
  Export( "/tmp/plot.png", plot(sin(x), x=-Pi..Pi), format="PNG" );
  data := Export( plot(sin(x), x=-Pi..Pi), target=direct, format="PNG" );   # string / ByteArray
  Export( "/tmp/doc.tex", expr, format="LaTeX" );
  Export( "/tmp/out.mpl", expr, format="MPL" );
  ```

### 4.5 Serialization summary matrix

| Target | 2018 | 2022 | Exact command |
|---|---|---|---|
| Plain text (1-D) | yes | yes | `lprint(x)`, or `interface(prettyprint=0): x;` |
| Formatted text | yes | yes | `printf("%a\n", x)`, `sprintf("%a", x)` |
| String | yes | yes | `convert(x, string)` |
| Session log file | yes | yes | `writeto("f.txt"):` … `writeto(terminal):`; `interface(echofile="f.txt")` (CLI only) |
| LaTeX string | yes | yes | `latex(x, output=string)` — **option sets differ (2021 rewrite)**; 2018 options UNVERIFIED |
| LaTeX file | yes | yes | `Export("f.tex", data, format="LaTeX")`; workspace-wide LaTeX is GUI-only |
| MathML string | yes | yes | `MathML:-ExportContent(x)` / `MathML:-Export(x)` |
| PNG / GIF / JPEG / BMP | yes | yes | `plotsetup(png, plotoutput="f.png"): plot(...):`; or `Export("f.png", p, format="PNG")` |
| EPS / PS | yes | yes | `plotsetup(ps, plotoutput="f.eps"): plot(...):` |
| SVG | **no** | **no** | no plot device, no `Export` format |
| Plot geometry (STL/PLY/DXF/…) | yes | yes | `plottools:-exportplot("f.stl", p)` |
| Worksheet file (`.mw`) | yes | yes | `ContentToString` + `FileTools:-Text:-WriteFile`; or `Worksheet:-WriteFile` |
| Worksheet → 1-D Maple text | yes | yes | `Worksheet:-WorksheetToMapleText("f.mw")` (2017+) |
| Worksheet → Jupyter | **no** | yes | `Worksheet:-WorksheetToJupyter("f.mw", outputfile="f.ipynb")` (2022+) |
| Worksheet → LaTeX | **no** | **no** | no in-kernel command; GUI File > Export As > LaTeX only |

---

## 5. Practical "run this cell and return the outputs" pattern

### 5.1 `;` vs `:` and echoing

* Maple's statement terminators: `;` evaluates **and displays** the result; `:` evaluates and **suppresses the
  display**. (This is core language behaviour; the Command-line interface inherits it. See the "Maple
  Statements"/"Input and Output in the Worksheet" material in the Programming Guide,
  <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>.)
* The **input** is echoed separately from the output, and that is controlled by `interface(echo)`:
  > `echo` — "0, 1, 2, 3, or 4 …
  > 0 - Do not echo under any circumstance.
  > **1 - Echo whenever the input or the output is not from or to the terminal, but do not echo as a result of a
  > read statement (the default).**
  > 2 - Echo whenever the input or the output is not from or to the terminal.
  > 3 - Echo only as a result of a `read` statement.
  > 4 - Echo everything.
  > **The echo option is superseded by `quiet`, so if `quiet=true`, no echo will occur.**"
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface>
  → In a piped/batch session (input not from a terminal) **input lines are echoed by default**, which is exactly
  what breaks naive output parsing. The CLI's `-s` option suppresses the prompt/banner
  (<https://www.maplesoft.com/support/help/maple/view.aspx?path=maple>; see `01-cli-batch.md` §1).
* `quiet` — "An interface constant that will suppress all auxiliary printing (logo, garbage collection messages,
  bytes used messages, and prompt)." Default `false`.
* `printbytes` — "Print the \"bytes used..\" message after every garbage collection (Command-line interface).
  Default value is true." → **another source of noise in CLI output**; turn it off.
* `prompt` — "The string that is printed when user input is expected." Default `"> "`.

Recommended preamble for a machine-parsed batch session:

```maple
interface(prettyprint=0):   # all results in lprint (1-D, parseable) form
interface(echo=0):          # no input echoing
interface(quiet=true):      # no logo / GC / bytes-used / prompt
interface(ansi=false):      # no ANSI colour escapes on UNIX (per 01-cli-batch.md)
interface(printbytes=false):
interface(warnlevel=0):     # or keep warnings and capture them deliberately (see 5.3)
```

### 5.2 Separating the value of the last expression from side-effect text

Because `;`/`:` output and `print`/`printf` output are interleaved on the same stream, use **explicit framing**
rather than positional parsing:

1. **Best:** don't parse the stream at all. Have the cell compute into a variable and return a value through a
   structured channel:
   * `DocumentTools:-RunWorksheet("cell.mw", outputs=[result])` → returns the named variables (documented form:
     for Maple worksheets it returns "an expression sequence" of the requested names; for Maple Flow it returns
     `name=value` pairs).
   * Or write the result with `FileTools:-Text:-WriteFile("out.txt", convert(value, string))` and read the file.
2. **Sentinel framing in the stream:** wrap the payload in unambiguous markers and set `prettyprint=0` so the
   payload is `lprint`-style 1-D:
   ```maple
   printf("<<<BEGIN>>>%a<<<END>>>\n", value);
   ```
   With `prettyprint=0`, the *implicit* `;` output is also lprint form, so a parser can treat the last
   `<<<BEGIN>>>…<<<END>>>` block as the value and everything else (warnings, messages) as side-effect text.
3. **Suppress the implicit display** of every statement with `:` and emit only your framed payload. Then the
   "last expression value" and the "side-effect text" never collide.
4. `%`/`%%`/`%%%` (ditto) and `print` are unreliable for machine use: `lprint` "returns NULL … the ditto commands,
   `%`, `%%`, and `%%%`, will not recall the output from lprint."

### 5.3 Capturing warnings and errors

| Control | Value | Effect |
|---|---|---|
| `interface(warnlevel)` | 0–4, default **3** | "0 - Suppress all warnings. 1 - Print only library-generated warnings. 2 - Print library- and kernel-generated warnings. **3 - Print library-, kernel-, and parser-generated warnings (the default).** 4 - Print library-, kernel-, parser-generated, and compatibility warnings." |
| `-w warningLevel` (CLI) | 0–4 | The command-line equivalent ("The `-w` (**warning level**) option specifies whether Maple should print certain warnings"). Not to be confused with a "worksheet" flag. |
| `interface(errorbreak)` | 0–3, default **1** | "Controls Maple's behavior when an error occurs while reading Maple commands from a file or redirected standard input … **1 - stop reading only on syntax errors** (default); 2 - stop reading on any error; 3 - stop reading on any error and show a stack trace." `errorbreak=1` means **a runtime error does not stop a batch script** unless you pass `-e2`/`-e3`. |
| `try … catch … finally … end try` | — | Structured trapping; catch strings select the exception. |
| `error`, `lasterror`, `tracelast` | — | Raise an exception / inspect the last error / get a stack trace. |
| `printlevel` | default **1** | "controls tracing of statements and procedures to a specified execution level (depth)… negative values will cause no information to be displayed." "When execution errors are encountered when printlevel > 2, a summary of calling routines, like that produced by tracelast, is also shown." For clean batch output keep it at the default or negative. |

**Recommended error-capture pattern** (per cell), which keeps the external client in control:

```maple
try
    result := <cell input>;
    printf("<<<OK>>>%a<<<END>>>\n", result);
catch:
    printf("<<<ERR>>>%a<<<END>>>\n", lasterror);
end try;
```
paired with launching `maple` with `-e2` (or `-e3`) so an uncaught error also aborts with a distinguishable exit
code (see `01-cli-batch.md` §1.3/§2).

### 5.4 `kernelopts` items worth knowing

<https://www.maplesoft.com/support/help/maple/view.aspx?path=kernelopts>

* Informational: `kernelopts(version)`, `kernelopts(mapledir)`, `kernelopts(bindir)`, `kernelopts(datadir)`,
  `kernelopts(dirsep)`, `kernelopts(gmpversion)`, `kernelopts(toolboxversion)`, `kernelopts(bytesalloc)`.
* Resource limits (relevant to a memory-light MCP worker): `kernelopts(cpulimit)`, `kernelopts(datalimit)`,
  `kernelopts(stacklimit)`, `kernelopts(gcfreq)`, `kernelopts(gcthreadmemorysize)`. Caveat, verbatim:
  > "The cpulimit, datalimit, and stacklimit limit variables must be used carefully. **When a limit is reached
  > Maple may shutdown without warning.** … On some platforms, including all Windows platforms, the detection of
  > limit violations is tied to garbage collection."
* Java-specific (a reminder that "Java" in Maple = *external calling*, not the worksheet engine):
  `kernelopts(jvmheaplimit)` — "The total amount of heap memory, in kibibytes, **the Java external calling virtual
  machine** is allowed to use. This option is effective only if the limitjvmheap kernel option is true." and
  `kernelopts(limitjvmheap)` — "If true, Maple limits the heap for the **Java external calling virtual machine**."

---

## 6. Pitfalls: things that silently require Java, the worksheet interface, or a display

1. **`Worksheet:-Display` / `Worksheet:-DisplayFile` — hard GUI requirement, explicitly documented:**
   "Important: The Display function cannot be used in the Command-line version of Maple."
   <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay>
2. **`Worksheet:-Comparator`** — "launches a Maplet interface": Maplets are Java GUI applications.
   <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FComparator>
3. **`Worksheet:-TableOfContents` and `Worksheet:-RemoveSection` silently open the GUI when the `destination`
   argument is omitted.** Always pass `destination` in automation.
   <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FTableOfContents> ·
   <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FRemoveSection>
4. **`DocumentTools:-InsertContent` / `Tabulate` / `GetProperty` / `SetProperty` / `Do`** all need an **open**
   worksheet/document, and `Do` "must query the GUI" (PG2018 §13.2). In a `cmaple` session there is no open
   document, so these will either error or silently do nothing useful.
5. **All 2-D / typeset math is GUI-only**, and the internal representation is unstable:
   > "Typeset or 2-D math is available with the standard worksheet interface." — PG2018 §10.7
   > "Extended typesetting output is produced by the Typeset command… This output, **which is recognized by the
   > Maple GUI, is not intended to be altered by users. Because the structure is meant for internal use, the tag
   > names and format of the structure may change from one Maple release to another.**" — PG2018 §10.7
   Consequence: `WorksheetToMapleText(includeoutput)` emits monstrous `Typesetting:-mtable(...)` comments for
   2-D output; do not try to parse those as results (they are inert typesetting trees, not values).
6. **Command-line plotting is a character plot by default:** "The command-line interface produces a simple
   character plot. Most plotting options are not supported in this interface."
   <https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Finterface>
   You must call `plotsetup(<file device>)` **before** the plot call; `inline`, `window`, `x11`, `maplet` devices
   need a display.
7. **`gdi` is not usable in the CLI** (plotsetup page). `plotsetup` and `plot/device` contradict each other on the
   Standard Worksheet case — do not rely on `gdi` anywhere automated.
8. **No SVG, no EPS-in-`Export`:** no `svg` plot device and no `svg`/`eps`/`ps` in `Export`'s format list. Use
   `plotsetup(ps, …)` for EPS and `Export(..., format="PNG"|"GIF"|"JPEG")` for raster.
9. **`-x` / `xmaple` / `-h`** start the GUI (and `-h` "tells Maple to open the GUI help browser") — never pass
   them in automation. (See `01-cli-batch.md` §1.3.)
10. **CLI output noise by default:** `echo` default 1 (input echoed when not a terminal), `quiet` default false,
    `printbytes` default true in the Command-line interface ("bytes used.." messages), and ANSI colour ON by
    default on UNIX. Any parser must set `interface(echo=0, quiet=true, printbytes=false, ansi=false)` or strip.
11. **`interface(echofile=…)` is command-line-only** — it is the one interface variable explicitly marked
    "(Command-line interface only.)", so it cannot be used to capture a GUI session.
12. **Version traps in this area:**
    * `Worksheet:-WorksheetToJupyter` — **2022 only**.
    * `Worksheet:-TableOfContents`, `Worksheet:-RemoveSection` — **2020+, so 2022 only**.
    * `DocumentTools:-SetDocumentProperty(..., mwfile, outfile)` — **2021+, so 2022 only**.
    * `Worksheet:-Convert(..., outputfilename, ...)` — **2025+**; not in 2018 or 2022.
    * `latex` — rewritten in **2021**; the 2018 option set is different (UNVERIFIED which options).
    * `Worksheet:-WorksheetToJupyter`'s notebook metadata embeds the running Maple version, so 2022 and 2026
      produce different `version`/`display_name` strings.
13. **The `.mw` storage vocabulary is explicitly unstable:** "The storage format for Maple worksheets is not
    documented, and is subject to change."
    <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>
14. **`Worksheet:-WriteFile` / `Worksheet:-ToString` only perform a surface check** ("It is assumed that the XML
    document that is written … represents a valid worksheet. (Maple performs only a surface check.)") — a
    hand-built tree can be written successfully and still be rejected on open.
15. **`RunWorksheet` caveats:** it runs in a **new engine** (no shared state — pass values via `var_init`, and
    `eval` procedures/tables/matrices first); it needs the `InputSectionTitle` document property for `var_init`;
    without a top-level `return` it returns `NULL`.

---

## 7. Explicit gaps / UNVERIFIED list (test these on the real installs)

1. Whether `Worksheet` (`ReadFile`, `Convert`, `WorksheetToMapleText`, `ToString`, `FromString`, `WriteFile`)
   actually loads and runs in a `maple`/`cmaple` command-line session in **2018** and **2022**. Maplesoft never
   states it; only `Display` carries an explicit prohibition. **Smoke-test first.**
2. The exact 2018 `Worksheet` package command list (archive had no 2018 snapshot; the list is deduced).
3. The exact 2018 `DocumentTools` package command list (nearest snapshot is 2019‑10‑19); specifically whether
   `Retrieve` existed in 2018.
4. Whether `DocumentTools:-Retrieve` runs headless, and whether it reads stored `<Output>` or re-evaluates the
   labelled expression.
5. The exact `latex` option set in **Maple 2018** (pre-2021 implementation).
6. Which `Worksheet:-Convert` `format` values existed in 2018 and 2022 (`_Inert`, `jupyter`, `procedure` are
   candidates for being 2025 additions).
7. Whether `Export(..., target=direct)` existed in 2018 (no compatibility note either way).
8. Whether `MathML:-ExportModified` behaves sensibly in 2018/2022 (it targets Maple Calculator / Maple Learn).
9. The internal mechanism of `DocumentTools:-RunWorksheet`'s "new engine" and whether it ever touches the Java VM.
10. Whether per-group `WorksheetToMapleText` on a `Group` sub-tree works at all (undocumented usage).
11. Whether `DocumentTools:-ContentToString` / `DocumentTools:-Layout:-*` are truly GUI-free (strongly implied,
    never stated).
12. Whether `Tabulate(..., output=XML)` is GUI-free.

---

## 8. Sources

**Live Maplesoft online help** — the `…/support/help/maple/view.aspx?path=<P>` URL form. *These pages reflect
**Maple 2026** today; per-command version facts were taken from each page's own `Compatibility` section.*

* `Worksheet` package overview — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>
* `Worksheet:-Comparator` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FComparator>
* `Worksheet:-Convert` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FConvert>
* `Worksheet:-Display` / `DisplayFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay>
* `Worksheet:-FromString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FFromString>
* `Worksheet:-ReadFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FReadFile>
* `Worksheet:-RemoveSection` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FRemoveSection>
* `Worksheet:-TableOfContents` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FTableOfContents>
* `Worksheet:-ToString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FToString>
* `Worksheet:-WorksheetToJupyter` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter>
* `Worksheet:-WorksheetToMapleText` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText>
* `Worksheet:-WriteFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWriteFile>
* `DocumentTools` package overview — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools>
* `DocumentTools:-Components` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FComponents>
* `DocumentTools:-ContentToString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FContentToString>
* `DocumentTools:-Do` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FDo>
* `DocumentTools:-GetDocumentProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetDocumentProperty>
* `DocumentTools:-GetProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetProperty>
* `DocumentTools:-InsertContent` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FInsertContent>
* `DocumentTools:-Layout` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FLayout>
* `DocumentTools:-Retrieve` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRetrieve>
* `DocumentTools:-RunWorksheet` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FRunWorksheet>
* `DocumentTools:-SetDocumentProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FSetDocumentProperty>
* `DocumentTools:-SetProperty` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FSetProperty>
* `DocumentTools:-Tabulate` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FTabulate>
* `DocumentTools:-GetContent` — **"Help Document not found"** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools%2FGetContent>
* `convert/MathML` — **"Help Document not found"** — <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert%2FMathML>
* `convert` (target list) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert>
* `convert/string` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=convert%2Fstring>
* `interface` (echo, quiet, prettyprint, errorbreak, warnlevel, prompt, printbytes, echofile, ansi,
  screenwidth/height) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface>
* `kernelopts` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=kernelopts>
* `latex` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=latex>
* `lprint` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=lprint>
* `MathML` package overview — <https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML>
* `MathML:-ExportContent` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML%2FExportContent>
* `plot/device` (device list; gdi note; "assume Standard Worksheet") —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Fdevice>
* `plot/interface` ("The command-line interface produces a simple character plot…") —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Finterface>
* `plot/options` (complete option list — **no `output`**) —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=plot%2Foptions>
* `plotsetup` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=plotsetup>
* `plottools:-exportplot` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=plottools%2Fexportplot>
* `Export` (supported-format list incl. PNG/GIF/JPEG/BMP; `target=direct`) —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Export>
* `FileTools` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=FileTools>
* `printlevel` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=printlevel>
* `printf` / `sprintf` (format codes `%a` `%A` `%q` `%Q` `%m` `%v` `%V` `%P`, `L`/`Z` modifiers) —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=printf> ·
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=sprintf>
* Structure Worksheets with Execution Groups (execution-group definition and the Enter gesture) —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fdocumenting%2Fexecutiongroups>
* Execute Selection (GUI) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fexpressions%2Fexecuteselection>
* What's New in Maple 2022 / Index of New Commands and Packages —
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates%2Fv2022> ·
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates%2FMaple2022%2Findex>
* `writeto` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=writeto>

**Archived (Wayback Machine) help pages — used for version scoping**

* `Worksheet` package overview, snapshot **2022-01-20** (proves `RemoveSection`/`TableOfContents` present and
  `WorksheetToJupyter` absent at that date):
  <https://web.archive.org/web/20220120060048id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>
* `DocumentTools` package overview, snapshot **2019-10-19** (nearest available to 2018):
  <https://web.archive.org/web/20191019223718id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools>
* `DocumentTools:-RunWorksheet`, snapshot **2019-12-10** (`inheritlibname` = "cmaple only"; "runs headless"):
  <https://web.archive.org/web/20191210010501id_/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools/RunWorksheet>
* `DocumentTools:-RunWorksheet`, snapshot **2022-01-19** (same, plus `outputs`):
  <https://web.archive.org/web/20220119111045id_/https://www.maplesoft.com/support/help/Maple/view.aspx?path=DocumentTools%2FRunWorksheet>
* Wayback availability API result for `DocumentTools/Retrieve` at 2018-06-01 → **closest snapshot is 2021-05-15**
  (i.e. no 2018 snapshot exists): <https://archive.org/wayback/available?url=maplesoft.com/support/help/maple/view.aspx%3Fpath%3DDocumentTools/Retrieve&timestamp=20180601>

**Official Maplesoft PDFs**

* *Maple 2018 Programming Guide* (§5 p. 189–190: top-level `return` + `DocumentTools:-RunWorksheet`; §10.3
  "Input and Output in the Worksheet"; §10.7 "2-D Math"; §13.2 "Programming Embedded Components" pp. 461–462:
  the `DocumentTools` command list and "the Do command must query the GUI"; §14.4 CLI; §16.6 resources):
  <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
* *Maple Programming Guide* (linked by Maplesoft as both the 2021 and the 2022 guide) —
  <https://www.maplesoft.com/documentation_center/maple2021/ProgrammingGuide.pdf>
* *Maple 2018 User Manual* — <https://www.maplesoft.com/documentation_center/maple2018/UserManual.pdf>
* *Maple 2022 User Manual* — <https://www.maplesoft.com/documentation_center/maple2022/UserManual.pdf>

**Other**

* Real `.mw` worksheet used to confirm `<Label-Scheme value="2" prefix=""/>` and
  `<Group labelreference="L1" …>` (fetched and inspected directly):
  <https://raw.githubusercontent.com/abuchel-hepth/cascading-gauge-theory-DFP-stability/refs/heads/main/attachement_formulars.mw>
* Cross-reference: `research/04-file-formats.md` in this same directory (`.mw` XML vocabulary, 1-D vs 2-D input,
  conversion recipes).
