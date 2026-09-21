# 06 — MCP Prior Art: Maplesoft Maple MCP and CAS MCP Design References

**Scope.** Research input for building a custom MCP (Model Context Protocol) server that connects an LLM to a
**locally installed Maple 2018 or Maple 2022**. This document covers (1) the official Maplesoft Maple MCP product,
(2) community prior art for Maple/CAS MCP servers, (3) what a good CAS MCP tool surface looks like,
(4) official/community information on Maple MCP's internal architecture, and (5) non-MCP integrations that solve the
same problem.

**Method & evidence rules.** All web content was treated as untrusted data. Claims are cited with a URL.
Anything not directly confirmed from a primary source is marked **UNVERIFIED**. Where a tool list could not be
obtained, this is stated explicitly rather than guessed.

**Research date:** 2026-09-21. Live probes were performed against public endpoints on that date.

**Known access limitation during this research:** after repeated fetches, `maplesoft.com` and its locale mirrors
began resetting connections from this host, and `web.archive.org` intermittently did the same. Everything in §1–§4
was captured **before** that happened and is quoted from the pages/PDFs themselves. Items that could only be reached
via search-result snippets after the block are explicitly marked "search-surfaced, NOT directly read" and
**UNVERIFIED**. No authentication was bypassed anywhere; every authenticated Maplesoft endpoint correctly returned
`not authorized` / `not logged in`.

---

## Executive answers (read this first)

| Question | Answer |
|---|---|
| Does an official Maplesoft Maple MCP exist? | **Yes.** Product page: <https://www.maplesoft.com/products/maplemcp/index.aspx> |
| How is it shipped? | **Not as downloadable software.** It is a *cloud service* unlocked by a **Maple 2026 license with active Elite Maintenance Program (EMP)** membership; the API key appears in Maple's **My Maple** ribbon. There is no public package, repo, or installer. |
| Which Maple versions? | **Maple 2026 only.** Server self-reports version `2026.1`. |
| Local or cloud? | **Cloud.** `https://cloud-api.maplenet.cloud/api/v2/mcp` (AWS/CloudFront). The client needs no local Maple install. |
| Transport? | **MCP Streamable HTTP** (JSON-RPC 2.0 over HTTP POST). **Not stdio.** |
| Auth? | **API key in a query parameter named `auth`.** |
| Will it work with Maple 2018 or 2022? | **No.** Not designed for it, and not licensable for it. See §1.7. |
| Are its MCP tools documented publicly? | **No — not discoverable.** `tools/list` returns `401 not authorized` without a key. **No public tool list exists.** Do not assume tool names. |
| Is there an official way to drive Maple from Python? | **Yes, but it excludes 2018/2022:** `Maplesoft/openmaple` ("OpenMaple for Python", MIT) is an official ctypes binding to the OpenMaple C library — but it **requires Maple 2023+** (README says 2024+) (§5.1). |
| Is there any local non-MCP bridge for our versions? | **Yes — three.** (a) The **OpenMaple C API** (`libmaplec`, `maplec.h`) is documented for **Maple 2018** and present in **2022** → we can write our own thin ctypes/FFI binding (§5.1). (b) On **Maple 2022 only**, Maplesoft ships an official **Maple Kernel for Jupyter** (ZeroMQ, built on OpenMaple, LaTeX+PNG output) (§5.2). (c) The `maple`/`cmaple` **CLI** works on both versions with documented exit codes 0–5 (§5.3). |
| Key takeaway for our project | The official product **cannot** serve old Maple, so a custom server is genuinely needed for 2018/2022. Combine a **local stdio process bridge** (OpenMaple `libmaplec` via ctypes, or the `maple`/`cmaple` CLI; the 2022-only Jupyter kernel is a third option) with an **evaluate-code tool shaped like Wolfram's `WolframLanguageEvaluator`**. |

---

## 1. The official Maplesoft "Maple MCP" product

### 1.1 Primary sources read

