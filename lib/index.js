/**
 * dsh-account-quota — host half.
 *
 * Serves the browser half one snapshot of **upstream-reported** account state
 * over `GET /plugins/account-quota/usage`. Every figure in that snapshot is
 * read from a provider endpoint; nothing is derived from local session logs.
 *
 * Two provider kinds, matching what the upstream APIs actually publish:
 * - `plan`:   subscription usage limits. `GET usageUrl` returns
 *             `usage.rolling|weekly|monthly` (`status`, `percent`, `resetsAt`),
 *             like OpenCode Go. `percent` is an integer.
 * - `tokens`: prepaid balance. `GET balanceUrl` returns
 *             `{ is_available, balance_infos: [{ currency, total_balance,
 *             granted_balance, topped_up_balance }] }`, like api.deepseek.com.
 *
 * Neither endpoint publishes token counts or per-request spend, so neither is
 * reported. An earlier version folded local `assistant/message.usage` events
 * and multiplied them by a pricing table; the result was a local-machine
 * estimate displayed beside real server-side percentages, which invited exactly
 * the wrong comparison. `percent` covers every client using the account, while
 * the local fold covered only sessions whose logs still existed here.
 *
 * ## Daily spend
 *
 * The balance endpoint is the one source that reveals account-level spend, and
 * only as a difference: `12.34` now against `12.90` a minute ago. The host
 * keeps a balance series and folds it into `balance.today`.
 *
 * - Spend is the sum of the drops between consecutive samples of the local day,
 *   and top-ups the sum of the rises. Summing drops rather than subtracting the
 *   latest balance from an anchor is identical while no recharge happens, and
 *   stays correct when one does instead of reading as negative spend.
 * - Samples are persisted, so a reloaded page, a second tab, another session,
 *   and a restarted host all fold the same series. Spending moves the account
 *   balance whoever caused it — another machine, a script, the DeepSeek app —
 *   so all of it counts; the fold needs no per-session bookkeeping.
 * - Nothing is interpolated across a gap, and the drop spanning local midnight
 *   is discarded rather than split between the two days. `balance.today.since`
 *   publishes the first sample of the day so the covered span is visible
 *   instead of assumed to be the whole day.
 * - `total_balance` carries two decimals, so a displayed total moves in ¥0.01
 *   steps. That is the endpoint's resolution, and no finer figure is invented.
 *
 * API keys never leave the host process and never appear in responses or logs.
 * The module takes no package dependency on purpose: the profile installs this
 * package as a `link:` checkout, so a bare import would fail to resolve from
 * its real path. Host capabilities arrive through cordis service injection.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin display name. */
export const name = 'account-quota'

/** Services required by this plugin. */
export const inject = ['webServer', 'credentials']

/** Browser-facing HTTP route. Fixed because both halves of this package own it. */
export const QUOTA_ROUTE_PATH = '/plugins/account-quota/usage'

/** Official OpenCode Go plan usage endpoint. */
const DEFAULT_OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Official DeepSeek prepaid-balance endpoint. */
const DEFAULT_DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Marker distinguishing this module's structured provider failures from any
 * other thrown value. A `DOMException` carries a numeric `code` and a Node
 * filesystem error a string one, so the marker — not the presence of `code` —
 * is what tells a reported failure from a foreign error.
 */
const failureMark = Symbol('account-quota.failure')

/**
 * Build one structured provider failure.
 * @param code - stable machine code published to the browser half.
 * @param message - operator-facing text.
 * @returns the value thrown by the credential, transport, and parse steps.
 */
const failure = (code, message) => ({ code, message, [failureMark]: true })

/** The three usage windows every `plan` endpoint is expected to publish. */
const PLAN_WINDOWS = ['rolling', 'weekly', 'monthly']

/** Built-in provider adapters. The user layer overrides per provider key. */
const DEFAULT_PROVIDERS = Object.freeze({
  /**
   * The deployment's OpenCode Go route. `settings.yaml` names this provider
   * `opencodego-deepseek`, and its credential is `OPENCODEGO_API_KEY`; the id
   * here is the plugin's own key, and the browser half renders one pill per
   * configured id without consulting the session's selected route.
   */
  'deepseek-go': Object.freeze({
    kind: 'plan',
    displayName: 'OpenCode Go',
    apiKeyEnv: 'OPENCODEGO_API_KEY',
    usageUrl: DEFAULT_OPENCODE_GO_USAGE_URL,
    rollingLabel: '5 小时',
  }),
  deepseek: Object.freeze({
    kind: 'tokens',
    displayName: 'DeepSeek 官方',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    balanceUrl: DEFAULT_DEEPSEEK_BALANCE_URL,
    currency: 'CNY',
  }),
})

