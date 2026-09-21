# Maple as a local computation engine: OpenMaple Java, .NET/MapleNet, and every other official connector

Research note for the MCP-server project (Node/TypeScript or Python, driving a **locally installed
Maple 2018 or Maple 2022**).

Author: research subagent. Date of research: 2026 (all online help referenced is the *current*
Maplesoft online help; version-specific claims are anchored to the Maple 2018 / 2021 / 2022 / 2023
Programming Guides and installation guides, which are stable PDFs).

> **Reading conventions**
> * `$MAPLE` / `<MAPLEDIR>` = the Maple installation root (`kernelopts(mapledir)`); on Linux typically
>   `/usr/local/Maple2022` or `/opt/maple2022`.
> * `<BINDIR>` = the platform binary directory (`kernelopts(bindir)`), e.g.
>   `$MAPLE/bin.X86_64_LINUX`, `C:\Program Files\Maple 2022\bin.X86_64_WINDOWS`.
> * **UNVERIFIED** = I could not confirm from an official source; do not rely on it without testing.
> * No Maple installation was available in this research environment, so **nothing here was executed
>   against a real Maple kernel**. Everything below is sourced; measurements are labelled as such.

---

## 0. Executive answer (what to actually build)

| Option | Maple 2018 | Maple 2022 | Fits a *thin* headless local bridge? |
|---|---|---|---|
| **`maple`/`cmaple` CLI in batch mode, stdin/stdout** | yes | yes | **Best first choice.** No JVM, no JARs, no env vars beyond a working Maple install. Maplesoft itself calls it "one of the simplest options" for embedding the engine. |
| **OpenMaple Java (JAR + native lib, helper JVM process)** | yes (`jopenmaple.jar`+`externalcall.jar`) | yes (same, per 2021/2023 guides) | Works, but costs a JVM (one **long-lived** process; engine cannot be re-created after `stop()`). |
| OpenMaple C (`libmaplec.so`) via ctypes/cffi/JNI | yes | yes | Lightest *in-process* route, but you must handle `ALGEB`/callbacks yourself. |
| **OpenMaple for Python (`import maplesoft.maple`)** | **no** | **no** (introduced in **Maple 2023**) | Excellent — but not on the two target versions. |
| **Maple Kernel for Jupyter** (ZeroMQ, Jupyter messaging protocol) | **no** | **yes** (new in Maple 2022) | **Best "real API" bridge on 2022**: official, local, process-isolated, per-session. |
| .NET `MapleEngine` P/Invoke (`extern/include/maple.cs`) | yes | yes (still documented in the 2023 guide) | Windows + .NET Framework-centric; not usable from Node/Python without a .NET host. |
| MapleNet (HTTP/PB compute service, Docker) | separate product | separate product (docs: 2019/2021) | Heavyweight separate server, not part of a Maple install. |
| `define_external` / ExternalCalling | yes | yes | Reverse direction (Maple calls *your* code). Useful, not a driver. |
| Excel add-in / MATLAB link / CAD link / Maplets / Embedded Components / Maple Learn / MapleCloud / Maple T.A.–Möbius | — | — | Desktop-GUI, cloud, or LMS products; **not** headless local bridges. |

**Recommended stack for the MCP server:** implement the driver as
`spawn maple -q` (session-per-request or one long-lived process) with a thin, machine-readable
protocol, and treat OpenMaple-Java as an optional "engine in my own process" upgrade for Maple 2022.
On Maple 2022 only, a Jupyter-kernel client is the most protocol-clean option.

---

## 1. OpenMaple Java API

### 1.1 What ships, and where

Official statement of the package layout (current online help, "Building and Running Applications"):

> The Java OpenMaple classes are provided in the `com.maplesoft.openmaple` package. This package is
> contained within the `Maple.jar` file. A second package,
> `com.maplesoft.externalcall.MapleException` is also required for Java OpenMaple. This class is in
> the `externalcall.jar` file. […] These jar files are in the `java` directory of your Maple
> installation.
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/running>

**Version-critical difference.** The same page today says `Maple.jar`, but the *versioned* Programming
Guides for the user's targets say `jopenmaple.jar`:

* Maple 2018 Programming Guide, §14.3: "If you are developing a Java application, you can find the
  **jopenmaple.jar** file in the **java** subdirectory of your Maple installation", and the build line is
  `"$MAPLE/java/externalcall.jar;$MAPLE/java/jopenmaple.jar"`.
  — <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
* Maple 2021 Programming Guide, §14.3 — identical wording and `jopenmaple.jar` classpath.
  — <https://www.maplesoft.com/documentation_center/Maple2021/ProgrammingGuide.pdf>
* Maple 2023 Programming Guide, §14.3 — still `jopenmaple.jar`.
  — <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>

Real-world reports for Maple 2021 show the OpenMaple classes compiling from **`Maple.jar`** while
`jopenmaple.jar` was *absent* from the install, and the JVM failing to find the **native** library
`jopenmaple` on `java.library.path` (i.e. `System.loadLibrary("jopenmaple")`):

> Error loading libraries: `java.lang.UnsatisfiedLinkError: no jopenmaple in java.library.path: …`
> […] at `com.maplesoft.openmaple.Engine.<clinit>(Engine.java:23)` […] at
> `java.lang.System.loadLibrary(System.java:1893)`
> — <https://www.mapleprimes.com/questions/232033-Where-Is-Jopenmaple-Supposed-To-Be-Located>

> `java -Djava.library.path=/Library/Frameworks/Maple.framework/Versions/2021/bin.APPLE_UNIVERSAL_OSX`
> `-classpath "$MAPLE/java/externalcall.jar:$MAPLE/java/Maple.jar:." test`
> … `Library not loaded: @rpath/libmaplec.dylib` (from `libjopenmaple.jnilib`) […] at
> `com.maplesoft.openmaple.Engine.getKernel(Native Method)` / `Engine.<init>(Engine.java:44)`
> — <https://www.mapleprimes.com/questions/232275-Java-OpenMaple-Running-Error>

Practical consequence — **do not hard-code the JAR name**. At install time, enumerate and probe:

