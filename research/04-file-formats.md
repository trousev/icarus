# Maple File Formats — Research Notes for an MCP Server that Creates/Inspects/Edits Maple Worksheets

Scope: file *formats* for a locally installed Maple **2018** and Maple **2022** (Linux). Target use case: an MCP server (Node/Python) that must **create, inspect and edit** worksheets on disk, plus convert them.

Evidence policy: every non-obvious claim has a URL. Verbatim evidence (file listings, XML, code) is in fenced blocks. Claims that could not be confirmed from a primary source are explicitly marked **UNVERIFIED**. Version-specific claims are labelled **2018** / **2022**. All empirical file evidence was obtained by downloading real `.mw`/`.mws`/`.mpl` files from public repositories (harvested with GitHub code search) and inspecting bytes directly; **no local Maple was installed or run** for this report (see §9 for the places where running Maple would close gaps).

---

## 0. Executive summary of the format findings

1. **A Maple 2018/2022 `.mw` worksheet is a single, plain-text, well-formed UTF-8 XML file — not a ZIP/OPC container, not binary.** Verified on real files written by Maple 2018.1 and 2022.0/2022.2: they start with `<?xml version="1.0" encoding="UTF-8"?>`, are `XML 1.0 document, ASCII text` per `file(1)`, are *not* zip files (`unzip -l` fails, Python `zipfile.is_zipfile()` is `False`), and parse with a stock XML parser.
2. The root element is `<Worksheet>`; the **first child is `<Version major="…" minor="…"/>`**, where `major` is the Maple release (e.g. `2018`, `2022`) and `minor` is the point/update release (e.g. `2022.2` → `minor="2"`).
3. The published help pages **[Worksheet/DTD](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDTD)** and **[Worksheet/Schema](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FSchema)** do **NOT** describe the modern `.mw` vocabulary. They describe the legacy Maple-8-era *`maple8_xml`* representation of the **classic** worksheet (lower-case `worksheet`, `version`, `section`, `exchange`, `para`, `text`, `mapletext`). Real `.mw` files use a **different, undocumented** vocabulary (`Worksheet`, `Version`, `Group`, `Input`, `Output`, `Text-field`, `Equation`, `Plot`, `Section`, `Title`, …). Maplesoft states the storage format is *undocumented and subject to change*.
4. Editing `.mw` outside Maple is **feasible and simple structurally** (it is just XML), but **not API-stable**: no schema is published for the modern vocabulary. Crucially, **input exists in two encodings**: 1-D input is plain text in the XML, while **2-D (typeset) input is an empty `Text-field` plus an `<Equation>` whose payload is a private nested-base64 Maple serialization**. Measured over 26 real worksheets: **190 of 566 non-empty input regions (~34 %) are 2-D-only and cannot be read by an external parser**; some real worksheets are 100 % 2-D. The safest thing for an MCP server to *emit* is 1-D `Text-field` input inside `Group`/`Input`; to *read* 2-D input you must let Maple linearise it (`Worksheet:-WorksheetToMapleText`).
5. The unmaintained 2015-era `mw2txt.py` (external `.mw` reader, §4.1) was run **unmodified** against a real Maple **2022.2** worksheet and extracted its 1-D input correctly — evidence that the external reading contract did not change from 2015 through 2022 for 1-D content, and that this is a viable approach for an MCP server.
6. `.mws` (classic worksheet) is a **brace-delimited text** format (`{VERSION 6 0 "IBM INTEL LINUX" "6.0" }…{SECT 0 {EXCHG {PARA … {MPLTEXT …}}}}`), not XML. **Maple 2018 still ships the Classic Worksheet interface** (can open/save `.mws`); **Maple 2022 does not** — the classic interface "was last released with Maple 2021 and is now obsolete". Maple 2022 can still read `.mws` only through the Worksheet Migration (`.mws` → `.mw`) facility.
7. The `.mw` format is **not compressed or zipped even for large files with embedded plots** (verified on 700 KB files containing many plots/equations): plots and 2-D math are stored as **base64 text inside the XML**.
8. Best programmatic conversion path is **in-Maple**, not outside: `Worksheet:-Convert`, `Worksheet:-ReadFile/WriteFile/ToString`, `Worksheet:-WorksheetToMapleText`, `Worksheet:-WorksheetToJupyter`, run headless with `maple -q -c '…'`. There is **no** worksheet-file CLI flag; `maple -w` is *warning level*, not "worksheet".
9. **`Worksheet:-WorksheetToJupyter` was introduced in Maple 2022** (so it does not exist in 2018); `Worksheet:-TableOfContents` and `Worksheet:-RemoveSection` were introduced in **Maple 2020** (absent in 2018); `Worksheet:-WorksheetToMapleText` exists since **Maple 2017**.

---

## 1. Inventory of Maple document/file formats

Source for the "known formats" list: [Formats](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats) and [Formats/All](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FAll). The official per-extension descriptions are the `Formats/<EXT>` help pages.