/** Top-level config defaults. */
const DEFAULT_CONFIG = Object.freeze({
  requestTimeoutMs: 10000,
  maxResponseBytes: 65536,
  /**
   * The staleness floor for a fetched snapshot, and the host's balance sampling
   * period. Both are the same question — how old a picture of the account may
   * be — so both ride one value: the scheduled sample refills the cache the
   * route reads, and a request inside the floor is answered from memory rather
   * than reaching a provider a second time.
   */
  cacheMs: 60000,
})

/** On-disk balance series format. */
export const STATE_VERSION = 1

/** Retained samples per provider: one local day at the fastest sensible period. */
const MAX_SAMPLES = 4096

/** Tolerance for a sample timestamped slightly ahead of the reading host's clock. */
const CLOCK_SKEW_MS = 60000

/**
 * Resolve the default balance-series file under the harness home.
 *
 * Mirrors the harness precedence (`$DSH_HOME`, else `~/.dsh`) without importing
 * `@deepseek-ai/dsh-home-paths`, which this package may not resolve. A blank
 * `$DSH_HOME` counts as unset so it never resolves under the working directory.
 * @param env - environment mapping read for `DSH_HOME`.
 * @param home - the OS home directory used when `DSH_HOME` is unset.
 * @returns the absolute path of the balance-series file.
 */
function defaultStatePath(env = process.env, home = homedir()) {
  const configured = env.DSH_HOME
  const root = configured !== undefined && configured.trim() !== '' ? configured : join(home, '.dsh')
  return join(root, 'account-quota', 'state.json')
}

/**
 * The local calendar day of an epoch timestamp, as `YYYY-MM-DD`.
 *
 * The day boundary is the reading machine's own: DeepSeek bills in its own
 * timezone, and a daily delta is only meaningful against a boundary the reader
 * can see on their own clock.
 * @param epochMs - epoch milliseconds.
 * @returns the local calendar day key.
 */
export function localDay(epochMs) {
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** An empty balance series. */
function emptyState() {
  return { version: STATE_VERSION, providers: {} }
}

/**
 * Read the balance series, treating every unreadable file as a first run.
 *
 * A missing, truncated, hand-edited, or foreign-version file must not take the
 * ambient reading down with it: the balance itself is still served, and only
 * the daily delta restarts.
 * @param file - absolute path of the balance-series file.
 * @returns the parsed series, or an empty one.
 */
async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.version !== STATE_VERSION) return emptyState()
    if (typeof parsed.providers !== 'object' || parsed.providers === null) return emptyState()
    return parsed
  } catch {
    // Absent file, unreadable permissions, and invalid JSON are the same
    // answer here: there is no series to fold yet.
    return emptyState()
  }
}

/**
 * Replace the balance-series file atomically.
 *
 * The write lands through a rename from a process-unique temporary name, so a
 * reader — including a second host process folding the same account — sees
 * either the whole previous file or the whole next one.
 * @param file - absolute path of the balance-series file.
 * @param state - the complete series to persist.
 */
async function writeState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, 'utf8')
  await rename(temporary, file)
}

/**
 * Union stored samples with a fresh one, keeping only the given local day.
 *
 * Merging by timestamp rather than overwriting is what lets two host processes
 * share one file: each folds in every sample the other recorded, and a repeated
 * write of the same instant stays a single sample. Everything outside today is
 * dropped, which is both the day rollover and the pruning rule.
 * @param existing - samples already stored for this provider.
 * @param incoming - samples read in this refresh.
 * @param day - the local day to keep, as `YYYY-MM-DD`.
 * @param now - current epoch ms, bounding timestamps from a clock that ran ahead.
 * @returns the merged samples, ascending by time.
 */
function mergeSamples(existing, incoming, day, now) {
  const byTime = new Map()
  for (const sample of [...existing, ...incoming]) {
    if (!Number.isFinite(sample?.t) || !Number.isFinite(sample?.v)) continue
    if (sample.t > now + CLOCK_SKEW_MS) continue
    if (localDay(sample.t) !== day) continue
    byTime.set(sample.t, { t: sample.t, v: sample.v })
  }
  const merged = [...byTime.values()].sort((left, right) => left.t - right.t)
  return merged.length > MAX_SAMPLES ? merged.slice(merged.length - MAX_SAMPLES) : merged
}

