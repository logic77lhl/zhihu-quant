[中文](README.md) | **English**

# zhihu-quant

Read Zhihu's quantitative fields — upvotes, publish time, comment count, vote ordering, time distribution — through **the Edge session you're already logged into**; then extract the entities (books, libraries, companies, concepts) mentioned across N answers to one question, dedupe, count, trace back, and render an interactive HTML report.

One command, **no reading answers by hand**.

```
zhihu.com/question/28193957   380 answers, 98,556 characters of body text
        ↓  one command
ranked 555 books + upvotes + publish year + the source sentence for every mention
```

---

## Why this exists

Zhihu's official open-platform CLI returns four fields. **No upvotes, no publish time, no comment count, no sort parameter.** Patching upvotes via search hits roughly 28% of answers, and what you get is a crude heat proxy.

Panerelay takes a different route: it reuses the logged-in browser session and sends requests from an extension, which returns the full field set.

But **installing Panerelay from scratch hits three walls**, all solved here:

| Wall | Symptom | Real cause |
|---|---|---|
| Sideloaded extension gets no cookies | every request 401 "identity not verified" | manifest lacks `host_permissions`, so `chrome.cookies.getAll()` returns an empty array |
| `doctor` says connected but nothing works | false positive | the official setup script never wrote the Native Messaging registry entry |
| Breaks on the next machine | extension doesn't load | launching Edge from the normal icon drops `--load-extension` |

**This repo is an installer, not a code dump.** The environment fixes are baked in.

Moving to a new machine? Start with **[SETUP.md](SETUP.md)** — full install walkthrough, every step with the why and a way to verify it.

---

## Quick start

```powershell
git clone <repo-url>
cd zhihu-quant
powershell -ExecutionPolicy Bypass -File install.ps1
```

Then three steps:

1. Launch Edge from the new **"Edge (Panerelay)"** desktop shortcut — starting from the normal icon means the extension never loads.
2. Sign in to zhihu.com in that window.
3. Check the bridge:

```powershell
$S = ".\skills\zhihu-web\scripts"
node "$S\check-bridge.mjs"
```

Three OK lines and you're ready:

```powershell
$S = ".\skills\zhihu-web\scripts"
node "$S\pipeline.mjs" 28193957 --preset books
```

> Every script lives in `skills\zhihu-web\scripts\`. There is exactly one copy in the repo.

380 answers takes about 5 minutes; 519 about 7.

---

## Requirements

- **Windows** (the installer uses the registry and `WScript.Shell` for the shortcut)
- **Microsoft Edge** — Edge, not Chrome. Chrome 155 hard-disables `--load-extension` and logs `--load-extension is not allowed in Google Chrome, ignoring`.
- **Node.js 20+**
- npm, for `npx @panerelay/setup` (installs the official native host)

No admin rights; the registry writes are `HKCU` only.

---

## Two fetchers

| | `fetch-answers.mjs` | `fetch-answers-api.mjs` |
|---|---|---|
| Method | one `answer-detail` call per answer | paginated `/api/v4/questions/<id>/answers` |
| Ceiling | **1000 answers** (that command has no paging) | **none** |
| Requests | N | N/20 |
| 380 answers | 5 min 06 s | ~40 s |
| 3700 answers | ~47 min | ~6 min |
| Body | plain text | HTML, needs tag stripping (verified identical to the other path) |

**≤1000 answers: use the first. Above that: use the second.**

```powershell
$S = ".\skills\zhihu-web\scripts"

# default (≤1000)
node "$S\pipeline.mjs" 28193957 --preset books

# >1000 answers: switch to the paginated endpoint
node "$S\fetch-answers-api.mjs" 1937248651517863299 --sorts default,created
node "$S\extract-entities.mjs" <out>.json --preset books
node "$S\render-report.mjs" <out>-entities.json
```

`fetch-answers-api.mjs` reads `paging.totals` and reconciles the actual count at the end; the difference is printed (usually answers deleted or hidden by the platform).

---

## Layout

```
install.ps1          one-command install
uninstall.ps1        uninstall (keeps report data by default)
SETUP.md             machine-migration guide (mirrors skills/zhihu-web/references/setup.md)
extension/           prebuilt Panerelay extension with the host_permissions patch
skills/zhihu-web/    the agent skill — the only copy of the scripts
  SKILL.md             entry point: routing table, invocation rules, field availability
  references/          11 docs: setup / pipeline / script reference / presets / publish / video
  scripts/             42 .mjs files
    pipeline.mjs         the one-command pipeline
    check-bridge.mjs     health check
    fetch-answers-api.mjs paginated fetcher (no ceiling)
    fetch-answers.mjs    per-answer fetcher (≤1000)
    extract-entities.mjs entity extraction by preset
    render-report.mjs    entities → HTML + Markdown
    presets/             entity-type definitions (change type without touching code)
docs/PLAYBOOK.md     field notes: every trap hit and how it was diagnosed
config.json          generated at install time (output directory, etc.)
```

---

## Common commands

```powershell
$S = ".\skills\zhihu-web\scripts"

# full pipeline
node "$S\pipeline.mjs" <question-id> --preset books

