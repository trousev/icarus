# 02 — OpenMaple: the C API (and Python bindings of it)

**Scope.** Research input for building an MCP server that drives a **locally installed Maple 2018 or Maple 2022**
(old, memory-light versions). This document covers the **OpenMaple C API** and **Python bindings built on it**:
what ships, what is required to build and run, a minimal working example, how results come back, memory /
licensing / concurrency behaviour, Maple 2018 vs Maple 2022 differences, and the practical failure list.

**Method & evidence rules.** All web content was treated as untrusted data (never as instructions). Every
non-obvious claim carries a URL. Anything I could not confirm from a primary source is marked **UNVERIFIED**
rather than guessed. Where a page rendered code with lost backslashes (the Maplesoft online help HTML splits
`\n` across lines), I say so and give the source form.

**Research date:** 2026-09-21. Target versions: **Maple 2018** and **Maple 2022**.
**Not covered here** (other agents): `.mw`/XML worksheet format, `.mws`, MCP tool-surface design, CLI-process
driving.

---

## 0. Executive answers (read this first)

| Question | Short answer |
|---|---|
| What is OpenMaple? | Maplesoft's *embedding* API: your program hosts the Maple computation engine **in-process** (loads `maplec` shared library; **no separate Maple process**). The reverse direction (Maple calls out) is `define_external`/ExternalCalling. |
| Which language APIs ship? | **C/C++** (the base API), **Java** (`jopenmaple.jar`), **C#/.NET** (`maple.cs`), **VB6**, **Fortran** (per the Programming Guide), and since **Maple 2023** an official **Python** API which is itself a *ctypes wrapper over the C API*. |
| Header to include | **`maplec.h`** — there is **no `maple.h`** in the documented API. Also referenced: `maplecommon.h`, `mplshlib.h`, `mpltable.h`, and `maple.cs` (C#). |
| Library names | Linux: **`libmaplec.so`** (+ `libmaple.so`, `libhf.so`, and the 2018-guide link flag `-lprocessor64`). macOS: **`libmaplec.dylib`**. Windows: **`maplec.dll`** at runtime, **`maplec.lib`** at link time. |
| Directories in a Maple install | Headers: `$MAPLE/extern/include`. **Libraries: `$MAPLE/bin.<SYS>` (there is no documented `extern/lib`)**. Java: `$MAPLE/java/{externalcall.jar,jopenmaple.jar}`. Samples: `$MAPLE/samples/OpenMaple/...`. Licence notice: `$MAPLE/extern/OpenMapleLicensing.txt`. |
| Env vars at runtime | `MAPLE=<install root>`, plus `LD_LIBRARY_PATH` (Linux) / `DYLD_LIBRARY_PATH` (macOS) containing the binary dir, or `PATH` (Windows). |
| Entry points | `StartMaple` → `EvalMapleStatement` / `EvalMapleProcedure` / `MapleEval` → `MapleToString` etc. → `StopMaple` (and `RestartMaple`). **There is no function called `MapleOpenMaple`.** |
| Results | Primarily **text via the `textCallBack`**, *and* structured **`ALGEB`** objects that you can convert with `MapleToString`, `MapleToInteger64`, … For LaTeX/MathML, call Maple commands (`latex`, `MathML:-ExportContent`, `Export`) **inside** the session and read the returned string. |
| Licence | Requires a **licensed, locally installed Maple**; you may distribute your app "to any licensed Maple 9 or later user". Terms: `extern/OpenMapleLicensing.txt` (contents **UNVERIFIED** — not published online). EULA PDF does not mention OpenMaple by name. |
| Python for 2018/2022 | **None officially.** The official Python API is **Maple 2023+** (`import maple`), renamed **`maplesoft.maple`** in 2024+, distributed on GitHub under MIT, **README states Maple 2024 or later**. For 2018/2022 you must write your own ctypes/cffi binding against the C API (or fork the MIT wrapper). |
| Bottom line for the MCP server | Use the **C API through Python `ctypes`** with `textCallBack`-captured output (plus `MapleToString` for the returned `ALGEB`). Keep one session per worker **process** (one `StartMaple` per process). Start the process from the Maple launch script (`-norun`) or set `MAPLE` + `LD_LIBRARY_PATH` yourself. |

---

## 1. What OpenMaple is, and what it ships

### 1.1 Official description

> "OpenMaple is a suite of functions that allows you to access Maple algorithms and data structures in your
> compiled C, Java, or Visual Basic programs. This is the reverse of ExternalCalling, which allows access to
> compiled C and Java code from Maple."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple>

> "The **C OpenMaple** application program interface (API) is built on top of the existing API for writing
> ExternalCalling custom wrappers. C OpenMaple provides the ability to start a Maple session, evaluate commands,
> manipulate native Maple data structures, and control output."
> — same page

> "The **Python OpenMaple** application program interface (API) is built on top of the C API. It provides
> comprehensive access to Maple data structures and commands from a Python session."
> — same page (this bullet exists only in *current* help; see §7 for version applicability)

The Maple 2018 Programming Guide, §14.3 (p. 476):

> "OpenMaple is an interface that lets you access the Maple computation engine by referencing its dynamic-link
> library (.dll) file. […] Interfaces to access the OpenMaple API are provided for use with C, C++, Java, Fortran,
> C#, and Visual Basic. **All of these interfaces are built on the C API**, so they all reference the primary
> library, `maplec.dll`, which is located in your Maple binary directory."
> — <https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf> (Maple 2018 Programming Guide)

The same chapter exists, textually near-identical, in:
* Maple 2021 — <https://www.maplesoft.com/documentation_center/Maple2021/ProgrammingGuide.pdf>
* Maple 2023 — <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>

See §6 for the 2018↔2022→2023 diff.

### 1.2 What "in-process" means (important for MCP design)

> "In all cases, the initialization process loads the `maplec.dll` file and sets up the initial state so that the
> OpenMaple interface can evaluate commands. **Despite the name `StartMaple`, this is only an initialization step;
> no separate Maple process is started.**"
> — 2018 Programming Guide, p. 478

So an OpenMaple host *is* a Maple kernel: there is no `maple` executable to talk to over stdio, and no CMAP
socket. Any license error, crash, or memory blow-up happens **inside your own process** — one reason to keep the
engine in a disposable worker process rather than in the MCP server itself.

### 1.3 API surface (the OpenMaple-specific functions)

From the official C API overview (<https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API>),
the functions usable **only** with OpenMaple are:

```text
callBackCallBack   errorCallBack   queryInterrupt   readLineCallBack
redirectCallBack   RestartMaple    StartMaple       statusCallBack
StopMaple          streamCallBack  textCallBack
```

The same page groups the rest of the (shared with `define_external`) API into: Conversion from Maple Objects
(`MapleToString`, `MapleToInteger64`, …), Conversion to Maple Objects (`ToMapleName`, `ToMapleInteger`, …),
Data Queries (`IsMapleString`, `IsMapleRTable`, …), RTable manipulation, List/Table manipulation, Output
(`MapleALGEB_Printf`, `MapleALGEB_SPrintf`, `MaplePrintf`, `MapleUserInfo`), Assignment/Selection
(`MapleAssign`, `MapleSelectIndexed`, …), Memory & foreign objects (`MapleAlloc`, `MapleGcProtect`, …),
System properties (`MapleHelp`, `MapleKernelOptions`, `MapleLibName`), and Evaluation/Error handling
(`EvalMapleStatement`, `EvalMapleProc`, `MapleEval`, `MapleEvalhf`, `MapleTrapError`, `MapleRaiseError1`,
`MaplePopErrorProc`, `MaplePushErrorProc`, `MapleMutexLock`, `MapleStartRootTask`, `MapleStartChildTask`,
`MapleCreateContinuationTask`, …).

> "All functions can be used in external code with OpenMaple **and** define_external (except OpenMaple-specific
> functions, which can be used only with OpenMaple)."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API>

**Note on naming:** there is **no** `MapleOpenMaple()` function in any source I checked. `OpenMaple` is the
product name; the session entry point is `StartMaple`. (Searched the C API function index and every
"OpenMaple Functions" help page.) If a design doc mentions `MapleOpenMaple`, it is a misnomer.

---

## 2. What you need to build and run the C API

### 2.1 Headers and directories

Verbatim from the official Examples page
(<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/Examples>):