/**
 * Fold one local day of balance samples into spend and top-ups.
 *
 * Each step between consecutive samples is attributed by the sign of its change:
 * a drop is spend, a rise is a recharge. The step across a gap is attributed to
 * the interval it was measured over, never to a hypothetical rate inside it.
 * @param samples - ascending samples for one provider, all from the same day.
 * @returns the day's reading, or null when the day has no sample yet.
 */
function summarizeDay(samples) {
  if (samples.length === 0) return null
  let spend = 0
  let topUp = 0
  for (let index = 1; index < samples.length; index += 1) {
    const drop = samples[index - 1].v - samples[index].v
    if (drop > 0) spend += drop
    else topUp -= drop
  }
  const round = (value) => Math.round(value * 100) / 100
  return {
    spend: round(spend),
    topUp: round(topUp),
    since: new Date(samples[0].t).toISOString(),
    samples: samples.length,
  }
}

/** One validated plan usage window from an upstream body. */
function parsePlanWindow(value, label) {
  if (typeof value !== 'object' || value === null) throw new Error(`usage.${label} must be an object`)
  if (value.status !== 'ok' && value.status !== 'rate-limited') {
    throw new Error(`usage.${label}.status must be "ok" or "rate-limited"`)
  }
  if (!Number.isInteger(value.percent) || value.percent < 0 || value.percent > 100) {
    throw new Error(`usage.${label}.percent must be an integer between 0 and 100`)
  }
  if (typeof value.resetsAt !== 'string' || Number.isNaN(Date.parse(value.resetsAt))) {
    throw new Error(`usage.${label}.resetsAt must be a parseable ISO timestamp`)
  }
  return { status: value.status, percent: value.percent, resetsAt: value.resetsAt }
}

/** Validate an OpenCode-Go-style plan body and return the three windows. */
function parsePlanBody(body) {
  if (typeof body !== 'object' || body === null || typeof body.usage !== 'object' || body.usage === null) {
    throw new Error('plan usage response must carry a usage object')
  }
  const windows = {}
  for (const window of PLAN_WINDOWS) {
    windows[window] = parsePlanWindow(body.usage[window], window)
  }
  return windows
}

/** Validate a DeepSeek-style balance body and return the selected currency row. */
function parseBalanceBody(body, preferredCurrency) {
  if (typeof body !== 'object' || body === null || !Array.isArray(body.balance_infos)) {
    throw new Error('balance response must carry a balance_infos array')
  }
  const rows = body.balance_infos
    .filter(row => typeof row === 'object' && row !== null && typeof row.currency === 'string')
    .map(row => ({
      currency: row.currency,
      totalBalance: row.total_balance,
      grantedBalance: row.granted_balance,
      toppedUpBalance: row.topped_up_balance,
    }))
  if (rows.length === 0) throw new Error('balance response carries no usable balance rows')
  const preferred = rows.find(row => row.currency === preferredCurrency)
  const nonZero = rows.find(row => Number(row.totalBalance) > 0)
  const selected = preferred ?? nonZero ?? rows[0]
  const number = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return {
    currency: selected.currency,
    totalBalance: number(selected.totalBalance),
    grantedBalance: number(selected.grantedBalance),
    toppedUpBalance: number(selected.toppedUpBalance),
  }
}

/** Read a bounded error message from an upstream error body without echoing credentials. */
function upstreamErrorMessage(text) {
  try {
    const body = JSON.parse(text)
    if (typeof body?.error?.message === 'string' && body.error.message.trim() !== '') {
      return body.error.message.trim().slice(0, 300)
    }
  } catch {
    // Non-JSON error body: fall through to the HTTP status message.
  }
  return undefined
}

function assertCredentialRef(value) {
  if (typeof value !== 'string' || !CREDENTIAL_REF_PATTERN.test(value)) {
    throw new Error(`apiKeyEnv must match ${String(CREDENTIAL_REF_PATTERN)}`)
  }
}

function assertHttpUrl(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${field} must be an absolute URL`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${field} must use http or https`)
  }
}