```bash
# Linux/macOS: find JARs and the native OpenMaple libs
ls -l "$MAPLE/java"
for j in "$MAPLE/java"/*.jar; do
  echo "== $j"; unzip -l "$j" | grep -E 'com/maplesoft/openmaple/Engine\.class|com/maplesoft/externalcall/MapleException\.class'
done
ls -l "$MAPLE"/bin.*/libjopenmaple* "$MAPLE"/bin.*/libmaplec* 2>/dev/null
```

Verbatim (non-obvious) facts about the native side:

* The C/C++ build line in the Maple 2018 Guide names the actual shared objects:
  `gcc -I $MAPLE/extern/include test.c -L $MAPLE/bin.X86_64_LINUX -lmaplec -lmaple -lhf -lprocessor64`
  (i.e. `libmaplec.so`, `libmaple.so`, `libhf.so`, `libprocessor64.so` in `$MAPLE/bin.X86_64_LINUX`).
* The Java native library name is `jopenmaple` (macOS file: `libjopenmaple.jnilib`). The exact Linux
  file name is **UNVERIFIED** (expected `libjopenmaple.so`); probe with the `ls` above.
* Header files: `$MAPLE/extern/include` (`maplec.h`, `maple.cs`, `maple.bas`).
* OpenMaple samples: `$MAPLE/samples/OpenMaple/...` — Java: `samples/OpenMaple/Java/simple`;
  VB6: `samples/OpenMaple/msvb` (all quoted from the 2018/2023 Programming Guides).

**There is no official artifact called `openmaple.jar`.** The names Maplesoft uses are
`jopenmaple.jar` (older, per the Programming Guides) and `Maple.jar` (current help); `externalcall.jar`
is required in both eras. Which release renamed/merged them is **UNVERIFIED**.

### 1.2 Runtime prerequisites

From the current help page (`OpenMaple/Java/running`), which is more explicit than the Programming Guide:

* The JVM loads the native library automatically; it must be findable via a platform-specific
  variable, **not** the JAR classpath:
  * Windows: add `<BINDIR>` to `PATH`
  * Linux: add `<BINDIR>` to `LD_LIBRARY_PATH` **and** set `MAPLE="<MAPLEDIR>"`;
    "For a complete list of directories to add, run `getenv(LD_LIBRARY_PATH);` in Maple and use that
    exact value."
  * macOS: `DYLD_LIBRARY_PATH` + `MAPLE`
* **`-Xss` is mandatory**: "the `-Xss` option must be used to specify the default amount of stack
  memory Java will allow the Maple calls to use. The default of 1MB is too low for Maple and may lead
  to segmentation faults." The documented run line is `-Xss100M`. (Current help; **not** mentioned in
  the 2018 or 2023 Programming Guides — the Guides' run line omits it.)

Verbatim commands (current help):

```bat
:: Windows
javac -classpath "<MAPLEDIR>\java\externalcall.jar;<MAPLEDIR>\java\Maple.jar" app.java
java -Xss100M -classpath "<MAPLEDIR>\java\externalcall.jar;<MAPLEDIR>\java\Maple.jar;." test
```

```bash
# macOS and Linux
javac -classpath "<MAPLEDIR>/java/externalcall.jar:<MAPLEDIR>/java/Maple.jar" app.java
java -Xss100M -classpath "<MAPLEDIR>/java/externalcall.jar:<MAPLEDIR>/java/Maple.jar:." test
```

Verbatim commands for the **2018/2021/2023** era (note `jopenmaple.jar`, no `-Xss`, semicolons on
Windows / colons on macOS+Linux):

```bat
$JDKBINDIR/javac -classpath "$MAPLE/java/externalcall.jar;$MAPLE/java/jopenmaple.jar" test.java
$JDKBINDIR/java  -classpath "$MAPLE/java/externalcall.jar;$MAPLE/java/jopenmaple.jar;." test
```

Alternative to `LD_LIBRARY_PATH` (used successfully in the MaplePrimes crash report above, and the
standard JVM mechanism): `-Djava.library.path="<BINDIR>"`. This is **not** in the official docs
(UNVERIFIED as an officially supported spelling), but it is the plain JVM equivalent.

