# Maple 2018 / Maple 2022 — Driving Maple from outside as a batch / CLI process

**Purpose.** Reference for building an MCP server that drives a *locally installed* Maple 2018 or
Maple 2022 through its command-line interface. Everything here is about **invoking Maple from
outside** as a process: launchers, options, streams, exit codes, headless behaviour, partial
worksheet execution, persistent-process control, resource limits and licensing.

**Version provenance used throughout (important!).**

| Label | What it is | URL |
|---|---|---|
| **M2018** | The `maple` help page as archived on **2018‑06‑01**, i.e. the Maple 2018 era. Confirmed 2018-era by the presence of `-cw` (Classic Worksheet), which was removed after 2018. | https://web.archive.org/web/20180601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple |
| **M2022** | Same help page archived on **2022‑06‑01**, i.e. the Maple 2022 era. | https://web.archive.org/web/20220601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple |
| **CURRENT** | The live help page, which reflects **Maple 2026** (page footer "© Maplesoft … 2026"). | https://www.maplesoft.com/support/help/maple/view.aspx?path=maple |
| **PG2018** | *Maple 2018 Programming Guide* (PDF), © 1996‑2018, §14.4 "The Maple Command-line Interface" p. 487 ff. | https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf (also mirrored at https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf) |
| **PG2021/22** | *Maple Programming Guide* linked by Maplesoft as **both** the "Maple 2021" and the "Maple 2022" Programming Guide, © 1996‑2020, §14.4 p. 487. | https://www.maplesoft.com/documentation_center/maple2021/ProgrammingGuide.pdf |
| **UM2018 / UM2022** | Maple 2018 / Maple 2022 *User Manual* PDFs. | https://www.maplesoft.com/documentation_center/maple2018/UserManual.pdf · https://www.maplesoft.com/documentation_center/maple2022/UserManual.pdf |
| **IG2018 / IG2022** | Maple 2018 / Maple 2022 *Installation and Licensing Guide* (HTML). | https://www.maplesoft.com/support/install/2018/Maple2018-Install.html · https://www.maplesoft.com/support/install/2022/Maple/Install.html |

> **Note on the Programming Guide.** The Maplesoft documentation archive lists the *Maple 2022
> Programming Guide* as `/documentation_center/maple2021/ProgrammingGuide.pdf`, and that file's
> copyright page says **© 1996‑2020**. So there is **no separately updated Maple 2022 Programming
> Guide**; the 2021/2022 CLI chapter is textually the same as the 2018 one (modulo pagination).
> See https://www.maplesoft.com/documentation_center/history.aspx

> **Caution on version scoping.** Every statement below is tagged with the version(s) it was
> verified against. Anything not directly confirmed by a source is marked **UNVERIFIED**.

---

## 0. TL;DR — the actionable facts

1. **On Linux/macOS the console Maple is `maple`; `xmaple` is the GUI.** `cmaple` is the
   **Windows** console command (and `maplew` the Windows GUI). *(CURRENT, and PG2018 §14.4.)*
2. **A headless, parseable batch run is:**
   ```sh
   /path/to/maple/bin/maple -q -s -e2 file.mpl
   ```
   with `file.mpl` containing, near the top:
   ```maple
   interface(prettyprint=0):
   interface(ansi=false):
   interface(quiet=true):
   ```
3. **`-f` is *not* "run this file."** It is documented in 2018, 2022 **and** current as
   *"the -f (license file) option tells Maple to use the specified license file instead of the
   default one."* The script to execute is the **trailing positional argument**.
4. **Default `interface(errorbreak)` is 1** → a **runtime** error does *not* stop the script and
   the exit code stays **0**. Only a **syntax** error aborts (exit 4). Pass **`-e2`** (or `-e3`)
   to abort on *any* error. *(M2018, M2022, CURRENT, PG2018 §16.)*
5. **Exit codes (identical in M2018 and M2022):** `0` normal · `1` startup/init failure · `2`
   script ended prematurely (unbalanced delimiter) · `3` could not re-open stdin after script
   (only with `-F`) · `4` error while processing a command-line script · `5` kernel died
   unexpectedly · `n` = `` `quit`(n) ``/`` `done`(n) ``/`` `stop`(n) ``, 0–255.
6. **ANSI colour is ON by default on UNIX** (`interface(ansi)` default `true` on UNIX, `false` on
   Windows). A parser **must** call `interface(ansi=false)` or strip escape sequences.
7. **Startup is cheap**: *"Starting the Maple command-line interface, automatically executing a
   command file, and stopping the Maple session can take about one tenth of a second."*
   *(PG2018 §14.4; same text in PG2021/22.)*