function normalizeProvider(id, entry) {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`providers.${id} must be an object`)
  }
  if (entry.kind !== 'plan' && entry.kind !== 'tokens') {
    throw new Error(`providers.${id}.kind must be "plan" or "tokens"`)
  }
  assertCredentialRef(entry.apiKeyEnv)
  const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
    ? entry.displayName.trim()
    : id
  const normalized = {
    kind: entry.kind,
    displayName,
    apiKeyEnv: entry.apiKeyEnv,
  }
  if (entry.kind === 'plan') {
    assertHttpUrl(entry.usageUrl, `providers.${id}.usageUrl`)
    normalized.usageUrl = new URL(entry.usageUrl).toString()
    // The rolling window's length is an upstream policy, not a constant this
    // plugin owns, so the label is configurable rather than hardcoded.
    normalized.rollingLabel = typeof entry.rollingLabel === 'string' && entry.rollingLabel.trim() !== ''
      ? entry.rollingLabel.trim()
      : '滚动'
  } else {
    assertHttpUrl(entry.balanceUrl, `providers.${id}.balanceUrl`)
    normalized.balanceUrl = new URL(entry.balanceUrl).toString()
  }
  if (entry.currency !== undefined) {
    if (typeof entry.currency !== 'string' || !/^[A-Za-z]{3,8}$/.test(entry.currency)) {
      throw new Error(`providers.${id}.currency must be a 3-8 letter code`)
    }
    normalized.currency = entry.currency.toUpperCase()
  }
  return normalized
}

/**
 * Fold the user provider layer over the built-in adapters, key by key.
 *
 * Supplying `providers` **replaces** the built-in table rather than extending
 * it. Merging would keep an unconfigured default alive as a real adapter, and
 * its credential is exactly what a deployment that writes its own table does
 * not have — so every such row would sit there reporting a missing credential
 * beside the accounts the user actually configured. A deployment that wants a
 * built-in restates it, which is also what a patch entry has to do anyway.
 */
function normalizeProviders(raw) {
  const providers = {}
  const source = raw === undefined ? DEFAULT_PROVIDERS : raw
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('providers must be an object keyed by provider route')
  }
  for (const [id, entry] of Object.entries(source)) {
    providers[id] = normalizeProvider(id, { ...(DEFAULT_PROVIDERS[id] ?? {}), ...(entry ?? {}) })
  }
  if (Object.keys(providers).length === 0) {
    throw new Error('providers must name at least one provider route')
  }
  return providers
}

/** Validate and fill one raw config value. Throws on the first invalid field. */
function normalizeConfig(value) {
  const raw = typeof value === 'object' && value !== null ? value : {}
  for (const key of Object.keys(raw)) {
    if (!(key in DEFAULT_CONFIG) && key !== 'statePath' && key !== 'providers') {
      throw new Error(`unknown config key ${JSON.stringify(key)}`)
    }
  }
  const config = { ...DEFAULT_CONFIG, ...raw }
  for (const field of ['requestTimeoutMs', 'maxResponseBytes', 'cacheMs']) {
    if (!Number.isInteger(config[field]) || config[field] < 1) {
      throw new Error(`${field} must be a positive integer`)
    }
  }
  if (raw.statePath !== undefined && (typeof raw.statePath !== 'string' || raw.statePath.trim() === '')) {
    throw new Error('statePath must be a non-empty path string')
  }
  config.statePath = raw.statePath ?? defaultStatePath()
  config.providers = normalizeProviders(raw.providers)
  return config
}

/** Standard-schema validator cordis calls through `Config['~standard'].validate`. */
const standardConfig = {
  version: 1,
  vendor: 'dsh-account-quota',
  validate(value) {
    try {
      return { value: normalizeConfig(value) }
    } catch (error) {
      return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
    }
  },
}

/** Cordis plugin config schema (callable normalizer + standard-schema face). */
export const Config = function Config(value) {
  return normalizeConfig(value)
}
Config['~standard'] = standardConfig