> "To build an OpenMaple application you need to specify the include path to **`maplec.h`**, which is found in the
> **`$MAPLE/extern/include`** directory. You also need to link to the **`maplec.lib`** (or **`libmaplec.so`**)
> library. The UNIX `HelpExamples.c` file also needs the standard C and standard math libraries, `-lc` and
> `-lm`, linked in. Before running your application make sure the appropriate path is set."

And:

> "The source code for many of the OpenMaple and define_external examples shown in these help pages is available in
> the **samples** directory of your Maple installation. In particular, **`samples/ExternalCall/HelpExamples/HelpExamples.c`**
> contains the source for all API function examples, and **`samples/OpenMaple/HelpExamples`** contains separate
> example C files for each `StartMaple` callback."

Directory cheat-sheet (all from official docs above + 2018 Programming Guide §14.3):

| Path | Contents |
|---|---|
| `$MAPLE/extern/include` | `maplec.h` and the other C headers (`maplecommon.h`, `mplshlib.h`, `mpltable.h`), `maple.cs` (C#) |
| `$MAPLE/bin.<SYS>` | the runtime libraries: `libmaplec.so` / `libmaplec.dylib` / `maplec.dll` (+ `maplec.lib` import lib on Windows), plus `libmaple.*`, `libhf.*` |
| `$MAPLE/java` | `externalcall.jar`, `jopenmaple.jar` |
| `$MAPLE/samples/OpenMaple` | `simple/`, `HelpExamples/`, `Java/simple/`, `msvb/` |
| `$MAPLE/extern/OpenMapleLicensing.txt` | additional terms for OpenMaple use |

> "Note that the C header files can be found in the `$MAPLE/extern/include` directory and **the library files can
> be found in the `$MAPLE/bin.$SYS` directory**."
> — 2018 Programming Guide, p. 480

`$SYS` is the platform tag; get yours from Maple with `kernelopts(bindir)` / `kernelopts(mapledir)`:

```text
bin.X86_64_LINUX              # Linux 64-bit       (documented)
bin.APPLE_UNIVERSAL_OSX       # macOS Intel 64-bit  (documented)
bin.X86_64_WINDOWS            # Windows 64-bit      (documented, current)
bin.win                       # older Windows layout, still referenced by the guide
```

**There is no documented `extern/lib`** directory: the guide puts the libraries in the binary directory.
(Apple-Silicon-specific binary directory names are **UNVERIFIED** — the documented macOS tag is
`bin.APPLE_UNIVERSAL_OSX`; check `kernelopts(bindir)` on the machine.)

### 2.2 Runtime environment variables

From the 2018 Programming Guide §14.3 "Runtime Environment Prerequisites" (p. 477):

> "To run your application, two paths must be set up in your local environment.
> • the path to the `maplec.dll` file
> • the path to the top-level directory in which Maple is installed
> In Windows, depending on the source programming language, calls to initialize the OpenMaple interface will
> locate these paths automatically […]
> **In Linux and Mac OS X, the `MAPLE`, and `LD_LIBRARY_PATH` or `DYLD_LIBRARY_PATH` environment variables must be
> set before starting your application.**"

and the documented way to get a fully-populated environment — source Maple's own launcher without starting Maple:

```sh
#!/bin/sh
export MAPLE="/usr/local/maple"
. $MAPLE/bin/maple -norun
myapp $*
```

> "These commands run the maple launch script to configure your environment without starting Maple. The period (.)
> prefix in a Bourne shell causes the commands to be sourced, thus, applying the settings to future sessions."

This is the most robust recipe, because `maple -norun` exports the *complete* `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH`
(which normally contains more than just `bin.$SYS`). The official Python docs say the same:

> "On Linux, you need to add at least `<BINDIR>` to the `LD_LIBRARY_PATH` environment variable and set the `MAPLE`
> environment variable. **For a complete list of directories to add, run `getenv(LD_LIBRARY_PATH);` in Maple and
> use that exact value.**"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/Python/running>

### 2.3 Exact build command lines

**Maple 2018 / 2021 / 2023 Programming Guide** (identical text in all three; the command wraps across two lines
in the PDF):

```text
gcc -I $MAPLE/extern/include test.c -L $MAPLE/bin.X86_64_LINUX -lmaplec
-lmaple -lhf -lprocessor64
```

> "In Windows, you only need to link to the `maplec.lib` library. Other platforms may require several libraries to
> be linked, including `libmaplec.so`, `libmaple.so`, and `libhf.so`. If you do not specify a library as required,
> the compiler returns a message indicating that undefined references to functions exist, or a dependent library
> cannot be found."
> — 2018 Programming Guide, p. 480

**Current online Examples page** (rendered as a 3-column table; reconstructed here — the source is a table, so
treat the exact spacing as my transcription, the flags as theirs):

```text
Linux (64-bit)     LD_LIBRARY_PATH=$MAPLE/bin.X86_64_LINUX
                   gcc simple.c -o simple -I$MAPLE/extern/include -L$MAPLE/bin.X86_64_LINUX -lmaplec -lrt

macOS (Intel 64-bit) DYLD_LIBRARY_PATH=$MAPLE/bin.APPLE_UNIVERSAL_OSX
                   gcc simple.c -o simple -I$MAPLE/extern/include -L$MAPLE/bin.APPLE_UNIVERSAL_OSX -lmaplec

Windows (64-bit)   PATH=$MAPLE/bin.X86_64_WINDOWS
                   cl simple.c -Fe:simple.exe -I$MAPLE/extern/include $MAPLE/bin.X86_64_WINDOWS/maplec.lib
```

> "These all assume the environment variable `$MAPLE` is set to the Maple install directory (eg.
> `MAPLE=/usr/local/maple`)."
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/Examples>

Note the **link-line difference**: the printed Programming Guides say `-lmaplec -lmaple -lhf -lprocessor64`, the
current online help says `-lmaplec -lrt`. An independent real-world binding uses the newer form:

```make
openMaple_stubs.o: openMaple_stubs.c
	gcc -g -c -std=c99 -fPIC \
	    -Wl,-rpath=${MAPLE}/bin.${MAPLE_ARCH} \
	    -L${MAPLE}/bin.${MAPLE_ARCH} \
	    -I${MAPLE}/extern/include \
	    $^
...
			-cclib -lmaplec \
			-cclib -lrt \
```
— <https://github.com/mezzarobba/openmaple-ocaml/blob/main/Makefile> (OCaml OpenMaple binding)

**Practical advice:** try `-lmaplec` alone first (plus `-lrt` if the linker asks), because `libmaplec.so` is
linked against the rest and carries an `RPATH`/`SONAME` chain on most installs; add `-lmaple -lhf -lprocessor64`
only if you get undefined references. **UNVERIFIED** which exact set is sufficient on a given 2018 vs 2022 Linux
install — this must be tested on the target machine.

### 2.4 Java / C# / VB6 build lines (for completeness)

* Java (2018 Guide, p. 483–484):

```text
$JDKBINDIR/javac -classpath "$MAPLE/java/externalcall.jar;$MAPLE/java/jopenmaple.jar" test.java
$JDKBINDIR/java  -classpath "$MAPLE/java/externalcall.jar;$MAPLE/java/jopenmaple.jar;." test
```

  (use `:` instead of `;` on macOS/Linux.) Requires `com.maplesoft.openmaple.*` and
  `com.maplesoft.externalcall.MapleException`.
* C#/.NET (2018 Guide, p. 482):

```text
csc test.cs $MAPLE\extern\include\maple.cs
```

  "The `maple.cs` file contains the `MapleEngine` class definition and defines an interface to the `maplec.dll`
  file." The C# example calls `MapleEngine.StartMaple(2, argv, ref cb, IntPtr.Zero, IntPtr.Zero, err)` and
  `MapleEngine.EvalMapleStatement(kv,"int(x,x);")`.
* VB6: see the VB example in the same Guide chapter; no separate library — it uses `maplec.dll` directly.

---

## 3. Minimal working C example, and the callback architecture

### 3.1 The canonical minimal example (verbatim, Maple 2018 Programming Guide pp. 479–480)

