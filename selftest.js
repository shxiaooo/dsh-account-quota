/**
 * Self-test for the account-quota row.
 *
 * It drives the real `apply()` from lib/index.js against a stand-in Context, a
 * stubbed `fetch` answering from a mutable balance, and a clock this file owns.
 * Every assertion reads a snapshot the plugin actually produced, or the file it
 * actually wrote; nothing here re-implements the fold.
 *
 * The client half is not covered: rendering it needs React, which a `link:`
 * install cannot resolve from this directory. Its text is checked by hand with
 * `renderToStaticMarkup` against a real snapshot instead.
 *
 * Run: node selftest.js
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, QUOTA_ROUTE_PATH, STATE_VERSION, localDay } from './lib/index.js'

const work = mkdtempSync(join(tmpdir(), 'account-quota-selftest-'))
const statePath = join(work, 'state.json')

const realNow = Date.now
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const realFetch = globalThis.fetch

/** The clock every sample is stamped with; tests move it explicitly. */
let clock = Date.parse('2026-09-12T09:12:00+08:00')
const timers = []
let applying = null
Date.now = () => clock
// The plugin's sampler is captured rather than scheduled, so a test runs one
// host's tick at a chosen instant instead of waiting for one. Each timer is
// tagged with the Context whose apply() registered it, so a two-host test can
// drive either host rather than whichever registered first.
globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms, owner: applying }); return timers.length }
globalThis.clearInterval = () => {}

/** The account balance the stubbed endpoint reports. */
let balance = 12.34
let balanceCalls = 0
const jsonResponse = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

globalThis.fetch = async (url) => {
  if (String(url).includes('api.deepseek.com')) {
    balanceCalls += 1
    const amount = balance.toFixed(2)
    return jsonResponse({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: amount, granted_balance: '0.00', topped_up_balance: amount }],
    })
  }
  const window = { status: 'ok', percent: 10, resetsAt: new Date(clock + 3600000).toISOString() }
  return jsonResponse({ usage: { rolling: window, weekly: window, monthly: window } })
}

const CREDENTIALS = { DEEPSEEK_API_KEY: 'deepseek-test', OPENCODEGO_API_KEY: 'opencode-test' }

/** A stand-in Context: real service surfaces, no cordis runtime. */
function makeContext() {
  const routes = []
  const warnings = []
  const disposers = []
  return {
    routes,
    warnings,
    disposers,
    logger: { warn: (message) => warnings.push(message) },
    credentials: {
      resolve: async (name) => (CREDENTIALS[name] === undefined ? undefined : { value: CREDENTIALS[name] }),
    },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
}

/** Let the plugin's pending fetch and file IO finish. */
async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) await new Promise(resolve => setTimeout(resolve, 1))
}

/** Mount the row on one host, attributing its sampler timer to that host. */
function applyHost(ctx, config = CONFIG) {
  applying = ctx
  apply(ctx, config)
  applying = null
}

/** Run one named host's scheduled sample and wait for it to land. */
async function tick(ctx) {
  timers.find(timer => timer.owner === ctx && timer.ms === 60000).fn()
  await settle()
}

/** Issue one GET against the route the browser half uses. */
async function get(ctx) {
  const route = ctx.routes.find(candidate => candidate.path === QUOTA_ROUTE_PATH)
  const chunks = []
  const res = {
    status: null,
    writeHead(status) { this.status = status },
    end(chunk) { if (chunk !== undefined) chunks.push(chunk) },
  }
  await route.handler({ method: 'GET' }, res)
  return JSON.parse(chunks.join(''))
}

const CONFIG = {
  statePath,
  providers: {
    'deepseek-go': {
      kind: 'plan',
      displayName: 'OpenCode Go',
      apiKeyEnv: 'OPENCODEGO_API_KEY',
      usageUrl: 'https://opencode.ai/zen/go/v1/usage',
      rollingLabel: '5 小时',
    },
    deepseek: {
      kind: 'tokens',
      displayName: 'DeepSeek 官方',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      balanceUrl: 'https://api.deepseek.com/user/balance',
      currency: 'CNY',
    },
  },
}

const readStateFile = () => JSON.parse(readFileSync(statePath, 'utf8'))
const entryOf = (snapshot, id) => snapshot.providers.find(entry => entry.id === id)
const balanceOf = (snapshot) => entryOf(snapshot, 'deepseek').balance
const planOf = (snapshot) => entryOf(snapshot, 'deepseek-go').plan

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const rejects = (config) => {
  try {
    Config(config)
    return null
  } catch (error) {
    return error.message
  }
}