Verbatim environment setup from the Maple 2018/2023 Programming Guides (§14.3, "Runtime Environment
Prerequisites"):

```sh
#!/bin/sh
export MAPLE="/usr/local/maple"
. $MAPLE/bin/maple -norun
myapp $*
```

("These commands run the maple launch script to configure your environment without starting Maple.")

Also from the Guides: on Windows the GUI/installer will usually locate the paths automatically; if the
app does not initialize, add `bin.win` or `bin.X86_64_WINDOWS` to `%PATH%`.

**Licensing.** Officially documented in the OpenMaple overview: "To run your application, Maple 9 or
later must be installed. You can distribute your application to any licensed Maple 9 or later user.
For additional terms and conditions on the use of OpenMaple, refer to
`extern/OpenMapleLicensing.txt`." (<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple>)
The C# sample in every Programming Guide also notes that if `StartMaple` fails, the `err` buffer
"usually" contains a **license error**. A `license error starting OpenMaple session` thread exists on
MaplePrimes (<https://www.mapleprimes.com/questions/243559-License-Error-Starting-OpenMaple-Session>),
so plan for license-failure handling on startup. OpenMaple does **not** start a separate Maple process
("Despite the name `StartMaple`, this is only an initialization step; no separate Maple process is
started" — 2018/2023 Guide) but it does consume a Maple license/seat like any Maple session.

### 1.3 Minimal working Java example (evaluate a string)

**Verbatim, Maple 2018 Programming Guide, "Java Example"** (also Maple 2021/2023, same code):

```java
import com.maplesoft.openmaple.*;
import com.maplesoft.externalcall.MapleException;
class test
{
   public static void main( String args[] )
   {
       String a[];
       Engine t;
       int i;
       a = new String[1];
       a[0] = "java";
       try
       {
           t = new Engine( a, new EngineCallBacksDefault(), null, null );
           t.evaluate( "int( x,x );" );
       }
       catch ( MapleException e )
       {
           System.out.println( "An exception occurred" );
           return;
       }
       System.out.println( "Done" );
   }
}
```

Output (per the Guide): `1/2*x^2` then `Done`.

The 2018 Guide's declaration is a little dated (the constructor throws), so the **current help's
canonical form** is the one to copy — it shows the result-printing/exception pattern and passes the
constructor exception through:

```java
import com.maplesoft.openmaple.*;
import com.maplesoft.externalcall.MapleException;
class Example
{
public static void main( String notused[] ) throws MapleException
{
String[] mapleArgs = { "java" };
Engine engine = new Engine( mapleArgs, new EngineCallBacksDefault(), null, null );
engine.evaluate( "int(x,x);" );
engine.evaluate( "LinearAlgebra:-RandomMatrix( 3, 3 );" );
try
{
engine.evaluate( "syntax_error" );
}
catch ( MapleException me )
{
System.out.println( "Error: "+me.getMessage() );
}
}
}
```

Output shown by the help: `1/2*x^2`, then the `Matrix(3,3,{...})` text, then
`Error: at offset 13, unexpected end of statement`.
— <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/Engine>

**Getting the result as a string** (the important bit for an MCP tool that returns text):
`Engine.evaluate` returns an `Algebraic`; `Algebraic.toString()` stringifies it, and
`EngineCallBacksDefault` already routes "displayed output" to `System.out`:

* `Algebraic evaluate( String statement ) throws MapleException` — "parses then evaluates
  statement and returns the results as an Algebraic object. […] The `statement` parameter must be
  terminated with a colon or semicolon. Using a colon suppresses output […] Errors generated during
  the parse and evaluation of the statement are directed to the `errorCallBack` method. Other errors
  cause a `MapleException` to be raised."
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/evaluate>
* `com.maplesoft.openmaple.EngineCallBacksDefault` — "configures a method to print output using the
  `System.out` method" (2018/2023 Programming Guide, "Text Callbacks"). Subclass it or implement
  `EngineCallBacks` (`textCallBack( int tag, String output )`, `errorCallBack`, `statusCallBack`, …) to
  capture output instead of printing it.
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/API>

A production helper therefore looks like:

```java
// minimal, UNTESTED-against-Maple sketch; API names are from the official help cited above
import com.maplesoft.openmaple.*;
import com.maplesoft.externalcall.MapleException;

public class MapleHelper {
  public static void main(String[] args) throws Exception {
    System.setProperty("java.awt.headless", "true");       // see §1.5
    String[] mapleArgs = { "java" };                        // args[0] MUST be "java"
    Engine engine = new Engine(mapleArgs,
        new EngineCallBacksDefault() { /* override textCallBack to emit JSON */ },
        null, null);                                        // user_data, res(null)
    Algebraic a = engine.evaluate("int(x,x);");             // trailing ; or : required
    System.out.println(a.toString());
    engine.stop();                                          // or engine.restart()
  }
}
```

**Exception model.** `com.maplesoft.externalcall.MapleException extends Exception`; "most methods are
declared to throw objects of type `MapleException`". Constructors: `MapleException(MapleException e)`,
`MapleException(Exception e)`, `MapleException(String msg)`, `MapleException(String msg, Object o1)`,
`MapleException(String msg, Object o1, Object o2)`; accessors `int getArgCount()` and
`int getArg(int i)` (0-based, `%1`→0, `%2`→1). The same class is used by Java ExternalCalling.
— <https://www.maplesoft.com/support/help/Maple/view.aspx?path=ExternalCalling/Java/MapleException>

**Shutdown / reset.** Two documented methods:

```
void stop() throws MapleException
void restart() throws MapleException
```

* `stop()`: "shuts down the Maple session represented by the Engine object. Any `Algebraic` objects
  will have their `dispose` method called. […] **Even after stopping the current Engine object, new
  Engine objects cannot be created.**"
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/stop>
* `restart()`: "causes the Maple session represented by the Engine object to clear its internal memory
  so that Maple acts (almost) as if just started. […] performs the same function as the `restart`
  function in Maple." All outstanding `Algebraic`s become disposed.
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/restart>

⇒ For an MCP server this dictates the process model: **one JVM = one Maple session for the life of the
process**; to truly reset, `engine.restart()`; to get a fresh session, kill and respawn the helper JVM.

### 1.4 Engine constructor signature and start-up arguments

```
Engine( String args[], EngineCallBacks cb, Object user_data, Object res )
```

* "Creating an instance of Engine starts the Maple session. **Only one instance of Engine should be
  created during the execution of the Java program.**"
* "The `args` parameter is an array of Strings to be passed as command-line arguments to Maple. The
  String at index 0 should be set to `"java"`."
* "`user_data` is a data element that is passed into each callback"; "`res` is reserved for future use.
  Programs calling Engine must always pass Java `null` for `res`."
* "(Windows only) If there are errors running a Java OpenMaple program with an atypical Java Virtual
  Machine, try passing the full path to the Java Virtual Machine executable as the zero'th string in
  `args`."
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/Engine>

The 2018/2023 Guides add: the first `StartMaple`/`Engine` parameter "is an array of strings that
specify options accepted by the command-line interface" (see the `maple` help page) — the C# sample
exploits this by passing `-A2`, so extra Maple CLI flags after `args[0]` are the intended mechanism.

### 1.5 Memory management (matters for a long-lived server)

Documented gotcha (Java only, because Java OpenMaple wraps Maple DAGs in native objects and tracks them
with a weak hash map):

> "This system fails when Java is creating many `Algebraic` objects without invoking the Java garbage
> collector. […] In this situation Maple is using a large amount of memory, but Java is not."
> Remedy: call `dispose()` on each result, e.g.
> ```java
> for ( i = 0; i < 100000; i++ )
> {
> kernel.evaluate( "Array( 1..100000, fill="+i+");" );
> }
> ```
> becomes
> ```java
> for ( i = 0; i < 100000; i++ )
> {
> a = kernel.evaluate( "Array( 1..100000, fill="+i+");" );
> a.dispose();
> }
> ```
> "Once the `dispose` member function has been called on an `Algebraic` no other member functions may
> be called except `isDisposed`."
> — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/memory>

Also authoritative: "The Maple command `unprotect:-gc` must be called to clean the memory reserved for
these tasks. **The OpenMaple Java interface is the only exception to this rule.**"
(Maple 2018/2023 Programming Guide §14.3.)

---

## 2. Java/OpenMaple runtime requirements in detail

### 2.1 JDK/JRE version compatibility

**Maplesoft does not publish a supported JDK version for OpenMaple.** The Programming Guides only say
`$JDKBINDIR`/`<JDKBINDIR>` is "the directory in which your Java development tools are installed"; the
help pages add no version constraint. What is documented/observable:

* The only "Java Runtime Environment version" figure in the Maple 2022 Installation and Licensing Guide
  is **for the browser plug-in used by the HTML exporter**: "Java Runtime Environment version 1.6.0_18
  or later". This is explicitly under "Web Browser Requirements" — **do not mistake it for an
  OpenMaple requirement**.
  — <https://www.maplesoft.com/support/install/2022/Maple/Install.html>
* The native bridge is plain JNI loaded by `System.loadLibrary("jopenmaple")` from `Engine`'s static
  initializer and calling the native `Engine.getKernel(String[], EngineCallBacks, Object, Object)`
  (observed in the 2021 macOS stack trace cited in §1.1). JNI is ABI-stable across JDK versions, but
  **community crash reports exist with newer JDKs** (e.g. `EXCEPTION_ACCESS_VIOLATION` in `maplec.dll`
  under `Java(TM) SE Runtime Environment (11.0.1+13)` on Windows:
  <https://www.mapleprimes.com/questions/233111-OpenMaple-For-Java-Memory-Access-Error>), and missing
  stack (`-Xss`) is documented to cause segmentation faults.
* Maple's own **Standard Worksheet GUI is Java-based** and its launcher accepts JVM options
  (`launch.ini`, Windows): `maxheap=700m`, `java_args=-Dfoo -Dbar`, `jaccess=true`,
  `java2d_nodraw=true` — evidence that Maple bundles/launches its own JVM for the GUI.
  — <https://www.maplesoft.com/support/install/2022/Maple/Install.html>

⇒ **Supported JDK versions: UNDOCUMENTED.** Practical guidance: match the JDK to the era (JDK 8 for
Maple 2018, JDK 11/17 for Maple 2022), always run with a large `-Xss` (documented value: `-Xss100M`),
and validate with the sample program before building anything on top. Do not assume the JVM that ships
inside Maple is usable for OpenMaple — the docs require *your* JDK (`<JDKBINDIR>`).

### 2.2 `java.library.path`, `MAPLE`, `LD_LIBRARY_PATH`

Covered verbatim in §1.2. Summary of the officially required environment:

| Platform | Required |
|---|---|
| Linux | `MAPLE=<MAPLEDIR>`; `LD_LIBRARY_PATH` must contain at least `<BINDIR>` (docs: use the full value of `getenv(LD_LIBRARY_PATH)` from Maple) |
| macOS | `MAPLE=<MAPLEDIR>`; `DYLD_LIBRARY_PATH` contains `<BINDIR>` |
| Windows | `PATH` contains `<BINDIR>`; usually auto-discovered |

`-Djava.library.path=<BINDIR>` is the JVM-level equivalent and appears in real-world working commands
(§1.1); `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` propagate to transitive `dlopen` dependencies
(`libmaplec.so`, `libmaple.so`, …) more reliably than `java.library.path` does, so prefer the
documented env vars in production.

### 2.3 Display / fonts / headless

* **No official statement requires a display for OpenMaple.** The documented prerequisites are only
  the two paths (`maplec` and the Maple install dir) — Maple 2018/2023 Programming Guide §14.3,
  "Runtime Environment Prerequisites".
* The Maple **command-line interface** is documented as usable in batch/pipeline mode with no GUI
  (`cmaple solve.mpl > solve.output`, `echo "int(x,x);" | cmaple`), i.e. the *engine* is headless.
  — Maple 2023 Programming Guide §14.4.
* Maple's Linux **system requirements** list "X11 R6" and a 16-bit-color console — but that is for the
  Standard (worksheet) interface, which is the Java GUI; it is not a requirement of the engine.
  — <https://www.maplesoft.com/support/install/2022/Maple/Install.html>
* `-Djava.awt.headless=true` is a standard JVM switch; **UNVERIFIED** whether OpenMaple needs it, but
  there is no documented AWT use in the Java OpenMaple API (all classes are data/engine classes), so it
  should be harmless and is a reasonable hardening default for a server. Test it against
  `EngineCallBacksDefault`/`getHelp` paths (help display callbacks exist) and any plotting calls.
* **Fonts:** no requirement documented for the engine. Plot *rendering* to images may pull in graphics
  support; only relevant if your MCP server returns plots. **UNVERIFIED** — test `plot(...)` with the
  server's minimal font set installed (e.g. a `-slim` container) if you render plots.

### 2.4 Cost on a thin production box

Measured on this research machine (OpenJDK **21.0.12** and **25.0.4**, x86-64 Linux, 12 cores, trivial
`main`; **not** a Maple workload — Maple's own engine memory is on top):

```
java -version (JDK 21):  wall ≈ 0.01– 0.12 s,  max RSS ≈ 41–43 MB
java -version (JDK 25):  wall ≈ 0.04 s,        max RSS ≈ 45 MB
java <class> -Xss100M:   wall ≈ 0.04–0.12 s,   max RSS ≈ 43–45 MB
```

Reference points that are official:

* Maple's GUI launcher default is `maxheap=700m` (launch.ini) — that is the *GUI* heap, not OpenMaple.
* OpenMaple starts **in-process** (no separate Maple process), so the helper JVM *is* the Maple kernel
  host; total RSS = JVM base (~45 MB measured) + Maple kernel + your data, and Maple's GC "may require
  a large amount of memory" if you leak `Algebraic`s (§1.5).

**Verdict for a thin box:** a *single long-lived* helper JVM is acceptable (≈+45 MB over the Maple
engine you must host anyway). Per-request JVM spawn is not, because startup is ~0.05–0.5 s and you also
pay Maple kernel initialization each time.

---

## 3. Java vs C as the bridge for a Node/Python service

### 3.1 Architectural options

1. **CLI batch mode (no JVM, no JNI)** — `maple -q` reading stdin / `-c 'stmt;'` / a `.mpl` file.
   Officially recommended as "one of the simplest options" for embedding the engine; the Guide claims
   "Starting the Maple command-line interface, automatically executing a command file, and stopping the
   Maple session can take about **one tenth of a second**" (a Maplesoft performance claim; the real
   number depends on start-up files and license checkout — treat as optimistic, measure on your box).
   Verbatim examples from Maple 2023 Programming Guide §14.4:
   ```sh
   cmaple solve.mpl > solve.output
   echo "int(x,x);" | cmaple
   /usr/local/maple/bin/maple -c 'datafile:="/tmp/12345.data";' -c N:=1;
   ```
   `-q` is documented as the flag "to hide extra output that interferes with parsing results
   automatically". This is the lowest-risk, thinnest bridge for **both** 2018 and 2022.
2. **C OpenMaple (`libmaplec.so`) from Python via `ctypes`/`cffi`** — official API
   (`StartMaple`/`EvalMapleStatement`/`StopMaple`, `MKernelVector`, `ALGEB`, callbacks), so no JVM at
   all, and the library is the same one the Java/`.NET` bindings sit on ("All of these interfaces are
   built on the C API"). Costs: you write the conversion layer (`MapleToString`, `MapleToInteger*`,
   rtable indexing…), you own the callbacks, and you must respect the threading rule: C API calls "can
   only be called from threads created within Maple or […] the thread which called `StartMaple`"
   (<https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/API>). Best if you need
   in-process performance and can spend a week on the binding.
3. **Java helper process (subprocess + JSON/line protocol)** — write ~100 lines of Java using
   `Engine`, speak one-JSON-per-line over stdin/stdout. Costs: JDK must be present at runtime, the
   helper must be built per Maple/platform, `-Xss100M` + `MAPLE`/`LD_LIBRARY_PATH` must be plumbed,
   one session per JVM and no re-creation after `stop()`. Benefit: you get the *typed* Maple object
   model (List/Table/RTable/Numeric/Name/Procedure) for free if you need structured results.
4. **In-process JNI from Node/Python** (`node-java`, `jpype`) — **not recommended**: you inherit JVM
   crash semantics inside your own service process, `UnsatisfiedLinkError`s (the `maplec.dll` access
   violation above is a hard JVM crash), and you lose restartability. If you want in-process, use the C
   API (option 2) instead, or use OpenMaple-for-Python on Maple 2023+ (option 5).
5. **Official Python OpenMaple** — `import maplesoft.maple` (Maple 2023+ only): "an interface for the
   Python programming language that allows you to access Maple algorithms and data structures from a
   Python session on the same machine"; bundled Python can be launched with `maple -python` on
   macOS/Linux. On Maple 2018/2022 this **does not exist**.
   — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2023/Connectivity> and
   <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/API>

### 3.2 Recommendation

* **Maple 2018 + 2022 → CLI bridge** (`maple -q`, session-per-request or a persistent `maple` process
  with sentinel-delimited replies). Zero JVM, zero JAR discovery, works identically on both versions,
  and it is the surface Maplesoft documents for exactly this use case.
* **Maple 2022 → also offer the Jupyter kernel** (see §5.1) as a "long-lived session with real
  protocol" mode.
* Use Java/OpenMaple only when you need typed Maple objects, callbacks into Java, or you already run a
  JVM. In that case: one long-lived helper JVM per Maple session, `-Xss100M`, `Engine.restart()` for
  resets, `dispose()` every `Algebraic`.

---

## 4. .NET and MapleNet

### 4.1 .NET / C# (`MapleEngine`, `extern/include/maple.cs`)

Still present in the Maple 2023 Programming Guide — this is the official ".NET" surface:

* §14.3 "C# Example" uses `MapleEngine.MapleCallbacks`, `MapleEngine.StartMaple(...)`,
  `MapleEngine.EvalMapleStatement(kv,"int(x,x);")`, `MapleEngine.StopMaple(kv)`, and catches
  `DllNotFoundException` / `EntryPointNotFoundException`.
* Build line: `csc test.cs $MAPLE\extern\include\maple.cs` — "The `maple.cs` file contains the
  `MapleEngine` class definition and defines an interface to the `maplec.dll` file."
* Verbatim comments from the sample: "If Maple does not start properly, the 'err' parameter will be
  filled in with the reason why (usually a license error)."
* There are also "Visual Basic 6" (`maple.bas`) and "Visual Basic .NET" samples.
  — Maple 2018 Guide §14.3; Maple 2023 Guide §14.3
  (<https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>)

Assessment: `MapleEngine` is a **P/Invoke wrapper over `maplec.dll`**, written for the .NET Framework
toolchain (`csc`), and its examples are Windows-only (the Guide says Windows auto-locates the paths and
mentions `%PATH%`). It is **not** a cross-platform .NET library and there is no NuGet package in the
official docs (**UNVERIFIED** whether any exists). On Linux the equivalent is the C API; on 2022 the
.NET surface is of no practical help to a Node/Python service. **"MapleNet API" ≠ .NET API** — see next.

### 4.2 MapleNet (the web server product)

* MapleNet is a **separate Maplesoft server product**, not part of a Maple desktop install. The Maple
  2023 Programming Guide still describes it: "MapleNet provides online viewing and execution of Maple
  documents and access to a Maple compute programming interface […] applications that require complex
  mathematical computations can send compute requests to MapleNet via standard HTTP POST request",
  pointing at the Compute API PDF. — Maple 2023 Programming Guide §14.2.
* The **Compute Engine API** (MapleNet 2021 docs) is Protocol-Buffers over HTTP:
  * POST to `/maplenet/mnserver/mcs/`, default server `http://localhost:8080`
  * Request/Reply protobuf messages: `MCSEvent`, `event_stream`, `commands { maple: "..." }`,
    `plot_options { type: IMAGE }`, `output_options { type: TEXT }`, `result`/`error`/`server_error`
  * sample Python client uses `httplib.HTTPConnection` + `connection.request("POST", "/maplenet/mnserver/mcs/", msg)`
  * `.proto` definitions live in `<MapleNetInstallDir>/include/`
  — <https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf>
* Deployment (Administrator Guide): "The MapleNet server is intended to be deployed in the Docker
  container generated by the MapleNet installer. Running it requires the Docker container engine. […]
  Attempting to run MapleNet outside of the Docker container is not supported", e.g.
  ```sh
  docker run --mount type=bind,source=$LICENSEFILE,target=/maple/license/license.dat,readonly \
             --publish $HOSTPORT:8080 maplesoft/maplenet:$IMAGETAG
  ```
  It needs a Maple license file, pools Maple engines, exposes metrics (`kernel_command_seconds`,
  `license_expiry_remaining_seconds`, engine limiter), default port 8080.
  — <https://www.maplesoft.com/documentation_center/MapleNet2021/AdministratorGuide.pdf>
* Availability: the documentation center only carries `MapleNet2021` and `MapleNet2019` manuals, and
  the product pages still exist (<https://www.maplesoft.com/products/maplenet/>). Whether MapleNet is
  still sold/updated for Maple 2022 is **UNVERIFIED**.

Relevance to a **local** headless bridge: **low**. It is a licensed server (Docker image + license
file), it is not shipped with Maple 2018/2022, and it adds a network hop while consuming an engine
pool. It is, however, the closest thing to an *official HTTP/JSON-ish compute API* and a good design
reference (command string in, typed event stream out).

---

## 5. Other official programmatic surfaces

### 5.1 Maple Kernel for Jupyter — **new in Maple 2022, and the most interesting alternative**

* Official: "The new **Maple Kernel for Jupyter** is a program bundled with Maple which allows Maple to
  be used as the computation engine in a session of the Jupyter computation environment. […]
  Output is displayed using standard file formats supported by Jupyter such as LaTeX and PNG."
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2022/Connectivity>
* Setup (current help; in Maple 2022 the kernel is named "Maple 2022" instead of "Maple 2025"):
  ```
  jupyter kernelspec list
  Jupyter[GenerateKernelConfiguration](somepath)      # in Maple; writes somepath/maple
  jupyter kernelspec install somepath/maple           # optionally --user
  ```
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/MapleKernel/Configuring>
* Also exists: the `Jupyter` package (`CreateNotebook`, `ExtractCodeSources`,
  `GenerateKernelConfiguration`, `SetOutputRendererByType`) and `Worksheet:-WorksheetToJupyter`.
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/GenerateKernelConfiguration>
* **Not available in Maple 2018** (introduced in 2022).

Why it matters: this is an official, local, headless, process-isolated Maple session with a
well-specified wire protocol (Jupyter messaging over ZeroMQ). A Node service would need a
ZeroMQ + Jupyter-protocol client; a Python service can use `jupyter_client.KernelManager` directly
and get execute/reply messages, stdout streams, and rich output. That is a materially cleaner MCP
backend than scraping `maple -q` stdout — if you can require Maple 2022.

### 5.2 OpenMaple for Python — **new in Maple 2023 (not in 2018/2022)**

* Officially: "OpenMaple for Python is an interface for the Python programming language that allows you
  to access Maple algorithms and data structures from a Python session on the same machine."
  Usage: `import maplesoft.maple as mpl`; symbols via `mpl.symbols('x,y,diff,dsolve')` or
  `maplesoft.maple.namespace` (`msym.evalf`, `msym.LinearAlgebra.Determinant`); automatic conversion
  `dict→table`, `list→list`, `set/frozenset→set`, `Fractions.fraction→fraction`, `sympy.Basic→anything`.
* On macOS/Linux the `maple` command gained `-python` ("launches the version of Python distributed with
  Maple. This is automatically configured to enable OpenMaple for Python to work").
* Note in the same page: "the primary package is now named `maplesoft.maple`" (it changed after
  Maple 2023, so 2023-era examples use `import maple`).
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2023/Connectivity>
* API surface: `Expression`, `ComplexNumeric`, `RealNumeric`, `Name`, `Indexable`,
  `ExpressionSequence`, `List`, `RTable`, `Set`, `Table`, operators
  (`__add__`, `__getitem__`, `__call__`, `eval`, `assign`, …).
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/API>

**This is the single best bridge if the project can target Maple 2023+.** For 2018/2022, it is a dead
end (there is no supported Python binding; the OpenMaple overview lists Python only in current help).

### 5.3 External calling (`define_external`, ExternalCalling)

* Direction: **Maple calls compiled code** (C, C++, Fortran, Java), i.e. the inverse of what the MCP
  server needs. Documented: "Most dynamic link-libraries (.dll) that contain mathematical functions
  written in another programming language can be linked directly in Maple"; `define_external('add',
  'num1'::integer[4], 'num2'::integer[4], 'RETURN'::integer[4], 'LIB'="mylib.dll")`; Java external
  functions need the keyword `JAVA` plus `CLASSPATH=`: `f := define_external('my_func','JAVA',
  CLASSPATH="...", ...)`. Java external code can throw `MapleException`, which Maple converts into a
  Maple error (`error`-like messages with `%1`,`%2` arguments).
  — Maple 2023 Programming Guide §14.5; <https://www.maplesoft.com/support/help/Maple/view.aspx?path=ExternalCalling/Java/MapleException>
* Relevance: **indirect**. Two legitimate uses: (a) a "callback into the host service" hook if you ever
  want Maple to call back into your MCP server's native code; (b) it shares the same native library
  (`maplec`) and the same `MapleException` class as OpenMaple, so tooling overlaps. It does **not**
  drive Maple from outside.

### 5.4 Excel add-in, MATLAB link, CAD link

* **Maple Plug-in for Excel**: "Maple is available as an add-in to Microsoft Excel **for Windows**";
  spreadsheet formula `=Maple( "&1*x^2 + &2*x + &3;", $C$1, $D$3, $B$6 )`. Windows+Excel GUI only.
* **MATLAB link**: two-way (`with(Matlab): setvar/evalM/getvar`; and Maple-from-MATLAB). Requires a
  locally configured MATLAB; it is an interactive desktop integration, not a service API.
* **CAD Connectivity** (`CADLink`, `OpenConnection`, `GetActiveDocument`, `OpenPart`): requires
  Inventor/NX/SolidWorks on the same machine.
  — Maple 2023 Programming Guide §§14.8–14.10; Maple 2018 Guide §14.
* Relevance to a headless local bridge: **none** (all require a GUI host application).

### 5.5 MapleCloud / Maple Learn / Maple T.A. / Möbius

* **MapleCloud** (`maple.cloud`) is Maplesoft's cloud repository for sharing Maple documents; the
  Programming Guides do **not** document a local automation API for it (no `MapleCloud` package
  chapter). A public REST API for programmatic upload/execute is **UNVERIFIED** (I could not find an
  official endpoint list). Treat as out of scope.
* **Maple Learn** integration runs on a *cloud* Maple engine: "the button action procedure is processed
  by a Maple engine in the cloud" (Maple 2023 Programming Guide §13.3, `DocumentTools:-Canvas`,
  `Script`, `ToString`). Not a local bridge.
* **Maple T.A. / Möbius**: now DigitalEd products; the Maple-side surface is
  `MapleTA:-Import`, `MapleTA:-Export`, `Grading:-Quiz`, `Grading` and task templates — i.e. **content
  interchange with an LMS/assessment platform**, not engine driving.
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=MapleTAIntegration>
* Relevance: **none** for a local headless MCP bridge.

### 5.6 Maplets and Embedded Components (EMC)

* **Embedded Components**: "simple graphical interface components that you embed into a worksheet or
  document […] **only available in the Standard interface**" (i.e. the Java GUI). Programmatic control
  via `DocumentTools`/`DocumentTools:-Do`.
  — <https://www.maplesoft.com/support/help/Maple/view.aspx?path=EmbeddedComponents>
* **Maplets**: "another technology within Maple that allow you to build an interface from a program
  description […] the interface always appears in a separate window"; `Maplets,Elements`,
  `Maplets,Utilities`, `Maplets,Examples`. (Maple 2023 Programming Guide §13.5.)
* Relevance to headless automation: **none** — both require the GUI/display. (Note: `DocumentTools`
  has headless-safe parts, e.g. `DocumentTools:-RunWorksheet` for Maple Flow documents in 2025, but
  components/Maplets are GUI-bound.)

### 5.7 TCP/IP sockets (bonus: an in-Maple server)

The Programming Guide documents "Accessing Data over a Network with TCP/IP Sockets" (§14.6 in the 2023
guide, `Sockets` package). If you want a persistent session without OpenMaple, you can also start a
Maple process that opens a socket and serves requests; that is a DIY protocol on top of the CLI, with
no JVM. Not an officially packaged service, but it is a documented Maple capability.

---

## 6. Maple 2018 vs Maple 2022 — differences that matter

| Area | Maple 2018 | Maple 2022 | Notes / source |
|---|---|---|---|
| OpenMaple Java JARs | `$MAPLE/java/externalcall.jar` + `$MAPLE/java/jopenmaple.jar` (2018 Guide) | same per the 2021 and 2023 Guides | current help says `Maple.jar`; verify by listing `$MAPLE/java`. Sources: 2018/2021/2023 Programming Guides; OpenMaple/Java/running |
| OpenMaple Java example/API | `Engine(String[], EngineCallBacks, Object, Object)`, `evaluate`, `stop`, `restart` | unchanged | 2018 Guide §14.3 vs 2023 Guide §14.3 |
| `-Xss100M` guidance | not in the 2018 Guide | in current online help ("running") | <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/running> |
| OpenMaple Python | no | **no** (came in Maple 2023) | <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2023/Connectivity> |
| Maple Kernel for Jupyter | no | **yes, new in 2022** | <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2022/Connectivity> |
| .NET/C# (`maple.cs`, `MapleEngine`) | documented | still documented in 2023 Guide | Windows/.NET Framework toolchain |
| MapleNet | documented | still documented in 2023 Guide (references MapleNet **2019** Compute API PDF) | product docs stop at MapleNet 2021 |
| Maplets | documented | documented (MaplePrimes reports a **Windows Maple 2023 crash when Maplets are used**: <https://www.mapleprimes.com/questions/236040>) | GUI-only anyway |
| Linux OS support | 2018-era distros (Ubuntu 16.04/18.04, RHEL 7, …) — **UNVERIFIED exact table** | Ubuntu 20.04 LTS/21.10, RHEL 7/8, SLED 15; 4 GB RAM, 10 GB disk, `lsb-base`/`lsb-core` (Ubuntu), "X11 R6" listed for the GUI | <https://www.maplesoft.com/support/install/2022/Maple/Install.html> |
| Licensing | FlexNet-based activation (Flexera FlexNet Publisher) | same | Install Guide |

**Deprecated/removed:** no official statement found that OpenMaple Java or the .NET `MapleEngine`
surface was removed in 2022; both remain in the 2023 Programming Guide. The notable *renames* are the
JAR-name change seen in current help (`Maple.jar`) and the OpenMaple-for-Python package rename
(`maple` → `maplesoft.maple` after Maple 2023). **UNVERIFIED**: exact release in which
`jopenmaple.jar` was merged into `Maple.jar`; exact release that dropped any legacy sample.

---

## 7. Concrete design notes for the MCP server

1. **Default backend: CLI.** `spawn(maple, ['-q'])`, write `statement;`, read until a sentinel
   (`printf("<<<END>>>\n")`-style) or use `-c`. Works on 2018 and 2022 with zero extra prerequisites.
   Budget per invocation per Maplesoft: ~0.1 s ("can take about one tenth of a second") — measure.
   Use `printf`/`lprint`-style output or `-q` for machine-readable results.
2. **Optional backend (2022): Jupyter kernel.** `Jupyter[GenerateKernelConfiguration](dir)` +
   `jupyter kernelspec install dir/maple`; drive with `jupyter_client` (Python) or a ZMQ client
   (Node). Gives streaming stdout, real session state, clean shutdown.
3. **Optional backend (any version): Java helper.** Build once with the JARs actually present in
   `$MAPLE/java`; run with `MAPLE`, `LD_LIBRARY_PATH`, `-Xss100M`; one Engine per process;
   `Engine.restart()` to reset; `dispose()` results; capture output by overriding `textCallBack`.
4. **Health checks.** On startup, evaluate something trivial and assert on the result; surface license
   failures distinctly (they show up as `MapleException`/C# `err` / CLI error text).
5. **Avoid:** in-process JNI from Node/Python; MapleNet for a local single-box bridge; anything
   GUI-based (Excel/MATLAB/CAD/Maplets/Embedded Components/Maple Learn).

---

## 8. Open questions / explicitly UNVERIFIED

1. Exact list of JARs in `$MAPLE/java` for a given 2018/2022 install, and which one contains
   `com/maplesoft/openmaple/Engine.class` (docs conflict: `jopenmaple.jar` vs `Maple.jar`).
2. The release in which the OpenMaple Java classes moved into `Maple.jar`, and whether `jopenmaple.jar`
   is still shipped (possibly as a compatibility alias) in 2022+.
3. Officially supported JDK versions for OpenMaple on Maple 2018 and 2022 (not documented). Test
   matrices needed: JDK 8/11/17 × Maple 2018/2022 × Linux.
4. Exact Linux filename of the Java OpenMaple native library (`libjopenmaple.so` assumed).
5. Whether `-Djava.awt.headless=true` is required/safe for OpenMaple, and whether any OpenMaple path
   (e.g. plotting, help callbacks) needs fonts or an X display.
6. MapleNet availability/lifecycle for Maple 2022 (latest manuals are 2021; product page still live).
7. Whether any public MapleCloud REST API exists for programmatic document upload/execution.
8. Real memory/time cost of a Maple kernel session (not measured here — no Maple install available).

---

## 9. Sources (URLs)

Official Maplesoft — OpenMaple & Java
* OpenMaple overview (licensing, list of language interfaces incl. Python):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple>
* Java OpenMaple API (class/interface list, classpath requirement):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/API>
* Java examples (the minimal program):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Examples>
* Building and running Java OpenMaple (JARs, env vars, `-Xss100M`):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/running>
* `Engine` constructor:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/Engine>
* `Engine.evaluate`:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/evaluate>
* `Engine.stop` / `Engine.restart`:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/stop> ·
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/Engine/restart>
* Java OpenMaple memory management (dispose):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Java/memory>
* `MapleException` (constructors, getArg/getArgCount):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=ExternalCalling/Java/MapleException>
* C OpenMaple / ExternalCalling API (function list, threading rule):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/C/API>
* OpenMaple for Python API (Maple 2023+):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=OpenMaple/Python/API>

Official Maplesoft — documentation PDFs
* Maple 2018 Programming Guide (OpenMaple §14.3, MapleNet §14.2, CLI §14.4, ExternalCalling §14.5,
  Excel/MATLAB, examples verbatim):
  <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
* Maple 2021 Programming Guide:
  <https://www.maplesoft.com/documentation_center/Maple2021/ProgrammingGuide.pdf>
* Maple 2023 Programming Guide (still `jopenmaple.jar`; C#/.NET, CLI, MapleNet, Maplets/EMC):
  <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>
* Maple 2022 Installation and Licensing Guide (Linux system requirements, `launch.ini`, browser JRE):
  <https://www.maplesoft.com/support/install/2022/Maple/Install.html>
* Maple 2022 Installation Guide PDF (mirror):
  <https://jp.maplesoft.com/documentation_center/maple2022/Maple-2022-Installation-Guide.pdf>

Official Maplesoft — connectors, versions, releases
* Connectivity in Maple 2022 (Maple Kernel for Jupyter; SMTLIB; DeepLearning):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2022/Connectivity>
* Connectivity in Maple 2023 (OpenMaple for Python, `maple -python`, OpenAPI code generation):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2023/Connectivity>
* Configuring the Maple Kernel for Jupyter:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/MapleKernel/Configuring>
* `Jupyter:-GenerateKernelConfiguration`:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/GenerateKernelConfiguration>
* Embedded Components (Standard interface only):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=EmbeddedComponents>
* Maple T.A. integration / Möbius:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=MapleTAIntegration>
* MapleNet Compute Engine API (protobuf over HTTP, `/maplenet/mnserver/mcs/`, port 8080):
  <https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf>
* MapleNet Administrator Guide (Docker deployment, license file, engine pool/metrics):
  <https://www.maplesoft.com/documentation_center/MapleNet2021/AdministratorGuide.pdf>
* MapleNet product page:
  <https://www.maplesoft.com/products/maplenet/>

Community (used only for real-world failure modes, clearly marked as such)
* `UnsatisfiedLinkError: no jopenmaple in java.library.path` (Maple 2021, macOS, JDK 15):
  <https://www.mapleprimes.com/questions/232033-Where-Is-Jopenmaple-Supposed-To-Be-Located>
* `libjopenmaple.jnilib` / `@rpath/libmaplec.dylib` failure + `-Djava.library.path` command
  (Maple 2021, macOS):
  <https://www.mapleprimes.com/questions/232275-Java-OpenMaple-Running-Error>
* `EXCEPTION_ACCESS_VIOLATION` in `maplec.dll` under Java 11.0.1 on Windows:
  <https://www.mapleprimes.com/questions/233111-OpenMaple-For-Java-Memory-Access-Error>
* License error starting an OpenMaple session:
  <https://www.mapleprimes.com/questions/243559-License-Error-Starting-OpenMaple-Session>
* OpenMaple in the free trial / API availability questions:
  <https://www.mapleprimes.com/questions/240672-Does-OpenMaple-Work-In-The-Free-Trial> ·
  <https://www.mapleprimes.com/questions/238591-OpenMaple-API-Still-Exist>
* "Where does one find the python module 'maple'?":
  <https://www.mapleprimes.com/questions/237943-Where-Does-One-Find-The-Python-Module-maple>

Local measurements (this research machine, for §2.4): OpenJDK 21.0.12 / 25.0.4, `/usr/bin/time -v`,
trivial `main`, `-Xss100M`. Not a Maple workload.