```c
#include <stdio.h>
#include <stdlib.h>

#include "maplec.h"

/* callback used for directing result output */
static void M_DECL textCallBack( void *data, int tag, char *output )
{
   printf("%s\n",output);
}

int main( int argc, char *argv[] )
{
   char err[2048]; /* command input and error string buffers */
   MKernelVector kv; /* Maple kernel handle */
   MCallBackVectorDesc cb = { textCallBack,
                               0,  /* errorCallBack not used */
                               0,  /* statusCallBack not used */
                               0,  /* readLineCallBack not used */
                               0,  /* redirectCallBack not used */
                               0,  /* streamCallBack not used */
                               0,  /* queryInterrupt not used */
                               0   /* callBackCallBack not used */
                              };
    ALGEB r;    /* Maple data-structures */

    /* initialize Maple */
    if( (kv=StartMaple(argc,argv,&cb,NULL,NULL,err)) == NULL ) {
        printf("Fatal error, %s\n",err);
        return( 1 );
    }

    r = EvalMapleStatement(kv,"int(x,x);");

    StopMaple(kv);

    return( 0 );
}
```

> "This example can be entered in a file called `test.c`. […] When this example is built, a file called `test.exe`
> is created. […] The following output is displayed.
> `1/2*x^2`"
> — 2018 Programming Guide, pp. 479–481

The same program is the `$MAPLE/samples/OpenMaple/simple/simple.c` sample referred to by the online Examples page.

### 3.2 The `StartMaple` help-page example (richer: options + ALGEB manipulation)

Verbatim from <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StartMaple> — note the
online help renders `\n` as a line break, so `printf("%sn",output)` in the text dump is `printf("%s\n",output)`
in the source:

```c
#include <stdio.h>
#include <stdlib.h>
#include "maplec.h"

static void M_DECL textCallBack( void *data, int tag, char *output )
{
    printf("%s\n",output);
}

int main( int argc, char *argv[] )
{
    char err[2048];
    MKernelVector kv;
    MCallBackVectorDesc cb = {  textCallBack,
                                0,
                                0,
                                0,
                                0,
                                0,
                                0,
                                0
                             };
    ALGEB r, l;

    if( (kv=StartMaple(argc,argv,&cb,NULL,NULL,err)) == NULL ) {
        printf("Fatal error, %s\n",err);
        return( 1 );
    }

    r = MapleKernelOptions(kv,"mapledir",NULL);
    if( IsMapleString(kv,r) )
        printf("Maple directory = %s\n",MapleToString(kv,r));

    printf("Evaluate an integral: \n\t");
    r = EvalMapleStatement(kv,"int(1/(x^4+1),x);");

    MapleAssign(kv,
                ToMapleName(kv,"x",TRUE),
                ToMapleInteger(kv,0));
    r = MapleEval(kv,r);
    MapleALGEB_Printf(kv,"\nEvaluated at x=0, the integral is: %a\n",r);

    l = MapleListAlloc(kv,3);
    MapleListAssign(kv,l,1,r);
    MapleListAssign(kv,l,2,ToMapleBoolean(kv,1));
    MapleListAssign(kv,l,3,ToMapleFloat(kv,3.14));
    MapleALGEB_Printf(kv,"\nHere is the list: %a\n",l);

    return( 0 );
}
```

(Indentation re-flowed by me; the token stream is as published. `%a` is the `MapleALGEB_Printf` conversion for an
`ALGEB`.)

### 3.3 Callback architecture

The `cb` argument to `StartMaple` is an `MCallBackVector`. Verbatim from the `StartMaple` help page:

```c
typedef struct {
void (M_DECL *textCallBack)( void *data, int tag, char *output );
void (M_DECL *errorCallBack)( void *data, M_INT offset,
char *msg );
void (M_DECL *statusCallBack)( void *data, long kilobytesUsed,
long kilobytesAlloc, double cpuTime );
char * (M_DECL *readLineCallBack)( void *data, M_BOOL debug );
M_BOOL (M_DECL *redirectCallBack)( void *data, char *name,
char *mode );
char * (M_DECL *streamCallBack)( void *data, char *name,
M_INT nargs, char **args );
M_BOOL (M_DECL *queryInterrupt)( void *data );
char * (M_DECL *callBackCallBack)( void *data, char *output );
} MCallBackVector, *MCallBack;
```

> "All callback functions have defaults that direct output to another callback, or to `stdout`. To use the
> default, set the function pointer to `NULL`. **It is recommended that you always define a `textCallBack`
> function.**"
> "The `data` parameter is passed the value of the `user_data` parameter given to `StartMaple`."
> "**All the API functions, including the callback functions, are declared with the `M_DECL` modifier. The
> functions assigned to the callback vector must also be declared with the `M_DECL` modifier.**"
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StartMaple>

`textCallBack` semantics, verbatim:

> "The `textCallBack` function is called with typical (non-exceptional) Maple output. The output that Maple
> generates, for example, an intermediate result or the output from a `printf` statement, is passed to the
> `textCallBack` function."
> "**A single result may be split into multiple calls to the `textCallBack` function.**"
> "Most output obeys `interface(screenwidth)`, which is initially set to infinity."
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/textCallBack>

The `tag` values (defined in `maplec.h`), verbatim from the same page:

```text
MAPLE_TEXT_OUTPUT    A line-printed (1-D) Maple expression or statement.
MAPLE_TEXT_DIAG      Diagnostic output (high printlevel or trace output).
MAPLE_TEXT_MISC      Miscellaneous output, for example, from the Maple printf function.
MAPLE_TEXT_HELP      Text help output.
MAPLE_TEXT_QUIT      Response to a Maple quit, done, or stop command.
MAPLE_TEXT_WARNING   A warning message generated during a computation.
MAPLE_TEXT_ERROR     An error message generated during parsing or processing.
                     (only if you do not specify an errorCallBack function)
MAPLE_TEXT_STATUS    Kernel resource usage status ("bytes used") message.
                     (only if you do not specify a statusCallBack function)
MAPLE_TEXT_DEBUG     Output from the Maple debugger.
```

`errorCallBack` semantics, verbatim:

> "The `offset` parameter indicates the location of a parsing error. **If `offset >= 0`, the error was detected at
> the specified offset in the string passed to `EvalMapleStatement`. If `offset < 0`, the error is not a parsing
> error; it is a computation error.**"
> "If an `errorCallBack` function is not specified, error messages are sent to the `textCallBack` function, with
> the `MAPLE_TEXT_ERROR` tag."
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/errorCallBack>

**Critical for an MCP server:** `textCallBack` receives *arbitrary-length* fragments and **a single result may be
split across several calls**, so capture into a buffer (one buffer per `EvalMapleStatement`) rather than assuming
one callback == one line/result. Also decide whether you want `errorCallBack` defined (structured `offset`) or
errors multiplexed into the text stream with `MAPLE_TEXT_ERROR`.

### 3.4 Exact signatures of the core functions

`StartMaple` (<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StartMaple>):

```c
StartMaple( argc, argv, cb, user_data, info, err )
/* argc      - int, number of startup command-line arguments (INCLUDING the
               implicitly-defined argv[0], which must be set to "maple")      */
/* argv      - char**                                                          */
/* cb        - callback Vector (MCallBackVector / MCallBackVectorDesc)         */
/* user_data - void*                                                           */
/* info      - void*; "reserved for internal use and must always be set to NULL" */
/* err       - char* buffer; on failure StartMaple returns NULL and fills this  */
/* returns   - MKernelVector (NULL on failure)                                  */
```

> "If initialization fails, `StartMaple` returns NULL and fills in the string provided in the `err` parameter.
> **This string, if non-NULL must be preallocated to fit at least 2048 characters (including the NULL
> terminator).** Maple does not generate error messages longer than this."
> "An initialization failure stating that the `license.dat` file does not exist, usually indicates that OpenMaple
> cannot find the path to the Maple installation. In Windows, it can find this in the registry, but **in UNIX and
> on the Macintosh, the environment variable `$MAPLE` must be set to the root directory of the Maple
> installation** […] In addition to the `$MAPLE` environment variable, the `$PATH`, or `$LD_LIBRARY_PATH` may also
> need to be set."
> "Startup options described in `?maple` can be used for starting OpenMaple by specifying them in `argv`. For
> example, to load the initialization file, `/home/myinit`, at startup, set `argv[1] = "-i"`, and
> `argv[2] = "/home/myinit"`."

`StopMaple` / `RestartMaple` (<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StopMaple>):

```c
StopMaple( kv )              /* kv - kernel handle of type MKernelVector */
RestartMaple( kv, err )      /* err - string buffer; returns FALSE and fills err on failure */
```