console.log('config')
check('the removed refreshMs key is rejected rather than ignored',
  /unknown config key "refreshMs"/.test(rejects({ ...CONFIG, refreshMs: 30000 }) ?? ''),
  rejects({ ...CONFIG, refreshMs: 30000 }))
check('an unknown key is rejected', /unknown config key "nope"/.test(rejects({ ...CONFIG, nope: 1 }) ?? ''))
check('an empty statePath is rejected', /statePath must be a non-empty/.test(rejects({ ...CONFIG, statePath: '  ' }) ?? ''))
check('a non-string statePath is rejected', /statePath must be a non-empty/.test(rejects({ ...CONFIG, statePath: 7 }) ?? ''))
check('an omitted statePath resolves under the harness home',
  /account-quota[\\/]state\.json$/.test(Config({ requestTimeoutMs: 10000, maxResponseBytes: 65536, cacheMs: 60000 }).statePath))
check('a zero cacheMs is rejected', /cacheMs must be a positive integer/.test(rejects({ ...CONFIG, cacheMs: 0 }) ?? ''))
check('an empty providers table is rejected',
  /at least one provider route/.test(rejects({ ...CONFIG, providers: {} }) ?? ''))

console.log('the first sample of a day')
const first = makeContext()
applyHost(first)
await settle()
const boot = await get(first)
check('the sampler runs at mount, not one period later', balanceCalls > 0)
check('the balance is reported', balanceOf(boot)?.totalBalance === 12.34, JSON.stringify(balanceOf(boot)))
check('a day with one sample has spent nothing', balanceOf(boot)?.today?.spend === 0, JSON.stringify(balanceOf(boot)?.today))
check('the day counts its sample', balanceOf(boot)?.today?.samples === 1)
check('the series starts at the first sample of the day',
  balanceOf(boot)?.today?.since === new Date(clock).toISOString(), balanceOf(boot)?.today?.since)
check('the sample reaches disk', readStateFile().providers.deepseek.length === 1)
check('the file carries the current format', readStateFile().version === STATE_VERSION)
check('the plan provider keeps no series', readStateFile().providers['deepseek-go'] === undefined)

console.log('spend accumulates between samples')
clock += 60000
balance = 12.29
await tick(first)
const spent = await get(first)
check('a drop is spend', balanceOf(spent)?.today?.spend === 0.05, JSON.stringify(balanceOf(spent)?.today))
check('spend does not move the balance reading itself', balanceOf(spent)?.totalBalance === 12.29)
check('two drops add up', await (async () => {
  clock += 60000
  balance = 12.21
  await tick(first)
  return (await get(first)).providers.find(entry => entry.id === 'deepseek').balance.today.spend === 0.13
})())

console.log('a top-up is not negative spend')
clock += 60000
balance = 22.21
await tick(first)
const topped = await get(first)
check('the day still reports the same spend', balanceOf(topped)?.today?.spend === 0.13, JSON.stringify(balanceOf(topped)?.today))
check('the rise is reported as a top-up', balanceOf(topped)?.today?.topUp === 10, JSON.stringify(balanceOf(topped)?.today))
check('the series keeps every sample', balanceOf(topped)?.today?.samples === 4)

console.log('the midnight step is discarded, not split')
clock += 60000
balance = 22.11
await tick(first)
check('spending before midnight still counts', balanceOf(await get(first)).today.spend === 0.23)

const beforeMidnight = clock
clock = Date.parse('2026-09-13T00:01:00+08:00')
balance = 20
await tick(first)
const rolled = await get(first)
check('the day rolled over', localDay(clock) === '2026-09-13' && localDay(beforeMidnight) === '2026-09-12')
check('the new day starts at zero', balanceOf(rolled)?.today?.spend === 0, JSON.stringify(balanceOf(rolled)?.today))
check('the drop across midnight is not attributed to the new day', balanceOf(rolled)?.totalBalance === 20)
check('the series holds only today', balanceOf(rolled)?.today?.samples === 1)
check('yesterday is pruned from the file', readStateFile().providers.deepseek.length === 1)
check('yesterday is gone even from a stale in-memory fold', readStateFile().providers.deepseek[0].v === 20)

