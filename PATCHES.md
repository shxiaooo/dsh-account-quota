# Local changes to dsh-account-quota

This directory is a local fork of
[`zer0zio-stack/dsh-opencode-go-quota`](https://github.com/zer0zio-stack/dsh-opencode-go-quota)
v0.4.0, installed into the `web` profile with `link:`. Renamed to
`dsh-account-quota` in v0.7.0: the row reports the DeepSeek account balance
beside OpenCode Go's plan windows, so a name carrying only the latter was
wrong. It is not published and not tracked by pnpm's registry, so an upstream
update is a manual merge against the changes below.

## v0.7.0 — renamed to `dsh-account-quota`, and the stat-dialog panel

### The panel is ui-chat's stat dialog

The two panels now share the session-stats dialog's surface declaration for
declaration (`ui-chat/src/client/chat/stat-dialog.module.css`): menu background,
12px radius, `elevation-prominent`, 12px text at 18px leading, a heading row with
a 0.5px rule under it, and a `minmax(76px, auto) minmax(0, 1fr)` label/value
grid. Width matches too — `max-content` between `min(300px, 100vw - 24px)` and
`min(440px, 100vw - 24px)` — so both surfaces break at the same window widths.

Placement and dismissal come from the same primitives rather than a second
implementation: `useAnchoredPosition` (left-aligned to the trigger, 8px gap, 12px
viewport margin, re-placed on scroll/resize/panel resize) and
`useDismissOnOutsidePointer`, with the panel portaled to `document.body` at
`z-index: 1100` so it layers above modal overlays exactly as the stat dialogs do.
Both specifiers are shell-seeded modules, so the module table answers them; the
package still imports nothing and needs no build step.

What this deleted: a hand-rolled centred clamp, its `window` listeners, a local
`pointerdown` handler, and a `position: fixed` panel with its own colours and a
320px cap that had nothing to do with the row above it.

The heading names the provider and carries no right-hand figure: a bare number
in that seat leaves the reader guessing what it counts, so every figure keeps a
row and a label (总余额 included).

The day's coverage moved into the row it qualifies: instead of a 统计起点 row of
its own, the first sample's time and the sample count follow the 今日消耗 **label**
as muted parenthetical context — `今日消耗 (09:12 · 288 次采样)` — leaving the value
column holding the amount alone.

### One anchor ref per pill

The placement primitive keys its effect on the anchor ref OBJECT
(`[open, anchorRef, panelRef, side, gap, margin]`). A single shared ref kept that
identity while its `current` moved from one pill to the next, so opening the
second pill straight from the first — pointerdown inside the row, so nothing
closed — changed the panel's rows without changing its position: the panel stayed
where the first-opened pill sat, holding the second pill's figures. Each provider
id now owns a ref object, so a switch is a dependency change and re-places.
`/tmp/ocgcheck/anchor.mjs` (jsdom, clicks one pill then the other, asserts the two
placement calls receive different ref objects) detects the old wiring.

## v0.7.0 — renamed to `dsh-account-quota`

The row shows the DeepSeek account balance beside OpenCode Go's plan windows, so
`dsh-opencode-go-quota` named only one of the two things it reports.

Renamed together, because they all identify the same package: the directory, the
package name, the cordis row id (`account-quota`), the browser bundle id, the
HTTP route (`/plugins/account-quota/usage`), the state directory
(`$DSH_HOME/account-quota/state.json`), the slot entry id
(`account-quota-reading`), the CSS prefix (`dsh-ocg-` → `dsh-aq-`), the logger
prefix, and the `User-Agent`. The profile's dependency key, bundle entry, lock
import, and `node_modules` link moved with it.

One string deliberately keeps the old name: `settings.yaml`'s route id
`opencodego-deepseek`, which names the deployment's model route rather than this
package. `package.json`'s `repository` / `homepage` / `bugs` now point at this
fork's own home, [`shxiaooo/dsh-account-quota`](https://github.com/shxiaooo/dsh-account-quota);
the upstream it was branched from stays credited in the README and in the
LICENSE's retained copyright line.

The state file moved with its directory, so today's series and its first-sample
anchor survive the rename.

## v0.6.0 — the balance series, and a host-owned clock

The DeepSeek balance endpoint is the one source that reveals account-level spend,
and only as a difference. The host now keeps a series of balance samples and
folds each local day into `balance.today`, so the resting row reads
`¥12.34 · 今日 -¥0.56`.

### Why a series rather than an anchor

The obvious rule — record the day's first balance, subtract the current one —
breaks the moment the account is topped up: the subtraction reads the recharge as
negative spend, or silently swallows the spend that preceded it. Summing the
drops and rises between consecutive samples gives the same answer while no
recharge happens, and a correct one when one does. The cost is storing every
sample (one day at `cacheMs`, well under 100 KB) instead of one number.

### Why the sampler is on the host

v0.5.0 fetched only when a browser GET arrived. That cadence is zero while no tab
is open, which is exactly when the overnight step happens — so the day's anchor
would be whenever the user first opened the GUI. A `setInterval` at `cacheMs` now
samples at mount and every period thereafter, sharing `refresh()` with the route
so there is one code path and one freshness floor. `cacheMs` therefore means both
"how stale a snapshot may be" and "how often the host samples"; they are the same
question. The removed `refreshMs` key was dead in v0.5.0 — validated, never read.

### Cross-session and cross-process

Accounting lives in the host and on disk, never in a client:

- `$DSH_HOME/account-quota/state.json`, one series per provider id, pruned to
  the current local day.
- Every write re-reads the file, unions by timestamp, and lands through a rename
  from a process-unique temporary name. A second `dsh web` folding the same
  account contributes its samples instead of being overwritten by them.
- A restart resumes the day rather than re-anchoring it; a page reload, a second
  tab, and another session all read the same series.
- Because the balance is account-level, spending from another machine, a script,
  or the DeepSeek app is counted too — no per-session bookkeeping is involved.
- If the file cannot be written, this process's own series still joins the merge,
  so the fold keeps accumulating in memory instead of collapsing to a single
  sample per tick. Found by the self-test.

### Deliberate information loss

- Nothing is interpolated across a gap: a step is attributed to the interval it
  was measured over, never to a rate inside it.
- The step spanning local midnight is discarded rather than split.
- `balance.today.since` publishes the first sample of the day, so the panel can
  say `今日消耗 (09:12 · N 次采样)` instead of presenting a partial total as the
  whole day.
- `total_balance` carries two decimals, so the figure moves in ¥0.01 steps. That
  is the endpoint's resolution; no finer number is invented.

### Also in this version

- The two readings are now **two pills**, each its own button opening its own
  provider's panel. The separator that used to sit between them is gone — the
  root's own 12px gap separates them, as it does the stats pills — and each pill
  separates its own two figures instead (`¥12.34 · 今日 -¥0.56`,
  `5 小时 42% · 重置于 12分`), mirroring `StatsPills`' `label`/`sep` markup.
- `statePath` config field, defaulting to `$DSH_HOME/account-quota/state.json`
  with the documented `$DSH_HOME` → `~/.dsh` precedence inlined (this package may
  not import `@deepseek-ai/dsh-home-paths`).
- Unknown config keys now fail loud rather than being silently carried.
- `selftest.js`: 57 checks over the real `apply()` with a stand-in Context, a
  mutable fake `fetch`, and a clock the test owns — including two host processes
  sharing one series, a corrupt file, and an unwritable path.

## v0.5.0 — upstream-only data, and a new seat

The plugin now reports **only** what the provider APIs publish, and it renders
under the composer instead of in the corner overlay.

### Why the local fold was removed

v0.4.0 read `usage.rolling|weekly|monthly` from the plan endpoint and, for
`tokens` providers, folded local `assistant/message.usage` events from every
session log into token totals and multiplied them by a built-in pricing table.

Two problems, both measured on this deployment:

1. **The estimate was zero.** The pricing table was keyed
   `deepseek-v4-flash` / `deepseek-v4-pro`, while `settings.yaml` selects the
   model id `deepseek-flash`. `aggregateEvents` looks up
   `providers[provider].pricing[model]`, so nothing matched and every event
   priced at 0 — the card showed `今日 3750万 tokens` next to `今日消费 ¥0`.
2. **The two figures measured different things.** `percent` is server-side and
   covers every client using the account; the local fold covered only sessions
   whose logs still existed on this machine. Displaying them side by side invites
   reading the difference as usage.

Neither endpoint publishes token counts or spend, so neither is now shown.
Deleted from `lib/index.js`: `syncUsage`, `aggregateEvents`, `foldProvider`,
`readStoredEvents`, `costOfBuckets`, `priceAt`, `usageBuckets`, `tokenPart`,
`localDateKey`, `weekStartKey`, `monthStartKey`, `DEFAULT_DEEPSEEK_PRICING`,
`normalizePricing`, `normalizePrice`, `normalizeRate`, `normalizePeakHours`,
`foldSelection`, `currentSelection`, the `usageCache`, and the
`sessionPersistence` / `agents` / `agentDefaultModel` injections.

### New: two providers, fetched in parallel

`refresh()` now queries every configured adapter concurrently and publishes one
snapshot. A provider that fails carries its own `error` while the others keep
their data.

`providers` now **replaces** the built-in table instead of extending it. The
built-ins then aliased one upstream twice over (`opencode-go` / `deepseek-go`
were both OpenCode Go; `deepseek` / `deepseek-official` were both
`api.deepseek.com`), so merging rendered each account twice; v0.6.1 dropped the
two aliases, leaving the missing-credential row as the standing reason.

A `cacheMs` floor was added because the new seat renders permanently rather than
on click; without it every mount would reach the provider endpoints. HEAD never
refreshes.

### Credential naming

`settings.yaml` names the OpenCode Go route `opencodego-deepseek` and its
credential `OPENCODEGO_API_KEY`. The built-in adapter expected
`OPENCODE_GO_API_KEY`, which does not exist in this deployment. The shipped
adapter is now `deepseek-go` with `OPENCODEGO_API_KEY`.

### New: the composer dock seat

`shell.overlay` → `conversation.composer.dock`, the ambient row below the
composer card, registered additively beside ui-chat's `stats` entry with
`order: 10`. `lib/client.js` carries its own CSS mirroring
`StatsPills.module.css`.

Brand marks are inlined from `@lobehub/icons-static-svg` 1.95.0 (MIT) as single
`fill="currentColor"` paths; both were verified byte-identical to the package's
SVGs. They cannot be imported: a `link:` package resolves bare specifiers from
its own real path, so an import here fails with `ERR_MODULE_NOT_FOUND`.

## Previous v0.4.0 fixes

All four are superseded by v0.5.0 rather than repaired, because the data they
recovered was not upstream-reported.

### 1. Live Session log — removed

`agent.session?.events ?? []` was always `undefined`; `Session` exposes
`snapshotEvents()`. Nothing reads session logs now.

### 2. Stored Session listing — removed

`sessionPersistence.listSnapshots()` never existed; the service exposes `list`.
Nothing lists stored sessions now.

### 3. Reading a stored Session — removed

`sessionPersistence.inspect()` never existed either; a log is read through
`open(id, 'read')` and the handle must be closed.

### 4. Selection fallback — removed

Same `inspect()` call on the durable-log fallback. The row no longer follows the
session's selected provider, because it shows every configured provider at once.

## v0.6.1 — dead-code sweep

### Holes closed in the same pass

- **The request timeout did not cover the response body.** `clearTimeout` ran as
  soon as `fetch` resolved, so a provider that sent its headers and then stalled
  left `await response.text()` pending forever. That did not merely hang one
  refresh: the sampler's `inFlight` flag stayed true, so `setInterval` kept
  firing into a guard that never released and the row kept serving its last
  snapshot for the life of the process. The timer now spans the body read, and
  `selftest.js` ticks again after a timed-out response to pin the recovery.
- **`maxResponseBytes` rejected a body that had already been buffered.**
  `response.text()` read the whole stream before the byte count was compared, so
  the cap bounded what the plugin parsed, not what it held. The body is now read
  through a reader that cancels the transfer as soon as the running total passes
  the cap, with `content-length` checked first when the provider declares one.
- **A foreign `code` reached the snapshot as a provider failure code.** Mapping
  "has a `code` property" to "our structured failure" also matched a
  `DOMException`, whose legacy numeric `code` is 20 — a stalled body was
  published as `{"code":20,"message":"This operation was aborted"}` instead of
  `TIMEOUT`. The self-test caught it. Failures this module raises now carry a
  symbol marker, and anything else becomes `INTERNAL_ERROR`.

### Dead code removed

- `balance.isAvailable` was parsed from `is_available` and published in the
  snapshot, but nothing rendered or read it.
- `DEFAULT_CONFIG`, `DEFAULT_PROVIDERS`, both endpoint-URL constants, and
  `defaultStatePath` were exported with no importer (`selftest.js` imports
  `apply`, `Config`, `QUOTA_ROUTE_PATH`, `STATE_VERSION`, `localDay`).
- The client's `WINDOW_ROWS.rolling.label` (`滚动窗口`) could not render: the
  host always publishes `rollingLabel` for a plan adapter, and the pill's own
  `?? '滚动'` fallback is what a missing one would show.
- `data-composer-quota` on the root was referenced by no selector, test, or doc.
- `@deepseek-ai/dsh-client-ui-model-selection` was still in `dsh.client.inject`
  from v0.4.0's priced card; the client half no longer touches model selection.
- The polling interval's `AbortController` was unreachable, so its "an unmount
  aborts through the signal" comment was false. The in-flight request is now
  aborted on the next tick and on unmount.
- The two built-in aliases (`opencode-go`, `deepseek-official`) are gone. Both
  existed so a deployment naming that route id would "resolve", but nothing has
  read a route id since v0.5.0 stopped following the session's selected
  provider; this deployment's config names neither. The built-in table is now
  exactly the two adapters the README documents.

## Verified

Against the live endpoints, through the plugin's own
`/plugins/account-quota/usage` handler:

| Reading | Observed | Source |
| --- | --- | --- |
| DeepSeek balance | `¥12.34` | `balance_infos[0].total_balance` |
| OpenCode Go rolling | `9%` | `usage.rolling.percent` |
| OpenCode Go weekly | `32%` | `usage.weekly.percent` |
| OpenCode Go monthly | `62%` | `usage.monthly.percent` |

Also checked: a second GET inside `cacheMs` returns a byte-identical body without
refetching; HEAD returns 200 with an empty body; an invalid balance credential
yields `UNAUTHORIZED` on that provider alone while the plan provider still
reports `62%`; both inlined icon paths match their MIT sources exactly.

## Upstream notes

The plugin's README claimed a "DSH 0.1.5 兼容修复", but that change covered only
the removed `connection.api.sessions.models` RPC. The persistence and Session-log
APIs were not updated in the same pass — and v0.5.0 removed that code path
entirely rather than repairing it, because the data it produced was not
upstream-reported.