> "`StopMaple` permanently terminates execution of OpenMaple. **After calling `StopMaple`, OpenMaple cannot be
> restarted with `StartMaple`.**" (i.e. do not `StartMaple` again after `StopMaple` in the same process)
> "`RestartMaple` causes the Maple kernel to clear its internal memory so that Maple acts as if just started.
> This function is equivalent to executing the Maple `restart` command."

`EvalMapleStatement` — not documented on its own help page in the current online help (the
`OpenMaple/C/EvalMapleStatement` URL 404s); it is listed in the API index under "Evaluation and Error Handling"
and its shape is fixed by every official example and by the official Python wrapper:

```c
ALGEB EvalMapleStatement( MKernelVector kv, char *statement );
```

The official MIT-licensed Python wrapper declares it as (verbatim):

```python
maplec.EvalMapleStatement.argtypes = [ MKernelVector, ctypes.c_char_p ]
maplec.EvalMapleStatement.restype = ALGEB
```
— <https://github.com/Maplesoft/openmaple/blob/main/maplesoft/maple/maplec_ctypes.py>

Related, from the API index: `EvalMapleProc(kv, ALGEB fn, ALGEB args)`, `MapleEval(kv, ALGEB)`,
`MapleEvalhf(...)`, `MapleTrapError(...)`, `MapleRaiseError1(kv,"fmt %1",(ALGEB)arg)`.

> "The OpenMaple interface manages Maple internal data structures and performs garbage collection. **The data
> structures that are returned by an API function are automatically protected from garbage collection.** The
> Maple command `unprotect:-gc` must be called to clean the memory reserved for these tasks."
> — 2018 Programming Guide, p. 479

That last sentence is a real memory-growth hazard for a long-lived session: every `ALGEB` you keep hold of stays
protected. For an MCP server, prefer **not** retaining `ALGEB`s across requests — evaluate, stringify, drop.

---

## 4. Getting results back

### 4.1 Two mechanisms, use both

1. **Text callbacks** — everything that would print in a Maple session arrives at `textCallBack`
   (1-D line-printed for `MAPLE_TEXT_OUTPUT`). Simplest, and enough for "show me the answer".
2. **Structured `ALGEB`** — `EvalMapleStatement` *also* returns the result as a Maple data structure you can
   inspect/convert without re-parsing text:
   * `MapleToString(kv, s)` → `char*` ("convert a Maple object to a character array")
   * `IsMapleString/Integer/Integer64/Float64/ComplexNumeric/List/Set/Table/RTable/Name/...` predicates
   * `MapleToInteger64`, `MapleToFloat64`, `MapleToM_BOOL`, `MapleToComplexFloat64`, …
   * `MapleALGEB_SPrintf1(kv, b'%d', expr)` for formatting into a Maple string, then `MapleToString`
   * Composite access: `MapleListSelect/MapleListAlloc`, `MapleTableSelect`, `RTable*`, `MapleExpseqAssign`, …

   The official Python wrapper uses exactly this mixture; e.g. integers become Python `int` via
   `MapleToInteger64` or `MapleALGEB_SPrintf1` + `MapleToString`, strings via `MapleToString`, lists/sets/tables
   recursed element-wise. See `maplesoft/maple/Session.py` and `exportto.py` in
   <https://github.com/Maplesoft/openmaple>.

`MapleToString` caveats, verbatim:

> "`MapleToString` returns the same character array pointer referenced in the given Maple object. **This string
> must not be modified in-place. Modifications must be made on a copy**, not the original string returned by
> `MapleToString`."
> "Some native types are defined in the header file `mplshlib.h`. **The types `M_INT` and `M_BOOL` are often used
> for word-sized integer and boolean values.**"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/ConvertFromMaple>

**ABI warning for ctypes/cffi authors:** `M_INT` is *word-sized* (not necessarily `int`). The C prototype is
`errorCallBack(void*, M_INT, char*)`, yet the official Python wrapper declares that field `ctypes.c_int64`
unconditionally. On LP64 (Linux/macOS 64-bit) that matches; on 64-bit Windows (LLP64) it may not. **Check
`mplshlib.h` in the actual `$MAPLE/extern/include` before trusting any hard-coded width.** (Reasoned ABI note,
not a documented statement.)

### 4.2 LaTeX, MathML, plain 1-D text — do it *inside* the session

OpenMaple does not have a `MapleToLaTeX` function. The clean approach is to evaluate a Maple expression that
*returns a string*, then read it via `ALGEB`→`MapleToString` (or let it print to `textCallBack`).

**LaTeX** — `latex(expr, output = string)` (synonym `LaTeX`). **Important:** by default the command returns
`NULL` (it only *prints*), so a programmatic host must pass `output = string`:

```text
latex( expr, options )
LaTeX( expr, options )   : LaTeX is a synonym of latex
```
> "`output = ...`: the right-hand side can be the keyword **`string`**, to return a string with the latex
> translation, or `file` in which case `filename = ...` is also required (deprecated use, superseded by
> `writeto`)."
> "… the ditto commands, `%` and `%%`, will not recall the previous latex output. **To get output (return value)
> different from `NULL`, you can use the optional argument `output = string`.**"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=latex>

So from the host, something like:

```c
r = EvalMapleStatement(kv,"latex(int(1/(x^4+1),x), output=string);");
printf("%s\n", MapleToString(kv, r));
```

**MathML** — the `MathML` package exposes `Export(expr)`, `ExportContent(expr)`, `ExportPresentation(expr)`,
`ExportModified(expr)`:

> "Exporting a Maple expression as MathML produces a representation of the expression as MathML-encoded text.
> **This text is produced in the form of a Maple string** which may then be printed or otherwise processed
> further."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML/ExportContent>

i.e. `MathML:-ExportContent(expr)` evaluated in-session gives you the MathML string.

**`Export`** — the general exporter writes to a file *or* returns a string/ByteArray, and its supported format
list includes **`LaTeX`** and **`MathML`**:

```text
Export( dest, data, opts )
Export( data, target = direct, opts )
```
> "The `format` option specifies the export format to use. […] If omitted, Export will attempt to infer the format
> from the file extension of [dest]."
> "The `Export` command exports data from Maple to an external file **or to a string or ByteArray** in the
> specified file format."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Export>

**Pretty-printing / 1-D vs 2-D text.** `interface(prettyprint=…)` accepts **-2 to +3**:

> "The variable that controls the method used to render Maple results and the output of the `print` command in the
> user interface. **Value 1 produces two-dimensional character-based output.** Higher values use interface-specific
> rendering methods. In the worksheet interface, values of 2 and 3 produce typeset math. […] Values less than or
> equal to zero produce various forms of output equivalent to that produced by `lprint`. […] default: 3 (in
> Worksheet interface); **1 (in Command-line interface)**"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface>

For an MCP server that wants *machine-friendly* output:
* `interface(prettyprint=0)` (lprint-style, single-line plain text) or `=1` (2-D character art) — set it once
  after `StartMaple` and, if you want strict 1-D, also `interface(screenwidth=infinity)` behaviour is already the
  default in OpenMaple.
* For exact structured data, don't parse text: use the `ALGEB` conversions, or emit JSON/CSV/LaTeX strings with
  `Export(..., target="direct")` and `MapleToString`.

---

## 5. Memory, performance, licensing, concurrency

### 5.1 Licensing

> "To run your application, **Maple 9 or later must be installed. You can distribute your application to any
> licensed Maple 9 or later user.** For additional terms and conditions on the use of OpenMaple, refer to
> `extern/OpenMapleLicensing.txt`."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple>

* A **full local Maple installation and a working licence** are required; OpenMaple is not a free runtime. There
  is no separate "OpenMaple runtime" download in any source I found.
* The failure mode when the licence/path is wrong is explicit: `StartMaple` returns `NULL` and fills `err`;
  the docs call out *"an initialization failure stating that the `license.dat` file does not exist"* as the
  typical symptom of a bad `$MAPLE` (StartMaple help page).