/**
 * Fetch the provider endpoints on demand and serve the snapshot on one exact
 * HTTP route.
 *
 * Both configured adapters are queried on every refresh and answered
 * independently: one credential missing or one endpoint failing leaves the
 * other's data in place, rather than blanking the whole reading.
 * @param ctx - cordis context carrying the injected services.
 * @param config - plugin config; defaults and validation are applied here too.
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)

  /**
   * Provider ids this deployment actually shows, in display order: balances
   * first (the account's money is the headline), then plan limits. The browser
   * half renders one entry per id.
   */
  const shownProviders = Object.keys(resolved.providers).sort((left, right) => {
    const rank = (id) => (resolved.providers[id].kind === 'tokens' ? 0 : 1)
    return rank(left) - rank(right)
  })

  let snapshot = {
    fetchedAt: null,
    providers: shownProviders.map(id => ({
      id,
      kind: resolved.providers[id].kind,
      displayName: resolved.providers[id].displayName,
      rollingLabel: resolved.providers[id].rollingLabel,
      status: 'idle',
      plan: null,
      balance: null,
      error: null,
    })),
  }

  /** Monotonic fetch counter: a slow refresh must not overwrite a newer one. */
  let refreshGeneration = 0
  /** Snapshot served while it is younger than `cacheMs`. */
  let cacheStamp = 0
  /** Last balance series read from disk or written by this process. */
  let sampleState = emptyState()
  /** Last warning per source, so a persistent failure logs once instead of ticking. */
  const warned = new Map()

  /**
   * Log a repeated failure once, and again only when its message changes.
   *
   * The sampler runs for the life of the process, so an unreachable endpoint
   * would otherwise write the same line every `cacheMs`.
   * @param source - the failing step, as a stable key.
   * @param message - the message to log when it differs from the last one.
   */
  function warnOnce(source, message) {
    if (warned.get(source) === message) return
    warned.set(source, message)
    ctx.logger?.warn?.(`account-quota: ${message}`)
  }

  /**
   * Read a response body, stopping the transfer once it passes the cap.
   *
   * `response.text()` would buffer the whole body before any size check could
   * reject it, so a provider that answers with an unbounded stream would grow
   * this process without limit.
   * @param response - the upstream response.
   * @param maxBytes - the largest body this plugin accepts.
   * @returns the decoded body text.
   */
  async function readBoundedBody(response, maxBytes) {
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw failure('RESPONSE_TOO_LARGE', '提供方响应超过 maxResponseBytes')
    }
    const chunks = []
    let size = 0
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw failure('RESPONSE_TOO_LARGE', '提供方响应超过 maxResponseBytes')
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  /** One credential-resolved, bounded JSON GET against a provider endpoint. */
  async function fetchProviderJson(url, apiKeyEnv) {
    const hit = await ctx.credentials.resolve(apiKeyEnv)
    if (hit === undefined) {
      throw failure('MISSING_CREDENTIAL', `凭据 ${apiKeyEnv} 未配置`)
    }
    const controller = new AbortController()
    // The timer covers the body read as well as the request: a provider that
    // sends its headers and then stalls would otherwise leave `refresh()`
    // pending forever, and the sampler's in-flight guard would stop sampling
    // for the rest of the process's life.
    const timeout = setTimeout(() => { controller.abort() }, resolved.requestTimeoutMs)
    let response
    let text
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${hit.value}`,
          'User-Agent': 'dsh-account-quota/0.7.0',
        },
        redirect: 'error',
        signal: controller.signal,
      })
      text = await readBoundedBody(response, resolved.maxResponseBytes)
    } catch (error) {
      // A failure this module raised — the size cap, say — keeps its own code
      // and message; everything else here is transport.
      if (error?.[failureMark] === true) throw error
      const aborted = error?.name === 'AbortError'
      throw failure(
        aborted ? 'TIMEOUT' : 'FETCH_FAILED',
        aborted ? '提供方接口超时' : '无法连接提供方接口',
      )
    } finally {
      clearTimeout(timeout)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw failure('INVALID_JSON', '提供方接口未返回 JSON')
    }
    if (!response.ok) {
      throw failure(
        httpErrorCode(response.status),
        upstreamErrorMessage(text) ?? `提供方接口返回 HTTP ${response.status}`,
      )
    }
    return body
  }

  /** Query one adapter, returning the reading or the structured failure. */
  async function readProvider(id) {
    const provider = resolved.providers[id]
    const base = {
      id,
      kind: provider.kind,
      displayName: provider.displayName,
      rollingLabel: provider.rollingLabel,
    }
    try {
      if (provider.kind === 'plan') {
        const body = await fetchProviderJson(provider.usageUrl, provider.apiKeyEnv)
        const windows = parsePlanBody(body)
        const limited = PLAN_WINDOWS.some(window => windows[window].status === 'rate-limited')
        return { ...base, status: limited ? 'rate-limited' : 'ok', plan: windows, balance: null, error: null }
      }
      const body = await fetchProviderJson(provider.balanceUrl, provider.apiKeyEnv)
      const balance = parseBalanceBody(body, provider.currency)
      return { ...base, status: 'ok', plan: null, balance, error: null }
    } catch (error) {
      return {
        ...base,
        status: 'error',
        plan: null,
        balance: null,
        error: error?.[failureMark] === true
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL_ERROR', message: error?.message ?? String(error) },
      }
    }
  }

  /**
   * Append this refresh's balance readings to the persisted series.
   *
   * The file is re-read before every write so a second host process folding the
   * same account contributes its samples instead of being overwritten by them.
   * A series that cannot be written still yields the in-memory fold, so the row
   * stays correct for this process even on a read-only filesystem.
   * @param readings - this refresh's provider readings.
   * @param now - the timestamp every sample in this refresh is recorded at.
   * @returns the series as it now stands in memory.
   */
  async function recordSamples(readings, now) {
    const day = localDay(now)
    const fresh = new Map()
    for (const reading of readings) {
      if (reading.kind !== 'tokens' || reading.balance === null) continue
      fresh.set(reading.id, { t: now, v: reading.balance.totalBalance })
    }
    const stored = await readState(resolved.statePath)
    const providers = {}
    for (const id of shownProviders) {
      // This process's own series joins the merge rather than being replaced by
      // the file's: when the file cannot be written, the host must still
      // accumulate across its own ticks instead of folding each reading against
      // an empty store. Both sides pass the same day and clock filters, so a
      // sample dropped on disk cannot resurrect through memory.
      const carried = sampleState.providers[id] ?? []
      const incoming = fresh.has(id) ? [fresh.get(id)] : []
      const merged = mergeSamples([...carried, ...(stored.providers[id] ?? [])], incoming, day, now)
      if (merged.length > 0) providers[id] = merged
    }
    sampleState = { version: STATE_VERSION, providers }
    try {
      await writeState(resolved.statePath, sampleState)
    } catch (error) {
      warnOnce('state', `余额序列写入 ${resolved.statePath} 失败，本次仅保留在内存：${error?.message ?? error}`)
    }
    return sampleState
  }

  /** Attach the folded local day to one balance reading. */
  function readingWithToday(reading) {
    if (reading.balance === null) return reading
    const today = summarizeDay(sampleState.providers[reading.id] ?? [])
    return { ...reading, balance: { ...reading.balance, today } }
  }

  /** Refresh every adapter in parallel, record the samples, and publish one snapshot. */
  async function refresh() {
    const generation = ++refreshGeneration
    const readings = await Promise.all(shownProviders.map(id => readProvider(id)))
    if (generation !== refreshGeneration) return
    const now = Date.now()
    await recordSamples(readings, now)
    snapshot = { fetchedAt: new Date(now).toISOString(), providers: readings.map(readingWithToday) }
    cacheStamp = now
  }

  // The sampler, not the browser, owns the clock. A daily delta needs a sample
  // taken near local midnight, and a request-driven refresh stops entirely
  // while no tab is open — which is exactly when the overnight step happens.
  // It shares `refresh()` with the route on purpose: one freshness floor, one
  // code path, and the cached snapshot a GET reads is the one it just filled.
  ctx.effect(() => {
    let stopped = false
    let inFlight = false
    const sample = async () => {
      if (stopped || inFlight) return
      inFlight = true
      try {
        await refresh()
      } catch (error) {
        warnOnce('refresh', `刷新失败：${error?.message ?? error}`)
      } finally {
        inFlight = false
      }
    }
    // Sampling at mount, not after one period: a host started at 00:05 should
    // anchor the new day then, not a minute later.
    void sample()
    const timer = setInterval(() => { void sample() }, resolved.cacheMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'account-quota: balance sampler')

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: QUOTA_ROUTE_PATH,
      // The sampler keeps the snapshot inside `cacheMs`, so this handler
      // normally answers from memory and the staleness check is the fallback
      // for a cleared sampler. HEAD never refetches, so a probe cannot drive
      // traffic to the provider.
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' })
          res.end()
          return
        }
        if (req.method === 'GET' && Date.now() - cacheStamp >= resolved.cacheMs) {
          await refresh().catch(error => {
            warnOnce('route', `刷新失败：${error?.message ?? error}`)
          })
        }
        const body = JSON.stringify(snapshot)
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(body)
      },
    })
    return () => { disposeRoute() }
  }, 'account-quota: HTTP route')
}

function httpErrorCode(status) {
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'NOT_ENTITLED'
  if (status === 429) return 'UPSTREAM_RATE_LIMITED'
  return 'HTTP_ERROR'
}