- English product page: <https://www.maplesoft.com/products/maplemcp/index.aspx>
- Chinese product page: <https://www.maplesoft.com.cn/products/MapleMCP/>
- French product page (contains the Copilot Studio PDF link): <https://fr.maplesoft.com/products/MapleMCP/>
- **"Setting up Maple MCP for Copilot Studio"** PDF:
  <https://www.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>
  (mirror: <https://fr.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf> — byte-identical, 467,077 bytes, 9 pages)
- "AI-Powered Assistance in Maple 2026" PDF:
  <https://www.maplesoft.com/products/maple/new_features/Maple2026/PDFs/Maple2026-AIPoweredAssistance.pdf>
- Maple 2026 new-features page: <https://www.maplesoft.com/products/maple/new_features/index.aspx>
- Elite Maintenance Program FAQ: <https://www.maplesoft.com/elite/faqs.aspx>
- Maple MCP contact/lead form: <https://www.maplesoft.com/contact/webforms/maplemcp.aspx>

> Note: the PDF's own URL is **not** in a `Claude-Desktop`/`ChatGPT`-named file. Probed and confirmed **404**:
> `.../MapleMCP/Claude-Desktop-MCP-Instructions.pdf`, `.../Claude-MCP-Instructions.pdf`,
> `.../ChatGPT-MCP-Instructions.pdf`, `.../Maple-MCP-Instructions.pdf`. Only the Copilot Studio PDF is published.

### 1.2 How it is shipped

Maple MCP is **not a distributable artifact**. It is an entitlement + a hosted endpoint:

- Official FAQ "How to Get Maple MCP?": *"Maple MCP is available to every Maple user who has an active membership
  in the Maplesoft Elite Maintenance Program. You'll find everything you need in the My Maple menu inside Maple."*
  — <https://www.maplesoft.com/products/maplemcp/index.aspx>
- Official FAQ "How do I get access?": *"Maple MCP is included with a Maple license if you already use Maple or are
  purchasing it - MCP is ready to use, no additional setup required."*
- Getting-started section: *"Current Maple users with an active Elite Maintenance Program membership can access it
  directly through My Maple menu inside Maple."*
- The Maple 2026 release notes state: *"**Maple MCP is a new benefit of membership in the Elite Maintenance Program
  (EMP).**"* — <https://www.maplesoft.com/products/maple/new_features/Maple2026/PDFs/Maple2026-AIPoweredAssistance.pdf>
- The enterprise path is sales-led, not self-serve: *"Standalone deployment — Don't need the full Maple environment?
  Deploy Maple's math engine directly into your existing LLM infrastructure. Integrates with private and on-premises
  LLMs; your data stays within your environment; custom licensing for teams and organizations."*
  — <https://www.maplesoft.com/products/maplemcp/index.aspx>
- The French page adds: *"If you don't have Maple, or if you want to talk about central deployment, contact us."*
  — <https://fr.maplesoft.com/products/MapleMCP/>

**Consequence:** there is no public package to install, no `npx`/`uvx`/`pip`/`npm` artifact, no GitHub repository,
and no source code. Whatever we build cannot reuse it.

**Corroboration from Maplesoft's own GitHub organization:** <https://github.com/orgs/Maplesoft/repositories> lists
**exactly 1 public repository** — `openmaple` ("OpenMaple for Python", Python, MIT, 1 star, 3 forks), last updated
2026-06-08. There is **no** Maple MCP repository, and no other official open-source Maple integration. (Retrieved
2026-09-21.)

### 1.3 Version, locale and licensing requirements

- **Maple 2026 + active EMP.** Maple MCP is introduced in the Maple 2026 release; it is listed under
  "AI-Powered Assistance in Maple 2026" and flagged as a **new** EMP benefit
  (<https://www.maplesoft.com/products/maple/new_features/Maple2026/PDFs/Maple2026-AIPoweredAssistance.pdf>).
- The live server corroborates the version: `initialize` returns `serverInfo.version = "2026.1"` (§1.5).
- **EMP requirement.** Being listed as an EMP benefit means an expired EMP removes access — the EMP FAQ states that
  choosing not to renew means you *"lose access to the benefits of EMP which include software upgrades, access to
  Technical Support and the host of free services"* (<https://www.maplesoft.com/elite/faqs.aspx>).
- The Maple 2026 AI PDF also notes the **`NaturalLanguage` package now requires credits**, included with EMP
  membership. Whether MCP calls consume those same credits is **UNVERIFIED** — Maplesoft does not say. Treat
  "MCP usage may be metered" as an open question for the enterprise path.

**Standalone / enterprise licensing** exists but is quote-only ("custom licensing for teams and organizations";
contact sales: <https://www.maplesoft.com/contact/webforms/contact_sales.aspx>). No published price.

### 1.4 Local vs cloud, and the transport

**It is cloud-hosted.** The Copilot Studio instructions give the endpoint verbatim:

```
Server name:        Maple MCP Math Engine
Server description: Use the Maple MCP server for mathematics.
Server URL:         https://cloud-api.maplenet.cloud/api/v2/mcp
Authentication:     API key
Authentication Type: Query
Authentication Label: auth
```

— <https://www.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>

Live probe of `https://cloud-api.maplenet.cloud/api/v2/mcp` (2026-09-21) confirms:

- Response headers include `x-amzn-trace-id`, `x-amzn-requestid`, `x-cache: Miss from cloudfront`,
  `via: 1.1 ...cloudfront.net (CloudFront)` → **AWS API Gateway + Lambda + CloudFront**.
- `content-type: application/json` for JSON-RPC responses; the endpoint also negotiates
  `Accept: application/json, text/event-stream` (MCP Streamable HTTP).
- A server-side **`mcp-session-id`** header is issued on `initialize`, i.e. the transport is
  **session-oriented Streamable HTTP**, not stateless request/response and **not stdio**.
- `notifications/initialized` → `HTTP 202` (accepted, empty body) — standard Streamable HTTP behaviour.

**Transport conclusion: MCP over Streamable HTTP (remote), version `2025-06-18`. There is no stdio/local mode.**

### 1.5 Live `initialize` response (verbatim, unauthenticated)

Unauthenticated `initialize` **succeeds** (only tool/resource access is gated). Exact response body:

```json
{
  "result": {
    "instructions": "Use Maple for all math calculations",
    "capabilities": {
      "resources": { "listChanged": false, "subscribe": false },
      "tools": { "listChanged": false }
    },
    "serverInfo": {
      "name": "Maplesoft",
      "title": "Maple Server",
      "icons": [ { "src": "https://www.maplesoft.com/media/logos/Maplesoft_Logo/Maplesoft_logo.jpg" } ],
      "version": "2026.1"
    },
    "protocolVersion": "2025-06-18"
  },
  "id": 1,
  "jsonrpc": "2.0"
}
```

Facts extractable from this:

- `serverInfo.name = "Maplesoft"`, `title = "Maple Server"`, `version = "2026.1"`.
- Advertised capabilities: **`tools`** and **`resources`** only. **No `prompts` capability, no `logging`,
  no `completions`.** `tools.listChanged = false` and `resources.subscribe = false`, i.e. the tool set is static.
- The server ships a global **`instructions`** string: `"Use Maple for all math calculations"`. This is the only
  server-authored guidance Maplesoft exposes publicly.
- Protocol version negotiated: **`2025-06-18`**.

### 1.6 Authentication

- Scheme: **API key** supplied as a **query parameter named `auth`** appended to the MCP URL
  (Copilot Studio: "Authentication: API key / Authentication Type: Query / Authentication Label: auth").
- Key provenance: *"You can find this information in Maple. Under the 'My Maple' ribbon there is a 'Maple MCP' icon.
  When clicked it will show you your API key. Click the 'Copy Code' button."*
  — <https://www.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>
- Gating behaviour observed live:
  - `initialize` without any key → **HTTP 200**, normal result (see §1.5).
  - `tools/list` without a key → **HTTP 401**, body `{"id":2,"jsonrpc":"2.0","error":{"code":-32600,"message":"not authorized"}}`
  - `resources/list` without a key → **HTTP 401**, same `not authorized` error.
  - A deliberately invalid key (`?auth=test`) still allows `initialize` (200); no distinct "invalid key" error was
    observed at that stage. **No authentication bypass was attempted or achieved** — every authenticated operation
    correctly refused.
- **Security observation (design-relevant):** a long-lived credential in a **query string** is leak-prone
  (browser history, reverse-proxy/CDN access logs, `Referer`). CloudFront terminates TLS and forwards the URL.
  For our local server, prefer a **stdio** transport (no credential needed) or an `Authorization` header.

### 1.7 Verdict for Maple 2018 / Maple 2022

**The official Maple MCP cannot be used with Maple 2018 or Maple 2022.** Reasons, each grounded in a source:

1. It is **not a local server**; there is nothing to install next to an old Maple. It is a cloud endpoint
   (`cloud-api.maplenet.cloud`) whose compute engines are Maplesoft-operated
   (<https://www.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>).
2. The only supported compute engine is **Maple 2026** (`serverInfo.version = "2026.1"`; the feature is documented
   as new in Maple 2026: <https://www.maplesoft.com/products/maple/new_features/Maple2026/PDFs/Maple2026-AIPoweredAssistance.pdf>).
3. The only way to obtain a key is the **My Maple ribbon inside Maple** plus an **active EMP** entitlement — an
   entitlement that a 2018/2022 license does not carry
   (<https://www.maplesoft.com/products/maplemcp/index.aspx>, <https://www.maplesoft.com/elite/faqs.aspx>).
4. It is a hosted service reached over the internet; a local 2018/2022 install is irrelevant to it.

**There is no configuration, flag, or compatibility mode that makes the official Maple MCP drive local Maple
2018/2022. UNVERIFIED whether Maplesoft's paid "standalone deployment" can be pointed at an on-premises older
engine — but even so it is a sales-negotiated enterprise product, not a path we could adopt, and it would target
current Maple, not 2018.**

### 1.8 Configuration in Claude Desktop / Copilot Studio / ChatGPT

- **Copilot Studio — fully documented.** Steps (from the PDF): create an agent → Tools → "Add a tool" →
  "Model Context Protocol" (or search for an existing Maple MCP tool) → enter the six settings quoted in §1.4 →
  "Not connected" → "Create new connection" → paste the API key into the `auth` field → **Create** →
  **Add and Configure** → test in chat → **Publish** (or leave unpublished for personal use).
  The PDF also shows the suggested agent name *"Maple Math Engine Connector"* and description
  *"Use this agent for any calculations from simple calculator inputs to advanced symbolic and numeric mathematics."*
- **Claude Desktop — NOT published.** No `claude_desktop_config.json` snippet for Maple MCP could be found on
  maplesoft.com or anywhere else. The official page only says MCP is compatible with Claude and that setup details
  are in the My Maple menu inside Maple. **No exact JSON config is available to cite. Do not invent one.**
  (For the record, the *expected* shape given the endpoint would be an `mcpServers` entry with `"type": "http"` and
  the URL carrying `?auth=...`, but this specific JSON is **UNVERIFIED** and not published by Maplesoft.)
- **ChatGPT — NOT published.** ChatGPT is listed as compatible (via Connectors/custom MCP), but Maplesoft publishes
  no ChatGPT-specific configuration. **UNVERIFIED.**
- **Gemini, Cohere, Perplexity** are listed as compatible on the product page; no per-client instructions published.

### 1.9 The MCP tools it exposes — **NOT FOUND**

This is a deliberate, important negative result:

- **The tool list is not publicly discoverable.** `tools/list` on the official endpoint returns
  **HTTP 401 `not authorized`** without a valid EMP API key. Obtaining that key requires owning Maple 2026 + EMP.
- No public documentation page, help topic, PDF, blog, or registry entry lists the Maple MCP tool names or schemas.
  Probed `https://www.maplesoft.com/support/help/maple/view.aspx?path=MapleMCP` → **HTTP 410 Gone** (help topic does
  not exist); `path=MCP`, `path=AI/MapleMCP`, `path=ai/MapleMCP`, `path=updates/Maple2026/whatsnew` → 410 as well.
- The **official MCP registry has no Maplesoft entry**: `registry.modelcontextprotocol.io/v0/servers?search=maplesoft`
  and `?search=maple+math` both return **zero** servers. (The only "Maple"-named hit is an unrelated Tesla
  collision-parts server, `ca.maplev/tesla-collision-parts`.)
- **mcp.so** has no Maple/Maplesoft server page (`https://mcp.so/server/maple/maplesoft` → 404).
- A **LobeHub** listing titled "marvalarva2929-maple-mcp" exists at
  <https://lobehub.com/mcp/marvalarva2929-maple-mcp> but the page returned no usable content (no tool names,
  no schema) and appears to be an auto-generated/SEO stub. **Do not cite it for tool names.**

**Therefore: the only confirmed server-authored text is the `instructions` string
`"Use Maple for all math calculations"`, the confirmed capabilities are `tools` + `resources`, and the tool names
and JSON schemas are UNVERIFIED / UNKNOWN.** Any design work must proceed from comparable CAS servers (§3), not from
guessed Maple tool names.

**Vendor-derived second-hand descriptions (no verbatim tool names — treat as UNVERIFIED).** Chinese reposts of the
Maple MCP beta announcement describe the capability areas as: numeric/symbolic expression evaluation, **executing
Maple code**, expression expansion/factorization, equation simplification/solving, generating interactive
visualizations, **predefined prompts**, and **loading Maple Learn documents**. Sources (all vendor-derived marketing
reposts, not independent reviews): <https://blog.sciencenet.cn/home.php?mod=space&uid=516836&do=blog&id=1518272>,
<https://www.sohu.com/a/973817594_121417987>, <https://www.cnblogs.com/maplesoft/articles/22448372>. One of them even
records that the model's prompt *"wasn't clear"* and the output *"has huge room for optimization"*.

**Notable inconsistency to flag:** those reposts mention **predefined prompts**, but the live server's `initialize`
response advertises **`tools` and `resources` only — no `prompts` capability** (§1.5). Either the reposts are
inaccurate/marketing-derived, or the prompts were removed/renamed. **UNVERIFIED** either way, but it means we should
**not** plan a Maple-style prompt surface on the assumption that the official server has one. Note that the
capability areas listed (evaluate expressions, execute Maple code, expand/factor, simplify/solve, visualizations,
load documents) are consistent with a mostly **evaluation-and-document** surface rather than a large per-operation
tool catalog — which matches the vendor pattern in §3.6.

### 1.10 The one useful architectural hint on the cloud side

`GET https://cloud-api.maplenet.cloud/api/v2/status` returns:

```json
{"result":"ok","server":"1.0","mcp_posts":77,"api_posts":1705,"window_ms":1800000}
```

Two things follow: (a) the same service fronts **both an MCP surface and a separate, much more heavily used REST
API**; (b) the counters are rolling over a **30-minute window** (`window_ms: 1800000`). Probing sibling routes showed
that `/api/v2/compute` and `/api/v2/index` return `{"result":"error","errormessage":"not logged in"}` — a *different*
error from the generic `{"result":"error","errormessage":"bad api"}` returned for non-existent routes — so
**`compute` and `index` are real, authenticated endpoints** of that REST API. `/api/v2/ping` returns `{"result":"ok"}`.
This is consistent with §4 (a MapleNet compute service plus a document/index service behind one gateway).
No authentication was bypassed at any point.

---

## 2. Community prior art: MCP servers for Maple and other CAS

### 2.1 MCP servers for the Maple CAS — **none exist**

GitHub repository search (GitHub Search API, `sort=updated`, 2026-09-21):

| Query | Results | Relevant to Maple CAS? |
|---|---|---|
| `maple mcp server` | 3 | **No** |
| `maple model context protocol` | 0 | — |
| `maple computer algebra mcp` | 0 | — |

The three hits for `maple mcp server` are all naming false positives:

| Repo | What it actually is |
|---|---|
| <https://github.com/samarpassey/maple-procure> | MCP server over **CanadaBuys** public tender data ("Maple" = Canada). Python, MIT, pushed 2026-09-15. |
| <https://github.com/kcw2034/maplestory-mcp-server> | **MapleStory** game OpenAPI MCP server. Python, MIT, pushed 2026-03-26. |
| <https://github.com/ljy9303/maplestory-mcp-server> | **MapleStory** (Nexon) game OpenAPI MCP server. TypeScript, no license shown, pushed 2025-07-16. |

**Conclusion: there is no known community MCP server for the Maplesoft Maple CAS.** We would be building the first
one. This also means there is no prior art to copy for the Maple-specific parts (worksheet model, `cmaple` handling).

### 2.2 Naming false positives to avoid (they pollute searches)

The word "Maple" is heavily overloaded, and so are the words "octave", "singular" and "cas". Every one of these was
returned by a *bona fide* CAS-related search and must **not** be cited as CAS prior art:

| Repo / entry | What it actually is |
|---|---|
| <https://github.com/oyc0401/maple-auction-mcp> (20★) | **MapleStory** Korean game auction-house API |
| <https://github.com/kcw2034/maplestory-mcp-server>, <https://github.com/ljy9303/maplestory-mcp-server>, <https://github.com/maplestory-llm/maplestory-mcp> | **MapleStory** (Nexon) game OpenAPI |
| <https://github.com/marvalarva2929/maple-mcp> | *"Honey, but for developers"* — a **software-discount** service. This is the repo behind the LobeHub "Maple MCP" listing flagged in §1.9 — **confirmed bogus**, not a CAS server. |
| <https://github.com/Goldferret/maple-mcp> | **MAPLE = Model-Agnostic Platform for Laboratory Experiments** (MADSci lab automation) |
| <https://github.com/popellab/maple> | **MAPLE = Model-Aware Parameterization from Literature Evidence** (QSP biology) |
| <https://github.com/xin8coder/MAPLE-harness-core> | **MAPLE = Memory-Augmented Planning with Language and Evolution** |
| <https://github.com/oramada/MCp-Use>, <https://github.com/MianMMajid/MCp-Use> | "Maple" agent-orchestration/observability platforms |
| <https://github.com/samarpassey/maple-procure> | CanadaBuys public-tender data ("Maple" = Canada) |
| <https://github.com/fouriers-tensor/maple-law-mcp> | CANLII Canadian law data |
| <https://github.com/Maple-Mathematics-Symbolic-Computation/maple-mathematics> | **SEO/warez download-spam page** for pirated Maple; not a server at all |
| <https://github.com/heodongun/maple-mcp> | **Empty repo** (0 bytes, no commits) |
| <https://docs.maple.finance/integrate/technical-resources/configure-mcp-server> | **Maple Finance** (DeFi lending) |
| <https://github.com/f12io/maple-vscode-extension>, `@f12io/maple-language-core` | **Maple CSS Engine**, not Maplesoft Maple |
| **<https://github.com/elevanaltd/octave-mcp> (55★)** | **OCTAVE = a document-canonicalization protocol** for LLM pipelines — **not GNU Octave**. The highest-starred "octave" hit and entirely irrelevant. Glama files it under "octave". |
| <https://github.com/springwq/singular-mcp> | **Report generation** (`create_report`, `get_report_status`) for a marketing-analytics product — not the Singular CAS |
| `CASParser/cas-parser-node` (Glama) | CAS = **Consolidated Account Statement** (Indian mutual funds) |
| <https://github.com/aatxe/OpenMaple> | **MapleStory** emulator |
| <https://github.com/dragonforce2010/openmaple> | Unrelated managed-agent platform |
| <https://github.com/iqtree/cmaple> | **CMAPLE** phylogenetics, not Maple's `cmaple` CLI |
| `ca.maplev/tesla-collision-parts` (official MCP registry) | Canadian auto-parts vendor |
| <https://github.com/tomncarter/sagemath-mcp> | **Empty repository** (0 bytes, no commits) — not usable prior art despite its description |

**Practical consequence for our project:** our README, MCP registry entry and tool metadata must say
**"Maplesoft Maple"** explicitly, or we will be misfiled alongside MapleStory, Maple Finance, MAPLE lab automation
and Maple CSS.**

### 2.3 Registry coverage — the official registry does not know about Maple either

Verified 2026-09-21:

- **Official MCP registry** (<https://registry.modelcontextprotocol.io/v0/servers>): the only CAS entries are
  `io.github.XBP-Europe/sagemath-mcp`, `io.github.justice8096/sagemath-mcp-server`,
  `io.github.matlab/matlab-mcp-server`, `io.github.daedalus/mcp-parigp`. **Zero** results for `maplesoft`, `maple math`,
  `algebra`, `maxima`, `octave`, `geogebra`, `desmos`, `symbolic`, `computer algebra`, `giac`. (Searching `maple`
  yields only `ca.maplev/tesla-collision-parts`, `io.github.kcw2034/maplestory-mcp-server`.)
- **mcp.so**: the entire `#math` tag contains **4** entries, none a CAS (e.g. `concordance-2`, `euclid`,
  `ultimath-mcp`). Effectively useless as a CAS registry.
- **glama.ai** and **lobehub.com** do index several real CAS servers, but their **categories and tool lists are
  scraped/keyword-derived and provably wrong** for this space (they file the OCTAVE document protocol under
  "octave" and the software-discount `maple-mcp` under "Maple"). Use them for discovery only; **never** cite their
  tool names as evidence.
- **pulsemcp.com** returns HTTP 403 to non-browser clients (UNVERIFIED coverage). **smithery.ai** surfaced no CAS
  servers.

**Takeaway:** there is no registry-based shortcut to learning the official Maple MCP's surface, and the ecosystem
has not yet registered any Maple CAS server — ours would be the first.

### 2.4 Community and third-party CAS MCP servers — full inventory

There is a **substantial** ecosystem for other CAS/math systems, even though there is none for Maple. The table below
is the survey result (metadata from the GitHub REST API; snapshot 2026-09-21). Full per-project tool schemas are in
§3.4–§3.5.

| Project | URL | Lang | License | ★ | Last commit | CAS interface | # tools | Stateful | Sandboxed |
|---|---|---|---|---|---|---|---|---|---|
| **WolframResearch/AgentTools** (official Wolfram) | <https://github.com/WolframResearch/AgentTools> | Wolfram Language | MIT | 90 | 2026-09-03 | in-kernel WL, stdio **and** cloud HTTP | 3–13 per server | **yes** (`session`) | time/memory constraints; cloud: none |
| **matlab/matlab-mcp-server** (official MathWorks) | <https://github.com/matlab/matlab-mcp-server> | Go | NOASSERTION | 1550 | 2026-09-11 | live MATLAB session | 5 (9 in multi-session) | **yes** | resource limits, telemetry |
| **matlab/mcp-framework-matlab-production-server** (official MathWorks) | <https://github.com/matlab/mcp-framework-matlab-production-server> | MATLAB | BSD-3-Clause | 32 | 2026-09-04 | publishes MATLAB functions as MCP tools | — | server-side | n/a |
| morluto/jacobian | <https://github.com/morluto/jacobian> | Python | MIT | 193 | 2026-09-20 | catalog of atomic ops + backends | **2** (+1 resource) | stateless tools | worker containment, deadlines |
| akalaric/mcp-wolframalpha | <https://github.com/akalaric/mcp-wolframalpha> | Python | MIT | 86 | 2026-01-12 | Wolfram\|Alpha HTTP API | 1 | no | n/a |
| sdiehl/sympy-mcp | <https://github.com/sdiehl/sympy-mcp> | Python | Apache-2.0 | 84 | 2026-03-18 | in-process SymPy (+einsteinpy) | ~36 | **yes** (global keyed state) | no (Docker) |
| SecretiveShell/MCP-wolfram-alpha | <https://github.com/SecretiveShell/MCP-wolfram-alpha> | Python | MIT | 75 | 2025-08-18 | Wolfram\|Alpha HTTP API | 1 (+1 prompt) | no | n/a |
| youngminsw/Origin-Pro-MCP | <https://github.com/youngminsw/Origin-Pro-MCP> | Python | MIT | 41 | 2026-07-11 | OriginLab Origin via Windows COM | 45 | **yes** (GUI docs) | watchdog + autosave + force-kill |
| siqiliu-tsinghua/mma-mcp | <https://github.com/siqiliu-tsinghua/mma-mcp> | Python | MIT | 32 | 2026-08-04 | `wolframclient` kernel pool | 2 | no (pooled) | RBAC + symbol filters + truncation |
| abhiphile/fermat-mcp | <https://github.com/abhiphile/fermat-mcp> | Python | MIT | 20 | 2026-09-19 | in-process SymPy/NumPy/Matplotlib | 4 sympy (+mpl, numpy) | no | no |
| puran-water/mathcad-mcp | <https://github.com/puran-water/mathcad-mcp> | Python | none | 17 | 2025-03-26 | COM automation of MathCAD Prime | **29** (+3 prompts) | **yes** (worksheets) | none (licensed GUI) |
| XBP-Europe/sagemath-mcp | <https://github.com/XBP-Europe/sagemath-mcp> | Python | MIT | 16 | 2026-09-21 | persistent Sage worker per session | **40** | **yes** (workspaces) | AST policy + timeouts + container |
| paraporoco/Wolfram-MCP | <https://github.com/paraporoco/Wolfram-MCP> | Python | MIT | 13 | 2026-02-12 | `wolframscript -c` per call | 11 | no | no |
| LBurny/symkit-mcp | <https://github.com/LBurny/symkit-mcp> | Python | Apache-2.0 | 12 | 2026-09-17 | SymPy + optional Lean-4 certification | ~40 (incl. `session_*`) | **yes** (derivation sessions) | n/a |
| GaloisHLee/mcp-server-sagemath | <https://github.com/GaloisHLee/mcp-server-sagemath> | TypeScript | MIT | 11 | 2025-12-12 | `sage` CLI subprocess | 3 | no | structured stdout/stderr/exit |
| TheGrSun/Desmos-MCP | <https://github.com/TheGrSun/Desmos-MCP> | Python | Apache-2.0 | 9 | 2026-09-10 | Desmos API | 5 (incl. `validate_formula`) | no | n/a |
| drewnix/arithma | <https://github.com/drewnix/arithma> | Rust | MIT | 8 | 2026-07-24 | own Rust CAS | ~17 | no | n/a |
| sanshanjianke/scicompute-mcp | <https://github.com/sanshanjianke/scicompute-mcp> | Python | Unlicense | 5 | 2026-04-16 | long-lived per-backend processes (incl. Maxima, Sage) | 4 | **yes** | none |
| aac6fef/mathematica_mcp | <https://github.com/aac6fef/mathematica_mcp> | Python | none | 3 | 2025-07-25 | `wolframclient` persistent kernel | 3 | **yes** (session ids) | no |
| fmcato/octave-mcp | <https://github.com/fmcato/octave-mcp> | Go | GPL-3.0 | 3 | 2026-04-05 | `octave` CLI per script | 2 | no | blocklist + timeout + concurrency + localhost |
| Eis4TY/Sym-MCP | <https://github.com/Eis4TY/Sym-MCP> | Python | MIT | 2 | 2026-06-09 | in-process SymPy, worker pool | 1 | no | **AST guard + setrlimit + timeouts** |
| toms74209200/mcp-maxima | <https://github.com/toms74209200/mcp-maxima> | TypeScript | MIT | 2 | 2026-07-14 | `maxima --batch-string` per call | 1 | no | no (Docker) |
| szeider/mcp-sage | <https://github.com/szeider/mcp-sage> | Python | MIT | 2 | 2026-08-08 | Jupyter kernel protocol running Sage | 5 | **yes** (kernel) | n/a |
| tufantunc/axiom-advanced-math-mcp | <https://github.com/tufantunc/axiom-advanced-math-mcp> | TypeScript | GPL-3.0 | 2 | 2026-09-14 | Giac/Xcas compiled to **WASM** (no process) | **3** | no | no network |
| daedalus/mcp-parigp | <https://github.com/daedalus/mcp-parigp> | Python | MIT | 1 | 2026-04-21 | `cypari2` in-process | **143** (≈180 per sibling count) | PARI globals only | timeout on `eval_expression` |
| justice8096/sagemath-mcp-server | <https://github.com/justice8096/sagemath-mcp-server> | TypeScript | CC0-1.0 | 1 | 2026-05-18 | `sage` CLI or Docker | 10 | no | n/a |
| TioSavich/geogebra-mcp | <https://github.com/TioSavich/geogebra-mcp> | TypeScript | NOASSERTION | 1 | 2026-05-11 | GeoGebra CAS app | ~30 | **yes** (construction) | n/a |
| LeGenAI/mcp-magma-handbook | <https://github.com/LeGenAI/mcp-magma-handbook> | TypeScript | MIT | 1 | 2025-07-06 | MAGMA handbook **RAG only** (no compute) | 3 | no | n/a |
| gtnoble/maxima-mcp | <https://github.com/gtnoble/maxima-mcp> | D | none | 1 | 2025-05-20 | Maxima batch mode | 1 | no | no |
| **sam-hart-ttp/maxima-mcp** | <https://github.com/sam-hart-ttp/maxima-mcp> | Common Lisp | GPL-2.0-derived (NOASSERTION) | 0 | 2026-05-07 | Maxima core, native Lisp MCP + Claude Code skill | **133** | **yes** | none |
| kamalsaleh/mcp_for_gap | <https://github.com/kamalsaleh/mcp_for_gap> | Python | none | 0 | 2026-01-21 | GAP session; tools **auto-generated from docs** | not fixed | **yes** | n/a |
| vibrate-project/maxima_mcp | <https://github.com/vibrate-project/maxima_mcp> | Common Lisp | Apache-2.0 | 0 | 2026-07-13 | in-Maxima JSON-RPC/HTTP+SSE | 6 | **yes** (named contexts) | localhost bind |

**The single most important observation from this table:** the two *vendor-official* CAS MCP servers
(Wolfram AgentTools, MathWorks MATLAB) both ship a **small** surface built around **code execution against a live,
stateful engine session**, with explicit tool annotations — neither one wraps its CAS's function library as hundreds
of tools. The community projects that do wrap exhaustively (`daedalus/mcp-parigp`; `sam-hart-ttp/maxima-mcp`, 133
tools) demonstrate that it *works*, but the widest one pairs its surface with a **routing skill** precisely because
the model cannot pick correctly from 133 names unaided (§3.8).

**The practical synthesis:** the surface size is a genuine trade-off, not a settled question. Vendor evidence favours
a **small** default surface; the Maple-analogue evidence (Maxima) shows a **wide** surface is viable *if* we also
ship routing guidance. §3.7 therefore proposes a small Tier 1/Tier 2 core plus an explicit decision point about
whether to add a wide operation tier, and if so, to ship a routing document with it.

### 2.5 Third-party commentary on Maple MCP

No substantive third-party analysis of Maple MCP was found (see §4.4). Searches surfaced only Maplesoft's own pages,
mirrors of the Copilot Studio PDF, and SEO/AI-generated stubs. **There is no community reverse-engineering of Maple
MCP's tool surface or architecture available to cite.** Independent sources were actively checked and came up empty:
a Hacker News (Algolia) search for "Maple MCP" / "Maplesoft MCP" returned **no relevant stories**; Reddit's search
JSON endpoint returned **HTTP 403**; MaplePrimes' search page is client-rendered and yielded no extractable threads;
LinkedIn was inaccessible. All of those are **UNVERIFIED** (absence of evidence, not evidence of absence), but the
practical conclusion stands: we cannot learn the official surface from the community.

---

## 3. What a good MCP tool surface for a CAS looks like

### 3.1 The official Wolfram MCP — a live, fully-observable comparator

Maplesoft's tool list is gated, but **Wolfram's official MCP server publishes its tool list to any caller**. This is
the single best available reference for what a vendor considers a correct CAS tool surface. The official registry
entry is `com.wolfram/mcp`, remote `streamable-http` at <https://agenttools.wolfram.com/mcp>
(<https://registry.modelcontextprotocol.io/v0/servers?search=wolfram>).

Live probe of `https://agenttools.wolfram.com/mcp` (2026-09-21, unauthenticated) returned:

- `initialize` → `serverInfo.name = "Wolfram"`, `serverInfo.version = "2026.09.15"`,
  `protocolVersion = "2025-03-26"`, `capabilities.tools.listChanged = true`, and **no `resources` capability**
  (note the contrast with Maple, which advertises `resources` but not `prompts`).
- `tools/list` → **3 tools**, reproduced verbatim below.

**Tool 1 — `WolframContext`** (annotations: `title: "Wolfram Context"`, `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`)

```json
{
  "name": "WolframContext",
  "description": "Uses semantic search to retrieve any relevant information from Wolfram.\nAlways use this tool at the start of new conversations or if the topic changes to ensure you have up-to-date relevant information.\nThis uses semantic search, so the context argument should be written in natural language (not a search query) and contain as much detail as possible (up to 250 words).",
  "inputSchema": {
    "type": "object",
    "properties": {
      "context": {
        "type": "string",
        "description": "A detailed summary of what the user is trying to achieve or learn about."
      }
    },
    "required": ["context"]
  }
}
```

**Tool 2 — `WolframLanguageEvaluator`** (`title: "Wolfram Language Evaluator"`, `readOnlyHint: true`,
`destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`)

```json
{
  "name": "WolframLanguageEvaluator",
  "description": "Evaluates Wolfram Language code for the user in a Wolfram Language kernel.\nIf a formatted result is provided as a markdown link, use that in your response instead of typing out the output.\nParse natural language input with `\\[FreeformPrompt][\"query\"]`, which is analogous to ctrl+= input in notebooks.\nNatural language input is parsed before evaluation, so it works like macro expansion.\nYou should ALWAYS use this natural language input to obtain things like `Quantity`, `DateObject`, `Entity`, etc.\nThis is a stateless kernel, so you cannot reuse definitions from previous evaluations.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "code": { "type": "string", "description": "The Wolfram Language code to evaluate." },
      "timeConstraint": { "type": "number", "description": "The time constraint for the evaluation (default is 60 seconds)." }
    },
    "required": ["code"]
  }
}
```

**Tool 3 — `WolframAlpha`** (`title: "Wolfram|Alpha"`, `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: false`, `openWorldHint: false`)

```json
{
  "name": "WolframAlpha",
  "description": "Use natural language queries with Wolfram|Alpha to get up-to-date computational results about entities in chemistry, physics, geography, history, art, astronomy, and more.",
  "inputSchema": {
    "type": "object",
    "properties": { "query": { "type": "string", "description": "Wolfram Alpha query" } },
    "required": ["query"]
  }
}
```

### 3.2 Official Wolfram AgentTools — the broader, documented official surface

The live `agenttools.wolfram.com` endpoint in §3.1 exposes the **default** server. Wolfram's actual product is the
`Wolfram/AgentTools` paclet (<https://github.com/WolframResearch/AgentTools>), which ships **four predefined servers**
with different tool sets. This matters because it shows a vendor deliberately splitting its surface by task.

| Server | Tools |
|---|---|
| `Wolfram` (the default, = §3.1) | `WolframContext`, `WolframLanguageEvaluator`, `WolframAlpha` |
| `WolframAlpha` | `WolframAlphaContext`, `WolframAlpha` |
| `WolframLanguage` | `WolframLanguageContext`, `WolframLanguageEvaluator`, **`ReadNotebook`**, **`WriteNotebook`**, `SymbolDefinition`, `CodeInspector`, `TestReport` |
| `WolframPacletDevelopment` | the `WolframLanguage` set **plus** `CreateSymbolDoc`, `EditSymbolDoc`, `EditSymbolDocExamples`, `CheckPaclet`, `BuildPaclet`, `SubmitPaclet` |

**This is the key precedent for the worksheet-oriented tools we were considering.** An official vendor CAS MCP server
does expose document tools — but note *which* ones and how they are shaped:

- `ReadNotebook(notebook)` — "Reads the contents of a **Wolfram notebook (.nb)** as **markdown** text."
  Parameter: `notebook` — "the Wolfram notebook to read, specified as a **file path, URL, or a NotebookObject[...]**".
- `WriteNotebook(file, overwrite, markdown)` — "Converts **markdown text** to a Wolfram notebook and saves it to a
  file." `file` must end in `.nb`; missing parent directories are created automatically; `overwrite` is an optional
  boolean. **The content parameter is `markdown`, not a cell array.**

Read that carefully: Wolfram's official approach to "worksheet" support is a **whole-document, file-in/file-out,
markdown-as-the-interchange-format** pair of tools. It is **not** a `create_cell` / `edit_cell` / `run_cell` API.
There is no per-cell addressing, no cell ids, and no "run one cell". That is a strong signal that
**per-cell worksheet editing is not what an official vendor chooses to expose**, and that whole-document
read/write with a text interchange format is the validated, low-risk design. Our §3.6 proposal should follow that
precedent rather than inventing a cell-level API.

Other details worth copying from this repo:

- `WolframLanguageEvaluator` has an **optional `session` parameter**: *"An opaque session ID returned by a previous
  call to this tool. Pass it to continue that conversation's isolated session (its definitions, line numbers, and
  history). Omit it to start a new session; the response returns a new ID that you should reuse on subsequent calls in
  this conversation."* — i.e. session continuation is a **parameter**, not a separate session-CRUD tool set.
- `timeConstraint` — *"The time constraint for the evaluation. Uses the server's configured default if not specified."*
- `SymbolDefinition(symbols, includeContextDetails, maxLength)` — note `maxLength` for **output truncation**
  (default 10000).
- `TestReport(paths, timeConstraint, memoryConstraint, newKernel)` — note both a **time** and a **memory** constraint.
- Deployment: **both stdio-local and cloud.** `"Transport" -> "StandardInputOutput"`, `"Location" -> "BuiltIn"` for
  local (README: *"AgentTools works with any stdio-based MCP client"*, plus a Docker image
  `ghcr.io/wolframresearch/mcpserver:latest`); `CloudDeployMCPServer[...]` for remote. Wolfram's cloud docs state the
  cloud endpoint is **stateless** ("no server-side session store, no persistent kernel between calls") and has
  **"No tool filtering / sandboxing in v1 — access control is the owner's responsibility, mediated entirely by API
  keys."** — <https://github.com/WolframResearch/AgentTools/blob/main/docs/cloud-deployment.md>
- The repo also ships per-client installers (`InstallMCPServer["ClaudeCode"|"Cursor"|"VisualStudioCode"|...]`) and
  MCP **prompts** (`WolframSearch`, `WolframAlphaSearch`, `WolframLanguageSearch`, `Notebook`) and **resources**
  (interactive notebook viewers). So the official Wolfram server uses all three MCP primitives, unlike Maple's
  (tools + resources only).

### 3.3 Official MathWorks MATLAB MCP server — the best "vendor CAS server" template

<https://github.com/matlab/matlab-mcp-server> — Go, 1550★, MathWorks' own, last commit 2026-09-11.

Its shape is a direct, highly credible answer to "what should a vendor's CAS MCP server expose?": **code execution
plus developer tooling around it**, not a catalog of math operations.

| Tool | Purpose | Key params |
|---|---|---|
| `detect_matlab_toolboxes` | Returns installed MATLAB version + toolboxes | *(none)* |
| `check_matlab_code` | Static analysis via MATLAB Code Analyzer; returns structured issues | `script_path` |
| `evaluate_matlab_code` | *"Evaluate a string of MATLAB code (`code`) in an existing MATLAB session."* | `code`, `project_path` (optional cwd) |
| `run_matlab_file` | Execute a `.m` script, capturing command-window output | `script_path` |
| `run_matlab_test_file` | Run a test file via built-in `runtests`, return structured results | `script_path` |

Multi-session mode adds `eval_in_matlab_session`, `list_available_matlabs`, `start_matlab_session`,
`stop_matlab_session` (session ids are integers).

Directly copyable patterns:

1. **`project_path` / working-directory parameter on every execution tool** — the CAS equivalent of a cwd for the
   session. Maple's `currentdir`/`FileTools` state makes this immediately relevant.
2. **A static-analysis tool** (`check_matlab_code`) that does *not* execute code — a cheap, safe, high-value tool.
   A Maple analogue using Maple's `CodeTools` package would be excellent.
3. **A test-runner tool** separate from raw execution.
4. **`WARNING:` inside the tool description** about a command that breaks the integration: *"Do not use
   `restoredefaultpath` as it will remove the MCP server functions from the path and break this tool's ability to
   communicate with MATLAB."* The Maple analogue is `restart` (and `quit`), which would destroy a persistent kernel
   session. **Our tool descriptions should carry the same warning.**
5. **Structured output schemas** for analysis results vs unstructured `RichContent` (text + PNG images) for
   evaluation — "RichContent is used as a tool output, when unstructured content should be used… like images, sound,
   or resources."
6. **Annotations by effect**: read-only for `detect_*`/`check_*`/`list_*`/`start_*`, destructive for all
   code-executing tools.
7. **MCP resources for guidance**: `guidelines://coding` and `guidelines://plain-text-live-code` (both
   `text/markdown`). A Maple server can ship equivalent Maple style-guide resources.
8. Licensing note that generalizes: *"MCP servers are only permitted to be used with MATLAB in accordance with the
   MathWorks Software License Agreement, and must not be shared by multiple users."*

### 3.4 Community CAS MCP surfaces — verbatim tool lists that inform our design

The most instructive community surfaces, with their actual tool names:

- **`XBP-Europe/sagemath-mcp`** (<https://github.com/XBP-Europe/sagemath-mcp>, MIT, 40 tools) — the most complete
  community template. `evaluate_sage(code, want_latex, capture_stdout, timeout_seconds, session)` is the core;
  `session` is threaded through **every** computational tool with the description *"Workspace to use, as a name or a
  portable handle. Workspaces have independent variables…"*. Session lifecycle tools: `start_sage_session`,
  `list_sage_sessions`, `stop_sage_session`, `reset_sage_session`, `interrupt_sage_session` (keeps state),
  `cancel_sage_session` (discards state). Diagnostics: `check_sage_health`, `lookup_sage_doc`.
  **Most valuable single idea: `verify_claim(claim, samples, precision_bits)`** — *"Independently re-check a stated
  mathematical claim and report how far the evidence goes: proved, refuted, supported or undecided… 'undecided' means
  every rung was inconclusive -- it never means false."* This is directly transferable to Maple's native
  `verify`/`is`, and it is a genuinely differentiating tool. Its own benchmark file
  (`tool-surface-stats.md`) reports that the **full 40-tool catalogue performed *worse* than a core-only set on some
  clients** — an honest warning against surface bloat.
- **`sdiehl/sympy-mcp`** (<https://github.com/sdiehl/sympy-mcp>, Apache-2.0, ~36 tools) — the best example of the
  **"introduce → operate on a key"** protocol: `intro` / `intro_many` / `introduce_expression(expr_str,
  canonicalize, expr_var_name)` create keyed handles (`expr_0`, `expr_1`, …), then
  `integrate_expression(expr_key, var_name, lower_bound, upper_bound)`, `differentiate_expression(expr_key,
  var_name, order)`, `solve_algebraically(expr_key, solve_for_var_name, domain)`, `simplify_expression(expr_key)`,
  `create_matrix`, `matrix_determinant`, … and `print_latex_expression(expr_key)` / `print_latex_tensor(tensor_key)`
  to render. `reset_state()` clears everything. **Conflict with sagemath-mcp naming:** these are **unprefixed**
  (`integrate_expression`, `matrix_operation`) and would collide if two math servers are installed together.
  Caveat to avoid: its keyed state is **process-global**, so all clients share one namespace, and there are **no
  timeouts or resource limits**.
- **`Eis4TY/Sym-MCP`** (<https://github.com/Eis4TY/Sym-MCP>, MIT, **1** tool) — best **error contract**:
  `{code, line, err, hint}` with a fixed error-code enum (`E_AST_BLOCK`, `E_SYNTAX`, `E_TIMEOUT`, `E_MEMORY`,
  `E_RUNTIME`, `E_WORKER`, `E_INTERNAL`), output truncation (`SYMMCP_MAX_OUTPUT_CHARS=1200`), and real limits
  (`SYMMCP_EXEC_TIMEOUT_SEC=3`, `SYMMCP_MEMORY_LIMIT_MB=150` via `setrlimit`, worker auto-rebuild). Its README is
  honest that this is *"restricted Python execution, not VM/container-grade isolation."*
- **`morluto/jacobian`** (<https://github.com/morluto/jacobian>, MIT, 193★, **2** tools + 1 resource) — the
  **discovery-vs-execution** pattern: `math.find(query|operation_id, namespace, limit, cursor, search_mode)` to
  search/inspect a catalog, then `math.run(operation_id, payload)` to execute. Registered with explicit names
  containing a **dot** (`math.find`, `math.run`) and explicit `ToolAnnotations`. Its error doctrine is the best
  statement anywhere of a rule a CAS server must obey: **"Timeout, cancellation, configured worker or host capacity
  exhaustion, backend failure, and delivery failure… must not be interpreted as `False`, `UNSAT`, absence of a
  witness, or completeness of a partial search."**
- **`puran-water/mathcad-mcp`** (<https://github.com/puran-water/mathcad-mcp>, no license, 17★, 29 tools) — the only
  surveyed server that treats **live worksheets as the session state** (a `worksheets` dict keyed by name inside a
  FastMCP `lifespan_context`). Tool names are the most direct precedent for a document-centric Maple surface:
  `open_worksheet(path)`, `close_worksheet(worksheet_name, save_option)`, `save_worksheet(worksheet_name, path,
  format='mcdx')` (formats `mcdx`/`pdf`/`rtf`/`xps`), `save_worksheet_inplace`, `activate_worksheet`,
  `set_real_input(worksheet_name, input_name, value, units)`, `set_string_input`, `set_matrix_input`,
  `get_input`, `get_matrix_input`, `calculate_worksheet(worksheet_name)`, `sync_worksheet`,
  `pause_calculation`, `resume_calculation`, `get_output`, `get_real_output`,
  `get_real_output_with_units`, `get_matrix_output`, `get_matrix_output_with_units`, `save_as_pdf`,
  `save_as_rtf`, `save_as_xps`, `is_worksheet_readonly`, `is_worksheet_modified`,
  `set_worksheet_modified(state)`, `list_mathcad_version`, `close_all_worksheets`, `quit_mathcad`.
  **Note the model: named inputs/outputs, recalculate, export — not cell-level editing.** It is also the closest
  analogue to Maple *if* we target `.mw` documents. Caveat: it requires a licensed GUI application and COM
  automation, and has no sandbox or timeouts.
- **`fmcato/octave-mcp`** (<https://github.com/fmcato/octave-mcp>, GPL-3.0, 2 tools) — the best **operational safety
  envelope** for a shell-out CAS server: `run_octave(script)` and `generate_plot(script, format)` (svg/png →
  `ImageContent`), with a validation blocklist, `getVersion` folded into the tool description, and env-configured
  `OCTAVE_SCRIPT_TIMEOUT` (default 10 s), `OCTAVE_CONCURRENCY_LIMIT` (default 10),
  `OCTAVE_SCRIPT_LENGTH_LIMIT` (default 10000 chars), localhost-only binding, `Origin` checks, CSP/`nosniff`/
  `X-Frame-Options: DENY` headers, per-plot temp dirs cleaned up, and `--no-*` opt-in for non-localhost. Worth
  copying wholesale. Its substring blocklist (`"load("`, `"&&"`, `` "`" ``) is the weak part — it both over- and
  under-blocks; prefer running Maple with restricted access at the OS level.
- **`sanshanjianke/scicompute-mcp`** (<https://github.com/sanshanjianke/scicompute-mcp>, Unlicense, 4 tools) — the
  **multi-backend** pattern with a `doc` tool that returns official documentation URLs per backend and symbol, a
  `stop` tool that *"Stop backend to clear variables and free memory… The backend will restart automatically when
  needed"*, and `list_backends`. Persistent per-backend processes.
- **`daedalus/mcp-parigp`** (<https://github.com/daedalus/mcp-parigp>, MIT, **143** tools) — the **anti-pattern**:
  one thin wrapper per CAS primitive (`factor`, `isprime`, `gcd`, `ellinit`, `bnrL1`, …) with one-line descriptions
  and no guidance on which to choose, plus `Any`-typed parameters that carry no schema. Its useful bit is an explicit
  precision/state control group (`set_real_precision`, `stacksize`, `allocatemem`) and a timeouted general escape
  hatch `eval_expression(expr, timeout=60)`.

### 3.5 Official MCP specification guidance on tool definitions

From <https://modelcontextprotocol.io/specification/2025-06-18/server/tools> (and the 2025-11-25 revision):

- **Tool names** *"SHOULD be between 1 and 128 characters in length"*, case-sensitive, *"the only allowed characters:
  uppercase and lowercase ASCII letters (A-Z, a-z), digits (0-9), underscore (_), hyphen (-), and dot (.)"*;
  *"SHOULD NOT contain spaces, commas, or other special characters"*; *"SHOULD be unique within a server."*
  → **`maple_evaluate_code` and `maple.evaluate_code` are both conformant; `evaluate maple code` is not.**
- **`inputSchema`** *"MUST be a valid JSON Schema object (not `null`)"*, JSON Schema 2020-12 by default. For a
  no-parameter tool use `{ "type": "object", "additionalProperties": false }`.
- **Two error channels**: protocol errors (JSON-RPC `error`, e.g. `-32602 Unknown tool`) vs **tool-execution errors**
  (`result.isError: true` with actionable text). *"Clients SHOULD provide tool execution errors to language models to
  enable self-correction."* → For Maple, a Maple syntax error must be `isError: true` with the Maple diagnostic text,
  **not** a JSON-RPC error.
- **Structured output**: tools may declare `outputSchema`; *"Servers MUST provide structured results that conform to
  this schema"*, and should also mirror the JSON in a `TextContent` block for back-compat.
- **Annotations**: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Clients *"MUST consider tool
  annotations to be untrusted unless they come from trusted servers."*
- **Security obligations**: validate all tool inputs, implement access controls, rate limit invocations, sanitize
  outputs, and *"there SHOULD always be a human in the loop with the ability to deny tool invocations."*

### 3.6 Design lessons to copy from the vendor surfaces

These are concrete, actionable, and directly evidenced:

1. **A CAS MCP surface can be tiny.** Wolfram ships exactly **three** tools. The core is a *single* code-evaluation
   tool. Do not over-engineer a large tool zoo.
2. **The evaluator is a thin, honest "run this code" primitive** — one required `code: string` plus one optional
   numeric guardrail (`timeConstraint`). The model is trusted to write the CAS language; the server does not try to
   model "solve", "integrate", "plot" as separate tools.
3. **Always attach a hard time limit with a documented default** (`default is 60 seconds`). For Maple, `timelimit`
   and/or a `cmaple` subprocess kill is the analogue.
4. **Declare kernel statefulness explicitly in the description.** Wolfram: *"This is a stateless kernel, so you
   cannot reuse definitions from previous evaluations."* For a local Maple session we must decide and document the
   opposite (persistent session) or the same (fresh engine per call) — and say so in the tool description, because
   the model's multi-step behaviour depends on it.
5. **Use MCP tool annotations**: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
   Wolfram sets `readOnlyHint: true` for pure evaluation. We should mark evaluation `readOnlyHint: true` (a fresh
   subprocess is non-destructive) but `destructiveHint: true` for any tool that edits or overwrites a worksheet file.
6. **A "context/knowledge" tool is a real, useful extra** (`WolframContext`): a semantic-search tool that primes the
   model with system-appropriate knowledge. A Maple analogue is a **help/documentation lookup** tool
   (e.g. wrapping Maple's `?topic` help or the Maple Programming Guide) — cheap to build and high value, and it does
   not require touching the CAS engine.
7. **Return formatted results as links/markdown where possible** — the description explicitly tells the model to
   prefer a provided formatted result over re-typing output. For Maple this maps to returning **MathML or LaTeX**
   rather than ASCII 2-D output.
8. **Vendor CAS MCP servers offer *both* cloud HTTP and local stdio — but Maplesoft offers only cloud.**
   - **Wolfram** ships both from one codebase: a **local stdio** server
     (`"Transport" -> "StandardInputOutput"`, `"Location" -> "BuiltIn"`; README: *"AgentTools works with any
     stdio-based MCP client"*, plus a Docker image) **and** a cloud Streamable-HTTP deployment
     (`CloudDeployMCPServer[...]`). Its live cloud endpoint is `https://agenttools.wolfram.com/mcp`.
   - **Maplesoft** ships **only** the cloud endpoint `https://cloud-api.maplenet.cloud/api/v2/mcp`
     — no stdio mode, no local server, no downloadable component (§1.2).
   - **This is the clearest strategic gap for us.** Our local server occupies the position Maplesoft left empty:
     **stdio is our advantage** (no API key, no data egress, works offline, works with any Maple version that exists
     locally). Wolfram's dual deployment also proves the pattern is viable and vendor-acceptable.
   - Wolfram's cloud docs are a caution worth heeding: the cloud variant is **stateless** ("no server-side session
     store, no persistent kernel between calls") and has **"No tool filtering / sandboxing in v1 — access control is
     the owner's responsibility, mediated entirely by API keys."** A local stdio server with a **persistent** engine
     session is therefore strictly more capable, not merely more private.

### 3.7 The Maple-side tool surface we should design (proposal)

Because the official Maple tool list is **unknown** (§1.9), this is a *proposal* derived from the vendor and community
surfaces above — **not** a copy of anything Maple ships. It deliberately starts minimal. The `maple_` prefix is
recommended because both the MCP spec (§3.5) allows it and unprefixed names like `matrix_operation` would collide
with the SymPy/Sage servers in §3.4.

**Tier 1 — core (build these first):**

| Tool (proposed) | Purpose | Key params | Modelled on |
|---|---|---|---|
| `maple_evaluate_code` | Run Maple language code in a persistent session; return results | `code: string` (required), `timeout_seconds: number` (optional), `session: string` (optional) | `WolframLanguageEvaluator`, `evaluate_sage` |
| `maple_check_code` | **Static analysis without executing** — CodeTools-style lint, returns structured issues | `code: string` or `path: string` | MathWorks `check_matlab_code` |
| `maple_help` | Look up documentation for a Maple command/topic | `topic: string` | `WolframContext`, scicompute `doc` |
| `maple_health` | Probe that evaluation works; report Maple version + latency | *(none)* | sagemath `check_sage_health` |

**Tier 2 — session and output quality:**

| Tool (proposed) | Purpose | Key params | Modelled on |
|---|---|---|---|
| `maple_verify` | Independently re-check a claim; report proved / refuted / supported / undecided | `claim: string`, `precision_bits: number` | sagemath `verify_claim` (maps to Maple's native `verify`/`is`); axiom `verify` |
| `maple_validate_code` | Normalize/parse code and return actionable syntax errors **without executing** | `code: string` | Desmos `validate_formula` |
| `maple_start_session` / `maple_list_sessions` / `maple_stop_session` | Named workspaces with independent variable state | `name: string` | sagemath session group; MathWorks multi-session |
| `maple_reset_session` / `maple_interrupt_session` / `maple_cancel_session` | Clear state / interrupt but keep state / discard state | `session: string` | sagemath `reset`/`interrupt`/`cancel` |
| `maple_to_latex` | Convert an expression/result to LaTeX or MathML | `expression: string` | sdiehl `print_latex_expression` |
| `maple_plot` | Render a plot and return image content | `expression`, `format` (png/svg), `width`, `height` | octave `generate_plot`; MapleNet `PlotOptions` (§4.2) |

**Tier 2b — an explicit decision point: wide operation tier, or not?**

The evidence cuts both ways (§2.4). Vendor-official servers stay small; the most Maple-analogous community project
(`sam-hart-ttp/maxima-mcp`) ships 133 operation tools. **If** we add a wide tier of `maple_*` operation tools
(`maple_solve`, `maple_dsolve`, `maple_int`, `maple_simplify`, `maple_limit`, `maple_laplace`, …), then per that
project's evidence we **must also ship a routing document/agent skill** mapping problem type → preferred tool, with an
explicit "prefer the dedicated tool over `maple_evaluate_code`" instruction. Without routing guidance a wide surface
measurably degrades tool selection. Our recommendation: **start with Tiers 1–2 only, measure, and add a wide tier
plus routing skill only if the generic evaluator proves insufficient.**

**Also encode an honest result status** (from `drewnix/arithma`'s taxonomy): every evaluation result should carry a
machine-readable status such as `exact` / `approximate` / `unevaluated` / `no_closed_form` / `error` / `timeout`,
alongside any Maple warning text. This is what prevents the model from reporting "Maple returned `int(...)` unchanged"
as if it were an answer, and it is the concrete answer to Maplesoft's own admission that MCP improves calculation but
not *repeatability* (§4.4).

**Tier 3 — document/worksheet tools (adopt the *document-level* pattern, not a cell API):**

| Tool (proposed) | Purpose | Key params | Modelled on |
|---|---|---|---|
| `maple_read_document` | Read a Maple document/worksheet as **markdown/text** | `path: string` | Wolfram `ReadNotebook` |
| `maple_write_document` | Write markdown/text out as a Maple document | `path: string`, `markdown: string`, `overwrite: bool` | Wolfram `WriteNotebook` |
| `maple_run_document` | Evaluate a document and return the results | `path: string` | MathWorks `run_matlab_file` |
| `maple_export_document` | Export to PDF / LaTeX / other formats | `path`, `output_path`, `format` | mathcad `save_as_pdf`/`save_as_rtf`/`save_as_xps` |

**Why the document tools are document-level, not cell-level.** This is the single most important correction that the
prior art forces on our design. The two vendors that actually ship document support — Wolfram (`ReadNotebook` /
`WriteNotebook`) and MathCAD (`open_worksheet` / `set_*_input` / `calculate_worksheet` / `get_*_output` /
`save_as_pdf`) — both expose **whole-document operations with a text interchange format**, not `create_cell` /
`edit_cell` / `run_cell`. Wolfram's content parameter is literally named `markdown`. **We should not invent a
per-cell editing API**; it has no precedent, and it multiplies the surface for little gain. If our local Maple
interface turns out not to support document manipulation well, Tier 3 can be dropped entirely without touching
Tiers 1–2.

**Still UNVERIFIED:** whether Maple 2018/2022 exposes a workable programmatic interface for creating/reading
documents and worksheets, and whether markdown→Maple-document conversion is feasible. §5 covers the candidate
interfaces. Until that is confirmed, treat Tier 3 as aspirational.

**Also copy these cross-cutting policies (all evidenced above):**

- **`isError: true` for Maple errors, never a JSON-RPC error** (MCP spec, §3.5), and never let a timeout look like a
  mathematical answer (jacobian's rule). Maple's `error`/`warning` output should be faithfully surfaced.
- **Hard timeouts with a documented default**, plus a memory constraint where available (Wolfram's
  `timeConstraint` + `TestReport`'s `memoryConstraint`; Sym-MCP's `setrlimit`).
- **Output truncation with an explicit marker** — Wolfram's `maxLength` (10000), Sym-MCP's `SYMMCP_MAX_OUTPUT_CHARS`
  (1200). Maple symbolic output can be enormous; this is mandatory.
- **`WARNING:` in the description for session-killing commands.** MathWorks warns about `restoredefaultpath`; for
  Maple the equivalents are `restart`, `quit`, and reassigning built-in names — a persistent session must warn about
  these.
- **A `project_path`/working-directory parameter** on execution and document tools (MathWorks' pattern; maps to
  Maple's `currentdir`/`FileTools`).
- **Guard arbitrary-precision integers against the JSON-double trap.** JSON numbers are IEEE doubles in many
  clients, so a 30-digit integer is silently rounded before it reaches us. `sagemath-mcp` handles this by accepting
  `int | str` and documenting the rule verbatim: *"Pass values above 2^53 as a decimal STRING: JSON numbers are IEEE
  doubles in JavaScript-based clients, so 10^30 arrives as 1000000000000000019884624838656 and the answer is
  silently wrong."* Maple's bignums make this a real correctness bug, not a theoretical one.
- **Avoid the wide-flat-parameter-bag anti-pattern.** `fermat-mcp` collapses a domain into one tool with an
  `operation` discriminator (`algebra_operation`, `calculus_operation`, …), which keeps the count at 4 — but
  `algebra_operation` carries **18** parameters, most irrelevant to any given operation. Prefer either a narrow
  per-tool schema or a single general evaluator; do not mix them into one wide signature.
- **Annotations by effect** — read-only for `check`/`help`/`health`/`read`, destructive for anything that writes or
  executes.
- **Be honest about what input filtering can and cannot do.** The best formulation in the survey is
  `sagemath-mcp`'s: the policy is *"defence in depth against accidents, not a boundary against adversarial code; the
  container is the boundary."* A Maple evaluator executes arbitrary Maple, which can read/write files, run
  `system()`/`ssystem()`, and open sockets. Substring blocklists (as in `octave-mcp`) both over- and under-block.
  Propose running Maple under an OS-level restriction (separate user, container, or sandbox profile) and say so in
  the docs, rather than promising safety from a keyword list.
- **stdio transport** for the local server (§3.6 item 8), with the API-key/query-parameter mistake of the official
  Maple MCP avoided entirely.

### 3.8 Additional high-value surfaces: routing, gateways and evidence taxonomies

Four more community projects carry ideas that are worth copying and are not covered above.

**(a) `sam-hart-ttp/maxima-mcp` — 133 tools *plus* a routing skill. The closest analogue to Maple.**
<https://github.com/sam-hart-ttp/maxima-mcp> (Common Lisp, forks the Maxima tree, default branch `mcp`, 2026-05-07).
Maxima and Maple are both large, flat, function-oriented CAS kernels, so this 133-tool surface maps almost 1:1 onto
Maple: `solve`, `solve_linear`, `solve_rec`, `ode2`, `desolve`, `laplace`, `ilt`, `fourier`, `integrate`,
`differentiate`, `limit`, `taylor`, `factor`, `expand`, `simplify`, `ratsimp`, `partfrac`, `matrix_multiply`,
`determinant`, `eigenvalues`, `eigenvectors`, `rank`, `nullspace`, `transpose`, `plot2d`, `plot3d`, `implicit_plot`,
`find_root`, `newton`, `quad_qags`, `sum`, `product`, `gcd`, `binomial`, `isprime`-style predicates, plus state
controls `assume`, `facts`, `forget`, `list_assumptions`, `kill`, `reset`, `set_format`, `get_value`, and a generic
`evaluate`/`ev` escape hatch.

Two things make this the single most instructive artifact in the survey:

1. It shows that a **wide, per-operation CAS surface is viable** — and that it needs exactly the normalization
   Maple would need (its names are inconsistent: `evaluate` vs `evenp` vs `set_format` vs `get_value`).
2. **It ships a Claude Code routing plugin** named `mcp-math`
   (`.claude-plugin/plugin.json` → `{"name":"mcp-math","description":"Routes mathematics tasks to the maxima-mcp CAS
   tools"}`) whose `skills/math/SKILL.md` is a **routing table mapping problem type → tool**, with the instruction
   *"Always prefer dedicated tools over `evaluate`."* **This is the missing piece for any wide Maple surface**: if we
   expose many `maple_*` operation tools, we should also ship an agent skill/routing document that tells the model
   which one to reach for, otherwise the model defaults to the generic evaluator or picks wrong.

**(b) `tufantunc/axiom-advanced-math-mcp` — the `compute` / `verify` / `plot` triad.**
<https://github.com/tufantunc/axiom-advanced-math-mcp> (TypeScript, GPL-3.0, 2026-09-14). Giac/Xcas compiled to
WebAssembly, so no external process. Exactly **3 tools**: `compute` (a single gateway that parses CAS-style strings
such as `solve(...)`, `diff(...)`, `det([[...]])` and routes internally), `verify` (independently re-checks a claim
symbolically/numerically), and `plot` (SVG out). **This is the most compact high-coverage shape found**, and it is a
strong alternative to both the single-evaluator and the 133-tool extremes. `verify` is the differentiating idea: it
re-derives rather than trusting the first answer, which for Maple maps onto `odetest`, `simplify`, `is`/`verify`, and
substitution-based checks.

**(c) `drewnix/arithma` — the best evidence taxonomy for honest CAS results.**
<https://github.com/drewnix/arithma> (Rust, MIT, 2026-07-24). Tools include `simplify`, `differentiate`, `integrate`,
`solve`, `solve_system`, `factor`, `partial_fractions`, `limit`, `taylor_series`, `equivalent`, `verify`,
`verify_chain`, `solve_ode`, plus explicit assumption controls. Its decisive contribution is a **result-status
vocabulary**: `exact` / `verified` / `approximate` / `heuristic` / `unable_to_compute` / `provably_impossible`,
carried alongside `error_bound`, `significant_digits`, and a machine-readable `verdict` of
`pass` / `fail` / `inconclusive`. **A CAS must not let the model conflate "no closed form exists" with "the tool
failed"** — Maple can genuinely prove non-elementarity (e.g. via `int`/`dsolve` returning unevaluated forms or
`verify` returning `FAIL`), and encoding that distinction is a cheap, high-credibility differentiator. This pairs
directly with the sagemath `verify_claim` ladder (§3.4) and jacobian's timeout rule (§3.4).

**(d) Two supporting patterns worth taking.**
- **MVP triad with structured output:** `GaloisHLee/mcp-server-sagemath`
  (<https://github.com/GaloisHLee/mcp-server-sagemath>, MIT) ships exactly `sagemath_version`,
  `sagemath_evaluate`, `sagemath_health` and returns `structuredContent` with
  `stdout` / `stderr` / `exitCode` / `durationMs` / `timedOut`. That is a clean, minimal target for Maple's
  subprocess bridge — note it separates **stdout, stderr and exit code**, which a `cmaple`-based bridge needs.
- **Raw passthrough + convenience wrappers:** `TioSavich/geogebra-mcp`
  (<https://github.com/TioSavich/geogebra-mcp>) exposes `cas_eval` (raw engine command) alongside typed wrappers
  (`solve`, `factor`, `simplify`, `derivative`, `integral`). Applied to Maple this gives
  `maple_evaluate_code` as the passthrough and a small layer of named tools on top — both, rather than either.
- **Input hygiene:** `TheGrSun/Desmos-MCP` (<https://github.com/TheGrSun/Desmos-MCP>) ships `validate_formula`,
  which normalizes input and returns actionable syntax guidance **before** the engine is called. A
  `maple_validate_code` tool could catch unbalanced parentheses/brackets and common Maple/Python syntax confusion
  cheaply.
- **Documentation companion:** `LeGenAI/mcp-magma-handbook`
  (<https://github.com/LeGenAI/mcp-magma-handbook>) is a RAG server over the MAGMA handbook —
  `search_magma` / `get_magma_example` / `explain_magma_code` — and does **not** execute MAGMA. It is the right model
  for a Maple help/context tool that does not touch the engine (§3.7, Tier 1).
- **Auto-generated tool surfaces (use with caution):** `kamalsaleh/mcp_for_gap`
  (<https://github.com/kamalsaleh/mcp_for_gap>) generates its MCP tools by **scraping installed GAP package
  documentation**, so its tool set is not fixed. Clever, and directly applicable to Maple's help database, but
  **non-deterministic tool surfaces are a liability** for a production server (caching, evals, client re-approval).

### 3.9 Security hardening for GUI/desktop-CAS bridges (relevant if we add document tools)

If Tier 3 (document/worksheet) tools are built by driving a real Maple GUI rather than the CLI, the closest
hardening reference is `youngminsw/Origin-Pro-MCP` (<https://github.com/youngminsw/Origin-Pro-MCP>, MIT, 41★, 45
tools driving OriginLab Origin over Windows COM). Its operational patterns address failure modes **identical** to
Maple's: a **modal-dialog watchdog** (a blocking dialog hangs the bridge), **autosave before any destructive
operation**, a **force-kill grace timer**, and **session detach/sweep** to avoid orphaned GUI processes. Also relevant:
`puran-water/mathcad-mcp` (§3.4) for the worksheet object model, and the `puran-water` prompts
(`solve_equation`, `plot_function`, `analyze_engineering_problem`) as an example of shipping MCP **prompts** alongside
tools. We should decide deliberately whether to ship prompts; the official Maple server advertises no `prompts`
capability (§1.5).

---

## 4. Maple MCP internal architecture: what is actually known

### 4.1 What is confirmed

| Aspect | Finding | Source |
|---|---|---|
| Deployment | Cloud, AWS API Gateway/Lambda behind CloudFront | Live response headers (`x-amzn-*`, `x-cache: Miss from cloudfront`) |
| Compute engine advertised | `serverInfo.version = "2026.1"` → Maple 2026 | Live `initialize` |
| Transport | MCP Streamable HTTP, `protocolVersion 2025-06-18`, session id header | Live probe |
| Capabilities | `tools` + `resources`; no `prompts` | Live `initialize` |
| Auth | API key as `auth` query parameter | Copilot Studio PDF |
| A parallel REST API exists | `/api/v2/status` reports `mcp_posts` **and** `api_posts`; `/api/v2/compute` and `/api/v2/index` are real authenticated endpoints | Live probe |

### 4.2 Does it embed OpenMaple? Does it shell out to `maple`/`cmaple`?

**Neither is confirmed, and neither is likely for the cloud product.**

- The service hostname is **`cloud-api.maplenet.cloud`** — i.e. it is built on **MapleNet**, Maplesoft's
  server-side Maple compute product (<https://www.maplesoft.com/products/maplenet/index_aca.aspx>). For a cloud
  service, the engine is whatever Maplesoft runs server-side; the client never touches OpenMaple or a CLI.
- The documented **MapleNet Compute Engine API** is the closest public description of that server-side engine, and
  it is a strong architectural analogue. Key details, verbatim from
  <https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf> (© Maplesoft 2019):
  - Wire format is **Google Protocol Buffers**, not JSON.
  - `Request { repeated Command commands; optional Session session; optional PlotOptions plot_options; optional OutputOptions output_options; }`
  - `Command { oneof command { string maple = 1; } }` — i.e. **the request body is literally Maple source text**.
  - `Session { optional string id; optional uint32 timeout; }` — **explicit session identity and a timeout**.
  - `OutputOptions.Type { TEXT = 0; MATHML = 1; }` — output is returned as **plain text or MathML**.
  - `PlotOptions { Type { IMAGE; PROTOBUFFER; }; pixel_width; pixel_height; }` — plots returned as **GIF bytes** or a
    structured plot buffer.
  - The reply is an **event stream** of typed events: `result` (text/mathml), `printf`, `pretty_print`, `lprint`,
    `error`, `warning`, `server_error`, `image_plot`, `plot`.
  - Statements are parsed from the command string and scheduled **"on an idle engine from a pool of available Maple
    compute engines."**
  - A reference Python client POSTs protobuf to `/maplenet/mnserver/mcs/`.

  **INFERENCE (clearly marked, not confirmed):** the Maple MCP server most plausibly wraps a MapleNet-style
  compute backend — an engine pool, per-session id, a timeout, Maple-source-in, typed-events-out, MathML and image
  plots as the rich output channels. This is consistent with every observation in §4.1 (version 2026.1, session id,
  separate `compute` endpoint, `resources` capability for returning artifacts). **Maplesoft has not stated this.**

### 4.3 Session state, sandboxing, resource limits, security

- **Session state:** MCP-level sessions definitely exist (`mcp-session-id`). Whether Maple *definitions* persist
  across calls within a session is **UNVERIFIED** — note that Wolfram explicitly chose a *stateless* kernel, so we
  cannot infer Maplesoft's choice from the protocol alone. The MapleNet doc's `Session{id, timeout}` supports either
  model (an engine can be pinned to a session and still be reset).
- **Resource limits:** the only documented timeout knob anywhere in Maplesoft's material is the MapleNet
  `Session.timeout` field (<https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf>).
  Concrete wall-clock/CPU/memory limits for Maple MCP are **UNVERIFIED**.
- **Sandboxing:** Maplesoft makes **no public statement** about sandboxing, filesystem isolation, or network egress
  of the Maple engines behind Maple MCP. **UNVERIFIED.** The marketing claim *"Your data stays within your environment"*
  applies only to the **enterprise/on-premises** offering, not to the standard cloud MCP
  (<https://www.maplesoft.com/products/maplemcp/index.aspx>). For the standard offering, prompts and code are sent to
  Maplesoft's cloud — a genuine data-governance consideration, and a strong argument for our local server.
- **Security note:** a bearer credential transmitted as a **query parameter** is weaker than a header or a stdio
  transport (URLs land in logs). Recorded as a design observation about the official product, not a vulnerability
  claim.

### 4.4 Third-party / community information on the architecture

No substantive independent analysis of Maple MCP's internals was found. Searches for third-party commentary
(MaplePrimes threads, blog posts, registry write-ups) surfaced only Maplesoft's own pages, the Copilot Studio PDF
mirrors, and SEO/AI-generated stubs (e.g. the LobeHub page in §1.9, whose source repo turned out to be a
software-discount service — see §2.2). Independent channels were checked and came up empty: a Hacker News (Algolia)
search found no relevant stories; Reddit's search JSON returned HTTP 403; MaplePrimes' search page is client-rendered;
LinkedIn was inaccessible. **There is no community reverse-engineering of Maple MCP's tool surface or architecture
available to cite.**

**The one substantive architectural statement from Maplesoft itself** (third-party venue, vendor-authored — *not* an
independent review): the **ICMS 2026** conference programme,
<https://icms-conference.org/2026/session10.html>, lists a Maplesoft talk *"How Maple is Using AI to Boost
Productivity"* by **Paul DeMarco** (the same author as the Copilot Studio PDF), whose abstract says:

> *"Using MCP the AI can be taught to call a 'tool', like Maple, when it needs to make a calculation. **While this
> improves the calculation ability exhibited in an AI response, it doesn't necessarily help with reasoning and
> repeatability.** We will explore how a user can interact with a LLM, having back-and-forth dialogue in order to
> access features that help lessen the learning curve towards generating usable code and visualizations."*

That is a notable admission from the vendor: **MCP improves calculation correctness but does not fix reasoning or
reproducibility.** It is a useful framing for our own tool descriptions — a CAS MCP should make results *verifiable
and repeatable* (deterministic re-evaluation, explicit assumptions, returned Maple source alongside results), not
merely more accurate. It also suggests Maplesoft's own emphasis is on **code generation and visualization**, which
matches the capability areas in §1.9 and the Tier-1/Tier-2 shape proposed in §3.7.

Anything beyond §4.1 plus this statement would be speculation.

---

## 5. Non-MCP integrations that solve the same problem

*(§5.1–§5.2 and §5.4 are from this researcher's own primary-source work; §5.3 integrates the parallel research
track that ran in this same worktree.)*

### 5.1 OpenMaple for Python — an **official Maplesoft** repo, but Maple 2023+ only (README: 2024+)

This is the single most important non-MCP finding, and it comes with a hard version constraint.

- **URL:** <https://github.com/Maplesoft/openmaple> — "OpenMaple API for Python". Owner is **Maplesoft itself**,
  and it is the **only** public repository in Maplesoft's GitHub organization
  (<https://github.com/orgs/Maplesoft/repositories>).
- **License:** MIT (`LICENSE.txt`). **`pyproject.toml`:** project name `OpenMaple`, version `1.0`, author/maintainer
  **Stephen Forrest `<sforrest@maplesoft.com>`**, `requires-python = ">=3.11"`, dependency `numpy >= 1.23`,
  build backend `hatchling`.
- **Version requirement — verbatim from the README:** *"OpenMaple for Python requires an installation of **Maple 2024
  or later** on the same machine."*
  → **It therefore does NOT support Maple 2018 or Maple 2022.** This is a decisive constraint: the official Python
  binding cannot be used for our target versions.
- **How it reaches Maple:** `ctypes` loading of the OpenMaple C library. From `maplesoft/maple/maplec_ctypes.py` and
  `Session.py`: it locates `libmaplec.so` (Linux) / `maplec.dll` (Windows) / `libmaplec.dylib` (macOS), then calls
  `StartMaple(0, sm_argv, callbacks, 0, 0, errorBuf)` and `StopMaple(kv)`. Evaluation is
  `EvalMapleStatement(kv, bytes(s, 'utf-8'))` and `EvalMapleProcedure(...)`; values are converted with
  `MapleToString`, `MapleToInteger64`, `MapleToFloat64`, `IsMaple*` predicates, etc.
- **Configuration:** set `MAPLE` to the Maple installation root (`C:\Program Files\Maple 2024`,
  `/Library/Frameworks/Maple.framework/Versions/2024`), or set the platform library path to the `bin.*` directory
  (`PATH`, `LD_LIBRARY_PATH` → `/opt/maple2024/bin.X86_64_LINUX`, `DYLD_LIBRARY_PATH`). The code also honours a
  `PYTHONMAPLE` variable first, then `MAPLE`, then the platform library-path variable. A copy is shipped inside Maple
  at `Python.*/lib` (e.g. `C:\Program Files\Maple 2024\Python.X86_64_WINDOWS\lib`).
- **Session model: persistent and stateful.** `__init__.py` creates a module-global `_activesession = Session()` and
  exposes `getactive()` / `setactive(sess)` / `eval()` / `execute(a)` / `range()` / `symbol()` / `symbols()`. A
  `Session` starts one Maple engine and keeps it alive until `__del__` calls `StopMaple` — i.e. **variables persist
  across calls**, exactly the semantics we want. `Session.execute(s)` is the raw "evaluate this Maple statement"
  entry point.
- **Rich Python↔Maple marshalling** (`Session._wrap` / `_unwrap`, `exportto.py`, `importfrom.py`): ints (with a
  64-bit fast path and big-int fallback via `MapleALGEB_SPrintf1`), `fractions.Fraction` (via `numer`/`denom`),
  floats, `complex`, `decimal.Decimal` (via `SFloatMantissa`/`SFloatExponent`), `str`/`bytes`, `list`, `tuple` (incl.
  `a..b` ranges), `dict`↔Maple table, `set`/`frozenset`, `datetime.date/datetime/timedelta`, NumPy `rtable`, and
  Maple `Set`/`List`/`Table`/`Name`/`ExpressionSequence` wrappers. `exportto` optionally interoperates with pandas,
  NumPy, SciPy, SymPy and PIL if importable.
- **Minor packaging inconsistency (observed, not a blocker):** `pyproject.toml` declares `packages = ["maplesoft"]`
  and the repo layout is `maplesoft/maple/*.py` with internal imports like
  `from maplesoft.maple.Session import Session`, yet the README's test snippet is `import maple` followed by
  `import maple.namespace as mpl`. The shipped-inside-Maple copy may differ from the repo. **UNVERIFIED** which
  import path applies to the packaged release.
- **Assessment:** the **best available design reference for a Maple bridge** (it is exactly "ctypes → libmaplec →
  persistent session → Python object marshalling"), and MIT-licensed so it can be learned from or reused for Maple
  2024+. **But it is unusable as-is for Maple 2018/2022.**

**RESOLVED — the OpenMaple C API *does* exist in Maple 2018 and Maple 2022, so a custom binding is viable.**
This was the critical open question for our project, and the parallel research track in this same worktree settled it
(see §5.4 for the sibling notes):

- **Maple 2018 — CONFIRMED and documented.** *Maple 2018 Programming Guide* §14.3 "OpenMaple", pp. 476–487
  (<https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>): *"OpenMaple is an interface that
  lets you access the Maple computation engine by referencing its dynamic-link library (.dll) file."* / *"Interfaces
  to access the OpenMaple API are provided for use with C, C++, Java, Fortran, C#, and Visual Basic. All of these
  interfaces are built on the C API, so they all reference the primary library, `maplec.dll`, which is located in your
  Maple binary directory."* Headers live in `$MAPLE/extern/include` (`maplec.h`, `maplecommon.h`, `mplshlib.h`,
  `mpltable.h`), the runtime libraries in `$MAPLE/bin.<SYS>` (`libmaplec.so` / `libmaplec.dylib` / `maplec.dll`), Java
  in `jopenmaple.jar`, examples in `samples/OpenMaple`, licensing terms in `extern/OpenMapleLicensing.txt`.
  **There is no Python binding in 2018.**
- **Maple 2022 — strong inference, not directly documented.** There is **no published Maple 2022 Programming Guide**
  (`/documentation_center/maple2022/ProgrammingGuide.pdf` → 404; the history index lists only `maple2022/UserManual.pdf`).
  The evidence that the C API is present in 2022: the **Maple Kernel for Jupyter** is announced in the Maple 2022
  Connectivity PDF, and its help page states *"The Jupyter kernel for Maple connects to Maple using the **OpenMaple
  C API**"*; and the Maple 2023 Programming Guide §14.3 is structurally identical to 2018 (same languages, same
  `maplec.dll`), with **Python added only in 2023**. So the C API is effectively unchanged across 2018→2023.
- **Version nuance:** the official **Python** binding is **Maple 2023+** (module `maple`), renamed to
  `maplesoft.maple` in 2024+, and the GitHub project states "Maple 2024 or later". **No Python OpenMaple before
  Maple 2023.**
- **Practical conclusion:** for Maple 2018/2022 we can either (a) write our own thin `ctypes`/`cffi` binding against
  the OpenMaple C API (lawful per the MIT wrapper as a reference, and per `extern/OpenMapleLicensing.txt` which
  **must be read**), or (b) drive the `maple`/`cmaple` CLI, or (c) **on Maple 2022 only**, attach to the official
  Jupyter kernel over ZeroMQ (§5.2). **Still UNVERIFIED:** `extern/OpenMapleLicensing.txt` terms, and whether
  `maplec` is present in every 2018/2022 distribution/edition.
- **Also UNVERIFIED (minor):** which import path the *packaged* wheel uses (README says `import maple`; the repo
  layout is `maplesoft/maple/...`). Note the PyPI `maple` package is **an unrelated server framework**, not Maplesoft's.

Also found while searching (for completeness):

- <https://github.com/mezzarobba/openmaple-ocaml> — C/OCaml bindings to OpenMaple, mirror of
  <https://src.koda.cnrs.fr/marc.mezzarobba.3/openmaple-ocaml.git>, last push 2023-06-21, **no license declared**.
  Evidence that third parties bind OpenMaple directly in other languages — supporting the "write our own ctypes
  binding" option. Version support **UNVERIFIED**.
- **Naming traps in this search space:** `cmaple` on GitHub is overwhelmingly the **phylogenetics program CMAPLE**
  (<https://github.com/iqtree/cmaple>, GPL-2.0), *not* Maple's console executable. `github.com/aatxe/OpenMaple` is a
  **MapleStory** emulator. `github.com/dragonforce2010/openmaple` is an unrelated managed-agent platform. Only
  `Maplesoft/openmaple` and `mezzarobba/openmaple-ocaml` refer to Maplesoft's OpenMaple.

### 5.2 Jupyter kernels, VS Code extensions and language servers for Maple

**IMPORTANT: there IS an official Jupyter kernel for Maple — it is just not on GitHub.** An earlier GitHub-only
search of mine returned zero and would have led to the wrong conclusion. The corrected picture:

- **Maple Kernel for Jupyter — official, new in Maple 2022.** *"The new Maple Kernel for Jupyter is a program bundled
  with Maple which allows Maple to be used as the computation engine in a session of the Jupyter computation
  environment. […] Output is displayed using standard file formats supported by Jupyter such as LaTeX and PNG."* —
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2022/Connectivity> and
  <https://www.maplesoft.com/products/maple/new_features/Maple2022/PDFs/Maple2022-Connectivity.pdf>.
  **It connects to Maple using the OpenMaple C API**
  (<https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/MapleKernel/Configuring>).
  Setup: `Jupyter[GenerateKernelConfiguration](somepath)` inside Maple, then
  `jupyter kernelspec install somepath/maple` (`--user` optional).
- **Crucially: Maple 2022 only — NOT Maple 2018.** The kernel is announced as new in Maple 2022, and the Maple 2022
  Connectivity page is the first announcement. **This is a hard version split for our project.**
- Related Maple packages: `Jupyter:-GenerateKernelConfiguration`, `Jupyter:-CreateNotebook`,
  `Jupyter:-ExtractCodeSources`, `Jupyter:-SetOutputRendererByType`, and `Worksheet:-WorksheetToJupyter`
  (**introduced in Maple 2022**).
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/GenerateKernelConfiguration>
- **Why this matters a lot for our design:** on **Maple 2022 the Jupyter kernel is arguably the best local bridge
  available** — it is official, local, process-isolated, per-session, and speaks a well-specified wire protocol
  (Jupyter messaging over ZeroMQ) with **LaTeX and PNG outputs already implemented**. A Python-based MCP server could
  drive it with `jupyter_client.KernelManager`; a Node service would need a ZMQ + Jupyter-protocol client. **Maple 2018
  has no such option**, so a 2018 bridge must be CLI/OpenMaple-based. *(This assessment is from the parallel research
  track in the same worktree — see §5.4.)*

GitHub-only searches, for completeness (all negative, and all explained by the kernel being bundled with Maple rather
than published):

| Query | Total | Verdict |
|---|---|---|
| `maple jupyter kernel` | **0** | Nothing on GitHub — but the official kernel is shipped *inside* Maple (above). |
| `maple language server` | **0** | No language server for the Maple CAS surfaced. |
| `maple vscode` | 16 | **All unrelated** (see below). |
| `maplesoft` | 25 | Nearly all SEO/"download" spam; no integration projects. |

The `maple vscode` hits are naming false positives:

- `f12io/maple-vscode-extension` (TypeScript, NOASSERTION) — *"Auto-suggestions, hover help, diagnostics, color
  swatches and formatter for the **Maple CSS Engine**"*. **This is a CSS engine, not Maplesoft Maple.** The same
  applies to the npm package `@f12io/maple-language-core` that a web search surfaces for "maple language server" —
  do not mistake it for a Maple CAS language server.
- `ahao0150/MapleStory-Server-079-vscode` — MapleStory game server.
- `subframe7536/vscode-theme-maple`, `Cateds/Tokyo-Maple-Theme`, `singularitti/vscode-maple-material-theme` — colour
  themes.
- `EliasRLima/Mapler-vscode` — a teaching aid for programming logic.

**Maplesoft ships a VS Code syntax-highlighting package with Maple** (a "VSCodeHighlightForMaple" README is mirrored
at <https://maple.iucc.ac.il/M2025/misc/MS.VisualCode/VSCodeHighlightForMaple/README.md>), which suggests syntax
highlighting is bundled with the Maple install rather than published separately. Whether it offers execution,
debugging, or only highlighting, and which Maple versions ship it, is **UNVERIFIED** — the mirror could not be read
from this host.

**Assessment for our project:** no *third-party* Jupyter kernel or language server for Maple exists, but the
**first-party Jupyter kernel** is a first-class option on Maple 2022 and should be evaluated as the primary 2022
bridge. There is no equivalent for 2018. Note the corollary for our own naming: because "Maple" is heavily overloaded
(MapleStory, Maple Finance, Maple CSS Engine, MAPLE lab automation), our README and registry entry must say
**"Maplesoft Maple"** explicitly.

### 5.3 Sibling research in this same worktree, and the consolidated bridge matrix

This note is one of a set produced in parallel. The others are directly relevant and should be read together with
§3.7 (tool surface) and §5.1–§5.3 (bridge options):

- **`research/01-cli-batch.md`** — driving Maple 2018/2022 as a CLI/batch process: launchers, options, streams, exit
  codes, headless behaviour, persistent-process control, resource limits, licensing.
- **`research/02-openmaple-c.md`** — the **OpenMaple C API**: what ships, headers/libraries, a minimal example,
  result marshalling, memory/licensing/concurrency, 2018-vs-2022 differences, failure list. **This is the note that
  answers "can we bind OpenMaple ourselves?"**
- **`research/03-openmaple-java-dotnet.md`** — OpenMaple Java, .NET/MapleNet, the Maple Kernel for Jupyter, and every
  other official connector.
- **`research/04-file-formats.md`** — `.mw`/`.mws` worksheet formats, read/write/edit feasibility, conversion
  commands and their version availability. **This is the note that determines whether §3.7 Tier 3 is buildable.**
- **`MAPLE-MCP-RESEARCH.md`** — the top-level synthesis.

**Consolidated option matrix for our local bridge (from those notes plus §5.1–§5.3):**

| Option | Maple 2018 | Maple 2022 | Fits a thin headless MCP bridge? |
|---|---|---|---|
| `maple`/`cmaple` CLI in batch mode (stdin/stdout) | **yes** | **yes** | **Best first choice and the only option common to both versions.** No JVM, no extra env vars. |
| OpenMaple **C API** (`libmaplec`, `maplec.h`) | **yes** (documented) | **yes** (strong inference) | Excellent — in-process, persistent, no GUI. Requires our own ctypes/FFI binding and a licensing check. |
| OpenMaple **Java** (`jopenmaple.jar`) | yes | yes | Viable but heavy (JVM) — see `03-openmaple-java-dotnet.md`. |
| **Maple Kernel for Jupyter** (ZeroMQ) | **no** | **yes** (new in 2022) | **Best 2022-only option**: official, local, process-isolated, per-session, LaTeX + PNG outputs already implemented. |
| OpenMaple **Python** (`Maplesoft/openmaple`) | **no** | **no** | Only Maple 2023+ (**README says 2024+**). Use as a *reference implementation*, not a dependency. |
| MapleNet REST/protobuf compute API | ? (add-on) | ? (add-on) | Needs a MapleNet server product; not a desktop path. |

**CLI facts that directly shape the implementation** (from `01-cli-batch.md`; Maple 2018 Programming Guide §14.4,
pp. 487–488, <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>):

- Windows: `cmaple.exe`; Linux/macOS: the `maple` script in `bin/` (GUI is `xmaple`).
- Documented invocations: `cmaple solve.mpl > solve.output`; `echo "int(x,x);" | cmaple`;
  `cmaple -c "datafile:=\`c:/temp/12345.data\`" -c N:=5;`.
- **`-q` is the flag that matters for us** — it suppresses the startup banner, the bytes-used/GC messages and the
  signoff, and the guide explicitly recommends it *"to hide extra output that interferes with parsing results
  automatically"*.
- **Streams:** results go to **stdout**; with `-t` the final bytes-used message goes to **stderr**; `-u` forces UNIX
  line endings.
- **Exit codes are documented 0–5:** `0` normal exit (end of script or `quit`/`done`/`stop`); `1` initialization
  error; `2` script ended prematurely (e.g. missing closing delimiter); `3` failed to re-open stdin after a script
  (only with `-F`); `4` error processing the script (threshold set by `interface(errorbreak)`); `5` kernel
  unexpectedly terminated; and `n` from `quit n`/`done n`/`stop n` (avoid 1–5). **This is exactly the exit-code
  contract a subprocess-based MCP bridge should surface.**
- Useful flags: `-c` (startup command), `-i initFile`, `-s` (skip init files), `-P` parse-only, `-w 0..4`
  (warnings), `-T` resource limits, `-F` (do not exit at EOF of redirected stdin).
  **UNVERIFIED:** whether the newer-looking flags on the current help page (`-noAI`, `--secure-*`, `--setsort`,
  `--historyfile`, `--echofile`) exist in 2018/2022.

**Worksheet/document facts that decide §3.7 Tier 3** (from `04-file-formats.md`):

- A Maple 2018/2022 `.mw` is a **plain-text UTF-8 XML file** (not zipped, not binary), root `<Worksheet>`.
- **But the modern `.mw` vocabulary is undocumented and unstable**, and **~34% of input regions in a sample of 26
  real worksheets were 2-D-only** — stored as an empty `Text-field` plus a private nested-base64 `<Equation>`
  payload, i.e. **unreadable by an external parser**. Some real worksheets are 100% 2-D. To read 2-D input you must
  let Maple linearise it (`Worksheet:-WorksheetToMapleText`).
- Therefore the safe design is: **emit 1-D `Text-field` input**, and for reading do the conversion **inside Maple**
  via `Worksheet:-Convert` / `WorksheetToMapleText` / `WorksheetToJupyter`, driven by `maple -q -c '…'`.
- Version gates: `Worksheet:-WorksheetToMapleText` exists since **Maple 2017**; `Worksheet:-TableOfContents` and
  `Worksheet:-RemoveSection` since **Maple 2020** (absent in 2018); `Worksheet:-WorksheetToJupyter` since
  **Maple 2022** (absent in 2018). `DocumentTools` and `CodeTools` are documented for **2018+**.
  **The availability of the `Worksheet` package itself in 2018 is UNVERIFIED**, and whether these commands run under
  the **command-line** `maple`/`cmaple` at all (no GUI) is **UNVERIFIED and is the highest-value smoke test.**

**A correction to a claim made by the parallel track:** that note describes Maple MCP as *"a local MCP server"*. My
own primary evidence contradicts this — Maplesoft's Copilot Studio PDF gives a **cloud** URL
(`https://cloud-api.maplenet.cloud/api/v2/mcp`, an AWS/CloudFront endpoint) and my live probe of it succeeded
(§1.4–§1.5), so the standard Maple MCP is **remote, not local**. The enterprise/on-premises variant is a separate,
sales-negotiated offering (§1.2). Trust the primary source here.

### 5.4 MapleNet Compute Engine API — confirmed primary source

<https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf> — **Assessment:** the most
directly relevant non-MCP mechanism for driving a *server-side* Maple engine programmatically; protobuf-based,
session- and timeout-aware, with MathML/GIF/plot outputs. Best architectural reference for our result model, but it
requires a **MapleNet server** (a server product), **not** a local desktop Maple 2018/2022 install.

---

## 6. Bottom line for our project

1. **The official Maple MCP is a dead end for Maple 2018/2022.** It is a Maple-2026-only, EMP-gated, cloud
   Streamable-HTTP service with no downloadable component. There is nothing to reuse and no compatibility path.
2. **We would be building the first MCP server for the Maple CAS.** No community Maple MCP exists on GitHub, and
   Maplesoft's is unregistered in the official MCP registry. That is an opportunity, and it means the Maple-specific
   design (session handling, `cmaple` invocation, worksheet model) has no prior art to lean on.
3. **Copy the vendor pattern, not a big tool zoo — but know the trade-off.** Both vendor-official CAS servers
   (Wolfram AgentTools, MathWorks MATLAB) are small surfaces built on *code execution against a live stateful
   engine*. Start with `maple_evaluate_code(code, timeout_seconds, session)` + `maple_check_code` + `maple_help` +
   `maple_health`, add a session lifecycle group, `maple_verify` and `maple_validate_code`, and only then consider
   output/plot/document tools. If a wide operation tier is added, **ship a routing document/agent skill with it**
   (the 133-tool Maxima server does exactly this), because a wide surface without routing degrades tool selection.
   The projects that shipped one tool per CAS primitive with no guidance (`daedalus/mcp-parigp`) are the cautionary
   tale.
4. **Do not invent a per-cell worksheet API.** The two vendors that ship document support — Wolfram
   (`ReadNotebook` / `WriteNotebook`) and MathCAD — both expose **whole-document** operations with a text/markdown
   interchange format, not `create_cell`/`edit_cell`/`run_cell`. Follow that. Tier 3 in §3.7 is droppable without
   affecting the core.
5. **Make every result carry an honest status.** Distinguish `exact` / `approximate` / `unevaluated` /
   `no_closed_form` / `error` / `timeout` (arithma's taxonomy). Maplesoft itself concedes that MCP improves
   calculation but *"doesn't necessarily help with reasoning and repeatability"* (§4.4) — an explicit status field,
   returned Maple source, and deterministic re-evaluation are the concrete answer to that criticism.
6. **Our differentiators are real and worth stating:** local execution (no data egress), no API key, works offline,
   works with Maple 2018/2022, **stdio transport**, and a **persistent** engine session (Wolfram's cloud variant is
   explicitly stateless — §3.6 item 8).
7. **Be explicit in tool descriptions about session state, timeouts, output truncation, and session-killing
   commands.** Wolfram documents its session semantics and `timeConstraint` in the tool description itself; MathWorks
   embeds a `WARNING:` about `restoredefaultpath`. The Maple equivalents are `restart`/`quit`. This is the single
   highest-leverage documentation decision because the model's multi-step behaviour depends on it.
8. **Make Maple errors `isError: true` results, never JSON-RPC errors, and never let a timeout masquerade as a
   mathematical result** (jacobian's rule). Maple's `error`/`warning` streams must be surfaced faithfully.
9. **Do not fabricate the official Maple tool list.** It is gated; no public source exists. If a stakeholder asks
   "what tools does Maple MCP expose?", the honest answer is: unknown — only `tools` + `resources` capabilities and
   the instruction string `"Use Maple for all math calculations"` are observable.
10. **Concrete bridge recommendation, now that the version question is resolved (§5.1–§5.3):**
    - **Common to both versions:** the `maple`/`cmaple` CLI in batch mode, with `-q` for parseable output and the
      documented exit codes 0–5 surfaced as the tool's error signal. This is the lowest-risk starting point and
      works on 2018 and 2022 identically.
    - **Better on both, more work:** an OpenMaple **C API** binding (`libmaplec` / `maplec.h`) via ctypes/FFI. The C
      API is documented for 2018 and present in 2022, gives an in-process persistent engine with no GUI, and the
      MIT-licensed `Maplesoft/openmaple` repo is a working blueprint to copy. **Read
      `$MAPLE/extern/OpenMapleLicensing.txt` first.**
    - **Best on Maple 2022 only:** drive the official **Maple Kernel for Jupyter** over ZeroMQ. Official, local,
      process-isolated, per-session, with LaTeX and PNG rendering already implemented. **There is no 2018 equivalent.**
    - Ship **one** MCP server that selects the available backend at startup and reports which one it chose via
      `maple_health`. Do **not** plan worksheet/document tools (Tier 3) until `Worksheet:-ReadFile`/`Convert` are
      smoke-tested under headless `maple`/`cmaple` on a real 2018/2022 install — that is the top-priority unknown
      (§5.3).

---

## Sources

**Maplesoft — official Maple MCP**
- Maple MCP product page (EN): <https://www.maplesoft.com/products/maplemcp/index.aspx>
- Maple MCP product page (ZH): <https://www.maplesoft.com.cn/products/MapleMCP/>
- Maple MCP product page (FR, links the setup PDF): <https://fr.maplesoft.com/products/MapleMCP/>
- Maple MCP contact / lead form: <https://www.maplesoft.com/contact/webforms/maplemcp.aspx>
- "Setting up Maple MCP for Copilot Studio" (PDF, 9 pp., © Maplesoft):
  <https://www.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>
  mirror: <https://fr.maplesoft.com/products/MapleMCP/Copilot-Studio-MCP-Instructions.pdf>
- Live MCP endpoint probed: `https://cloud-api.maplenet.cloud/api/v2/mcp`
  (also `/api/v2/status`, `/api/v2/compute`, `/api/v2/index`, `/api/v2/ping`)

**Maplesoft — Maple 2026, EMP, licensing**
- "AI-Powered Assistance in Maple 2026" (PDF): <https://www.maplesoft.com/products/maple/new_features/Maple2026/PDFs/Maple2026-AIPoweredAssistance.pdf>
- New features in Maple 2026: <https://www.maplesoft.com/products/maple/new_features/index.aspx>
- Elite Maintenance Program FAQ: <https://www.maplesoft.com/elite/faqs.aspx>
- EMP overview: <https://www.maplesoft.com/elite/>
- Book a Maple demo: <https://www.maplesoft.com/contact/webforms/book-maple-professional-demo.aspx>
- Contact sales: <https://www.maplesoft.com/contact/webforms/contact_sales.aspx>
- Documentation Center: <https://www.maplesoft.com/documentation_center/>
- MapleNet product page: <https://www.maplesoft.com/products/maplenet/index_aca.aspx>

**Maplesoft — architecture analogue (MapleNet Compute API)**
- "The MapleNet Compute Engine Application Programming Interface" (PDF, © Maplesoft 2019):
  <https://www.maplesoft.com/documentation_center/MapleNet2021/MapleNetComputeAPI.pdf>
- Maple online help entry point (MCP help topics return 410 Gone):
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=MapleMCP>

**Maplesoft — OpenMaple / Python embedding (non-MCP integration path)**
- **Official Maplesoft repo, "OpenMaple for Python" (MIT; requires Maple 2024+):**
  <https://github.com/Maplesoft/openmaple>
- README (version requirement, env vars, usage):
  <https://raw.githubusercontent.com/Maplesoft/openmaple/HEAD/README.md>
- `pyproject.toml` (metadata, Python ≥3.11, numpy, MIT):
  <https://raw.githubusercontent.com/Maplesoft/openmaple/HEAD/pyproject.toml>
- `maplesoft/maple/Session.py` (ctypes → `libmaplec`, `StartMaple`/`StopMaple`/`EvalMapleStatement`,
  persistent global session, Python↔Maple marshalling):
  <https://raw.githubusercontent.com/Maplesoft/openmaple/HEAD/maplesoft/maple/Session.py>
- `maplesoft/maple/maplec_ctypes.py` (the OpenMaple C function/callback surface):
  <https://raw.githubusercontent.com/Maplesoft/openmaple/HEAD/maplesoft/maple/maplec_ctypes.py>
- Third-party OpenMaple bindings in another language: <https://github.com/mezzarobba/openmaple-ocaml>
  (mirror of <https://src.koda.cnrs.fr/marc.mezzarobba.3/openmaple-ocaml.git>)
- Versioned Programming Guides that contain the OpenMaple chapter (**search-surfaced only; not directly read —
  maplesoft.com was unreachable from this host, so these are UNVERIFIED**):
  <https://www.maplesoft.com/documentation_center/maple2016/ProgrammingGuide.pdf> and
  <http://www.digisec-technology.com/pub/DVD/2019/root/Maple/manuals/M2019.Programming_Guide.pdf>
- OpenMaple help page lead: <https://www.maplesoft.com/support/help/AddOns/view.aspx?path=OpenMaple%2fVB%2fMapleEval>
- Naming trap — `cmaple` on GitHub is the phylogenetics tool CMAPLE, not Maple's CLI:
  <https://github.com/iqtree/cmaple>

**Maplesoft — local non-MCP bridges for Maple 2018 / 2022**
- Maple 2018 Programming Guide, §14.3 "OpenMaple" (pp. 476–487) and §14.4 "The Maple Command-line Interface"
  (pp. 487–488): <https://www.maplesoft.com/documentation_center/maple2018/ProgrammingGuide.pdf>
- Maple 2023 Programming Guide §14.3 (structurally identical OpenMaple chapter; Python added in 2023):
  <https://www.maplesoft.com/documentation_center/Maple2023/ProgrammingGuide.pdf>
- Documentation-center prior-versions index (shows there is **no** Maple 2022 Programming Guide):
  <https://www.maplesoft.com/documentation_center/history.aspx>
- Maple 2022 Connectivity (announces the **Maple Kernel for Jupyter**):
  <https://www.maplesoft.com/products/maple/new_features/Maple2022/PDFs/Maple2022-Connectivity.pdf> and
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=updates/Maple2022/Connectivity>
- Configuring the Maple Kernel for Jupyter (states it "connects to Maple using the OpenMaple C API"):
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/MapleKernel/Configuring>
- `Jupyter:-GenerateKernelConfiguration`:
  <https://www.maplesoft.com/support/help/Maple/view.aspx?path=Jupyter/GenerateKernelConfiguration>
- `Worksheet` package (Convert, ReadFile, WriteFile, ToString, FromString, WorksheetToMapleText,
  WorksheetToJupyter, TableOfContents, RemoveSection, Display, Comparator):
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet>;
  `Worksheet:-WorksheetToJupyter` compatibility note ("introduced in Maple 2022"):
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=Worksheet%2FWorksheetToJupyter>
- `DocumentTools` package: <https://www.maplesoft.com/support/help/maple/view.aspx?path=DocumentTools>
- `CodeTools` package: <https://www.maplesoft.com/support/help/maple/view.aspx?path=CodeTools>
- `maple` / `cmaple` command-line help page:
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=maple>
- Maple 2025 Connectivity (Worksheet:-FromMarkdown; RunWorksheet for Maple Flow):
  <https://www.maplesoft.com/products/maple/new_features/Maple2025/PDFs/Maple2025-Connectivity.pdf>
- Maple 2024 "AI in Maple" (NaturalLanguage package, new in Maple 2024):
  <https://www.maplesoft.com/support/help/maple/view.aspx?path=updates/Maple2024/AIinMaple>
- Maple Flow with AI coding assistants (only Maplesoft-adjacent integration found that shells out to `cmaple.exe`):
  <https://www.maplesoft.com/products/MapleFlow/AI-Coding-Assistants/index.aspx>
- OpenMaple licensing terms (ships with Maple; **not read — UNVERIFIED**): `$MAPLE/extern/OpenMapleLicensing.txt`

**Sibling research notes in this same worktree (`worktree/maple-cli-research`)**
- `research/01-cli-batch.md` — driving Maple 2018/2022 as a CLI/batch process.
- `research/02-openmaple-c.md` — the OpenMaple C API, its Python bindings, and 2018-vs-2022 differences.
- `research/03-openmaple-java-dotnet.md` — OpenMaple Java, .NET/MapleNet, the Maple Kernel for Jupyter, and other
  official connectors.
- `research/04-file-formats.md` — `.mw`/`.mws` worksheet formats and conversion feasibility.
- `MAPLE-MCP-RESEARCH.md` — top-level synthesis.

**Wolfram — official comparator (live tool schemas)**
- Official MCP registry entry `com.wolfram/mcp`: <https://registry.modelcontextprotocol.io/v0/servers?search=wolfram>
- Live endpoint probed: `https://agenttools.wolfram.com/mcp` (returns `WolframContext`,
  `WolframLanguageEvaluator`, `WolframAlpha` with full input schemas)
- Official Wolfram AgentTools paclet (four predefined servers; `ReadNotebook`/`WriteNotebook`,
  `CodeInspector`, `TestReport`; stdio + cloud deployment): <https://github.com/WolframResearch/AgentTools>
- Wolfram cloud deployment notes (stateless, "No tool filtering / sandboxing in v1"):
  <https://github.com/WolframResearch/AgentTools/blob/main/docs/cloud-deployment.md>
- Wolfram AgentTools tool reference: <https://github.com/WolframResearch/AgentTools/blob/main/docs/tools.md>
- `Wolfram/MCPServer` paclet: <https://resources.wolframcloud.com/PacletRepository/resources/Wolfram/MCPServer/>

**MathWorks — official MATLAB MCP server (vendor CAS template)**
- <https://github.com/matlab/matlab-mcp-server>
- Custom tools guide: <https://github.com/matlab/matlab-mcp-server/blob/main/guides/custom-tools.md>
- Security notes: <https://github.com/matlab/matlab-mcp-server/blob/main/SECURITY.md>

**MCP specification**
- Server tools (naming, inputSchema, annotations, error channels, security):
  <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
  and the 2025-11-25 revision: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>

**Community CAS MCP servers (tool lists and design references)**
- SageMath (40 tools; session workspaces; `verify_claim`): <https://github.com/XBP-Europe/sagemath-mcp>
- SageMath (3-tool MVP triad; structured stdout/stderr/exit): <https://github.com/GaloisHLee/mcp-server-sagemath>
- SageMath via Jupyter kernel protocol (`sage_start`/`exec`/`interrupt`/`stop`/`list`):
  <https://github.com/szeider/mcp-sage>
- SageMath curriculum-shaped 10 tools: <https://github.com/justice8096/sagemath-mcp-server>
- SymPy (keyed `expr_N` handles, LaTeX render): <https://github.com/sdiehl/sympy-mcp>
- SymPy (single tool; AST guard, `setrlimit`, structured error contract): <https://github.com/Eis4TY/Sym-MCP>
- Math catalog (`math.find` / `math.run` discovery pattern): <https://github.com/morluto/jacobian>
- **Maxima (133 tools + `mcp-math` Claude Code routing skill): <https://github.com/sam-hart-ttp/maxima-mcp>**
- Maxima (`maxima_compute`, `maxima_batch`, `maxima_help`, named contexts):
  <https://github.com/vibrate-project/maxima_mcp>
- Maxima (single exec tool): <https://github.com/toms74209200/mcp-maxima>; batch mode in D:
  <https://github.com/gtnoble/maxima-mcp>
- **Giac/Xcas WASM gateway (`compute`/`verify`/`plot`): <https://github.com/tufantunc/axiom-advanced-math-mcp>**
- **Rust CAS with an explicit result-status taxonomy: <https://github.com/drewnix/arithma>**
- SymPy + Lean-4 certification, derivation sessions: <https://github.com/LBurny/symkit-mcp>
- Octave (2 tools; safety envelope worth copying): <https://github.com/fmcato/octave-mcp>
- PARI/GP (143 tools — anti-pattern): <https://github.com/daedalus/mcp-parigp>
- MathCAD (29 tools treating worksheets as session state): <https://github.com/puran-water/mathcad-mcp>
- Origin COM bridge hardening (watchdog, autosave, force-kill grace):
  <https://github.com/youngminsw/Origin-Pro-MCP>
- GeoGebra (`cas_eval` raw passthrough + typed wrappers): <https://github.com/TioSavich/geogebra-mcp>
- GeoGebra (namespaced `geogebra_*` tools): <https://github.com/YZDame/geogebra-mcp-server>
- Desmos (`validate_formula` input hygiene): <https://github.com/TheGrSun/Desmos-MCP>
- MAGMA handbook RAG (documentation companion, no compute):
  <https://github.com/LeGenAI/mcp-magma-handbook>
- GAP (tools auto-generated from package docs): <https://github.com/kamalsaleh/mcp_for_gap>
- Multi-backend CAS with `doc`/`stop` tools: <https://github.com/sanshanjianke/scicompute-mcp>
- Wolfram Engine kernel pool with RBAC: <https://github.com/siqiliu-tsinghua/mma-mcp>
- Mathematica persistent-kernel session triad: <https://github.com/aac6fef/mathematica_mcp>
- Wolfram Language one-tool-per-operation: <https://github.com/paraporoco/Wolfram-MCP>
- Wolfram|Alpha HTTP wrappers: <https://github.com/akalaric/mcp-wolframalpha>,
  <https://github.com/SecretiveShell/MCP-wolfram-alpha>
- Official MathWorks, second server (publish MATLAB functions as tools):
  <https://github.com/matlab/mcp-framework-matlab-production-server>

**Third-party commentary on the official Maple MCP (vendor-authored; not independent)**
- ICMS 2026 programme — Maplesoft talk "How Maple is Using AI to Boost Productivity" (Paul DeMarco), including the
  admission that MCP *"doesn't necessarily help with reasoning and repeatability"*:
  <https://icms-conference.org/2026/session10.html>
- Vendor-derived Chinese reposts describing capability areas (no verbatim tool names; mention "predefined prompts"):
  <https://blog.sciencenet.cn/home.php?mod=space&uid=516836&do=blog&id=1518272>,
  <https://www.sohu.com/a/973817594_121417987>,
  <https://www.cnblogs.com/maplesoft/articles/22448372>
- Independent channels checked and found empty: Hacker News Algolia search (no relevant stories),
  Reddit search JSON (HTTP 403), <https://www.mapleprimes.com/search?q=MCP> (client-rendered, no extractable
  results), LinkedIn (inaccessible). All **UNVERIFIED**.

**Registries & community search**
- Official MCP registry: <https://registry.modelcontextprotocol.io/v0/servers>
- GitHub Search API: <https://api.github.com/search/repositories>
- Maplesoft GitHub organization (1 public repo): <https://github.com/orgs/Maplesoft/repositories>
- mcp.so: <https://mcp.so/> (no Maple/Maplesoft server page)
- Glama: <https://glama.ai/mcp/servers?query=maple>
- LobeHub stub entry (no usable content): <https://lobehub.com/mcp/marvalarva2929-maple-mcp>
- Maplesoft-bundled VS Code highlighting (mirror, not read from this host):
  <https://maple.iucc.ac.il/M2025/misc/MS.VisualCode/VSCodeHighlightForMaple/README.md>
- Maple **CSS Engine** VS Code extension / language package — **NOT** Maplesoft Maple:
  <https://github.com/f12io/maple-vscode-extension>, <https://www.npmjs.com/package/@f12io/maple-language-core>

**Naming false positives (explicitly NOT the Maple CAS)**
- <https://github.com/samarpassey/maple-procure> (CanadaBuys procurement, not Maplesoft)
- <https://github.com/kcw2034/maplestory-mcp-server> (MapleStory game API)
- <https://github.com/ljy9303/maplestory-mcp-server> (MapleStory game API)
- <https://docs.maple.finance/integrate/technical-resources/configure-mcp-server> (Maple Finance, DeFi)
- <https://github.com/aatxe/OpenMaple> (MapleStory emulator)
- <https://github.com/dragonforce2010/openmaple> (unrelated managed-agent platform)
- <https://github.com/iqtree/cmaple> (CMAPLE phylogenetics, not Maple's `cmaple` CLI)
- `ca.maplev/tesla-collision-parts` in the official MCP registry (Canadian auto-parts vendor)

**Probed-and-absent (negative results worth recording)**
- `https://www.maplesoft.com/products/MapleMCP/Claude-Desktop-MCP-Instructions.pdf` → 404
- `https://www.maplesoft.com/products/MapleMCP/Claude-MCP-Instructions.pdf` → 404
- `https://www.maplesoft.com/products/MapleMCP/ChatGPT-MCP-Instructions.pdf` → 404
- `https://www.maplesoft.com/support/help/maple/view.aspx?path=MapleMCP` → 410 Gone
- `registry.modelcontextprotocol.io/v0/servers?search=maplesoft` → 0 results
- `https://mcp.so/server/maple/maplesoft` → 404