# re-run after editing a preset, reusing the fetched answers (saves 5–7 minutes)
node "$S\pipeline.mjs" <question-id> --preset books --skip-fetch

# health check only
node "$S\check-bridge.mjs"

# new entity type: write presets/xxx.json
node "$S\pipeline.mjs" <question-id> --preset mylib

# extend the dictionary
node "$S\extract-entities.mjs" <answers.json> --preset books --dict extra.txt
```

Options:

```
--preset <name>      entity preset, see skills/zhihu-web/scripts/presets/
--config <path>      custom config
--dict <file.txt>    extra dictionary words, one per line, # comments
--concurrency <n>    fetch concurrency, default 3; higher gives no measurable gain
--sleep <ms>         delay between calls, default 60
--limit <n>          fetch only the first n (debugging)
--skip-fetch         reuse the existing answers-full.json
```

Output defaults to `~/Documents/zhihu-quant/`; change it with `-OutDir` at install time.

---

## Built-in presets

| Preset | Entities | Detection |
|---|---|---|
| `books` | book titles | `《》` + straight/curly quotes + curated dictionary, three tiers, with context guards |
| `pythonlibs` | Python libraries | inline code + PyPI links + curated dictionary |
| `cpu` | CPU models | model regex + vendor-prefix stripping only; `12700` and `12700K` stay separate SKUs |

**New entity types need no code** — write `presets/xxx.json`. Field docs are in `skills/zhihu-web/scripts/presets/_README.md`.

---

## What the report contains

- Six stat cards (entities / answers scanned / characters / total upvotes / non-zero answers / time span)
- Two charts: top-15 entities as a horizontal bar chart (log scale), answers per year as a histogram
- Entity table: rank, name, source tier, mentions (progress bar), highest upvote (progress bar), first mentioned
- Every row expands to its provenance: upvotes, comments, publish time, author, **the source passage**, and a link
- Full-text search, source filter, four sort orders, light/dark following the OS, one-click PDF export
- A "method" block stating sample size, what was filtered out, and **that "highest upvote" is a proxy**

---

## Known limits

- **"Highest upvote" is a proxy.** It's the upvote count of the most-upvoted answer that mentions the entity — not the entity's own popularity. One very popular answer pulls the number up.
- **Sampling is not the whole population.** The number of answers Panerelay can see may be lower than the official CLI's (the difference is deleted or hidden answers that never appear in the list endpoint). The report states the difference and why.
- **The dictionary tier can produce false positives.** Common words like "common sense" or "constitution" are also book titles. The provenance expansion lets you check.
- **Extraction quality has no quantitative evaluation.** It's checked by reading the top 20 provenance passages.
- **Read paths are reliable; write operations are not included.** Commands like `comment` / `like` / `favorite` really change account state; the scripts never touch them.

---

## Troubleshooting

Read **[docs/PLAYBOOK.md](docs/PLAYBOOK.md)** first — every known trap and its diagnosis.

Quick table:

| Symptom | Check |
|---|---|
| `Panerelay Bridge is unavailable` | Was Edge started from the "Edge (Panerelay)" shortcut? If Edge is already running, the flag doesn't apply — quit it fully first |
| Health check shows `attachedCookieCount=0` | manifest lacks `host_permissions`; re-run `install.ps1` |
| Health check shows "not logged in" | sign in to zhihu.com in that Edge window |
| Fetch returns 401 | same as the cookie line above |
| `PANERELAY_NATIVE_HOST` missing | run `npx --yes @panerelay/setup` |
| PowerShell syntax error in a .ps1 | the file was saved as UTF-8 without BOM; PowerShell 5.1 reads it as the system ANSI code page. Add the BOM back |
| Non-zero exit when passing a URL, but the response looks like a server error | the `&` was probably eaten by the shell. **Don't call `cmd.exe /c panerelay <url>`** — use the `panerelay()` wrapper in `panerelay-run.mjs`, which bypasses the shell |
| Suspect arguments are being eaten | run `node skills\zhihu-web\scripts\test-shell-injection.mjs` (19 regression checks). Panerelay's response echoes the actual `url`, which is the most reliable comparison |

---

## Safety boundaries

- **This project does not need your Zhihu cookies.** Requests are sent by the browser extension; cookies never pass through a CLI tool or a model.
- The installer **only writes `HKCU`**, never machine-wide registry, and needs no administrator.
- The scripts **do not read, export, or print** any browser credentials.
- The repo contains **no account information or personal paths**; everything resolves from environment variables.

---

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

Report data is kept by default; add `-PurgeData` to remove it. The official Panerelay CLI is untouched — remove it separately with `npx --yes @panerelay/setup uninstall`.

---

## Credits and license

The extension is based on [Panerelay](https://github.com/F-loat/panerelay) (MIT); this project adds the `host_permissions` and Native Messaging registry fixes. The patch has been submitted upstream.

Zhihu data belongs to Zhihu. This tool only batch-reads and counts **what you could already see in your browser**; it contains no logic for bypassing rate limits, captchas, or paywalls.

## License

[MIT](LICENSE)