| Extension | What it is | Text / binary | Introduced | Primary source |
|---|---|---|---|---|
| `.mw` | **Maple Worksheet / document** — the native Standard-Worksheet format. XML-based. | **Plain text XML** (UTF-8, single file, verified) | "introduced with **Maple 9**, replacing the Maple Classic Worksheet (MWS) format" | [Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW) |
| `.mws` | **Maple Classic Worksheet** — legacy, brace-delimited text format of the Classic Worksheet interface. | **Text** (brace syntax, verified) | Legacy Maple V-era; present through Maple 2021 (classic interface last released in 2021) | [Formats/MWS](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMWS), [versions](https://www.maplesoft.com/support/help/maple/view.aspx?path=versions) |
| `.mpl` | **Maple Language File** — Maple source/program text; "simply text files containing statements conforming to the syntax of the Maple language". Executed with `read`. | **Text** | n/a (always existed) | [Formats/MPL](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMPL) |
| `.mla` | **Maple Library Archive** — a *repository*: binary archive of Maple objects (expressions, procedures, modules) in Maple's internal format. | **Binary** | Single-file `.mla` is the modern form; `.lib`+`.ind` is the older form | [Formats/MLA](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMLA), [repository](https://www.maplesoft.com/support/help/maple/view.aspx?path=repository) |
| `.lib` **+** `.ind` | Two-file repository: `.lib` holds data, `.ind` is the index. "both files must be present"; first 1024 bytes of `.lib`/`.mla` is a header. `march('convert', …)` converts between `.mla` and `.lib`. | **Binary** | `.lib`/`.ind` = "the standard format used by **Maple 9 and earlier** releases" | [repository](https://www.maplesoft.com/support/help/maple/view.aspx?path=repository), [march](https://www.maplesoft.com/support/help/maple/view.aspx?path=march) |
| `.m` | **Maple Internal Format** — compact binary serialization of Maple objects/procedures. Written by `save`, read by `read`. Distinguished from a language file *only* by the `.m` ending. | **Binary** | long-standing | [Formats/m](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2Fm) |
| `.maple` | **Maple Workbook** — bundles many worksheets + attachments + saved variables. **"The underlying file format is an SQLite database."** | **Binary (SQLite 3)** | Introduced in the **Maple 2016** timeframe (Maplesoft published "What's New in Maple 2016 – Workbook"); documented as a file type in every PG 2018/2022 | [Formats/Maple](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMaple), PG2018 §10.4 "Files Used by Maple" |
| `.maplet` | **Maplet** application file (runnable by MapletViewer / command-line Maple). | text (Maple language) | long-standing | PG2018/2022 §10.4 |
| `.hdb` | **Maple Help Database** — "deprecated"; "replaced in **Maple 18** by the Maple Help format (`.help`)". | binary | legacy (pre-Maple 18) | [Formats/HDB](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FHDB) |
| `.help` | **Maple Help** database. "introduced in **Maple 18** and replaces the deprecated hdb format". | binary | **Maple 18** | [Formats/Help](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FHelp) |
| `.mwz` | Listed by Maple's Linux MIME definition together with `.mw`/`.mla`/`.maple`/`.mws` as `application/x-maple-worksheet`. **Not documented in Maple help**; `path=mwz` returns "Help Document not found". Likely a compressed/zip worksheet variant. | **UNVERIFIED** | **UNVERIFIED** | MIME glob list (§4.2); `path=mwz` 404 |
| (export targets of `.mw`) | `.html` (+ MathML), `.tex` (LaTeX), `.mpl` (Maple input), `.maplet`, Maple text, plain text, `.pdf`, `.rtf`, `.zip` (Maple T.A.), `.ipynb` (Jupyter) | — | — | [Export a Worksheet](https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fmanaging%2Fexport) |

Note the **naming trap**: `.maple` is a *Workbook* (SQLite), but RosettaCode and other code collections also use `.maple` for *Maple language* source (`acmeism/RosettaCodeData`, e.g. `set.maple`). Any MCP file-type detector must sniff content (SQLite magic `SQLite format 3\0` vs `> S := ...` / `proc(`), not just the extension.

---

## 2. The `.mw` format in detail

### 2.1 It is a single plain-text XML file (NOT ZIP/OPC, NOT binary)

Maplesoft describes it as XML-based and as a **single** document format:

> "MW (Maple Worksheet) is the native format for Maple documents and worksheets.
> It is an XML-based format and was introduced with Maple 9, replacing the Maple Classic Worksheet (MWS) format."
> — [Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW)

There is **no** `maple.xml`, no `_rels/.rels`, no `[Content_Types].xml` part: those are OOXML/ODF concepts that do not apply here. Empirical proof on files written by Maple 2018.1 and 2022.2:

```
$ file oselin__MDS.mw kenoticpurge__b3d_element.mw
oselin__MDS.mw:               XML 1.0 document, ASCII text, with very long lines (7570)
kenoticpurge__b3d_element.mw: XML 1.0 document, ASCII text, with very long lines (6328)

$ xxd -l 48 oselin__MDS.mw
00000000: 3c3f 786d 6c20 7665 7273 696f 6e3d 2231  <?xml version="1
00000010: 2e30 2220 656e 636f 6469 6e67 3d22 5554  .0" encoding="UT
00000020: 462d 3822 3f3e 0a3c 576f 726b 7368 6565  F-8"?>.<Workshee

$ unzip -l oselin__MDS.mw
Archive:  oselin__MDS.mw
  End-of-central-directory signature not found.  Either this file is not
  a zipfile, or it constitutes one disk of a multi-part archive.

$ python3 -c "import zipfile; print(zipfile.is_zipfile('oselin__MDS.mw'))"
False
```

`oselin/MDS docs/maple/MDS.mw` is a **40 KB** file (`<Version major="2022" minor="2"/>`); `lukaswittmann/molecular-dynamics-sim min_pot.mw` is **81 KB** and contains 3 plots; `ebertolazzi/Clothoids maple/circle_circle_intersection.mw` is **258 KB** with 124 equations and a plot — all still a single plain XML text file. So **large/plot-bearing worksheets are not zipped**.

Also: standard XML parsers accept these files unmodified (verified with Python `xml.etree.ElementTree` on the 2018 and 2022 samples).

### 2.2 The `<Version>` element (format version detection)

`<Version major="…" minor="…"/>` is the first child of `<Worksheet>`. Empirically harvested from real files:

| File (repo path) | `<Version>` |
|---|---|
| `openturns/openturns validation/src/Airy.mw` | `major="13" minor="0"` |
| `hakaru-dev/hakaru maple/NewSLO.mw` | `major="2015" minor="1"` |
| `hakaru-dev/hakaru maple/ForTesting.mw` | `major="18" minor="2"` |
| `hakaru-dev/hakaru maple/fun-fact.mw` | `major="2016" minor="1"` |
| `grtensor/grtensor worksheets/Overview.mw` | `major="2017" minor="0"` |
| `grtensor/grtensor worksheets/intros/ReisNord.mw` | `major="2017" minor="3"` |
| `su2code/SU2 …/CMMSNSUnitQuadSolution.mw` | `major="2018" minor="1"` |
| `ebertolazzi/Clothoids maple/circle_circle_intersection.mw` | `major="2018" minor="1"` |
| `ccshan/prob-school maple/LinearRegression.mw` | `major="2019" minor="1"` |
| `dmicha16/waterlab_mpc courant_number.mw` | `major="2019" minor="2"` |
| `GhazaleZe/Artificial-Intelligence ghazale.mw` | `major="2020" minor="2"` |
| `Beatthezombie/SphericalHarmonicsFromScratch maple/sh.mw` | `major="2020" minor="2"` |
| `ebertolazzi/Clothoids maple/DUBINS.mw` | `major="2021" minor="2"` |
| `amirbaharvand66/continuum_mechanics codes/example_3_20_2.mw` | `major="2022" minor="0"` |
| `lukaswittmann/molecular-dynamics-sim min_pot.mw` | `major="2022" minor="0"` |
| `kenoticpurge/Corotational-Beam-Elements …/b3d_element.mw` | `major="2022" minor="2"` |
| `oselin/MDS docs/maple/MDS.mw` | `major="2022" minor="2"` |
| `martyushev/eliminationTemplates _common.mw` | `major="2023" minor="1"` |
| `ebertolazzi/Clothoids maple/derivative.mw` | `major="2024" minor="2"` |

Conclusions:
* `major` = product release identifier. For Maple ≤ 18 that is the integer (`13`, `15`, `18`); from **Maple 2015** onward Maplesoft's product name is year-based and so is `major` (`2015`, `2016`, … `2026`). Note **Maple 18 (2014) ≠ Maple 2018**; do not confuse them.
* `minor` = point/update release: `2018` + Maple 2018.1 → `minor="1"`; `2022` + Maple 2022.2 → `minor="2"`; `2017.3` → `minor="3"`.
* The published XSD's `VersionType` constrains `major` to integer ≥ 4 and `minor` to 0–9 — consistent with observed values ([Worksheet/Schema](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FSchema)):

```
    <!-- Version number types -->
    <xsd:simpleType name="VersionMajorType">
        ...
        <xsd:restriction base="xsd:integer">
            <xsd:minInclusive value="4"/>
        </xsd:restriction>
    </xsd:simpleType>
    <xsd:simpleType name="VersionMinorType">
        ...
        <xsd:restriction base="xsd:integer">
            <xsd:minInclusive value="0"/>
            <xsd:maxInclusive value="9"/>
        </xsd:restriction>
    </xsd:simpleType>
```

### 2.3 Document skeleton

Raw head of a real Maple 2022.2 worksheet (`oselin/MDS docs/maple/MDS.mw`) — **verbatim**, line breaks preserved, long attribute lists elided with `…`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Worksheet>
<Version major="2022" minor="2"/>
<Label-Scheme value="2" prefix=""/>
<View-Properties presentation="false" autoexpanding_sections="true" UserProfileName="Maple Default Profile" NumericFormat-ApplyInteger="true" NumericFormat-ApplyRational="true" NumericFormat-ApplyExponent="false" editable="true">
<Hide name="Group Range"/>
</View-Properties>
<MapleNet-Properties prettyprint="3" warnlevel="3" compactdisplay="false" preplot="" helpbrowser="standard" displayprecision="-1" echo="1" scientificx="true" unitattributes="&quot;fontweight&quot; = &quot;bold&quot;" imaginaryunit="I" longdelim="true" … plotdevice="inline" errorbreak="1" plotoptions="" plotdriver="opengl" quiet="false" … format="worksheet" … prompt="&gt; " verboseproc="1" latexwidth="8.0" ShowLabels="true"/>
<Styles>
<Font name="Heading 1" background="[255,255,255]" bold="true" executable="false" family="Montserrat" foreground="[195,69,11]" italic="false" opaque="false" readonly="false" size="20" subscript="false" superscript="false" underline="false" placeholder="false"/>
<Font name="Text Output" … />
<Layout name="Heading 1" alignment="left" bullet="none" firstindent="0" … />
<Layout name="Text" … />
<Pencil-style … />
<Highlighter-style … />
</Styles>
<Startup-Code>…</Startup-Code>
<Task-table>
<Task-category>
<Task>…</Task>
</Task-category>
</Task-table>
…
<Section collapsed="false" isCollapsible="true" drawButton="true" MultipleChoiceAnswerIndex="-1" MultipleChoiceRandomizeChoices="false" TrueFalseAnswerIndex="-1" EssayAnswerRows="5" EssayAnswerColumns="60"><Title><Text-field style="Heading 1" layout="Heading 1">Generation of points</Text-field></Title>
<Group hide-input="false" labelreference="L23" drawlabel="true" applyint="true" applyrational="true" applyexponent="false">
<Input><Text-field prompt="&gt; " style="Maple Input" layout="Normal">X := &lt;&lt;0,0,0&gt;|&lt;2,14,6&gt;|&lt;7,9,12&gt;|&lt;5,1.5,2&gt;|&lt;5.3,4.2,1.1&gt;&gt;;</Text-field>
</Input>
<Output><Text-field style="2D Output" layout="Maple Output"><Equation executable="false" style="2D Output" display="LUkqbWNvbXBsZXRlRzYjL0krbW9kdWxlbmFtZUc2IkksVHlwZXNldHRpbmdHSShfc3lzbGliR0YnNiQtSSVtcm93R0YkNiYtSSNtaUdGJDYlUSJYRicvJSdpdGFsaWNHUSV0cnVlRicvJSxtYXRodmFyaWFudEdRJ2l0YWxpY0YnLUkjbW9HRiQ2LVEpJkFzc2lnbjtGJy9GNlEnbm9ybWFsRicvJSZmZW5jZUdRJmZhbHNlRicvJSpzZXBhcmF0b3JHRkAvJSlzdHJldGNoeUdGQC8lKnN5bW1ldHJpY0dGQC8lKGxhcmdlb3BHRkAvJS5tb3ZhYmxlbGltaXRzR0ZALyUnYWNjZW50R0ZALyUnbHNwYWNlR1EsMC4yNzc3Nzc4ZW1GJy8lJ3JzcGFjZUdGTA…"/>
</Text-field>
</Output>
</Group>
…
</Section>
<Group labelreference="L3" drawlabel="true" applyint="true" applyrational="true" applyexponent="false">
<Input><Text-field prompt="&gt; " style="Maple Input" layout="Normal"></Text-field>
</Input>
</Group>
</Worksheet>
```

Note there is **no trailing newline**, no XML declaration comment, no DOCTYPE, and no namespace declaration on `<Worksheet>` in real files. The file ends with `</Worksheet>` (verified: last 300 chars of the 2022.2 file end `…</Group>\n</Worksheet>`).

**Invariants across all 26 harvested files (Maple 13 → 2024):** the root element is exactly `<Worksheet>` with **zero attributes and no namespace**, and the first three children are always, in order, `Version`, `Label-Scheme`, `View-Properties`:

```
root='Worksheet' root_attrs={} first3=['Version', 'Label-Scheme', 'View-Properties']   # every sample
```

### 2.4 Element vocabulary, as actually used

Counting distinct element names across 26 real `.mw` files (Maple 13 → 2024), the vocabulary is stable:

| Element | Role |
|---|---|
| `Worksheet` | document root |
| `Version` | `major`/`minor` writer version (first child) |
| `Label-Scheme`, `View-Properties`, `MapleNet-Properties`, `Styles` (`Font`, `Layout`, `Pencil-style`, `Highlighter-style`), `Startup-Code`, `Task-table`/`Task-category`/`Task` | fixed prologue/boilerplate emitted by Maple on save |
| `Section` + `Title` + `Text-field` | a document section and its heading (`<Section collapsed="false" isCollapsible="true" drawButton="true" …><Title><Text-field style="Heading 1" …>…</Text-field></Title>`) |
| `Group` | **execution group** (one input region + its outputs). Attributes seen: `hide-input`, `labelreference` (`L1`, `L23`, …), `drawlabel`, `applyint`, `applyrational`, `applyexponent`, and `view="code"` or `view="presentation"` |
| `Input` | wrapper for the group's input content |
| `Output` | wrapper for the group's output content |
| `Text-field` | a run of text; `style` selects semantics (`Maple Input`, `Maple Output`, `2D Output`, `Text`, `Heading 1`, `Code`, `2D Math`, …) and `layout` the paragraph layout. 1-D Maple input is stored **as plain text in the element body** |
| `Equation` | 2-D math (input or output): `executable="true"` / `"false"`, `style` = `2D Input` / `2D Output` / `2D Math` / `Code`, `input-equation=""`, and a **base64 `display="…"` attribute**; its **text content is a second base64 payload** |
| `Plot` | an embedded plot: attributes (`type="two-dimensional"`, `height`, `width`, `plot-scale`, `gridlinevisibility`, `legendvisibility`, `input="…"`) and a large **base64 text body** |
| `Presentation-Block`, `Hide`, `Hyperlink`, `RTable`, `Zoom` | other observed nodes |

Structural mapping (the important part for an MCP server):

* **execution group** = `<Group>` … `</Group>`
* **input** = `<Group><Input>…</Input></Group>`; the payload is a `<Text-field style="Maple Input" layout="Normal" prompt="&gt; ">` whose text is the 1-D Maple source
* **output** = `<Group><Output>…</Output></Group>`; payload is `<Text-field style="2D Output" layout="Maple Output">` containing one or more `<Equation>` (2-D/pretty-printed) or plain text
* **text paragraph** = a `<Text-field style="Text" layout="Text">` (often inside `<Group>` with `view="presentation"`)
* **section** = `<Section>` with a `<Title>`; groups live inside sections
* **plot** = `<Plot>` with base64 body

### 2.5 How much of a real worksheet is externally readable? (measured)

This is the single most important practical caveat. Maple stores input in two ways:

* **1-D input** (a.k.a. "Maple Input"/"Code") → plain text **directly in the element body**: `<Text-field prompt="&gt; " style="Maple Input" layout="Normal">restart; …</Text-field>` — trivially readable and writable externally.
* **2-D input** (typeset math, the default in the Standard Worksheet for many users) → an **empty** `Text-field` containing `<Equation executable="true" style="2D Input"|"Code" input-equation="" display="<base64>">` — **not** plain text.

Measuring every `Group/Input/Text-field` node in the 26 harvested worksheets (Maple 13 → 2024):

```
file                                                 ver    1D-text  2D-only  both empty
Beatthezombie/SphericalHarmonicsFromScratch sh.mw    2020         7       0     0     8
GhazaleZe/Artificial-Intelligence ghazale.mw         2020         0       6     0     0
amirbaharvand66/continuum_mechanics ex3_20_2.mw      2022        14       0     0     1
ccshan/prob-school LinearRegression.mw               2019        21       0     0     0
dmicha16/waterlab_mpc courant_number.mw              2019         0       8     0     0
ebertolazzi/Clothoids DUBINS.mw                      2021        52       0     0     1
ebertolazzi/Clothoids derivative.mw                  2024        35       1     0     0
ebertolazzi/Clothoids circle_circle_intersection.mw  2018        70       1     0     1
grtensor/grtensor "RN Divergence.mw"                 2018         0       9     0     0
grtensor/grtensor Overview.mw                        2017         0      31     0    45
grtensor/grtensor ReisNord.mw                        2017        11      11     0     6
hakaru/hakaru NewSLO.mw                              2015        29       0     0     6
hakaru/hakaru ForTesting.mw                          18          11       0     0     4
hakaru/hakaru fun-fact.mw                            2016        17       0     0     1
hakaru/hakaru march21.mw                             18          33       0     0     6
kenoticpurge/… SectionParameters.mw                  2022         0      10     0     0
kenoticpurge/… b3d_element.mw                        2022         0      21     0     0
lukaswittmann/molecular-dynamics-sim min_pot.mw      2022         0       8     0     0
martyushev/eliminationTemplates F_IOD.mw             2023        12       1     0    14
martyushev/eliminationTemplates _common.mw           2023        22       1     0    13
openturns/openturns Airy.mw                          13           1       2     0     0
oselin/MDS MDS.mw                                    2022         3       0     0     2
su2code/SU2 CMMSNSUnitQuadSolution.mw                2018         0      79     0     0
TOTAL (26 files)                                               376     190     0   111
```

**≈34 % of non-empty input regions (190 of 566) are 2-D-only and therefore not readable by an external XML parser.** Some real worksheets (SU2's, `grtensor`'s "RN Divergence", `kenoticpurge`'s) are **100 % 2-D** — an external tool sees an outline but no source code. There is no plain-text mirror anywhere in the file: for a 2-D input, the `display` attribute and the element text content both carry the **same** private nested-base64 typeset payload:

```
Text-field style='Code' text=''
Equation attrs: {'executable': 'true', 'style': 'Code', 'input-equation': '',
                 'display': 'LUklbXJvd0c2Iy9JK21vZHVsZW5hbWVHNiJJLFR5cGVzZXR0aW…'}
  display attr: b64len=564 decoded[:140]=b'-I%mrowG6#/I+modulenameG6"I,TypesettingGI(_syslibGF\'6)-I#miGF$6&Q%withF\'/%\'italicGQ%trueF\'/%,mathvariantGQ\'italicF\'-I(mfence'
  text content: b64len=564 decoded[:140]=b'-I%mrowG6#/I+modulenameG6"I,TypesettingGI(_syslibGF\'6)-I#miGF$6&Q%withF\'/%\'italicGQ%trueF\'/%,mathvariantGQ\'italicF\'-I(mfence'
```

So: **to read 2-D input externally you must let Maple linearise it** — `Worksheet:-WorksheetToMapleText` does exactly that (its help example turns a 2-D worksheet into `m := Matrix(2,2,[[-4, sqrt(17)], [ln(45), 61/4]]);`), and `Worksheet:-Convert(format=mapletext)` / `WorksheetToJupyter` likewise.

**Empirical cross-check that the 1-D path still works on modern files:** the unmaintained 2015-era `mw2txt.py` (§4.1) was run **unmodified** with lxml 6.1.3 against a real Maple **2022.2** worksheet and correctly extracted the input:

```
$ python3 mw2txt.py -m /tmp/oselin__MDS.mw        # Maple 2022.2 worksheet
restart:with(LinearAlgebra):
read("./lib/mds-lib.maplet"):
c_set := ColorTools:-GetPalette("spring");

X := <<0,0,0>|<2,14,6>|<7,9,12>|<5,1.5,2>|<5.3,4.2,1.1>>;
d := 
```

The same script produced **no output** for `su2code/SU2` (Maple 2018.1) and `kenoticpurge/b3d_element.mw` (Maple 2022.2) because those files' inputs are 100 % 2-D — a concrete demonstration of the limitation, and evidence that the 2018→2022 `.mw` reading contract is otherwise unchanged for 1-D content.

### 2.6 Base64 payloads: what is inside `Equation` and `Plot`

Decoding the `display` attribute of a 2022 `Equation` (outer base64) yields Maple's compact typeset serialization, not standard MathML:

```
b'-I%mrowG6#/I+modulenameG6"I,TypesettingGI(_syslibGF\'6+-I#miGF$6%Q"PF\'/%\'italicGQ%trueF\'/%,mathvariantGQ\'italicF\'-I(mfencedGF$6$-F#6%-F,6%Q"xF\'F/F2/%+executableGQ&falseF\'/F3Q\'normal'
```

Decoding the base64 body of a `<Plot>` yields Maple's internal serialized plot data structure:

```
b'6*-%\'CURVESG6$7\\dl7$$"$D"!"%$!+J^pOn!#57$$"$v$!"%$!1,++Y&\\N!o!#;7$$"$D\'!"%$!+)e3-(o!#57$$"$v)!"%$!)OlOp!")7$$"%D6!"%$!+>'
```

And an `<Equation>`'s *text content* decodes to Maple `mprint`-style output:

```
LV9JLFR5cGVzZXR0aW5nRzYkJSpwcm90ZWN0ZWRHSShfc3lzbGliRzYiSSxtcHJpbnRzbGFzaEdGKDYkNyM+SSJhR0YoJCIiJCEiIjcjRi4=
```

**Consequence for an MCP server:** these payloads are opaque, undocumented Maple-internal encodings. An external tool can *preserve* them byte-for-byte (safe: it is XML attribute/text) but **cannot synthesise valid ones for new 2-D math or plots**. Practical strategy: emit **1-D plain-text `<Text-field style="Maple Input">` input only** (this is exactly what `Worksheet:-WorksheetToMapleText`, the "Export as Maple Input" menu item, and `mw2txt.py`'s inverse direction all assume), and leave 2-D typesetting to Maple.

A real plot element, verbatim opening tag (from `lukaswittmann/molecular-dynamics-sim min_pot.mw`, Maple 2022.0):

```xml
<Plot height="500.0" originalheight="500.0" type="two-dimensional" width="500.0" originalwidth="500.0" plot-scale="1.0" plot-xtrans="0.0" plot-ytrans="0.0" gridlinevisibility="1" legendvisibility="false" input="_ATTRIBUTE(&quot;input&quot; = [TABLE([1 = plot, 2 = [-exp(-.1*(x-2)^2)], 3 = (x = 0 .. 10)]), &quot;originalview&quot; = [0.125000000000000007e-1 .. 9.98750000000000071, -.999984375100000045 .. -0.169509647099999996e-2]])">
```

### 2.7 The published DTD/Schema do **not** describe `.mw` (important!)

Maplesoft explicitly says the storage format is not documented:

> "This package makes it unnecessary to know the storage format for the Maple worksheet by providing access to its XML representation. … **The storage format for Maple worksheets is not documented, and is subject to change.**"
> — [Worksheet package overview](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)

But there *are* two published schema-ish documents. Their **element names do not match real `.mw` files**:

* **DTD** ([Worksheet/DTD](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDTD)): namespace `http://www.maplesoft.com/MWS`, "This entity may be identified by the SYSTEM identifier: SYSTEM \"worksheet.dtd\"", declared elements include `cell`, `cell-options`, `column-widths`, `cstyle`, `exchange`, `glplot2d`, `glplot3d`, `hyperlink`, `legend`, `legends`, `mapletext`, `mark`, `pagebreak`, `pagenumbers`, `para`, `plotdata`, `pstyle`, `rtable`, `r5mathobj`, `section`, `spreadsheet`, `style-table`, `text`, `urllink`, `version`, `viewopts`, `worksheet`, `xppedit`, `xppmath`.
* **XSD** ([Worksheet/Schema](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FSchema)): namespace `http://www.maplesoft.com/xml/schema/worksheet`, declared elements exactly: `bitmap cell cell-options column-widths cstyle exchange glplot2d glplot3d hyperlink inline-plot legend legends mapletext mark newsmartplot2d newsmartplot3d pagebreak pagenumbers para plotdata pstyle r5mathobj row-heights rtable rtable-handles section smartplot2d smartplot3d spreadsheet spreadsheet-options style-table text urllink version viewopts windows-metafile worksheet xppedit xppmath`.

Compare with the real `.mw` vocabulary: there is **no** `Group`, `Input`, `Output`, `Text-field`, `Title` or `Plot` element in either document, and conversely real `.mw` files contain none of the DTD/XSD `exchange`/`para`/`mapletext`/`cell` elements. The lower-case names are the XML-ised form of the **classic** `.mws` structure (`SECT`, `EXCHG`, `PARA`, `TEXT`, `MPLTEXT` — see §3), which the `Worksheet` package exposes as the `maple8_xml` format ([Worksheet/ToString](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FToString) accepts `format` = `"mws"`, `"maple8_xml"`, or `"mw"`; [Worksheet/ReadFile](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FReadFile) accepts `"maple8_xml"` or `"mw"`).

**Therefore: use these DTD/XSD pages for the legacy MWS-XML, not as a validator for `.mw`.** A `.mw` file will *not* validate against `worksheet.xsd`.

Cross-check that the *modern* vocabulary is what `ReadFile` returns (help example on a legacy `.mws` path):

```
> mws := ReadFile( cat(dir, "/examplesclassic/obj.mws") ):
> type( mws, Worksheet:-worksheet );
                                    true
> use XMLTools in ElementStatistics( mws ) end use
 Styles = 1, Task = 1, Version = 1, Label-Scheme = 1, View-Properties = 1, Worksheet = 1,
 Hyperlink = 5, Section = 8, Title = 10, Layout = 33, Group = 104, Input = 104,
 Font = 110, Text-field = 146
```

The statistics use the **modern** names (`Group`, `Input`, `Text-field`, `Section`, `Title`). Whether `examplesclassic/obj.mws` is itself stored in modern XML or is converted by `ReadFile` on the fly is **UNVERIFIED** — but the takeaway holds: `Worksheet:-ReadFile` yields a `Worksheet:-worksheet` XML tree in the **modern** vocabulary, which is what `Worksheet:-Convert(format=mw)` writes.

---

## 3. The classic `.mws` format

`.mws` is **text**, brace-delimited, with a `{VERSION …}` header. Verbatim head of a real Maple 6 worksheet (`openturns/openturns validation/src/ti.mws`):

```
{VERSION 6 0 "IBM INTEL LINUX" "6.0" }
{USTYLETAB {CSTYLE "Maple Input" -1 0 "Courier" 0 1 255 0 0 1 0 1 0 0 
1 0 0 0 0 1 }{CSTYLE "2D Math" -1 2 "Times" 0 1 0 0 0 0 0 0 2 0 0 0 0 
0 0 1 }{CSTYLE "2D Output" 2 20 "" 0 1 0 0 255 1 0 0 0 0 0 0 0 0 0 1 }
{PSTYLE "Normal" -1 0 1 {CSTYLE "" -1 -1 "" 0 1 0 0 0 0 0 0 0 0 0 0 0 
0 0 0 }0 0 0 -1 -1 -1 0 0 0 0 0 0 -1 0 }{PSTYLE "Maple Output" 0 11 1 
{CSTYLE "" -1 -1 "" 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 }3 3 0 -1 -1 -1 0 
0 0 0 0 0 -1 0 }…}
```

Body structure (same file):

```
{SECT 0 {EXCHG {PARA 0 "> " 0 "" {MPLTEXT 1 0 137 "restart:\np:=(2*Pi)
^(-16/2)/sigma1^13/sigma2^3*exp(-1/(2*sigma1^2)*sum((x[i]-1)^2,i=1..13
))*exp(-1/(2*sigma2^2)*sum((x[i]-1)^2,i=14..16));" }}{PARA 12 "" 1 "" 
{XPPMATH 20 "6#>%\"pG,$*&#\"\"\"\"$c#F(*,%#PiG!\")%'sigma1G!#8%'sigma2
G!\"$-%$expG6#,$*&#F(\"\"#F…" }}}{EXCHG {PARA 0 "> " 0 "" {MPLTEXT 1 0 19 "dp:=di
ff(p,sigma1);" }}{PARA 12 "" 1 "" {XPPMATH 20 "6…" }}}
```

* Section = `{SECT 0 …}`, execution group = `{EXCHG …}`, paragraph/region = `{PARA style flags "prompt" …}`, text = `{TEXT …}`, Maple input = `{MPLTEXT flags … "…"}` (newlines escaped as `\n` inside the quoted string), 2-D math/expressions = `{XPPMATH …}` with a quoted ASCII serialization of Maple's internal format. Style tables are `{USTYLETAB {CSTYLE …}{PSTYLE …}}`.
* Round-tripping `.mws` outside Maple is much harder than `.mw`: the `XPPMATH` payloads use Maple's undocumented "email safe internal format" (compare [repository](https://www.maplesoft.com/support/help/maple/view.aspx?path=repository): "Each member is a Maple expression encoded in a compact and email safe internal format. The internal format is not publicly documented and may change between releases"). The **text and `MPLTEXT`** parts are readable, the math payloads are not.
* `VERSION` header values observed in the wild (GitHub harvest) map to releases: `{VERSION 5 0 "IBM INTEL LINUX" "5.0"}` (Maple V R5), `6` (Maple 6), `11` (Maple 11), `13` (Maple 13), `15` (Maple 15), `16` (Maple 16), `18` (Maple 18, `minor` = 1). Platform strings observed: `"IBM INTEL LINUX"`, `"SUN SPARC SOLARIS"`, `"Windows NT (unknown)"`, `"Linux"`. No `.mws` written by Maple ≥ 2015 was found in the wild, so whether the `VERSION` field becomes `2018`/`2022` is **UNVERIFIED** (expected by analogy, but unconfirmed).
* **2018 vs 2022**: Maple 2018 still had the Classic Worksheet interface and can open/save `.mws`; Maple 2022 **cannot** (classic interface "was last released with Maple 2021 and is now obsolete" — [versions](https://www.maplesoft.com/support/help/maple/view.aspx?path=versions)). The Maple 2018 User Manual mentions "Classic Worksheet" 15 times (incl. a §"Tables and the Classic Worksheet" and "Worksheet Compatibility"); the Maple 2022 User Manual mentions it **0** times. Both manuals still document the Worksheet Migration facility: "Worksheet Migration - an interface to convert worksheets from Classic Maple (.mws files) to Standard Maple (.mw files)."
* The `.mws`-era **XML** variant (`maple8_xml`) is what the DTD/XSD in §2.7 describe, and what `Worksheet:-Convert(format=maple8)` / `ToString(format="maple8_xml")` produce.

---

## 4. External read/write tooling (third-party)

### 4.1 `davidovitch/maple-to-python` — the only mature-looking `.mw` reader found (CONFIRMED)

* URL: <https://github.com/davidovitch/maple-to-python>
* Language: Python. License: **GPL-3.0** for the repository (`gh api repos/davidovitch/maple-to-python`), while `mw2txt.py`'s own header declares **LGPL-3.0-or-later** (it was inherited from W. Trevor King's original — <http://blog.tremily.us/posts/Maple/>).
* Maturity: 11 stars, created 2014-02-07, **last commit 2015-01-29** — unmaintained. README calls it "a very early and naive prototype on an incomplete and unfinished conversion scheme".
* What it actually does: `mw2txt.py` parses `.mw` directly with `lxml.etree.parse(path)` — i.e. it treats the `.mw` as plain XML (consistent with §2.1) — and walks `Text-field` nodes, using `style == 'Maple Input'` to emit Maple code and the `prompt` attribute to reproduce `> ` prompts. `mw2py.py` then translates the text to SymPy/IPython. Verbatim from `mw2txt.py`:

```python
def mw2txt(path, writer, filter_math=False):
    xml = _lxml_etree.parse(path)
    pruned_iteration(
        root=xml.getroot(),
        match=lambda node: node.tag == 'Text-field',
        match_action=lambda node: top_text_node2txt(
            node=node, writer=writer, filter_math=filter_math),
        match_tail=lambda node:writer(text='\n'))
...
def other_in_text_node2txt(node, writer):
    if node.tag in ['Drawing-Root']:
        # ignore missing content
        pass
    elif node.tag in ['Equation', 'Image', 'Plot']:
        # warn about missing content
        writer(text=node.tag, color='yellow')
```

```
$ mw2txt.py example.mw 
Hi there
> restart;
> interface(prettyprint=0):
> 1;# one  + plus 2 two ;
1
> 3 + 4;  bold
7
Equation
```

* Version compatibility: written against Maple ~15/2013-era `.mw` (its bundled samples are `Version major="11"` and `major="15"`). Because the vocabulary and `<Version>` element are unchanged through 2018/2022, its parsing approach still applies. **Tested here:** the *unmodified* `mw2txt.py` (with lxml 6.1.3) correctly extracted input from a real **Maple 2022.2** worksheet — see §2.5. It produced **no output** for two 2-D-only worksheets (one 2018.1, one 2022.2), which is the expected limitation: `other_in_text_node2txt` prints the literal string `Equation` for `<Equation>` nodes and discards their content. Its inverse (writing `.mw`) does not exist.
* Its two bundled sample worksheets are the ones used for the format claims in §2.1: `example-exc-output.mw` (`<Version major="15" minor="0"/>`, 20 KB) and `example-inc-output.mw` (`<Version major="11" minor="1"/>`, 875 KB) — both plain XML.
* Forks/copies: `yuv418/math640 maple/mw2txt.py` is a byte-for-byte copy apart from two Pygments colour names (`diff` shows only `'magenta': 'fuchsia'→'magenta'`), so it adds no capability.

### 4.2 MIME / editor metadata (CONFIRMED, useful for detection)

From `MarkWalters-dev/aur` (`maple2024/Maplesoft-x-maple-worksheet.xml`, also maple2019/2020/2021/2023 variants) — a freedesktop shared-mime-info definition:

```xml
<?xml version="1.0"?>
<mime-info xmlns='http://www.freedesktop.org/standards/shared-mime-info'>
  <mime-type type="application/x-maple-worksheet">
    <comment>Maple Worksheet</comment>
    <glob pattern="*.mw"/>
    <glob pattern="*.mwz"/>
    <glob pattern="*.mla"/>
    <glob pattern="*.maple"/>
    <glob pattern="*.mws"/>
  </mime-type>
</mime-info>
```

This is the only place `.mwz` appears; Maple's own help has no `mwz` page (**UNVERIFIED** meaning; likely a compressed worksheet).

### 4.3 Pandoc / generic converters

Pandoc has no Maple reader or writer. The only realistic Pandoc path is a **two-step** conversion: Maple → LaTeX/HTML(+MathML)/plain text (via Maple itself, §5) and then Pandoc for the rest. See the companion section in `06-mcp-prior-art.md`; a deeper third-party survey was also commissioned for this report (Section 4.4).

### 4.4 Additional tooling survey (own searches + commissioned survey)

Findings from my own targeted searches (GitHub **code** search via the authenticated API, npm registry, and web):

* **`.mw` readers:** the only real one is `davidovitch/maple-to-python` `mw2txt.py` (§4.1) plus its trivial copy in `yuv418/math640`. GitHub code searches for parser code returned only that project and unrelated hits:
  * `"Text-field" "Maple Input" language:Python` → 6 results, of which the only parser is `davidovitch/maple-to-python :: mw2txt.py` / `yuv418/math640 :: maple/mw2txt.py`; the rest are Python simulation scripts that happen to contain the strings.
  * `"Text-field" "Maple Input" -extension:mw -language:XML` → 20 results, again only `mw2txt.py` is a parser.
  * `filename:maple.xml`, `filename:worksheet.xml maple` → **no Maple parser**; hits are editor syntax definitions (`jecelyin/920-text-editor-v2 tools/assets/syntax/maple.xml`, `factor/factor basis/xmode/catalog/modes/maple.xml`, `maths/dragmath formats/Maple.xml`) and the AUR MIME file (§4.2). Notably **there is no `maple.xml` part** because `.mw` is not a container.
* **`.mws` readers:** **none found.** `"{EXCHG" "MPLTEXT"` (1608 hits) and `"USTYLETAB" parse` (111 hits) return only `.mws` *data* files (mostly `openturns/openturns validation/src/*.mws`, `linbox-team/linbox interfaces/maple-old/*.mws`, textbooks) — no code that parses the brace format.
* **`.mw` writers:** **none found** in any language.
* **npm:** `https://registry.npmjs.org/-/v1/search?text=maple%20worksheet` returns 675 packages but **zero** Maple-worksheet packages — everything named "maple" is unrelated (Maple observability SDK, Maple CSS engine, `@fontsource/maple-mono`, Maple REST SDK). `text=maple parser` likewise returns only generic parsers. **Conclusion: there is no off-the-shelf Node.js library for `.mw`.**
* **PyPI:** the search UI (`https://pypi.org/search/?q=maple+worksheet`) could not be scraped (anti-bot "Client Challenge"), so the JSON API was probed directly for candidate names. **None of them is a Maple-worksheet package:** `maple` = "reliable, scalable, distributed server framework"; `pymaple` = "Maple Container Utility" (an HPC docker/podman wrapper, unrelated to Maplesoft); `mws` = Amazon MWS API client. `maple-worksheet`, `mapleworksheet`, `mw2txt`, `maple-parser`, `mpl-parser`, `maplefile`, `maple-worksheets`, `openmaple`, `maple-kernel` → **HTTP 404 (do not exist)**. Combined with the GitHub code-search result, there is **no PyPI package for `.mw`/`.mws`**.
* **Pandoc:** Pandoc has **no** Maple `.mw`/`.mws` reader or writer. The workaround is two-step: Maple → LaTeX/HTML(+MathML)/plain text (via Maple itself, §5), then Pandoc. (`06-mcp-prior-art.md` covers related prior art.)
* **VS Code / editors:** only syntax highlighting and MIME association exist (the `application/x-maple-worksheet` definition, §4.2). No editor parses the format semantically.

A dedicated survey was also commissioned in parallel to widen this search; my confirmed result set above (§4.1 reader, §4.2 MIME, and the negative results here) stands on its own. **Bottom line: an MCP server for Maple worksheets must implement `.mw` handling itself; the only reusable code is ~250 lines of unmaintained GPL/LGPL Python in `mw2txt.py`.**

### 4.5 What an external writer can realistically do

Because `.mw` is plain XML, an external tool can build a **valid-enough** worksheet by emitting the boilerplate prologue plus `Group`/`Input`/`Text-field` nodes, e.g.:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Worksheet>
<Version major="2022" minor="0"/>
<Label-Scheme value="2" prefix=""/>
<View-Properties presentation="false" UserProfileName="Maple Default Profile" editable="true"/>
<MapleNet-Properties format="worksheet" prompt="&gt; " prettyprint="3" typesetting="extended"/>
<Styles/>
<Group hide-input="false" drawlabel="true" applyint="true" applyrational="true" applyexponent="false">
<Input><Text-field prompt="&gt; " style="Maple Input" layout="Normal">restart;
1+1;</Text-field>
</Input>
</Group>
</Worksheet>
```

This is an **inference** from the observed real-file structure, not a documented contract: Maplesoft performs "only a surface check" on worksheet XML written through `Worksheet:-WriteFile` ("It is assumed that the XML document that is written to the file represents a valid worksheet. (Maple performs only a surface check.)" — [Worksheet/WriteFile](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWriteFile)). Whether a hand-built file is accepted by **Maple 2018**/**2022** without repairs is **UNVERIFIED** — this is the single most valuable thing to test on the real 2018/2022 installs. Safer alternative: have the MCP generate `.mpl` (fully documented text) and let Maple convert it, or generate an `.mw` from a template captured from the actual installed Maple version.

---

## 5. Conversions

### 5.1 In-GUI "Export As" — identical list in 2018 and 2022

> "By selecting Export As from the File menu, you can also export a document in the following formats: **HTML, LaTeX, Maple input, Maplet application, Maple text, plain text, PDF, and Rich Text Format**."
> — Maple 2018 User Manual §11.4 "Exporting to Other Formats", p. 323; **identical wording** in the Maple 2022 User Manual §11.4, p. 331.

Additional formats listed by the online help [Export a Worksheet](https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fmanaging%2Fexport): "Export as Worksheet from a Maple Workbook", "HTML or HTML with MathML", "Maple T.A.(zip)", "Maplet".

* HTML export embeds math as **GIF, MathML 2.0 Presentation, MathML 2.0 Content, or Maple Viewer** (2018 & 2022 manuals, same text).
* LaTeX export produces a `.tex` ready for LaTeX; Maple ships the style files; the manual points to the `exporttoLaTeX` help page. **The `exporttoLaTeX` help page could not be fetched** (maplesoft.com became unreachable during this session) — **UNVERIFIED**: whether `exporttoLaTeX` is a callable command or only a page name.
* Important caveat for CLI workflows, verbatim from both manuals: "When exporting a document as Maple input for use in Command-line Maple, your document must contain explicit semicolons in 1-D Math input. If not, the exported .mpl file does not contain semicolons, and Command-line Maple generates errors."
* `Worksheet:-TableOfContents` and `Worksheet:-RemoveSection` can *write* `.mw` (with/without a destination argument; otherwise they open in the GUI).

### 5.2 `Worksheet` package — the programmatic conversion API

Package overview ([Worksheet](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet)): commands are `Comparator`, `Convert`, `Display`/`DisplayFile`, `FromString`, `ReadFile`, `RemoveSection`, `TableOfContents`, `ToString`, `WorksheetToJupyter`, `WorksheetToMapleText`, `WriteFile`.

`Worksheet:-Convert` ([help](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FConvert)) is the main hub:

```
Convert( worksheet, opts )
Convert( worksheet, outputfilename, opts )
```
> "format = string or name — Specifies the output format. Supported values are
> `_Inert` (Maple inert form), `jupyter` (Jupyter format), `maple`, `workbook` (Maple workbook format), `maple8` (Legacy Maple 8 file format), `mapletext` (Maple Text format (MPL format)), `mw` (Maple worksheet format), `procedure` (Maple procedure).
> The default is inferred from the output filename, if given. Otherwise Maple worksheet format is assumed."
> "The worksheet may be given as a filepath or a Maple XML data structure."
> Compatibility: "The Worksheet[Convert] command was updated in Maple 2025. The `outputfilename` option was introduced in Maple 2025." → **the `outputfilename` argument does not exist in 2018/2022**; there you must use the 2-arg-less form or `Worksheet:-WriteFile`.

A worked legacy→modern conversion from the help page:

```
> doc := ReadFile( cat(dir, "/examplesclassic/obj.mws"), format=maple8_xml ):
> mws := Convert( doc, format=mw ):
```

Other commands:

* `Worksheet:-ReadFile(filename, format="mw"|"maple8_xml")` → XML tree of type `Worksheet:-worksheet`. "parse a worksheet into an XML data structure".
* `Worksheet:-WriteFile(fileName, xmlTree, format="mw"|"maple8_xml")` → writes the tree; "Maple performs only a surface check". (The help page's own prose and example use `format = mws`, which contradicts its parameter list — a documentation inconsistency worth remembering: prefer `format="mw"`.)
* `Worksheet:-ToString(xmlTree, format="mws"|"maple8_xml"|"mw")` → string; "The returned XML document is formatted without line breaking or indentation of any kind. As a result, regardless of size, the document is returned as a single line of text."
* `Worksheet:-FromString(str)` → XML tree.
* `Worksheet:-WorksheetToMapleText(worksheet)` / `(worksheet, includeoutput)` → 1-D Maple text; "similar in functionality to the Maple Text format in the File > Export As menu". **Introduced in Maple 2017** → available in 2018 and 2022. Notes: "This command only fully supports worksheets. It may not work properly for Maple documents with tables or components."
* `Worksheet:-WorksheetToJupyter(worksheet, outputfile=…)` → Jupyter notebook JSON (`nbformat: 4`, `kernelspec.name: maple`, `file_extension: .mpl`). **Introduced in Maple 2022** → **NOT available in Maple 2018**. Same "only fully supports worksheets" caveat; "Output saved in the original worksheet is not translated".
* `Worksheet:-TableOfContents` / `Worksheet:-RemoveSection` — **introduced in Maple 2020** → **NOT available in Maple 2018**; present in 2022.
* `Worksheet:-Display`/`DisplayFile` — "Important: The Display function cannot be used in the Command-line version of Maple." → GUI-only; an MCP server must not rely on it. Also note its legacy heuristic: "If the name fileName of the file ends with the substring `.xml`, the file is taken to be a Maple worksheet saved in XML format. Otherwise, the file is assumed to be a Maple worksheet saved in native format."

### 5.3 Data-level `Export` and `latex` (not worksheet-level)

`Export(dest, data, opts)` ([Export](https://www.maplesoft.com/support/help/maple/view.aspx?path=Export)) was introduced in **Maple 2015** and its `base` option in **Maple 2017** → available in both 2018 and 2022. Its supported-format list includes `Jupyter`, `LaTeX`, `MathML`, `MLA`, `MPL`, `MW`, `Text` (verified substring of the published list) — but **not** `MWS`, `RTF`, `PDF` or `HTML`. But `Export` exports **data objects** (expressions, matrices, plots), and `format=MW` expects worksheet-shaped data — it is not the documented worksheet-file writer (`Worksheet:-WriteFile`/`Convert` are). The `Formats/MPL` page confirms `Export` can write `.mpl`: "The Export command can also export Maple expressions and programs to this format."

`latex(expr)` ([latex](https://www.maplesoft.com/support/help/maple/view.aspx?path=latex)) converts **expressions** to LaTeX source; it does not walk a worksheet.

### 5.4 Command-line / batch recipes

The `maple` command ([maple](https://www.maplesoft.com/support/help/maple/view.aspx?path=maple)) is the documented batch entry point. Relevant options, verbatim:

* `-c mapleCommand` — "specifies a command that Maple is to execute on startup. **It is only valid for Command-line versions of Maple.** The command can be any valid Maple command, but it cannot contain blank characters." (…so quote/escape carefully, or use `-i`.)
* `-i initFile`, `-q` (quiet), `-s` (suppress the banner/`>` prompt in scripts), `-b libname`, `-B`, `-e errorBreak`, `-F` (keep going when stdin ends).
* `-w warningLevel` — "The `-w` (**warning level**) option specifies whether Maple should print certain warnings. `-w 0` turns off warnings … `-w 4` enables all warnings…". **There is no worksheet-related `-w` flag** — a common misconception worth recording.
* `-x` — runs the Standard Worksheet GUI ("The `xmaple` command is equivalent to `maple -x`").
* Interfaces: "In Linux, use the `maple` command to start the Command-line version … or the `xmaple` command to start the Standard Worksheet version (X Windows). In Windows, use `cmaple` … `maplew`…"

So the headless conversion recipe is of the form:

```bash
# .mws -> .mw  (2018/2022, no GUI)
maple -q -s -c 'Worksheet:-WriteFile("out.mw", Worksheet:-Convert(Worksheet:-ReadFile("in.mws", format="maple8_xml"), format="mw"), format="mw")'

# .mw -> .mpl (1-D Maple input), works in 2018 and 2022 (WorksheetToMapleText since 2017)
maple -q -s -c 'FileTools:-Text:-WriteFile("out.mpl", Worksheet:-WorksheetToMapleText("in.mw"))'

# .mw -> .ipynb   *** Maple 2022 only (command introduced in 2022) ***
maple -q -s -c 'Worksheet:-WorksheetToJupyter("in.mw", outputfile="out.ipynb")'
```

Caveats: (a) `-c` cannot contain blank characters — use `-i script.mpl` or a single argument with `cat`/`FileTools:-JoinPath` instead of literal spaces; (b) **whether the `Worksheet` package works in the command-line `maple`/`cmaple` at all** is not explicitly documented. The only explicit GUI-requirement note found is for `Display`. The other commands are pure XML/text manipulation (`ReadFile`, `WriteFile`, `ToString`, `FromString`, `Convert`, `WorksheetToMapleText`, `WorksheetToJupyter`) and there is a whole help section "Connectivity : Web Features : Worksheet Package" implying server-side use. **Still, this must be smoke-tested on the installed 2018/2022 — mark as UNVERIFIED until then.** `DocumentTools:-Retrieve` (used on the [Formats/MW](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW) page for `DocumentTools:-Retrieve(MWFile, L6)`) and other `DocumentTools` commands are more GUI-coupled.

### 5.5 Worksheet Migration (`.mws` → `.mw`) and reverse

Both 2018 and 2022 User Manuals document "Worksheet Migration — an interface to convert worksheets from Classic Maple (.mws files) to Standard Maple (.mw files)." It is a GUI tool (Maple 2018 User Manual p. 30). Reverse conversion (`.mw` → `.mws`) is only meaningful where a classic interface exists (≤ Maple 2021); in Maple 2022 the `.mws` format is a read/import-only legacy format.

---

## 6. `.mpl` (Maple Language File)

From [Formats/MPL](https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMPL):

> "MPL (Maple Language File) is a text-based file format for Maple programs.
> MPL files are simply text files containing statements conforming to the syntax of the Maple language. These are the same as statements that can be entered interactively.
> MPL files can be executed from within Maple using the `read` statement.
> The commands in a Maple worksheet can be exported to MPL format using the Export as Maple Input menu option.
> The Export command can also export Maple expressions and programs to this format."

Maple 2018/2022 Programming Guide §10.4 adds: "Any filename can be used for a Maple language file, but the name cannot end with `.m`… Maple language files may be read using the `read` statement. The statements within the file are read as if they were being entered into Maple interactively, except that they are not echoed to the screen unless the `echo` interface variable has been set to 2 or higher. Maple includes a preprocessor modeled on the C preprocessor and Maple language files may include preprocessor directives such as `$include` and `$define`."

A real `.mpl` example (`hakaru-dev/hakaru maple/Edit.mpl`) — plain text with `#` comments and `proc … end proc`:

```maple
go := module ()
  local undoStack, sr;
  export here, where, up, child, fac, trm, silent, undo, ModuleApply;

  where := [];

  up := proc()
    here, where := op(1,where)(here),
                   [op(2..-1,where)];
  end proc;
```

Answers to the specific questions:

* **Execution groups → `.mpl`**: one execution group becomes one *statement block* (the group's `<Input>` `<Text-field>` text, verbatim). Outputs are dropped unless `WorksheetToMapleText(…, includeoutput)` is used, in which case outputs are emitted as `# out_1> …` comment lines (verbatim from the help example: `# out_1> Typesetting:-mfenced(…)` and `# out_2> -61-sqrt(17)*ln(45)`). `Worksheet:-Convert(format=mapletext)` is the same "MPL format" target.
* **Comments / `>` prompts**: `.mpl` has no prompts — prompts (`> `) exist only in `.mw` `<Text-field prompt="&gt; ">` / `.mws` `{PARA 0 "> " …}`. Maple comments are ordinary `#` to end-of-line (and `(* … *)` block comments). But **`# out_N>` lines produced by `WorksheetToMapleText(includeoutput)` are comments and are ignored on re-read**, so output does not round-trip as evaluation.
* **Round-trip `.mpl` → worksheet cell**: yes, semantically. `Worksheet:-Convert(format=mapletext)`/`WorksheetToMapleText` go worksheet → MPL; to go MPL → `.mw` you either `read` the `.mpl` in a Maple session and save, or build `<Group><Input><Text-field style="Maple Input">` nodes from statement blocks. The manual warning above matters: **a worksheet saved with 2-D input and without explicit semicolons exports to `.mpl` without semicolons**, which then errors in command-line Maple. If your MCP writes the `.mpl`, always terminate statements with `;`/`:`.
* `.mpl` is **not** a worksheet: it loses sections, text, plots, 2-D math, and outputs.

---

## 7. Encoding, line endings, and how Maple detects format/version

* **Encoding**: real `.mw` files declare `encoding="UTF-8"` and are stored UTF-8. Across 26 harvested `.mw` files: **no BOM** (`\xef\xbb\xbf` absent), zero CRLF in 25 of 26, and one 2024 file (`ebertolazzi/Clothoids maple/derivative3.mw`) contained 6 CRLF pairs — i.e. **LF is the norm and CRLF is tolerated but not required**. `.mws` samples are likewise LF-only, no BOM. **Recommendation: write UTF-8, no BOM, LF.**
* Non-ASCII count was 0 in every sample, so multi-byte handling is **UNVERIFIED** from my evidence; UTF-8 declaration plus `&lt;`/`&gt;`/`&quot;`/`&amp;` entity escaping (observed for `<`, `>`, `"`) is what Maple emits.
* **Format detection on open**, as documented/observed:
  * `.mw` → Standard Worksheet; the writer version is *inside* the file as `<Version major minor/>` (there is no external version marker).
  * `.mws` → classic; version is in the `{VERSION n m "PLATFORM" "os.version" }` header.
  * Legacy `DisplayFile` rule: "If the name fileName of the file ends with the substring `.xml`, the file is taken to be a Maple worksheet saved in XML format. Otherwise, the file is assumed to be a Maple worksheet saved in native format." ([Worksheet/Display](https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay)).
  * `Worksheet:-ReadFile` takes an explicit `format="mw"|"maple8_xml"` — no auto-detection documented.
  * `.mpl` vs `.m`: "The presence of the `.m` ending in the filename specifies that the file is an internal format file, and not a language file" (PG 2018/2022 §10.4). So a language file must **not** end in `.m`.
  * `.maple` workbook: SQLite database (detect by magic `SQLite format 3\0`).
  * `.mla`/`.lib`: first 1024 bytes are a repository header; `.lib` requires its sibling `.ind` ("both files must be present for Maple to use the repository").
* **2018 vs 2022 compatibility**: the documented file-format sections of the 2018 and 2022 Programming Guides are **word-for-word the same** (only page numbers differ), and the `.mw` element vocabulary observed in 2018.1 and 2022.2 files is the **same set**. Worksheets are explicitly "portable between the graphical user interfaces on different platforms". A file's `<Version major>` lets a consumer know the writer, but **no documented downgrade/upgrade behaviour for `.mw`** was found (e.g. whether 2018 opens a 2022 file) — **UNVERIFIED**. Practical inference (not a guarantee): a `.mw` limited to `Group`/`Input`/`Output`/`Text-field`/`Equation`/`Plot`/`Section`/`Title` plus the standard prologue is likely to open in both 2018 and 2022, and the `Version` value should probably be set to the *older* of the two if maximum compatibility is wanted.

---

## 8. Implications and recommendations for the MCP server

1. **Create**: prefer generating `.mpl` (documented, trivial) and/or `.mw` XML with 1-D `Text-field` inputs. If targeting both 2018 and 2022, emit `<Version major="2018" minor="1"/>` or just omit 2-D math/plots. Use the real installed Maple as the final writer whenever possible (`Worksheet:-WriteFile`) to guarantee a canonical file.
2. **Inspect**: parse `.mw` with any XML parser. Read `<Version>` for the writer, iterate `Group` for execution groups, `Group/Input/Text-field` (style `Maple Input`) for code, `Group/Output` for results, `Section/Title` for the TOC. Treat `Equation@display`, `Equation` text, and `Plot` text as opaque base64 — preserve, never invent.
3. **Edit**: attribute/text edits on existing nodes are safe; adding new 1-D input groups is safe-by-inference; synthesising 2-D math or plots is not possible externally. Round-trip through Maple for anything involving typesetting.
4. **Convert**: shell out to `maple -q -s -c '…'` and use `Worksheet:-Convert` / `WorksheetToMapleText` / `WorksheetToJupyter`; do **not** count on `exporttoLaTeX`/PDF from the CLI, and never depend on `Worksheet:-Display` (GUI-only). Gate `WorksheetToJupyter`, `TableOfContents`, `RemoveSection` behind a version check (`>= 2022` / `>= 2020`).
5. **Detect**: sniff content, not just extension (`.maple` is ambiguous; `.mwz` is undefined).
6. **Do not** assume ZIP/OPC — several plausible-looking "specs" for `.mw` (e.g. "`maple.xml` inside a zip") are **wrong**; there is no `_rels/.rels` or `[Content_Types].xml` in a Maple worksheet.

---

## 9. Open questions / UNVERIFIED list

1. Whether `Worksheet:-ReadFile/ToString/Convert/WorksheetToMapleText/WorksheetToJupyter` actually run under command-line `maple`/`cmaple` in 2018 and 2022 (no GUI). **Highest-value test.** (Only `Worksheet:-Display` is explicitly documented as GUI-only.)
2. Whether a hand-written minimal `.mw` (Section 4.5) opens cleanly in Maple 2018/2022 without repair.
3. Whether `.mw` files > some size, or with embedded images/components/tables, switch to a compressed/ZIP container (all 26 harvested files, including 700 KB ones, are plain XML; the `.mwz` extension hints at a compressed variant but is undocumented).
4. Whether Maple ≥ 2015 writes `{VERSION 2018 …}`-style headers into `.mws` (no such file was found in the wild).
5. Whether `.mw` is forward/backward compatible between 2018 and 2022 (e.g. 2022 file opened in 2018) and what warnings/repairs occur.
6. Exact semantics of `.mwz` and of the `maple8`/`workbook` values of `Worksheet:-Convert` (output shapes).
7. Whether `exporttoLaTeX` is a callable command (help page unreachable during this session).
8. Whether non-ASCII/Unicode worksheet content is stored raw UTF-8 or entity-escaped.

---

## 10. Sources

Maplesoft online help (all under `https://www.maplesoft.com/support/help/maple/view.aspx?path=`):

* `Formats` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats>
* `Formats/All` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FAll>
* `Formats/MW` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats/MW>
* `Formats/MWS` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMWS>
* `Formats/MPL` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMPL>
* `Formats/MLA` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMLA>
* `Formats/m` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2Fm>
* `Formats/Maple` (Workbook, SQLite) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FMaple>
* `Formats/HDB` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FHDB>
* `Formats/Help` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Formats%2FHelp>
* `Worksheet` (package overview; "storage format … is not documented, and is subject to change") — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>
* `Worksheet/ReadFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FReadFile>
* `Worksheet/WriteFile` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWriteFile>
* `Worksheet/ToString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FToString>
* `Worksheet/FromString` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FFromString>
* `Worksheet/Convert` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FConvert>
* `Worksheet/WorksheetToJupyter` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter>
* `Worksheet/WorksheetToMapleText` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToMapleText>
* `Worksheet/Display` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDisplay>
* `Worksheet/TableOfContents` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FTableOfContents>
* `Worksheet/RemoveSection` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FRemoveSection>
* `Worksheet/DTD` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FDTD>
* `Worksheet/Schema` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FSchema>
* `IsWorksheetInterface` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=IsWorksheetInterface>
* `versions` (classic interface last released with Maple 2021) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=versions>
* `worksheet/managing/export` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=worksheet%2Fmanaging%2Fexport>
* `repository` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=repository>
* `march` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=march>
* `libname` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=libname>
* `maple` (command-line options) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=maple>
* `Export` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Export>
* `latex` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=latex>

Manuals (documentation center — <https://www.maplesoft.com/documentation_center/>):

* Maple 2018 Programming Guide — <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf> (§10.4 "Files Used by Maple")
* Maple 2022 Programming Guide — <https://www.maplesoft.com/documentation_center/Maple2022/ProgrammingGuide.pdf> (§10.4, identical wording)
* Maple 2022 User Manual — <https://www.maplesoft.com/documentation_center/Maple2022/UserManual.pdf> (§11.4 "Exporting to Other Formats", p. 331; "Worksheet Migration")
* Maple 2018 User Manual (§11.4, p. 323; §Tables and the Classic Worksheet; "Worksheet Migration", p. 30)

Sample files and third-party repositories (all inspected directly):

* `davidovitch/maple-to-python` — <https://github.com/davidovitch/maple-to-python> (`mw2txt.py`, `mw2py.py`, `example-exc-output.mw` `major="15"`, `example-inc-output.mw` `major="11"`)
* `oselin/MDS` — `docs/maple/MDS.mw` (`major="2022" minor="2"`) — <https://github.com/oselin/MDS>
* `kenoticpurge/Corotational-Beam-Elements` — `Spatial Beam Elements/Maple/b3d_element.mw`, `SectionParameters.mw` (`major="2022" minor="2"`)
* `amirbaharvand66/continuum_mechanics` — `codes/example_3_20_2.mw` (`major="2022" minor="0"`)
* `lukaswittmann/molecular-dynamics-sim` — `min_pot.mw` (`major="2022" minor="0"`, 3 plots)
* `ebertolazzi/Clothoids` — `maple/circle_circle_intersection.mw`, `DUBINS.mw`, `derivative.mw`, `derivative3.mw` (2018–2024)
* `su2code/SU2` — `Common/src/toolboxes/MMS/CreateMMSSourceTerms/CMMSNSUnitQuadSolution.mw` (`major="2018" minor="1"`)
* `grtensor/grtensor` — `worksheets/Overview.mw`, `worksheets/intros/ReisNord.mw`, `worksheets/intros/RN Divergence.mw`
* `hakaru-dev/hakaru` — `maple/NewSLO.mw`, `maple/ForTesting.mw`, `maple/fun-fact.mw`, `maple/demos/march21.mw`, `maple/Edit.mpl`, `maple/Domain.mpl`
* `openturns/openturns` — `validation/src/Airy.mw`, `Wishart_pdf.mw`, `Cas1.mws`, `Cas4.mws`, `Cas6.mws`, `ti.mws`
* `ccshan/prob-school` — `maple/LinearRegression.mw`; `dmicha16/waterlab_mpc` — `courant_number.mw`; `GhazaleZe/Artificial-Intelligence` — `ghazale.mw`; `Beatthezombie/SphericalHarmonicsFromScratch` — `maple/sh.mw`; `martyushev/eliminationTemplates` — `_common.mw`, `F_IOD.mw`
* `MarkWalters-dev/aur` — `maple2024/Maplesoft-x-maple-worksheet.xml` (MIME definition) — <https://github.com/MarkWalters-dev/aur>
* W. Trevor King's original `mw2txt` write-up — <http://blog.tremily.us/posts/Maple/>