console.log('a second host process folds the same series')
const second = makeContext()
applyHost(second)
await settle()
clock += 60000
balance = 19.5
await tick(second)
const seenBySecond = await get(second)
check('the second host records its own sample', balanceOf(seenBySecond).today.samples === 2, JSON.stringify(balanceOf(seenBySecond).today))
check('the second host starts from the first host\'s series', balanceOf(seenBySecond).today.since === new Date(clock - 60000).toISOString())
check('the second host folds both drops', balanceOf(seenBySecond).today.spend === 0.5, JSON.stringify(balanceOf(seenBySecond).today))
clock += 60000
balance = 19.4
await tick(first)
const merged = await get(first)
check('the first host picks up the second host\'s sample', balanceOf(merged).today.samples === 3, JSON.stringify(balanceOf(merged).today))
check('the merged fold counts every drop', balanceOf(merged).today.spend === 0.6, JSON.stringify(balanceOf(merged).today))
check('both hosts agree', balanceOf(await get(second)).today.spend === 0.6)
check('the file holds only the union', readStateFile().providers.deepseek.length === 3, JSON.stringify(readStateFile().providers.deepseek))

console.log('a damaged or foreign series file')
// Fresh hosts, so these assertions read what the file said rather than what a
// long-running process already had in memory.
writeFileSync(statePath, '{ this is not json')
clock += 60000
balance = 19.3
const corrupt = makeContext()
applyHost(corrupt)
await settle()
const recovered = await get(corrupt)
check('a truncated file does not blank the reading', balanceOf(recovered).totalBalance === 19.3)
check('a truncated file restarts the day at zero', balanceOf(recovered).today.spend === 0, JSON.stringify(balanceOf(recovered).today))
check('a truncated file is rewritten', readStateFile().version === STATE_VERSION)
check('the rewritten file holds only the fresh sample', readStateFile().providers.deepseek.length === 1)

const future = clock + 300000
writeFileSync(statePath, JSON.stringify({
  version: STATE_VERSION,
  providers: {
    unknown: [{ t: clock, v: 1 }],
    deepseek: [{ t: clock - 86400000, v: 99 }, { t: future, v: 99 }],
  },
}))
clock += 60000
balance = 19.2
const foreign = makeContext()
applyHost(foreign)
await settle()
const cleaned = await get(foreign)
check('a provider no longer configured is dropped', readStateFile().providers.unknown === undefined)
check('a sample from yesterday is dropped', readStateFile().providers.deepseek.length === 1, JSON.stringify(readStateFile().providers.deepseek))
check('a timestamp ahead of the clock is dropped', readStateFile().providers.deepseek.every(sample => sample.t !== future))
check('the surviving sample is this refresh\'s', readStateFile().providers.deepseek[0].v === 19.2, JSON.stringify(readStateFile().providers.deepseek))
check('the dropped samples never reach the fold',
  balanceOf(cleaned).today.samples === 1 && balanceOf(cleaned).today.spend === 0, JSON.stringify(balanceOf(cleaned).today))

console.log('an unwritable series file')
const blocked = makeContext()
const blockedPath = join(work, 'blocked')
writeFileSync(blockedPath, 'not a directory')
applyHost(blocked, { ...CONFIG, statePath: join(blockedPath, 'state.json') })
await settle()
const unwritten = await get(blocked)
check('the reading is still served', balanceOf(unwritten).totalBalance === 19.2)
check('the in-memory fold still works', balanceOf(unwritten).today.spend === 0, JSON.stringify(balanceOf(unwritten).today))
check('the failure is logged once', blocked.warnings.length === 1, JSON.stringify(blocked.warnings))
check('the log names the path', /blocked/.test(blocked.warnings[0] ?? ''), blocked.warnings[0])
clock += 60000
balance = 19
await tick(blocked)
check('a repeated failure does not repeat the log', blocked.warnings.length === 1, JSON.stringify(blocked.warnings))
check('an unwritable series still accumulates in memory',
  balanceOf(await get(blocked)).today.spend === 0.2, JSON.stringify(balanceOf(await get(blocked)).today))

console.log('a failing provider')
const seriesBefore = readFileSync(statePath, 'utf8')
const broken = makeContext()
const resolveCredential = broken.credentials.resolve
broken.credentials.resolve = async (name) => (name === 'DEEPSEEK_API_KEY' ? undefined : resolveCredential(name))
applyHost(broken)
await settle()
const missing = await get(broken)
check('a missing credential is reported as an error', entryOf(missing, 'deepseek').status === 'error')
check('a failed provider carries no day', balanceOf(missing) === null)
check('the other provider still answers', planOf(missing) !== null)
check('a failed provider leaves the series untouched', readFileSync(statePath, 'utf8') === seriesBefore)