8. **Memory/time caps**: `-T cpu,data,stack,core` (kibibytes), `--init-reserve-mem=`
   (the session's maximum memory map), `kernelopts(datalimit=…)`, and statement-level
   `timelimit(seconds, expr)`.
9. **Licensing needs nothing extra for batch** beyond a valid, activated license: single-user
   `license.dat` in `<maple>/license/`, or a FlexNet (`lmgrd` + `maplelmg`) network server.
   Each Maple process is a separate licensed instance.

---

## 1. The launchers and the full command-line option list

### 1.1 Which executable to call on which platform

**CURRENT** help, *Maple Interfaces* section of the `maple` page
(https://www.maplesoft.com/support/help/maple/view.aspx?path=maple):

> "The name of the command that invokes Maple depends on your operating system and chosen
> interface, worksheet (graphical user interface) or command line (character-based interface).
> … In Linux, use the `maple` command to start the Command-line version (that is, UNIX shell
> interface) or the `xmaple` command to start the Standard Worksheet version (X Windows). In
> Windows, use the `cmaple` command to start the Command-line version (that is, DOS console
> mode), the `maplew` command to start the Standard Worksheet version. … On macOS, use the
> `maple` command to start the Command-line version or the `xmaple` command to start the
> Standard Worksheet version."

**CURRENT** help, *Maple Versions* page
(https://www.maplesoft.com/support/help/maple/view.aspx?path=versions):

> "The Command-line version does not include graphical user interfaces features, but this method
> is recommended when solving very large complex problems or using scripts for batch processing.
> … [To start] the Command-line version in Mac or Linux, use the `maple` command. In Windows,
> use the `cmaple` command."

**PG2018 §14.4** (https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf):

> "In Windows, the command-line interface is called `cmaple.exe`. You can run this file from
> either the `bin.win` or `bin.X86_64_WINDOWS` directory of your Maple installation, depending on
> your platform. On other platforms, you can start the command-line interface by running the
> `maple` script located in the `bin` directory of your Maple installation."

**UM2018/UM2022** compare the interfaces and state that the Command-line version is
*"A command-line interface for solving very large complex problems or batch processing with
scripts. No graphical user interface features are available."*
(https://www.maplesoft.com/documentation_center/maple2018/UserManual.pdf)

**Practical consequence for Linux.** The executable an MCP server on Linux should invoke is
`<maple-install>/bin/maple`. This is corroborated by the Debian packaging project `deb-maple`,
which states the generated package *"adds links to `maple` and `xmaple` executables in
`/usr/bin`"* — **not** `cmaple` (https://github.com/guillod/deb-maple/blob/main/README.md).

> ***UNVERIFIED:*** whether some Linux Maple 2018/2022 installs *also* ship a `cmaple` binary or
> symlink. The official documentation consistently names only `maple` on Linux. Locate the
> installation and list `bin/` to confirm on the target machine.

Also note the `-x` option: *"The `-x` option runs the Standard Worksheet X Window version on UNIX
platforms … instead of the default Command-line version. The `xmaple` command is equivalent to
the `maple -x` command."* (M2018, M2022, CURRENT). **Never pass `-x`** for headless work.

### 1.2 Official calling sequences, verbatim

**M2018** (archived 2018‑06‑01 help page):

```
maple -a -A assertLevel -B -b libname -binary operatingSystemName -c mapleCommand -cw
-D macroDef -e errorBreak -F -f file -h -I includePath -i initFile -km kernelMode
-L logFile -l latexOption -nocloud -P -q -s -T resourceLimit -t -U macroName -u
-w warnLevel -x -z --setsort=orderNumber --historyfile=histFile --historysize=histSize
--secure-read=speclist --secure-noread=speclist --secure-write=speclist
--secure-nowrite=speclist --secure-extcall=speclist --secure-noextcall=speclist
--secure-readspec=filelist --secure-writespec=filelist --secure-extcallspec=filelist
--secure-syscall=flag --secure-mode=flag --init-reserve-mem=memorysize
--init-commit-mem=memorysize file
```

**M2022** (archived 2022‑06‑01 help page):

```
maple -a -A assertLevel -B -b libname -binary operatingSystemName -c mapleCommand
-D macroDef -e errorBreak -F -f file -h -I includePath -i initFile -km kernelMode
-L logFile -l latexOption -nocloud -P -q -s -T resourceLimit -t -U macroName -u
-w warnLevel -x -z --echofile=echoFile --historyfile=histFile --historysize=histSize
--init-reserve-mem=memorysize --init-commit-mem=memorysize --strip-debug-info
--secure-read=file --secure-noread=file --secure-write=file --secure-nowrite=file
--secure-extcall=file --secure-noextcall=file --secure-readspec=file
--secure-writespec=file --secure-extcallspec=file --secure-syscall=flag
--secure-mode=flag file --setsort=orderNumber
```

**CURRENT (Maple 2026)** — identical to M2022 except that it *adds* `-noAI`:

```
maple -a -A assertLevel -B -b libname -binary operatingSystemName -c mapleCommand
-D macroDef -e errorBreak -F -f file -h -I includePath -i initFile -km kernelMode
-L logFile -l latexOption -noAI -nocloud -P -q -s -T resourceLimit -t -U macroName -u
-w warnLevel -x -z --echofile=echoFile --historyfile=histFile --historysize=histSize
--init-reserve-mem=memorysize --init-commit-mem=memorysize --strip-debug-info
--secure-read=file --secure-noread=file --secure-write=file --secure-nowrite=file
--secure-extcall=file --secure-noextcall=file --secure-readspec=file
--secure-writespec=file --secure-extcallspec=file --secure-syscall=flag
--secure-mode=flag file --setsort=orderNumber
```

Positional-file rule (identical M2018/M2022/CURRENT):

> "If a `file` is specified on the command line after the last option, that file is read by
> Maple. For the Command-line interface, the file must be a text file of valid Maple commands.
> For worksheet versions, the file must be a Maple worksheet file."

### 1.3 Option-by-option semantics for the requested flags

The list below is the *requested* set. **"2018 / 2022 / current"** marks the versions in which the
option appears in the calling sequence. Quotations are from the official help page (M2018, M2022
and CURRENT texts are identical unless noted).

#### `-c mapleCommand` — 2018 / 2022 / current

> "The `-c` (execute command) option specifies a command that Maple is to execute on startup.
> It is only valid for Command-line versions of Maple. The command can be any valid Maple
> command, but **it cannot contain blank characters**. Multiple `-c` options can be specified.
> Commands specified by `-c` options, and files specified by `-i` options, are executed in the
> order in which they are specified, after the initialization files have been read. Note: These
> commands are also re-executed after a `restart` command."

> ⚠️ **Contradiction to be aware of.** PG2018 §14.4 (same text in PG2021/22) explicitly shows `-c`
> arguments **containing spaces and shell quoting**, e.g.
> `cmaple -c "datafile := \`c:/temp/12345.data\`" -c N:=5;`. The help-page claim "cannot contain
> blank characters" therefore appears to be stale. ***UNVERIFIED:*** whether multi-token,
> shell-quoted `-c` arguments are reliably accepted in Maple 2018/2022. The safe pattern is a
> single token with no spaces (`-c N:=5;`) or, better, put the code in an `.mpl` file / use `-i`.

PG2018 verbatim examples (Windows and UNIX quoting differ):

```
cmaple -c "datafile := `c:/temp/12345.data`" -c N:=5;
/usr/local/maple/bin/maple -c 'datafile:="/tmp/12345.data";' -c N:=1;
```

#### `-q` (quiet) — 2018 / 2022 / current

> "The `-q` (quiet) option suppresses the printing of the Maple startup message, various
> informational messages (bytes used messages and garbage collection messages), and the signoff
> message. Maple is better suited for use as a filter when these messages are suppressed."

PG2018 §14.4: *"You can use the `-q` option to hide extra output that interferes with parsing
results automatically."*

#### `-s` (suppress initialization) — 2018 / 2022 / current

> "The `-s` (suppress initialization) option causes Maple to forgo reading initialization files
> when initiating a session."

From the *Initialization Files* section of the same page:

> "The `-s` option suppresses the reading of all initialization files, including those specified
> by `-i` options."

Initialization file location (same page, *System Environment Variables*): the `HOME` variable
identifies where the user's `.mapleinit` file is located.

#### `-B` — 2018 / 2022 / current

`-B` is a **flag (no argument)**. From CURRENT:

> "The `-B` option tells Maple that the default system and toolbox libraries should be added to
> the `libname` variable used to specify where Maple looks for code repositories. By default
> `-B` is implicitly specified. It is most commonly used in addition to `-b` to append to or
> rearrange the library search order."

#### `-b libname` — 2018 / 2022 / current

> "The `-b` (library) option tells Maple that the following argument specifies the pathname of
> the directory that contains Maple libraries or the full path of the `.lib` or `.mla` file of a
> single Maple library. This initializes the Maple variable `libname`. By default, `libname` is
> initialized with the pathname of the main Maple library (for example, `/usr/local/maple/lib`).
> … More than one `-b` option can be specified. When several `-b` options are used, the first `-b`
> option overrides the default `libname` setting, and subsequent `-b` options are appended to
> `libname`, forming a Maple expression sequence of directory names."

PG2018 example:

```
maple -b /usr/public/waterloo/maple/lib $*
```

#### `-w warnLevel` — 2018 / 2022 / current

> "`-w 0` turns off warnings. `-w 1` enables library-generated warnings. `-w 2` enables library-
> and kernel-generated warnings. `-w 3` (the default) enables library-, kernel-, and
> parser-generated warnings. `-w 4` enables all warnings, that is library-, kernel-,
> parser-generated, and compatibility warnings."

For machine parsing, `-w 0` (or `interface(warnlevel=0)`) is the aggressive choice.

#### `-x` (X Window) — 2018 / 2022 / current

> "The `-x` option runs the Standard Worksheet X Window version on UNIX platforms and the
> Standard Worksheet version on Macintosh platforms, instead of the default Command-line version.
> The `xmaple` command is equivalent to the `maple -x` command."

Do **not** use for headless.

#### `-i initFile` — 2018 / 2022 / current

> "The `-i` (initialization file) option specifies additional files to be read after the standard
> Maple initialization files. It is valid only for the Command-line interface. Multiple `-i`
> options can be specified. Files specified by `-i` options, and commands specified by `-c`
> options, are executed in the order in which they are specified, after the normal initialization
> files have been read. If security is enabled, files specified by `-i` are automatically added to
> the list of readable files."

#### `-f file` (LICENSE file, not a script!) — 2018 / 2022 / current

> "The `-f` (license file) option tells Maple to use the specified license file instead of the
> default one."

This is the text in **all three** versions (M2018, M2022, CURRENT). The argument is named `file`
in the calling sequence, which is presumably why it is frequently misread as "the file to run".

#### `-km kernelMode` — 2018 / 2022 / current, **worksheet interfaces only**

> "The `-km s` (or single kernel mode) option, which **applies only to worksheet versions** of
> Maple, is used to start Maple in the single server kernel mode. …"

CURRENT additionally documents `-km p` (parallel server kernel mode, the default for the Standard
GUI) and `-km q` (query/mixed kernel mode). M2018's page documents only the `-km s` text.
Because these are explicit GUI/worksheet concepts, **`-km` is irrelevant to headless `maple`
usage**; treat it as a no-op there. ***UNVERIFIED:*** whether passing `-km` to the console
launcher is silently ignored or an error.

#### `-T resourceLimit` — 2018 / 2022 / current

> "The `-T` (resource limiT) option is used to limit the amount of system resources that Maple can
> consume before execution is terminated. This option takes four parameters, separated by commas.
> The CPU time limit parameter specifies the maximum number of seconds of CPU time that the Maple
> process is to use. The data limit restricts the amount of memory, in kiloBytes, that Maple can
> use. The stack limit sets the maximum stack size, in kiloBytes. The core dump limit specifies
> the maximum size of core file that can be produced in the unlikely event of a core dump. You can
> specify any prefix of the four parameters, and omit the rest (for example, specify only the CPU
> and data limits)."

PG2018 §16.6 adds: *"These options can also be set using the `-T` command-line option."* and warns
that `cpulimit`, `datalimit`, `stacklimit` *"must be used carefully. Unlike the `timelimit`
command, once one of these limits is reached, Maple may shut down without warning … This makes
these limit options most useful for running in non-interactive sessions."*

#### `--historyfile=histFile` — 2018 / 2022 / current

> "The `--historyfile` option instructs Maple to use the specified file for persistent
> command-line history. If the value `"none"` is given, then persistent history is disabled. The
> default history file is `.maple_history` in the user home directory."

For a server, use `--historyfile=none` (strongly recommended: avoids concurrent writers to
`~/.maple_history`).

#### `--historysize=histSize` — 2018 / 2022 / current

> "The `--historysize` option instructs Maple to retain the specified number of lines of
> command-line history."

#### `--echofile=echoFile` — **2022 / current only** (ABSENT in 2018)

> "The `--echofile` option instructs Maple to echo the current session (both input and output) to
> the specified file, in HTML format if the filename ends with `.htm` or `.html`, or as plain text
> otherwise."

Also available in-session as `interface(echofile="…")` (CURRENT *interface* page).

#### `--secure-*` and `-z` — 2018 / 2022 / current

Present in all three. Argument placeholder changed from `speclist`/`filelist` (2018) to `file`
(2022/current). From CURRENT (`maple` page) and **EngineSecurity/CLIConfig**
(https://www.maplesoft.com/support/help/maple/view.aspx?path=EngineSecurity/CLIConfig):

```
-z                                    use the default security settings
--secure-read=<file>                  add to the inclusion specification for readable files
--secure-noread=<file>                add to the exclusion specification for readable files
--secure-write=<file>                 add to the inclusion specification for writable files
--secure-nowrite=<file>               add to the exclusion specification for writable files
--secure-extcall=<file>               add to the inclusion spec. for loadable external libraries
--secure-noextcall=<file>             add to the exclusion spec. for loadable external libraries
--secure-readspec=<file>              read the readable-file specification from the given file
--secure-writespec=<file>             read the writable-file specification from the given file
--secure-extcallspec=<file>           read the external-library specification from the given file
--secure-syscall[=enable|disable]     enable (disable) calls to system/ssystem
--secure-mode[=enable|disable]        enable (disable) security
```

> "These options are processed in the order in which they are specified on the command line, from
> left to right."

`-z` (default security settings) means, per the CLIConfig page:

> "disabling all write access · disabling calls to the `system` · disabling read access to
> everything except those files listed in `libname` and those files located immediately below
> directories listed in `libname` · disabling external call access to everything except those
> files located immediately below the Maple `bin.<platform>` directory and any toolbox
> `bin.<platform>` directories."

> ⚠️ **If the MCP server sandboxes user code, `-z` is the right switch — but it will also block
> reading/writing arbitrary files unless you add `--secure-read=` / `--secure-write=`
> specifications.** Note that `--secure-syscall` is *disabled by default if any other security
> option is given*.

#### `-e errorBreak` — 2018 / 2022 / current, **semantics changed**

M2018 (0,1,2 only):

> "`-e0` tells Maple to report the error and keep reading the file. `-e1` (the default) tells
> Maple to stop reading the file (and to skip to the end) when a **syntax** error is encountered.
> `-e2` tells Maple to stop reading and to skip to the end when **any** type of error is
> encountered. This behavior can also be changed in Maple by using the command
> `interface(errorbreak = n)` where n is 0, 1, or 2."

M2022 / CURRENT (0,1,2,**3**):

> "Both `-e2` and `-e3` tell Maple to stop reading and to skip to the end when any type of error
> is encountered. In addition, `-e3` will also print a Maple function stack trace after the
> error. This behavior can also be changed in Maple by using the command
> `interface(errorbreak = n)` where n is 0, 1, 2, or 3."

#### `-D macroDef` — 2018 / 2022 / current

> "The `-D` (Define) option is used to predefine a macro for the Maple preprocessor
> (see `$define`). The `-D` option can be followed by a symbol, or a symbol, equal sign, and the
> definition of the symbol. Multiple `-D` options can be used to define multiple symbols."

(The corresponding `-U undefineMacro` removes a macro defined earlier with `-D`.)

#### Other flags you will care about (not in the requested list, but relevant)

| Option | Versions | Meaning (official text) |
|---|---|---|
| `-F` (no filter) | 2018/2022/current | "prevents Maple from exiting when the standard input has been redirected from a file, and the end of the file is encountered. By default, Maple exits. If `-F` is specified, Maple instead continues interactively at that point." |
| `-P` (parse only) | 2018/2022/current | "causes Maple to read input, but not evaluate any expressions. This can be used to quickly check a file of Maple commands for syntax errors, and should be used in conjunction with `-e0` …" — excellent for a *syntax-check* MCP tool. |
| `-t` (test mode) | 2018/2022/current | "the prompt is changed to `#-->`, prettyprinting is disabled, and all but the last 'bytes used' messages are suppressed. **The final 'bytes used' message is printed to stderr.** This option is not normally needed by Maple users." |
| `-u` (UNIX line endings) | 2018/2022/current | "forces non-UNIX versions of Maple to produce UNIX line endings on the standard output stream. This is generally only of use if you are using the Command-line version of Maple in conjunction with UNIX-like tools under Microsoft Windows." |
| `-h` (help) | 2018/2022/current | "tells Maple to open the GUI help browser." — avoid in headless mode. |
| `-a` / `-A n` | 2018/2022/current | assertion checking, equivalent to `kernelopts(assertlevel=1)` / `=n` (n ∈ {0,1,2}). |
| `-L logFile` | 2018/2022/current | log every library object loaded in the session. |
| `-l latexOption` | 2018/2022/current | LaTeX filter mode. |
| `-I includePath` | 2018/2022/current | directories searched for `$include` directives (comma-separated or repeated). |
| `-binary operatingSystemName` | 2018/2022/current | override automatic platform detection when more than one runtime is installed. |
| `--init-reserve-mem=memorysize` | 2018/2022/current | see §5.2. |
| `--init-commit-mem=memorysize` | 2018/2022/current | see §5.2. |
| `--strip-debug-info` | **2022/current only** | removes source file/line-number debug info when reading from source or archive; prevents source-level debugging. |
| `--setsort=orderNumber` | 2018/2022/current | changes the ordering of Maple sets (default `--setsort=1`; `--setsort=0` = pre-Maple-12 address ordering). Set only at startup. |
| `-nocloud` | 2018/2022/current | starts Maple without the MapleCloud palette. "This option can only be used in the standard GUI interface." |
| `-noAI` | **current only (Maple 2024+)** | starts Maple without the AI Formula Assistant palette and without the AI connection; Standard GUI only. |
| `-cw` | **2018 only** | "The `-cw` (classic worksheet) option runs the Classic Worksheet X Window version on supported UNIX platforms, instead of the default Command-line version or Standard Worksheet X Window version (launched with the `maple -x` or `xmaple` command)." Removed in 2019+ (the Classic interface was discontinued). |

### 1.4 Version deltas at a glance (2018 ↔ 2022 ↔ current)

| Option | M2018 | M2022 | CURRENT (2026) |
|---|---|---|---|
| `-cw` (Classic Worksheet) | ✅ | ❌ | ❌ |
| `--echofile=echoFile` | ❌ | ✅ | ✅ |
| `--strip-debug-info` | ❌ | ✅ | ✅ |
| `-noAI` | ❌ | ❌ | ✅ |
| `-e` accepted values | 0, 1, 2 | 0, 1, 2, 3 | 0, 1, 2, 3 |
| `-km` documented modes | `s` | `s` (page text) | `p`, `q`, `s` |
| `--secure-*=…` argument name | `speclist`/`filelist` | `file` | `file` |
| All other short options (`-a -A -B -b -binary -c -D -F -f -h -I -i -L -l -nocloud -P -q -s -T -t -U -u -w -x -z`) | ✅ | ✅ | ✅ |
| Exit-code table | identical | identical | identical |

The `-cw` / `--echofile` bracketing is the most reliable version fingerprint I found; I could not
retrieve 2019–2021 archived help pages to pin the exact release in which each changed
(***UNVERIFIED*** for the exact release, but `-cw` was definitely present in the 2018-era page and
absent by the 2022-era page, and `--echofile` was absent in 2018 and present by 2022).

---

## 2. Fully headless operation, streams, exit codes and parseable output

### 2.1 Does it need X11 / a display?

**No, when you invoke the command-line flavour.** On Linux the two entry points are deliberately
separated: `maple` = *"Command-line version (that is, UNIX shell interface)"* and `xmaple` =
*"Standard Worksheet version (X Windows)"* (CURRENT `maple` help, cited in §1.1). `-x` is the flag
that switches `maple` into GUI mode, so a plain `maple …` invocation never initialises X11.

Supporting statements:

* **CURRENT** *Maple Versions*: "The Command-line version **does not include graphical user
  interfaces features**…"
* **UM2018 / UM2022** interface comparison: Command-line version = *"A command-line interface for
  solving very large complex problems or batch processing with scripts. No graphical user
  interface features are available."*
* **IG2018** ("Command-line Maple"): *"The Command-line version of Maple has a text-based user
  interface. While allowing complete access to the mathematical engine, the Command-line version
  of Maple **requires less system resources**."*
  (https://www.maplesoft.com/support/install/2018/Maple2018-Install.html)

⚠️ **Two headless traps that are *not* about X11 but look like it:**

1. **Plotting.** `interface(plotdevice)` defaults to `inline`, which is a worksheet concept.
   Set an explicit device. From the *plot/device* help
   (https://www.maplesoft.com/support/help/maple/view.aspx?path=plot/device):
   * `char` — "Produces a drawing using ASCII characters … used primarily for testing and for
     reporting bugs. This driver is limited to simple line drawing plots and does not support
     color or font control."
   * `colorchar` — "Draws using ASCII characters and extended ANSI escape sequences … on
     terminals supporting 256-color mode."
   * `postscript`/`ps`, `gif`, `jpeg`, `bmp`, `hpgl`, `gdi` — write to the file named by
     `interface(plotoutput)`.
   So a headless-safe plot is
   ```maple
   interface(plotdevice=postscript, plotoutput="/tmp/out.ps"):
   plot(x^2, x=-1..1);
   ```
   (Same `plotdevice`/`plotoutput` defaults and names documented on the CURRENT *interface* page;
   ***UNVERIFIED*** whether Maple 2018/2022 expose exactly the same device list — the `char` driver
   is long-standing, but verify on the target install with `interface(plotdevice=help)`-style
   probing is not available, so just try `char`.)
2. **`-h`** opens the GUI help browser and **`-l`** puts Maple into LaTeX filter mode. Neither
   belongs in a server invocation.

> ***UNVERIFIED:*** the exact failure mode of `maple` when `DISPLAY` is set but broken, or when
> the Standard GUI is accidentally requested. Nothing in the official CLI documentation suggests
> the console launcher touches X11.

### 2.2 The batch invocation forms (verbatim from official sources)

**PG2018 §14.4 "Batch Files"** — the canonical example:

```
cmaple solve.mpl > solve.output
```

> "In this example, the output is redirected to a file named `solve.output`. You can configure an
> application to read this output file to capture the result."

**PG2018 §14.4 "Directing Input to a Pipeline"**:

```
echo "int(x,x);" | cmaple
```

**PG2018 §14.4 "Specifying Start-up Commands"**:

```
cmaple -c "datafile := `c:/temp/12345.data`" -c N:=5;
/usr/local/maple/bin/maple -c 'datafile:="/tmp/12345.data";' -c N:=1;
```

**Third-party HPC examples** (useful because they show real Linux production usage):

* North Carolina State University HPC — Maple 2022-era batch job
  (https://hpc.ncsu.edu/Software/Apps.php?app=Maple):
  ```sh
  #!/bin/bash
  #BSUB -W 10
  #BSUB -n 1
  #BSUB -o out.%J
  #BSUB -e err.%J
  module load maple
  maple < script.mpl
  ```
* RWTH Aachen IT Center — Maple 2022.0 under Slurm
  (https://help.itc.rwth-aachen.de/en/service/rhr4fjjutttf/article/82df5dc002ed443880487184a798dcb4/):
  ```sh
  module load Maple/2022.0
  # start non-interactive batch job
  maple -q worksheet
  ```
  (Here `worksheet` is the positional script file, per §1.2.)

**Recommended shape for the MCP server** (composing only documented behaviour):

```sh
/opt/maple2022/bin/maple -q -s -e2 --historyfile=none /abs/path/job.mpl
```

with `job.mpl` beginning:

```maple
interface(prettyprint=0):
interface(ansi=false):
interface(quiet=true):
interface(printbytes=false):
```

### 2.3 What goes to stdout vs stderr

This is only **partially** documented; be conservative.

* `-q` suppresses "the Maple startup message, various informational messages (**bytes used
  messages and garbage collection messages**), and the signoff message. Maple is better suited
  for use as a filter…" *(M2018/M2022/CURRENT `maple` help)*.
* `-t` (test mode) explicitly documents that **"The final 'bytes used' message is printed to
  stderr."** *(same page)*. This is direct evidence that the bytes-used diagnostics live on
  **stderr** (at least under `-t`), while normal results are on **stdout**.
* `interface(printbytes)` (default `true`) — *"Print the 'bytes used..' message after every garbage
  collection (Command-line interface)."* Set `interface(printbytes=false)` as a belt-and-braces
  measure. *(CURRENT `interface` page.)*
* `interface(quiet=true)` — *"An interface constant that will suppress all auxiliary printing
  (logo, garbage collection messages, bytes used messages, **and prompt**)."* *(CURRENT `interface`
  page.)*

> ***UNVERIFIED:*** whether Maple's **error** messages (`Error, …`, syntax-error carets) go to
> stdout or stderr in the command-line version for Maple 2018/2022. I could not find an official
> statement. **Practical rule: capture/merge both streams** (`2>&1`) when parsing, and do not
> assume errors are on stderr.

> ***UNVERIFIED:*** whether the interactive prompt is emitted to stdout when stdin is a pipe or a
> file, in Maple 2018/2022. `interface(prompt)` default is `"> "`; `interface(quiet=true)`
> suppresses the prompt. `-q`'s documented list does **not** explicitly include the prompt. Using
> `-q` **and** `interface(quiet=true)` is the safe combination.

### 2.4 Exit codes — official table (identical text in M2018 and M2022)

> "On exit, the Command-line version of Maple returns a return code to the operating system. When
> invoked from a UNIX or Windows shell script, this return code can be tested to determine why
> Maple exited. The possible return codes are:"

| Code | Meaning (verbatim) |
|---|---|
| `0` | "Maple exited normally, as a result of reaching the end of a Maple script if one was specified on the command line, or by executing a `quit`, `done`, or `stop` command." |
| `1` | "An error occurred during initialization, and Maple was unable to properly start up." |
| `2` | "A script specified on the command line (possibly by redirecting the standard input stream) ended prematurely. Usually this indicates a missing closing delimiter in the script, such as a parenthesis or an `end` keyword." |
| `3` | "After successfully reading a script specified on the command line, Maple failed to re-open the standard input stream for interactive input. This can happen only if the `-F` option was specified." |
| `4` | "While processing a script specified on the command line, an error was encountered. The severity of the error required to cause Maple to exit (instead of attempting to carry on) depends on the setting of `interface(errorbreak)`. A setting of 1 will stop only on syntax errors. A setting of 2 will stop on any error." |
| `5` | "The Maple kernel has unexpectedly terminated while executing a script or being used interactively." |
| `n` | "Any other return value can only occur if Maple executes a `` `quit`(n) ``, `` `done`(n) ``, or `` `stop`(n) `` function call, passing `n` as the desired return code. Typically … any value in the range 0 to 127 is permitted. It is a good idea to avoid values 1 through 5 since they already have predefined meanings as described above." |

**The single most important consequence for an MCP server:** with the **default
`errorbreak=1`**, a **runtime** error in the script does *not* abort and the process still exits
**0**. To make failures visible, always pass **`-e2`** (abort on any error → exit 4). `-e3`
(2022 only) additionally prints a stack trace.

Also note the **exception-channel** difference documented on the CURRENT `interface` page:

* `interface(errorbreak=0)` — reading/processing continues after any error (including redirected
  stdin and `read` files).
* `interface(errorbreak=1)` — from redirected stdin / `read` files: continues after a *computation*
  error, **stops after a syntax error**.
* `interface(errorbreak=2)` — stops after any error.
* `interface(errorbreak=3)` — as 2, plus a `tracelast` stack dump.

Additional detail from the same page: "Whenever reading and processing of a `read` file stops, the
stack of all currently active `read` commands is unwound… Whenever a stack of `read`s unwinds,
processing continues, with the next command being read from either the user, or from a redirected
input file. In other words, an error in a `read` file will not stop processing of a redirected
input file."

### 2.5 How syntax and runtime errors are reported

Maple prints errors as lines beginning with `Error,`. Concrete output strings from PG2018:

```
Error, invalid input: evalf expects 1 or 2 arguments, but received 0
Error, (in solve) a constant is invalid as a variable, 5
Error, (in cos) expecting 1 argument, got 2
Error, incorrect syntax in parse: missing operator or `;` (near 4th
Error, attempting to assign to `int` which is protected.            Try declaring
```

For syntax errors the CLI additionally positions the cursor / draws a pointer at the offending
location: `interface(errorcursor)` — *"For the Command-line interface, tells Maple to place the
cursor on the location of a syntax error (if true), or to indicate the location with a pointer
(if false)."* (default `true`). *(CURRENT `interface` page.)*

`-P` (parse-only) is the documented way to validate a file without executing it:

> "causes Maple to read input, but not evaluate any expressions. This can be used to quickly check
> a file of Maple commands for syntax errors, and should be used in conjunction with `-e0` so that
> Maple does not stop when an error is encountered."

Recommended MCP "lint" invocation:

```sh
maple -q -s -P -e0 file.mpl
```

***UNVERIFIED:*** the exact exit code produced by `-P -e0` when syntax errors are present (the
documented behaviour is "report the error and keep reading", so the process may well exit 0).
Detect syntax errors from the `Error, incorrect syntax in parse:` text instead.

### 2.6 Making output machine-parseable

All of the following are documented on the CURRENT `interface` and `lprint` help pages
(https://www.maplesoft.com/support/help/maple/view.aspx?path=interface and
https://www.maplesoft.com/support/help/maple/view.aspx?path=lprint):

| Mechanism | Documented effect | Why it matters for a parser |
|---|---|---|
| `interface(prettyprint=0)` | "Values less than or equal to zero produce various forms of output equivalent to that produced by `lprint`." In the **Command-line interface the default is `1`** (two-dimensional character-based output). | **Mandatory.** Without it, results are ASCII-art 2-D math and are very hard to parse. |
| `interface(ansi=false)` | "For the command-line interface, tells the pretty printer to use ANSI escape sequences to highlight Maple keywords, error messages, etc." Default is **`false` (Windows); `true` (UNIX)**. | **Mandatory on Linux.** Otherwise output is full of colour escapes. Related: `interface(ansilprint=false)`, `interface(ansiedit=false)`, `interface(getansi)`. |
| `lprint(expr)` | "returns NULL and prints its arguments in a one-dimensional format… In general, the printed form produced by `lprint` is valid Maple input." | Best per-value serialisation. |
| `printf("%a", expr)` | `%a` — "The object … is output in correct Maple syntax." `%A` omits quotes around symbols; `%Zm`/`%m` give `.m` format; `%q`/`%Q` consume and print all remaining arguments as an expression sequence. | The reliable way to emit **one line per result**, e.g. `printf("RESULT %a\n", ans):`. |
| `sprintf(…)` | Same formats, returns a string. | Build a value you can wrap in sentinels. |
| `interface(quiet=true)` | Suppresses logo, GC messages, bytes-used messages **and the prompt**. | Removes the `> ` prompt from the stream. |
| `interface(printbytes=false)` | Stops "bytes used" messages after every GC. | Removes diagnostics. |
| `interface(warnlevel=0)` / `-w 0` | Suppress all warnings. | Avoids interleaved warning text. |
| `interface(echo=0)` | "0 - Do not echo under any circumstance." | Avoids input being echoed into output. |
| `interface(rtablesize=infinity)` | Prevents large Arrays/Matrices being elided as placeholders. | Otherwise big results are silently truncated in the output. |
| `interface(screenwidth=…)` | Affects line-breaking of `lprint`/`latex`/`showstat` and the character plot driver. | Set a big value to avoid wrapping. |
| `writeto(file)` / `appendto(file)` | Redirect all screen output to a file (PG2018 §10.3). | Alternative to stdout capture. |
| `kernelopts(version)`, `interface(version)` | Version/build identification. | Handshake / capability probe. |
| `kernelopts(bytesused)`, `kernelopts(bytesalloc)`, `kernelopts(memusage)` | Memory introspection. | Resource accounting. |

The classic parseable prologue therefore is:

```maple
interface(prettyprint=0):
interface(ansi=false):
interface(quiet=true):
interface(echo=0):
interface(printbytes=false):
interface(warnlevel=0):
```

***UNVERIFIED:*** whether Maple 2018 supports every one of these interface variables with exactly
these names. All of them except the Maple-2021-era additions are long-standing; `interface` was
"updated in Maple 2021" (CURRENT page *Compatibility* note), so verify on the target install with
a probe such as `interface(prettyprint=0): interface(ansi=false): print("OK");`.

---

## 3. Running only PART of a worksheet / a single execution group

> *Section pending — being researched. This placeholder is replaced before delivery.*

---

## 4. Persistent Maple process controlled from outside (request/response protocol)

> *Section pending — being researched. This placeholder is replaced before delivery.*

---

## 5. Start-up, shutdown, resource limits and killing runaway computations

### 5.1 Start-up and shutdown cost

**Start-up is officially cheap.** PG2018 §14.4 (same text PG2021/22):

> "Starting the Maple command-line interface, automatically executing a command file, and stopping
> the Maple session can take about **one tenth of a second**, depending on which commands are run
> and the speed of your system. The quick start-up time and the minimal amount of processing
> required make the Maple command-line interface suitable to be called from other applications,
> even for quick calculations."

**Starting a session is not free of licensing cost** — see §6 (each process checks out a licence).

**Shutdown.** From the *quit* help page
(https://www.maplesoft.com/support/help/maple/view.aspx?path=quit), which applies to the
**Command-line** session:

> "The `quit` statement (`done` and `stop` are synonyms) terminates the Command-line Maple session
> and returns the user to the shell from which Maple was started. … Maple returns a status of 0."
>
> "The `` `quit` `` function (`` `done` `` and `` `stop` `` are synonyms) terminates the
> Command-line Maple session… The `expr` passed to `` `quit` `` must evaluate to an integer, and it
> is passed as a return status back to the shell. The range of valid return values is `0..255`."

Verbatim official example:

```
>`quit`(12)
bytes used=90888, alloc=131048, time=0.07
$ echo $?
12
```

> "In the Graphical User Interface version of Maple, entering `quit`, `done`, or `stop` at the
> Maple prompt does not terminate the Maple session."

So: to end a script cleanly with a chosen status use the **function form with backquotes**,
`` `quit`(0); ``. To end at the end of the script, just let it run off the end (exit 0).

### 5.2 Memory and CPU caps

There are three layers, all official:

**(a) `-T` — OS-level rlimits applied at startup** (M2018/M2022/CURRENT `maple` help):

```
-T cpu,data,stack,core
```

* `cpu` = "maximum number of seconds of CPU time"
* `data` = "amount of memory, in **kiloBytes**, that Maple can use"
* `stack` = "maximum stack size, in kiloBytes"
* `core` = "maximum size of core file"
* "You can specify any prefix of the four parameters, and omit the rest."

Example — 60 s CPU, 4 GiB heap:

```sh
maple -q -s -T 60,4194304 job.mpl
```

**(b) `--init-reserve-mem` / `--init-commit-mem` — Maple's own memory map** (same help page):

> "The `--init-reserve-mem` option allows the size of the virtual memory map that Maple creates on
> start up to be specified. **This is also the maximum amount of memory that the Maple session
> will be able to use.** By default Maple creates a map slightly smaller than the amount of
> physical memory available on the machine. By using this option, that size can be changed. By
> specifying an amount larger than that physical memory, Maple will use swap space if necessary.
> **If options `--init-reserve-mem` and `-T` are both given, then `-T` takes precedence.**"
>
> "The `--init-commit-mem` option allows the size of the memory Maple allocates on start up to be
> specified. … Instead of Maple growing its committed memory to that size, this option will force
> Maple to allocate the specified amount on start up."

**(c) `kernelopts(...)` — in-session, from PG2018 §16.6 "Managing Resources"** and the CURRENT
`kernelopts` help (https://www.maplesoft.com/support/help/maple/view.aspx?path=kernelopts):

| `kernelopts` name | Type | Documented meaning |
|---|---|---|
| `cpulimit` | integer (s) | "The total amount of CPU time, in seconds that Maple may consume. **Maple aborts if this time limit is exceeded.**" |
| `datalimit` | integer (KiB) | "The total amount of heap memory in kibibytes that Maple may consume. **Maple aborts if this limit is exceeded.** … This option is not supported on all platforms." |
| `stacklimit` | integer (KiB) | "The total amount of stack space … that Maple may consume. Maple aborts if this limit is exceeded." |
| `filelimit` | integer | "The maximum number of files that Maple can have open at one time." |
| `processlimit` | integer | "The maximum number of external processes that Maple can have running at one time." |
| `cacheclearlimit` | integer (KiB) | GC threshold for clearing temporary cache-table elements. |
| `jvmheaplimit` + `limitjvmheap` | integer / boolean | Cap the Java external-calling JVM heap (`limitjvmheap` default `false`). |
| `bytesused`, `bytesalloc` | integer | Total kernel bytes used / allocated. |
| `memusage` | list | "Displays a matrix of memory usage by Maple internal objects." |
| `gcbytesavail`, `gcbytesreturned`, `gctimes`, `gctotaltime` | integer | GC statistics. |
| `numcpus`, `gcmaxthreads`, `gcthreadmemorysize` | integer | Parallelism control (relevant for keeping the process small). |
| `version`, `versionnumber`, `platform`, `wordsize`, `pid`, `mapledir`, `bindir`, `datadir`, `homedir`, `dirsep` | various | Metadata / capability probing; all read-only except where noted. |

PG2018 §16.6 warns explicitly:

> "The `cpulimit`, `datalimit`, and `stacklimit` options can be used to set limits on the resources
> available to Maple and **must be used carefully**. Unlike the `timelimit` command, once one of
> these limits is reached, **Maple may shut down without warning** without prompting you to save
> your work. This makes these limit options most useful for running in non-interactive sessions."
>
> "On some platforms, including all Windows platforms, the detection of limit violations is tied
> to garbage collection and therefore the detection of limit violations will be inaccurate for
> code that rarely starts the garbage collection process."

> **There is no `kernelopts(maximememory)`.** The CURRENT `kernelopts` page lists 70+ names, and
> `maximememory` is not among them. Use `--init-reserve-mem` / `-T` / `datalimit` instead. *(The
> task brief guessed `kernelopts(maximize...)`; no such option exists in current documentation.
> ***UNVERIFIED*** for 2018/2022 specifically, but no such name appears in PG2018 either.)*

### 5.3 Per-statement time limits and killing a runaway

**Soft, catchable limit — `timelimit`.** PG2018 §16.6:

> "The `timelimit` command is used to limit the maximum amount of time available for a computation.
> … `timelimit( time, expression )` … If the time limit is reached before the expression is
> evaluated, `timelimit` raises an exception."

Official verbatim example with the catchable exception string:

```maple
> timelimit(0.25, f());
> try
    timelimit(0.25, f());
   catch "time expired":
    NULL;
   end try;
```

> "Multiple calls to `timelimit` can be nested, causing both limits to be active at once."
> "…a `try`-`catch` construct cannot capture a time limit exception event generated by a
> `timelimit` call in a surrounding scope."

Note: `timelimit` is documented in terms of **CPU time**.

**Hard kill.** The command-line interface documents interrupt handling in the
*Keyboard Shortcuts for Command-Line Maple* help page
(https://www.maplesoft.com/support/help/maple/view.aspx?path=commandline/reference/shortcutkeys):

| Shortcut | Function (verbatim) |
|---|---|
| `Ctrl + C` | "Interrupt the Currently Executing Command" |
| `Ctrl + Shift + _` | "Stop the Currently Executing Command in the Debugger" |
| `Ctrl + D` | "Delete (to Right of Cursor), or **Exit Maple** (if on a Blank Line)" |

So the console Maple responds to `Ctrl+C` / SIGINT interactively. For an MCP server the robust
pattern is defence in depth:

1. Wrap user computations in `timelimit(N, …)`.
2. Set `kernelopts(cpulimit=…)` and/or pass `-T cpu,data`.
3. As a last resort send `SIGTERM`/`SIGKILL` to the **kernel process, not the `maple` shell
   wrapper** — on Linux `maple` is a *script* (PG2018 §14.4 calls it "the `maple` script"), so
   `os.kill(pid)` on the wrapper may leave the kernel running. ***UNVERIFIED:*** the exact
   process tree/`exec` behaviour of the Linux `maple` script for 2018/2022; verify with
   `pstree -p` on the target machine and kill the process group (`kill -- -PGID` or start the
   child in its own process group).

---

## 6. Licensing and automation

### 6.1 What a batch/headless run requires

**Nothing special beyond a valid, activated licence.** The licence is checked when the Maple
kernel starts; if it fails you get documented exit code **1** ("An error occurred during
initialization, and Maple was unable to properly start up"). No CLI flag is documented as being
required for batch or headless operation.

### 6.2 Single-user (node-locked) licence

From **IG2018** (https://www.maplesoft.com/support/install/2018/Maple2018-Install.html), *Maple
2018 Installation Using a Single User License → Activating Single User Versions*:

> "**Starting Maple 2018 requires a Maple 2018 license file to operate.** License files for earlier
> releases of Maple will not work with Maple 2018. You must activate the single user version of
> Maple 2018 to obtain your license file."
>
> "**On Linux, you can also activate by running the activation script located in the `bin`
> directory of your Maple 2018 installation.**"
>
> "A Maple 2018 license file (`license.dat`) will be saved in the **`license` folder of your Maple
> 2018 installation**."
>
> "Note: Starting from Maple 14, **FlexNet**, the license management software used in Maple,
> requires Linux systems to be LSB 3.0 compatible… If you are receiving the 'Error detecting
> HostID' error message when trying to activate Maple on Linux, please ensure that the appropriate
> packages are installed. On Ubuntu, ensure the `lsb-base` and `lsb-core` packages are installed…
> On Red Hat, ensure the `redhat-lsb` package is installed. On SUSE, ensure the `lsb` package is
> installed."

**IG2022** (https://www.maplesoft.com/support/install/2022/Maple/Install.html) is textually the
same for Maple 2022: activation on Linux via the script in `bin`, and a `license.dat` saved in the
`license` folder of the installation.

Independent confirmation of the path and of the network-licence file format, from the Debian
packaging project `deb-maple` (https://github.com/guillod/deb-maple/blob/main/README.md):

> "A license file `license.dat` has to be provided to use Maple either next to the installer in
> order to be included in the package or need to be added in **`/opt/maple/license/`** after the
> package is installed. To use a network license server the `license.dat` is simply:
> ```
> SERVER hostname-or-ip-of-license-server ANY 27000
> USE_SERVER
> ```"

> **The `-f` option points at this file.** `maple -f /path/to/license.dat …` — *"tells Maple to use
> the specified license file instead of the default one"* (M2018/M2022/CURRENT). This is the
> documented way to run a batch process against a non-default licence file without touching the
> installation.

### 6.3 Network (floating) licence

Maple's network licensing is **FlexNet Publisher** (formerly FLEXlm). From IG2018 / IG2022:

* The licence server is started with the **`lmgrd`** daemon; the Maple **vendor daemon is
  `maplelmg`** (IG2022: "The `…\Maple Network Tools\FLEXlm\11.13.1.2\windows` directory contains
  license manager daemons (`lmgrd` and `maplelmg`) required to run Maple").
* Verbatim start command (IG2018, macOS/Linux):

  ```
  ./lmgrd -c license_file_path -l debug_log &
  ```

  > "where `license_file_path` is the full path and filename of the network license file (by
  > default, …`Maple2018.lic`), and `debug_log` is the name of a file to which debugging
  > information is written."
* Default port: **27000**; redundant-server setups use 27000/27001/27002 (IG2018/IG2022 install
  option table: `portNumber` default `27000`, `portNumber1` `27000`, `portNumber2` `27001`,
  `portNumber3` `27002`).
* The client is configured at install time ("In the *Choose The Type of Licensing* screen, select
  *Network License*… Enter the name or IP address of the license server…"), not per invocation.
* "Named Network Licensing" allows the administrator to restrict which users/machines may run
  Maple via an options file (`maplelmg.opt`) with `INCLUDE`/`GROUP` lines
  (https://www.maplesoft.com/support/install/2018/Maple2018-Install.html).

### 6.4 Concurrency, environment variables, and what is NOT documented

* **Concurrency.** A network (floating) licence is checked out **per running Maple process**. An
  MCP server that keeps N Maple workers alive holds N seats, and a worker that cannot get a seat
  will fail to initialise (documented exit code **1**). This is the main operational risk for a
  persistent-worker design. ***UNVERIFIED:*** the exact error text and whether the client blocks
  waiting for a seat before timing out; test on the target server.
* **Documented environment variables** (CURRENT `maple` help, *System Environment Variables*, a
  UNIX section):
  * `MAPLE` — "specifies where to find the Maple library and help files, the help browser index,
    and various configuration files. If the `MAPLE` variable is undefined, Maple uses
    `/usr/local/maple` as the default."
  * `HOME` — "used to identify where the user's `.mapleinit` file is located."
  * `PATH` — "used to locate auxiliary programs, such as the plot driver."
  * The page adds: "Under UNIX, Maple uses several system environment variables. **These are
    generally set by the `maple` script, so the user need not worry about them.**"
* **`LM_LICENSE_FILE` / `MAPLE_LICENSE_FILE`: *UNVERIFIED*.** No Maplesoft documentation I found
  states that Maple honours `LM_LICENSE_FILE` or a `MAPLE_LICENSE_FILE` variable. Even though the
  underlying licence manager is FlexNet Publisher, the documented client configuration mechanism
  is a `license.dat` in `<maple>/license/` (or a `-f <file>` override) plus the install-time
  server settings. **Do not rely on `LM_LICENSE_FILE`; do not put it in the MCP server's launch
  contract.**
* **Automation restrictions.** The only licence-related restriction I can point to officially is
  the requirement that each *concurrent* use has a licence (single-user licence = that machine /
  that user; network = a checked-out seat). Consult the Maplesoft EULA for the authoritative terms
  (https://www.maplesoft.com/documentation_center/Maplesoft_EULA.pdf). Anything stronger than that
  is ***UNVERIFIED***.

### 6.5 A concrete provenance / detection recipe for the MCP server

At startup, run a cheap probe to learn the version, platform and whether the licence works:

```sh
/opt/maple2022/bin/maple -q -s -e2 -c 'printf("PROBE %a %a %a\n", kernelopts(version), kernelopts(platform), kernelopts(wordsize)):'
```

and treat exit code `1` as "licence / installation problem", exit `0` + the `PROBE` line as
healthy. *(Composition of documented primitives: `-q -s -e2 -c`, `kernelopts(version)`,
`kernelopts(platform)`, `kernelopts(wordsize)`, `printf("%a")`.)*

---

## 7. Implications for the MCP-server design (summary)

| Decision | Recommendation | Basis |
|---|---|---|
| Executable | `<maple>/bin/maple` on Linux/macOS; `cmaple` on Windows | §1.1 |
| Per-call batch | `maple -q -s -e2 --historyfile=none -w 0 script.mpl` | §2.2, §1.3 |
| Parseable output | `interface(prettyprint=0): interface(ansi=false): interface(quiet=true):` | §2.6 |
| Failure detection | rely on **exit code 4** *only if* `-e2`/`-e3` is set; otherwise scan for `Error,` | §2.4, §2.5 |
| Syntax-only tool | `maple -q -s -P -e0 file.mpl` | §1.3 `-P` |
| Sandboxing untrusted code | `-z` plus `--secure-read=` / `--secure-write=` specifications; note `--secure-syscall` defaults off | §1.3 |
| Memory cap | `--init-reserve-mem=<bytes>` *or* `-T cpu,data`; `-T` wins | §5.2 |
| Per-request time cap | `timelimit(N, expr)` inside the script, plus `-T`/`kernelopts(cpulimit)` as backstop | §5.3 |
| Runaway kill | SIGINT/SIGTERM to the **kernel process / process group**, not the `maple` shell wrapper | §5.3 |
| Licensing | one licence seat per live worker; expect exit 1 on licence failure | §6.4 |
| Version split to handle | 2018 lacks `--echofile`/`--strip-debug-info`, has `-cw`; `-e3` is 2022+ | §1.4 |

---

## 8. Explicit open questions / UNVERIFIED items

1. Whether a Linux Maple 2018/2022 installation also provides a `cmaple` binary or symlink.
2. Whether `-c` really rejects arguments containing spaces, given PG2018's contradicting example.
3. Whether error messages go to stdout or stderr in the command-line version — merge both streams.
4. Whether the `> ` prompt is printed when stdin is a pipe/file in 2018/2022, and whether `-q`
   alone suppresses it (use `interface(quiet=true)` too).
5. Whether `-km` is silently ignored by the console launcher.
6. Whether `LM_LICENSE_FILE` / `MAPLE_LICENSE_FILE` are honoured at all.
7. The exact release in which `-cw` was removed and `--echofile`/`--strip-debug-info`/`-e3` were
   added (bracketed between the 2018-era and 2022-era snapshots).
8. The exact network-licence exhaustion error text and whether `maple` blocks or fails fast.
9. The process tree / `exec` behaviour of the Linux `maple` launcher script (matters for killing).
10. Availability of every `interface()` variable listed in §2.6 in Maple 2018 specifically.

---

## Sources

**Official Maplesoft — online help (live pages reflect Maple 2026 unless stated):**

* `maple` — the command and all options, exit codes, initialization files, environment variables:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=maple
* `maple` help page **as archived 2018‑06‑01** (Maple 2018 era):
  https://web.archive.org/web/20180601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple
* `maple` help page **as archived 2022‑06‑01** (Maple 2022 era):
  https://web.archive.org/web/20220601000000id_/https://www.maplesoft.com/support/help/maple/view.aspx?path=maple
* Maple Versions (interfaces and which command to use per platform):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=versions
* `kernelopts` (resource limits, memory introspection):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=kernelopts
* `interface` (prettyprint, ansi, plotdevice, errorbreak, prompt, quiet, printbytes, echofile, …):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=interface
* `lprint` (1-D, parseable serialisation):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=lprint
* `printf` (formats `%a`, `%A`, `%q`, `%m`, …):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=printf
* `plotsetup`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=plotsetup
* `plot/device` (headless plot drivers `char`, `colorchar`, `postscript`, `gif`, `jpeg`, …):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=plot/device
* `quit` / `done` / `stop` (exit status 0–255):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=quit
* `timelimit`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=timelimit
* `read`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=read
* `readstat`:
  https://www.maplesoft.com/support/help/maple/view.aspx?path=readstat
* EngineSecurity/CLIConfig (the `--secure-*` options and `-z` semantics):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=EngineSecurity/CLIConfig
* Keyboard Shortcuts for Command-Line Maple (Ctrl+C interrupt, Ctrl+D exit):
  https://www.maplesoft.com/support/help/maple/view.aspx?path=commandline/reference/shortcutkeys
* Command-Line Maple help category (index of CLI help pages):
  https://www.maplesoft.com/support/help/maple/category.aspx?cid=1435

**Official Maplesoft — PDFs and installation/licensing guides:**

* Maple 2018 Programming Guide, §14.4 "The Maple Command-line Interface" (p. 487), §14.3 OpenMaple,
  §16.6 "Managing Resources":
  https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf
  (mirror: https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf)
* Maple Programming Guide linked as the **Maple 2022** Programming Guide (© 1996‑2020):
  https://www.maplesoft.com/documentation_center/maple2021/ProgrammingGuide.pdf
* Maple 2018 User Manual (interface comparison: Command-line version):
  https://www.maplesoft.com/documentation_center/maple2018/UserManual.pdf
* Maple 2022 User Manual:
  https://www.maplesoft.com/documentation_center/maple2022/UserManual.pdf
* Maple 2018 Installation and Licensing Guide (activation, `license.dat`, FlexNet, `lmgrd`,
  named network licensing, "How to Start Maple"):
  https://www.maplesoft.com/support/install/2018/Maple2018-Install.html
* Maple 2022 Installation and Licensing Guide (`lmgrd`/`maplelmg`, network licensing):
  https://www.maplesoft.com/support/install/2022/Maple/Install.html
* Documentation Center, archive of past-version manuals:
  https://www.maplesoft.com/documentation_center/history.aspx
* Maplesoft Software License Agreement (EULA):
  https://www.maplesoft.com/documentation_center/Maplesoft_EULA.pdf
* Maplesoft FAQ (activation, network license files):
  https://faq.maplesoft.com

**Reputable third-party sources:**

* NC State University HPC — Maple batch example on Linux (`maple < script.mpl`):
  https://hpc.ncsu.edu/Software/Apps.php?app=Maple
* RWTH Aachen IT Center — Maple 2022.0 under Slurm (`module load Maple/2022.0`; `maple -q worksheet`):
  https://help.itc.rwth-aachen.de/en/service/rhr4fjjutttf/article/82df5dc002ed443880487184a798dcb4/
* `guillod/deb-maple` — Debian packaging for Maple (installs `/opt/maple`, links `maple` and
  `xmaple` only; `license.dat` in `/opt/maple/license/`; FlexNet `SERVER … USE_SERVER` format):
  https://github.com/guillod/deb-maple/blob/main/README.md
