# OPDS MCP

An MCP server that proxies a book catalog over the [OPDS](https://specs.opds.io/) protocol.
The same code works with any catalog: the address is set in `OPDS_URL`, the site is
not hardcoded in the code. Project Gutenberg, Calibre, a home library on an OPDS engine —
no difference.

```
node tools/opds-mcp/server.mjs        # stdio, the way pi starts it
```

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `OPDS_URL` | yes | root of the OPDS catalog: `https://www.gutenberg.org/ebooks.opds/`, `http://<address>:8080/opds/` |
| `OPDS_USER`, `OPDS_PASSWORD` | no | basic auth for the catalog |
| `OPDS_TOKEN` | no | Bearer token; takes priority over basic |
| `OPDS_TIMEOUT_SECONDS` | no | timeout of a request to the catalog, default 15 |
| `OPDS_MAX_DOWNLOAD_MB` | no | download limit, default 25 MB |
| `OPDS_SAVE_DIR` | no | where to put files; default `$ICARUS_HOME/incoming` (the attachments folder) |

## Tools

- `catalog_search(query, limit?)` — search via the OpenSearch template from the catalog root.
  If there's no template, it tries the standard `/search?q=` and `/search.opds?query=` and, if
  nothing worked, honestly lists the reasons.
- `catalog_browse(link?, limit?)` — the catalog root or a selected section, links
  only from the server's responses.
- `book_info(link)` — a card: authors, year, languages, formats with size, annotation.
  It also understands catalogs that give books directly as file links (that's what
  Calibre does): the server remembers such entries from the output and builds a card from them.
- `book_download(link, format?, confirm: true)` — download into `incoming/` with a
  human-readable name "Author - Title.format". Without `confirm: true` it refuses;
  more than `OPDS_MAX_DOWNLOAD_MB` — it stops.

Atom/OPDS 1.x is supported. OPDS 2.0 is JSON, that's not here.

A book card that the catalog gave directly as a file link lives in the process
memory: after the server restarts, it must be fetched again via search.

Errors are distinguished deliberately: "nothing found" is a parsed empty output;
"response is not Atom/OPDS" — `OPDS_URL` points at an HTML page, not a catalog; 401 — you need
`OPDS_USER`/`OPDS_PASSWORD` or `OPDS_TOKEN`; timeout — the catalog isn't responding.

## Tests

```
node tools/opds-mcp/test.mjs      # parse real Project Gutenberg fixtures
./script/test packages/service/test/opds-mcp.test.ts
                                  # protocol, errors, limit and download on a fake catalog
```

The fixtures in `fixtures/` are real responses from the public Project Gutenberg catalog
(public domain), captured 12.11.2026. In the tests the address is replaced with a local one:
no network needed.