console.log('a provider that stalls its response body')
// The timeout has to cover the body read, not just the request: a provider
// that sends headers and then stalls would otherwise leave `refresh()`
// pending, and the sampler's in-flight guard would never release.
const stalling = makeContext()
const healthyFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.deepseek.com')) return healthyFetch(url, init)
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"balance_infos":'))
      init.signal.addEventListener('abort', () => {
        controller.error(new DOMException('This operation was aborted', 'AbortError'))
      })
    },
  }), { status: 200 })
}
applyHost(stalling, { ...CONFIG, requestTimeoutMs: 40 })
await new Promise(resolve => setTimeout(resolve, 120))
const stalled = await get(stalling)
check('a stalled body times out instead of hanging',
  entryOf(stalled, 'deepseek').error?.code === 'TIMEOUT', JSON.stringify(entryOf(stalled, 'deepseek').error))
check('the stalled provider leaves the plan provider alone', planOf(stalled) !== null)
globalThis.fetch = healthyFetch
clock += 60000
balance = 21
await tick(stalling)
check('the sampler resumes after a timed-out response',
  balanceOf(await get(stalling)).totalBalance === 21, JSON.stringify(balanceOf(await get(stalling))))

console.log('an oversized response body')
// The cap must stop the transfer, not merely reject a body already buffered.
let pulled = 0
const oversized = makeContext()
globalThis.fetch = async (url, init) => {
  if (!String(url).includes('api.deepseek.com')) return healthyFetch(url, init)
  return new Response(new ReadableStream({
    pull(controller) {
      if (pulled >= 70 * 1024) {
        controller.close()
        return
      }
      pulled += 1024
      controller.enqueue(new Uint8Array(1024))
    },
  }), { status: 200 })
}
applyHost(oversized, { ...CONFIG, maxResponseBytes: 1024 })
await settle()
const capped = await get(oversized)
check('an oversized body is refused',
  entryOf(capped, 'deepseek').error?.code === 'RESPONSE_TOO_LARGE', JSON.stringify(entryOf(capped, 'deepseek').error))
check('the cap stops the read early', pulled <= 4096, `${pulled} bytes pulled`)
globalThis.fetch = healthyFetch

console.log('a malformed provider body')
const malformed = makeContext()
const window = { status: 'ok', percent: 10, resetsAt: new Date(clock + 3600000).toISOString() }
globalThis.fetch = async (url, init) => {
  if (String(url).includes('api.deepseek.com')) return healthyFetch(url, init)
  return new Response(JSON.stringify({ usage: { rolling: { ...window, percent: '10' }, weekly: window, monthly: window } }), { status: 200 })
}
applyHost(malformed)
await settle()
const invalid = await get(malformed)
check('a body failing validation is an internal error, not a foreign code',
  entryOf(invalid, 'deepseek-go').error?.code === 'INTERNAL_ERROR', JSON.stringify(entryOf(invalid, 'deepseek-go').error))
check('the validation message is published', /percent must be an integer/.test(entryOf(invalid, 'deepseek-go').error?.message ?? ''))
globalThis.fetch = healthyFetch

console.log('the HTTP route')
const callsBefore = balanceCalls
const route = first.routes.find(candidate => candidate.path === QUOTA_ROUTE_PATH)
const headChunks = []
await route.handler({ method: 'HEAD' }, { writeHead() {}, end(chunk) { if (chunk !== undefined) headChunks.push(chunk) } })
check('HEAD answers with no body', headChunks.length === 0)
check('HEAD does not refetch', balanceCalls === callsBefore)
const notAllowed = await new Promise((resolve) => {
  route.handler({ method: 'POST' }, { writeHead(status, headers) { resolve({ status, headers }) }, end() {} })
})
check('a write method is refused', notAllowed.status === 405 && notAllowed.headers.Allow === 'GET, HEAD')

for (const ctx of [first, second, corrupt, foreign, blocked, broken, stalling, oversized, malformed]) {
  for (const dispose of ctx.disposers) dispose()
}
Date.now = realNow
globalThis.setInterval = realSetInterval
globalThis.clearInterval = realClearInterval
globalThis.fetch = realFetch
rmSync(work, { recursive: true, force: true })

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