* `extern/OpenMapleLicensing.txt` **exists in the install** but I could **not find its text published online**
  → its specific terms are **UNVERIFIED**. Also, the Maplesoft EULA PDF
  (<https://www.maplesoft.com/documentation_center/Maplesoft_EULA.pdf>) contains **no** occurrence of the word
  "OpenMaple", so the additional terms live only in that file. **Action item: read
  `$MAPLE/extern/OpenMapleLicensing.txt` on the target machine before shipping.**

### 5.2 Startup cost

**No documented startup-time figures** exist for `StartMaple` → **UNVERIFIED**. What is documented that affects it:

* Startup runs standard Maple initialisation: *"The initialization process follows standard Maple start-up
  steps, including reading and running initialization files, setting library paths, and setting default security
  options."* (2018 Guide p. 478) — passing `-i`/`-c` in `argv` adds work at every session start.
* Because there is no separate process, "startup cost" is amortised differently than for a CLI child: a worker
  process that starts one kernel and reuses it avoids paying init per request — but a crashed kernel takes the
  worker with it.
* `RestartMaple(kv, err)` is the documented cheap reset (equivalent to the Maple `restart` command) without
  paying process startup: useful between MCP requests to stop state leaking between conversations.

### 5.3 Memory limits (`-T` and friends)

OpenMaple accepts the same flags as the command-line `maple` in `argv`. Documented options
(<https://www.maplesoft.com/support/help/maple/view.aspx?path=maple>):

```text
-T resourceLimit
   "The -T (resource limiT) option is used to limit the amount of system resources that Maple can consume before
    execution is terminated. This option takes four parameters, separated by commas. The CPU time limit parameter
    specifies the maximum number of seconds of CPU time that the Maple process is to use. The data limit restricts
    the amount of memory, in kiloBytes, that Maple can use. The stack limit sets the maximum stack size, in
    kiloBytes. The core dump limit specifies the maximum size of core file that can be produced in the unlikely
    event of a core dump. You can specify any prefix of the four parameters, and omit the rest."

--init-reserve-mem=memorysize
   "… allows the size of the virtual memory map that Maple creates on start up to be specified. This is also the
    maximum amount of memory that the Maple session will be able to use. By default Maple creates a map slightly
    smaller than the amount of physical memory available on the machine. […] If options --init-reserve-mem and -T
    are both given, then -T takes precedence."

--init-commit-mem=memorysize
   "… allows the size of the memory Maple allocates on start up to be specified. This option can be used if Maple
    is executing a problem that is known to require a large amount of physical memory."
```

This directly answers the "`-T`-equivalents" question: for OpenMaple you set them via `argv` to `StartMaple`
(e.g. `argv[] = {"maple", "-T", "300,1048576", NULL}`), bearing in mind the documented `argc` convention
(`argv[0]` must be `"maple"`).

Also relevant: the kernel emits "bytes used" status messages (`MAPLE_TEXT_STATUS`) only when you do **not**
provide a `statusCallBack`.

### 5.4 Concurrency and threading

The C API overview states the hard rule:

> "These functions can only be called from threads created within Maple or, when using OpenMaple, **the thread
> which called `StartMaple`. Calling these routines from other threads is unsupported and may cause
> instability.**"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API>

Consequences:

* **One kernel = one thread.** All API calls for a given `MKernelVector` must happen on the thread that called
  `StartMaple`. Do not call `EvalMapleStatement` from an asyncio executor thread or a thread pool worker.
* For parallelism you need **one OS process per concurrent session**. Whether *multiple* `StartMaple` calls in a
  single process are supported is **UNVERIFIED** — I found no official statement endorsing or forbidding it, and
  the official Python wrapper only ever creates one module-level session (`_activesession = Session()`). Design
  for **process-per-session**; do not rely on multi-session-per-process.
* Inside *one* session you can still use Maple's own parallelism: `MapleStartRootTask`, `MapleStartChildTask`,
  `MapleCreateContinuationTask` implement the Task Programming Model in C
  (<https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/TaskProgramming>), and there are
  `MapleMutexCreate/Lock/Unlock` and `MapleRegisterThread`/`MapleUnregisterThread` functions in the API index.
  This is advanced and not needed for an MCP server.
* `queryInterrupt` is the documented way to let long evaluations be cancelled from the host — implement it if you
  want MCP request cancellation.

---

## 6. Version notes: Maple 2018 vs Maple 2022

### 6.1 The OpenMaple chapter is textually unchanged 2018 → 2021 → 2023

I diffed the "14.3 OpenMaple" chapter of three official Programming Guides:

| Guide | URL | OpenMaple chapter |
|---|---|---|
| Maple 2018 | <https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf> | §14.3, p. 476 |
| Maple 2021 | <https://www.maplesoft.com/documentation_center/Maple2021/ProgrammingGuide.pdf> | §14.3, p. 477 |
| Maple 2023 | <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf> | §14.3, p. 531 |

The chapter prose, the C example, the `gcc … -lmaplec -lmaple -lhf -lprocessor64` line, the "Runtime Environment
Prerequisites" section, and the statement "all of these interfaces are built on the C API" are **identical** in
all three. The only changes are cosmetic: "Mac OS X" → "macOS". This is strong evidence that **the C OpenMaple API
is ABI/API-stable across 2018→2022→2023**; no deprecations or signature changes are documented in the Guides.

**Caveat / UNVERIFIED:** the *Maple 2022* Programming Guide PDF is **not** published at the obvious URL
(`https://www.maplesoft.com/documentation_center/Maple2022/ProgrammingGuide.pdf` → HTTP 404; only
`Maple2022/UserManual.pdf` exists there, HTTP 200). So Maple 2022 is *bracketed* by the 2021 and 2023 documents
rather than directly quoted. The per-version `updates/Maple20xx/Connectivity` help pages do not contradict this:
the **2022** page exists and announces no OpenMaple change (only Maple-calls-Python features), while the
**2019/2020/2021** update pages are not published at those paths at all (they render the online help "document
not found" page), so for 2019–2021 there is simply no announcement to read.

### 6.2 Build-flag drift (documented, and worth testing on the target machine)

| Source | Linux link line |
|---|---|
| Programming Guide 2018/2021/2023 | `-lmaplec -lmaple -lhf -lprocessor64` |
| Online Examples help (current) | `-lmaplec -lrt` |
| openmaple-ocaml Makefile (real-world) | `-lmaplec -lrt` |

Both are "official-ish"; the difference is most likely *what the linker needs* on a given libc/kernel install
(e.g. `-lrt` for `shm_open`/timers on older glibc) rather than an ABI change. Treat the link line as
**per-machine**, and prefer bootstrapping the environment with `. $MAPLE/bin/maple -norun`.

### 6.3 New in this window, relevant to us

* **Maple 2019**: the `openMaple`-related `Maple 2019 Programming Guide` exists at a third-party mirror
  (<http://www.digisec-technology.com/pub/DVD/2019/root/Maple/manuals/M2019.Programming_Guide.pdf>) — same
  chapter; no need to rely on it.
* **Maple 2023**: **OpenMaple for Python is introduced** (see §7). This is the only significant OpenMaple change
  in 2018→2023.
* Task Programming / continuation tasks in C are documented on the current help site (present in 2023+; exact
  introduction version **UNVERIFIED**).

---

## 7. Python bindings

### 7.1 Official: "OpenMaple for Python" — **Maple 2023+ only**

**Version introduction — confirmed.** The Maple 2023 "Connectivity" update page and its PDF both announce it:

> "**OpenMaple for Python**
> • The **new** OpenMaple for Python is an interface for the Python programming language that allows you to access
> Maple algorithms and data structures from a Python session on the same machine.
> • You can use OpenMaple for Python from any Python session or within Maple from a Python Code Edit Region."
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates/Maple2023/Connectivity> and
> <https://www.maplesoft.com/products/maple/new_features/Maple2023/PDFs/Maple2023-Connectivity.pdf>

The Maple **2022** Connectivity update page has **no** OpenMaple-for-Python section (it only covers Maple *calling*
Python/TensorFlow: `Python:-ImportModule`, `convert(..., python)`, DeepLearning). The 2019/2020/2021
`updates/.../Connectivity` pages are not published on the current help site (they return the "Help Document not
found" page), so there is no 2019–2021 announcement to check — the earliest documented mention is the Maple 2023
page, which calls the feature "**new**". **Conclusion: the official Python OpenMaple API does not exist in Maple
2018 or Maple 2022.** (Also, there is no `OpenMaple/Python/*` topic in a 2018-vintage help snapshot; the current help
carries only the new content.)

**Module name — changed.** In Maple 2023 it was **`maple`**:

```python
import maple
import numpy
x,y,abs,D,diff,dsolve,numeric = maple.symbols('x,y,abs,D,diff,dsolve,numeric')
import maple.namespace as mpl
```
— Maple 2023 Connectivity update page (verbatim)

The current help page carries a retro-note:

> "(Please note the details for importing the Python API have changed since Maple 2023. **the primary package is
> now named `maplesoft.maple`.** The examples below have been updated to reflect this change.)"
> — <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates/Maple2023/Connectivity>

**Current import form and minimal example** (official, verbatim from
<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/API> and `.../OpenMaple/Python/Examples`):

```python
# simplest smoke test (from the GitHub README)
import maple
import maple.namespace as mpl
print( mpl.int( mpl.x ** 2, mpl.x ) )
```

```python
# official "A Simple Example" (current help, renamed package)
import maplesoft.maple
import maplesoft.maple.namespace as msymbol
x = msymbol.x
print( 'Integral of x with respect to x:', msymbol.int( x, x ) )
```

```python
# official "Computing with a symbolic matrix"
import maplesoft.maple as mpl
import maplesoft.maple.namespace as msymbol
a,b,c,d = mpl.symbols('a,b,c,d')
A = msymbol.Matrix([[a,b,c,d,c],[b,c,d,a,b],[a+b,b+c,c+a,a+d,d+c]]);
B = msymbol.LinearAlgebra.ReducedRowEchelonForm(A);
print( 'Result:', B )
```

```python
# official "Solving a differential equation" (numpy required)
import maplesoft.maple
import numpy
timepoints = numpy.array([0, 0.25, 0.5, 0.75, 1])
x,y,abs,D,diff,dsolve = mpl.symbols('x,y,abs,D,diff,dsolve')
dsys5 = {diff(y(x), x, x) + abs(y(x)) == 0, y(1) == -1, D(y)(0) == 1}
dsol5 = dsolve(dsys5, numeric = True, output = timepoints)
```

**Where it lives in the install / how to install**

> "If OpenMaple is not already in the Python module search path (`sys.path`), add the directory in which OpenMaple
> for Python is installed with `sys.path.append`.
> Note: if you wish to use the OpenMaple for Python shipped with Maple, **it is located in the directory
> `Python.*/lib` under the Maple installation.** For example, on Windows:
> `sys.path.append('C:\\Program Files\\Maple 2024\\Python.X86_64_WINDOWS\\lib')`"
> — <https://github.com/Maplesoft/openmaple> README (verbatim)

There is also a documented launcher flag (Maple 2023+, macOS/Linux):

> "The Maple commandline script on macOS and Linux now accepts an additional flag, **`-python`**, which launches
> the version of Python distributed with Maple. This is automatically configured to enable OpenMaple for Python
> to work. To use it simply type `maple -python` in a terminal window and then enter `import maple` to load
> OpenMaple for Python."
> — Maple 2023 Connectivity update page

**Environment / headless.** From <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/Python/running>:

```text
Windows: set PATH=%PATH%;<BINDIR>
Linux:   export LD_LIBRARY_PATH="$LD_LIBRARY_PATH:<BINDIR>"
         export MAPLE="<MAPLEDIR>"
macOS:   export DYLD_LIBRARY_PATH="$DYLD_LIBRARY_PATH:<BINDIR>"
         export MAPLE="<MAPLEDIR>"
```

with `<MAPLEDIR> = kernelopts(mapledir)` and `<BINDIR> = kernelopts(bindir)`.

**Headless:** nothing in the Python API docs requires a GUI or an X display; the API is the *engine* (the same
`maplec` library), and the docs describe it as usable "from any Python session". **However I found no official
statement explicitly certifying headless operation** → headless-ness is **UNVERIFIED but strongly implied** by
(a) the engine being the same one the command-line `maple` uses, and (b) the `maple -python` flag being a
terminal workflow. Test on the target host.

**Licensing of the wrapper vs. of Maple.** The GitHub project is **MIT** ("This project is released under the MIT
license", `LICENSE.txt` in the repo), but the *MIT licence covers the wrapper code only*: running it still
requires a licensed local Maple 2024+ (README: "OpenMaple for Python requires an installation of Maple 2024 or
later on the same machine"). The Maple-side OpenMaple terms remain `extern/OpenMapleLicensing.txt`.

**Repo facts (GitHub API, fetched 2026-09-21):**

| Field | Value |
|---|---|
| URL | <https://github.com/Maplesoft/openmaple> |
| Description | "OpenMaple for Python" |
| Created | 2024-08-21 |
| Last push | **2026-06-08** (`Update README.md`) |
| Licence | **MIT** |
| Stars / forks | 1 / 3 |
| Archived | no |
| Default branch | `main` |
| Files | `maplesoft/maple/{__init__,Session,Expression,maplec_ctypes,exportto,importfrom}.py`, `maplesoft/maple/namespace/__init__.py`, `pyproject.toml` |
| Requirements | Python **3.11+** for a non-Maple interpreter (README) / `>=3.8` enforced in `__init__.py`; **numpy** required |
| Maple versions | README: **Maple 2024 or later** (the code auto-discovers `libmaplec.so` / `libmaplec.dylib` / `maplec.dll` by walking `$MAPLE` or a platform lib path) |

**Why this matters for us even though it doesn't support 2018/2022:** the implementation is *pure Python +
`ctypes`*, and `maplec_ctypes.py` is a ready-made, MIT-licensed, battle-tested set of ctypes declarations for
exactly the C functions we need. Adapting it to 2018/2022 is mostly a question of (a) the package name/API
surface the older engine offers, (b) the `M_INT` width caveat, and (c) the under-sized error buffer (see below).
Verbatim core of `maplec_ctypes.py`:

```python
class MCallBackVectorDesc(ctypes.Structure):
    _fields_ = [
        ("textCallBack", ctypes.CFUNCTYPE( None, ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p ) ),
        ("errorCallBack", ctypes.CFUNCTYPE( None, ctypes.c_void_p, ctypes.c_int64, ctypes.c_char_p ) ),
        ("statusCallBack", ctypes.c_void_p),
        ("readLineCallBack", ctypes.c_void_p),
        ("redirectCallBack", ctypes.c_void_p),
        ("streamCallBack", ctypes.c_void_p),
        ("queryInterrupt", ctypes.CFUNCTYPE( ctypes.c_bool, ctypes.c_void_p ) ),
        ("callBackCallBack", ctypes.CFUNCTYPE( ctypes.c_char_p, ctypes.c_void_p, ctypes.c_char_p ) )
    ]
...
    maplec.EvalMapleStatement.argtypes = [ MKernelVector, ctypes.c_char_p ]
    maplec.EvalMapleStatement.restype = ALGEB
...
    maplec.MapleToString.argtypes = [ MKernelVector, ALGEB ]
    maplec.MapleToString.restype = ctypes.c_char_p
...
    maplec.StartMaple.argtypes = [
        ctypes.c_int,    # int argc
        ctypes.c_char_p, # char* argv
        ctypes.POINTER( MCallBackVectorDesc ), # MCallBackVector cb
        ctypes.c_void_p, # void *user_data
        ctypes.c_void_p, # void *info
        ctypes.c_char_p  # char *errstr
    ]
    maplec.StopMaple.argtypes = [ MKernelVector ]
```

and the session lifecycle (verbatim from `Session.py`):

```python
        self._kv = self._maplec.StartMaple( 0, sm_argv, self.mcbv, 0, 0, self.errorBuf )
...
    def __del__(self):
        kv = self._kv
        maplec = self._maplec
        self._kv = None
        self._maplec = None
        maplec.StopMaple( kv )
```

Note: the official wrapper passes **`argc = 0`** (no `argv[0]="maple"`), which contradicts the documented
convention that `argv[0]` must be `"maple"`. It evidently works on the versions Maplesoft supports. For our own
binding I would pass the documented form:

```python
argv = (ctypes.c_char_p * 3)(b"maple", b"-T", b"300,1048576")   # example
kv = maplec.StartMaple(3, argv, ctypes.byref(cb), None, None, errbuf)
```

**Two bugs/risks to avoid when forking it:**
1. `create_string()` returns `ctypes.create_string_buffer(1024)`, but `StartMaple` requires **at least 2048**
   bytes for `err`. Allocate 2048+ (I'd use 4096).
2. `errorCallBack` declares `ctypes.c_int64` for the `M_INT offset` argument — verify `M_INT` against the
   installed `mplshlib.h`, especially on 64-bit Windows.

**A minimal, self-contained ctypes skeleton** (derived from the official MIT wrapper above; **not executed** —
no Maple on this machine, so treat as a starting point, not a verified program):

```python
import ctypes, os, sys

CANDIDATES = ["libmaplec.so", "libmaplec.dylib", "maplec.dll"]

def find_maplec():
    roots = []
    if os.environ.get("MAPLE"):
        roots.append(os.environ["MAPLE"])
    if sys.platform.startswith("linux") and os.environ.get("LD_LIBRARY_PATH"):
        roots += os.environ["LD_LIBRARY_PATH"].split(os.pathsep)
    if sys.platform == "darwin" and os.environ.get("DYLD_LIBRARY_PATH"):
        roots += os.environ["DYLD_LIBRARY_PATH"].split(os.pathsep)
    for r in roots:
        for dirpath, _dirs, files in os.walk(r):
            for c in CANDIDATES:
                if c in files:
                    return os.path.join(dirpath, c)
    raise FileNotFoundError("libmaplec not found; set MAPLE and LD_LIBRARY_PATH/DYLD_LIBRARY_PATH")

TEXT_CB = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p)
ERR_CB  = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int64, ctypes.c_char_p)

class CallbackVector(ctypes.Structure):
    _fields_ = [("textCallBack", TEXT_CB), ("errorCallBack", ERR_CB),
                ("statusCallBack", ctypes.c_void_p), ("readLineCallBack", ctypes.c_void_p),
                ("redirectCallBack", ctypes.c_void_p), ("streamCallBack", ctypes.c_void_p),
                ("queryInterrupt", ctypes.c_void_p), ("callBackCallBack", ctypes.c_void_p)]

class Session:
    def __init__(self, argv=(b"maple",)):
        lib = ctypes.CDLL(find_maplec())
        lib.StartMaple.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_char_p),
                                   ctypes.POINTER(CallbackVector), ctypes.c_void_p,
                                   ctypes.c_void_p, ctypes.c_char_p]
        lib.StartMaple.restype = ctypes.c_void_p
        lib.EvalMapleStatement.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.EvalMapleStatement.restype = ctypes.c_void_p
        lib.MapleToString.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        lib.MapleToString.restype = ctypes.c_char_p
        lib.StopMaple.argtypes = [ctypes.c_void_p]
        lib.StopMaple.restype = None
        self.lib, self.out, self.err = lib, [], []
        self._tcb = TEXT_CB(lambda data, tag, out: self.out.append(out.decode("utf-8", "replace")))
        self._ecb = ERR_CB(lambda data, off, msg: self.err.append(msg.decode("utf-8", "replace")))
        self.cbv = CallbackVector(self._tcb, self._ecb, None, None, None, None, None, None)
        errbuf = ctypes.create_string_buffer(4096)          # docs demand >= 2048
        argv_t = (ctypes.c_char_p * len(argv))(*argv)        # argv[0] must be b"maple"
        self.kv = lib.StartMaple(len(argv), argv_t, ctypes.byref(self.cbv), None, None, errbuf)
        if not self.kv:
            raise RuntimeError("StartMaple failed: " + errbuf.value.decode())

    def eval(self, code):
        self.out.clear(); self.err.clear()
        res = self.lib.EvalMapleStatement(self.kv, code.encode("utf-8"))
        text = "".join(self.out)
        if res:
            s = self.lib.MapleToString(self.kv, res)
            if s:
                text = text or s.decode("utf-8", "replace")
        return text, list(self.err)

    def close(self):
        if self.kv:
            self.lib.StopMaple(self.kv); self.kv = None
```

### 7.2 Third-party Python wrappers — **none of substance found**

Searched PyPI (`pymaple`, `openmaple`, `maple`, `maplebridge`, `pyopenmaple`, `maplesoft`), Anaconda.org,
GitHub repo search, and the web:

| Name | What it actually is | Verdict |
|---|---|---|
| `Maplesoft/openmaple` (GitHub) | The **official** wrapper (above). Not on PyPI. | Use/adapt |
| `PyMaple` on PyPI (<https://pypi.org/project/PyMaple/>) | "Maple Container Utility" — a **Docker/Podman/Singularity container-wrapper for HPC**, by `akashdhruv/Maple`. **Nothing to do with the Maple CAS.** MIT, 6 releases, last upload 2022-10-27. | **Not relevant** (name collision trap) |
| `maple` on PyPI | "reliable, scalable, distributed server framework" by `dantezhu` — unrelated | Not relevant |
| `openmaple`, `maplebridge`, `pyopenmaple`, `maplesoft` on PyPI | **do not exist** (PyPI returns "not found") | — |
| `openmaple` on Anaconda.org | no results | — |
| `mezzarobba/openmaple-ocaml` (GitHub, mirror of `src.koda.cnrs.fr`) | Genuine **OCaml** OpenMaple binding, C stubs. README: "a simple Ocaml wrapper for the OpenMaple API", "Status: pre-alpha", "Licence: **public domain**". Single push 2023-06-21. Makefile defaults to `MAPLE=${HOME}/opt/maple/13`, i.e. it originally targeted **Maple 13** and still links `-lmaplec -lrt`. Useful as a *reference implementation*, not a Python option. <https://github.com/mezzarobba/openmaple-ocaml> | Reference only |
| `speedyHKjournalist/OpenMapleClient`, `openmaple/MapleEngine`, `aatxe/OpenMaple` (GitHub) | **MapleStory game clients/emulators** — "Maple" the Korean MMO, not Maplesoft. AGPL-3.0 / Unlicense / etc. | **Not relevant** (search-noise trap) |
| `zachetienne/nrpylatex` | LaTeX/SymPy interop, unrelated to OpenMaple | Not relevant |

**Conclusion:** for Maple 2018/2022 there is **no prebuilt Python binding** worth adopting. The practical path is
a small in-house `ctypes` module modelled on `Maplesoft/openmaple` (§7.1), or the C API consumed directly.
Anything labelled "maple" on PyPI must be checked carefully — the top hits are name collisions.

---

## 8. Practical warning list (what actually breaks)

Ordered roughly by how often each bites, with the documented basis where one exists.

1. **Wrong/missing `MAPLE` → `StartMaple` returns NULL, "license.dat does not exist".**
   Docs: *"An initialization failure stating that the `license.dat` file does not exist, usually indicates that
   OpenMaple cannot find the path to the Maple installation. […] in UNIX and on the Macintosh, the environment
   variable `$MAPLE` must be set to the root directory of the Maple installation."*
   → Always set `MAPLE` **and** the platform lib path; prefer sourcing `$MAPLE/bin/maple -norun`.
2. **Segfault / `libmaplec.so: cannot open shared object file` from a wrong `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`.**
   `$MAPLE/bin.$SYS` is the *minimum*; the real list is longer. Docs tell you to copy `getenv(LD_LIBRARY_PATH)`
   from a running Maple. Note: on macOS, `DYLD_*` variables are stripped for some launch paths (e.g. when a
   process is started through certain launchers/`sudo`), which produces exactly this class of failure.
3. **Calling the API from the wrong thread → instability/segfaults.** Documented: only the thread that called
   `StartMaple` may call the API. Never share one session across threads; one process per session.
4. **`StopMaple` then `StartMaple` again in the same process** — documented as impossible: *"After calling
   `StopMaple`, OpenMaple cannot be restarted with `StartMaple`."* Use a fresh process, or `RestartMaple`.
5. **`ALGEB` retention → unbounded memory growth.** Returned `ALGEB`s are auto-protected from GC; the documented
   way to release them is `unprotect:-gc`. Long-lived sessions that keep every result will grow. Drop references
   and/or call `unprotect:-gc` periodically, or recycle the worker process.
6. **The `err` buffer must be ≥ 2048 bytes.** `StartMaple` writes up to that; the official Python wrapper
   allocates only 1024. Undersized buffers can corrupt memory. Allocate 2048–4096.
7. **`info` must be NULL.** Documented: "reserved for internal use and must always be set to NULL."
8. **`M_DECL` calling convention on callbacks.** The callback functions you install must be declared with
   `M_DECL` (it matters on Windows, where it maps to the right calling convention). In ctypes, use the right
   `CFUNCTYPE`/`WINFUNCTYPE` and keep a **reference to every callback object alive** for the lifetime of the
   session — a GC'd ctypes callback is a classic segfault.
9. **`M_INT` width assumptions.** Documented only as "word-sized". Verify against the installed `mplshlib.h`
   before hard-coding `c_int64`/`c_int` in a struct (especially Windows LLP64).
10. **Output is fragmented.** Documented: "A single result may be split into multiple calls to the `textCallBack`
    function." Never treat one callback as one result; concatenate per evaluation, and be careful when multiple
    evaluations interleave (i.e. don't overlap evaluations on one session).
11. **Errors arrive as text by default.** Without an `errorCallBack`, errors land in `textCallBack` with tag
    `MAPLE_TEXT_ERROR`; if you *want* them silent/structured, install `errorCallBack` — and remember
    `offset < 0` means a computation error, `offset >= 0` a parse error at that string offset.
12. **Typeset/font issues.** The **engine** produces 1-D text through `textCallBack`
    (`MAPLE_TEXT_OUTPUT` is documented as "a line-printed (1-D) Maple expression or statement"), so no fonts are
    needed for pure evaluation. Fonts/`prettyprint` only matter if you request 2-D typeset rendering
    (`interface(prettyprint=2/3)`) or export images — which in a headless worker is a bad idea. **UNVERIFIED:**
    I found no official statement about missing fonts breaking the *kernel*; treat "Maple needs fonts for
    typesetting" as applying to the GUI/worksheet and to image export, not to plain evaluation.
13. **Headless / no-X.** The command-line Maple and OpenMaple are engine-level and the docs describe setting only
    `MAPLE` + lib paths; no display variable is mentioned anywhere in the OpenMaple prerequisites. Working
    assumption: **no X needed for text evaluation**; **UNVERIFIED** for plotting (`plot` may still produce a plot
    data structure fine, but rendering to an image may need more). Test on the deployment host.
14. **`StartMaple` does not spawn a process** — so a Maple crash is *your* crash. Keep the kernel in a
    disposable worker; on a hard crash, exit and restart rather than trying to recover in-process.
15. **Undocumented on-disk storage / version mixing.** Not an OpenMaple issue per se, but relevant: the same
    binary must talk to the *same* Maple install it links against. Mixing `libmaplec.so` from 2022 with a 2018
    `$MAPLE` (or vice versa) is a classic source of "license.dat does not exist" and of ABI weirdness.
16. **`extern/OpenMapleLicensing.txt`** — read it. It is *additional* terms that are **not** in the EULA PDF and
    **not** published online (**UNVERIFIED** content). Redistribution questions (can we ship an MCP server that
    requires the user's Maple?) should be answered from that file plus counsel.

---

## 9. Research gaps / explicitly UNVERIFIED items

* **Maple 2022 Programming Guide PDF** — not published at the canonical URL (404). Version bracket established
  from the 2021 and 2023 Guides; 2022-specific wording not directly quoted.
* **`extern/OpenMapleLicensing.txt` contents** — file exists per the OpenMaple overview page; text not found
  online. Not mentioned in `Maplesoft_EULA.pdf`.
* **Multiple `StartMaple` sessions in one process** — no official statement found either way.
* **Startup latency numbers** for `StartMaple` (2018 vs 2022, cold vs warm) — no published figures.
* **Exact minimum link flags** on a given 2018/2022 Linux/macOS install (`-lmaplec` alone vs `-lmaplec -lrt` vs
  `-lmaplec -lmaple -lhf -lprocessor64`).
* **Apple Silicon binary directory name** (documented tags cover Intel macOS and x86-64 Linux/Windows only).
* **Headless/X/fonts requirement for the kernel** — reasoned but not officially certified.
* **Whether the official `maplesoft.maple` wrapper can be made to work against 2018/2022** — it is untested here
  (no Maple installed on this machine); it depends on which of the ~60 symbols it declares exist in the older
  `libmaplec`, and on struct/width details. `EvalMapleStatement`, `StartMaple`, `StopMaple`, `MapleToString`,
  `ToMapleName`, `EvalMapleProcedure` are all present in 2018-era docs, so a *reduced* subset is plausible, but
  this must be verified empirically on a real 2018/2022 install.

---

## 10. Sources

**Official Maplesoft — OpenMaple help (current online help; content is version-agnostic for the C API):**
* OpenMaple overview — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple>
* C API function index / overview — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/API>
* Examples (build lines, sample locations) — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/Examples>
* `StartMaple` (signatures, `MCallBackVector`, error buffer, `$MAPLE`) — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StartMaple>
* `StopMaple` / `RestartMaple` — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/StopMaple>
* `textCallBack` (tags) — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/textCallBack>
* `errorCallBack` (offset semantics) — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/errorCallBack>
* Conversion from Maple objects, incl. `MapleToString`, `M_INT`/`M_BOOL` headers — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/ConvertFromMaple>
* Task Programming in C (parallel tasks) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/C/TaskProgramming>
* CustomWrapper / ExternalCalling interface — <https://www.maplesoft.com/support/help/maple/view.aspx?path=define_external/CustomWrapper>
* Command-line options for `StartMaple`'s `argv`: `-T`, `--init-reserve-mem`, `--init-commit-mem`, `-i`, `-A` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=maple>
* `interface` (incl. `prettyprint` = -2…+3) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=interface>
* `Export` (supported formats include `LaTeX`, `MathML`) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=Export>
* `latex` / `LaTeX` — <https://www.maplesoft.com/support/help/maple/view.aspx?path=latex>
* `MathML:-ExportContent` etc. — <https://www.maplesoft.com/support/help/maple/view.aspx?path=MathML/ExportContent>

**Official Maplesoft — Python OpenMaple (2023+):**
* Python API overview (`import maplesoft.maple`, `namespace`, classes) — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/API>
* Python examples — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/Examples>
* Building and running (env vars, `MAPLE`/`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`/`PATH`, `Python.*/lib`) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=OpenMaple/Python/running>
* Maple 2023 "Connectivity" update (introduction + `import maple` + `maple -python`) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates/Maple2023/Connectivity>
* Maple 2023 Connectivity PDF — <https://www.maplesoft.com/products/maple/new_features/Maple2023/PDFs/Maple2023-Connectivity.pdf>
* Maple 2022 "Connectivity" update (no OpenMaple-for-Python) — <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates/Maple2022/Connectivity>
* Official Python wrapper repo (MIT, ctypes) — <https://github.com/Maplesoft/openmaple>
  * README (version requirement, install paths, smoke test) — <https://github.com/Maplesoft/openmaple/blob/main/README.md>
  * ctypes declarations — <https://github.com/Maplesoft/openmaple/blob/main/maplesoft/maple/maplec_ctypes.py>
  * session lifecycle — <https://github.com/Maplesoft/openmaple/blob/main/maplesoft/maple/Session.py>

**Official Maplesoft — versioned Programming Guides:**
* Maple 2018 Programming Guide §14.3 "OpenMaple" (p. 476 ff.) — <https://web.mit.edu/maple_v2018/ProgrammingGuide.pdf> (MIT mirror; Last-Modified 2018-03-23)
* Maple 2021 Programming Guide §14.3 — <https://www.maplesoft.com/documentation_center/Maple2021/ProgrammingGuide.pdf>
* Maple 2023 Programming Guide §14.3 — <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>
* Maple 2022 User Manual (proves the version directory exists; the Programming Guide PDF there 404s) — <https://www.maplesoft.com/documentation_center/Maple2022/UserManual.pdf>
* Documentation center index — <https://www.maplesoft.com/documentation_center/>
* Maplesoft EULA (no OpenMaple mention) — <https://www.maplesoft.com/documentation_center/Maplesoft_EULA.pdf>

**Third-party / community:**
* OCaml OpenMaple binding (public domain, pre-alpha; Makefile shows `-lmaplec -lrt`, `-I…/extern/include`) — <https://github.com/mezzarobba/openmaple-ocaml>
* PyPI `PyMaple` (container utility, **not** the CAS) — <https://pypi.org/project/PyMaple/> and <https://github.com/akashdhruv/Maple>
* PyPI `maple` (distributed server framework, unrelated) — <https://pypi.org/project/maple/>

---

*Companion documents: `research/06-mcp-prior-art.md` (MCP landscape) and the other `research/0*.md` notes.*
