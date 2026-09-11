/**
 * dsh-account-quota — browser half.
 *
 * One pill per provider, in the same row the session stats pills occupy,
 * matching that row's typography and color tier:
 *
 *   [DeepSeek mark ¥12.34 · 今日 -¥0.56]   [OpenCode mark 5 小时 42% · 重置于 12分]
 *
 * Each pill is its own button opening its own panel with every field the host
 * reported for that provider, including the ones the resting row omits. No
 * separator sits between the pills: the root's own 12px gap is the separation
 * the stats pills already use, and each pill separates its two figures itself.
 *
 * A panel is ui-chat's stat-dialog surface, declaration for declaration: the
 * menu skin, the heading rule, and the label/value grid below it. It is placed
 * and dismissed by the same primitives those dialogs use, from shell-seeded
 * modules, so the two agree on width, margins, layering, and close behavior
 * instead of drifting apart as two hand-rolled popovers.
 *
 * Every figure is upstream-reported or a difference between upstream readings.
 * Nothing here is folded, estimated, or inferred from local session logs, and
 * this half holds no accounting state of its own: the balance series lives in
 * the host, so every session, tab, and reload shows the same day's total — see
 * the host half's header.
 *
 * Brand marks are inlined from `@lobehub/icons-static-svg` (MIT,
 * https://github.com/lobehub/lobe-icons) as single
 * `fill="currentColor"` paths, so they inherit this row's color and hover tier
 * without any module import. A `link:`-installed package resolves bare
 * specifiers from its own real path, outside the profile's node_modules, so an
 * import here would fail at load.
 */

window.__ModuleLoader__.load({
  id: 'dsh-account-quota',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React
    const { createPortal } = require('react-dom')
    // The panel borrows ui-chat's own dialog machinery: placement and dismissal
    // come from the shared primitives rather than a second clamp and outside
    // handler re-derived here. Both specifiers are shell-seeded modules, so the
    // module table answers them and this package imports nothing.
    const { useAnchoredPosition, useDismissOnOutsidePointer } = require('@deepseek-ai/dsh-client-ui-primitives')

    const API_PATH = '/plugins/account-quota/usage'

    /**
     * How often the resting row re-reads the host snapshot. The host enforces
     * its own freshness floor, so this only decides how quickly an upstream
     * change becomes visible.
     */
    const POLL_MS = 60000

    /** Viewport margin the placement clamp keeps, copied from stat-dialog.ts. */
    const PANEL_MARGIN = 12

    /** Distance between the trigger's top edge and the panel's bottom. */
    const PANEL_GAP = 8

    /** Unplaced portal panel: hidden but laid out, so the clamp measures it. */
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }

    /** Window order in the expanded panel; the resting row shows `rolling` only. */
    const WINDOW_ROWS = [
      // `rolling` carries no label: its display name is the provider's own
      // `rollingLabel`, which the host always publishes for a plan adapter.
      { key: 'rolling' },
      { key: 'weekly', label: '每周' },
      { key: 'monthly', label: '每月' },
    ]

    /**
     * Brand marks, inlined from `@lobehub/icons-static-svg` (MIT). Each is one
     * `currentColor` path in a 24-unit box, so a mark inherits the row's text
     * color and hover tier exactly as the stats row's own icons do.
     */
    const DEEPSEEK_MARK = 'M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z'
    const OPENCODE_MARK = 'M16 6H8v12h8V6zm4 16H4V2h16v20z'

    const CSS = `
/* The composer dock is a list slot, so a second entry lands on a line below
   ui-chat's stats row. Both entries are made to share one centred line.

   Every slot render site is wrapped in a \`[data-slot]\` anchor, and that anchor
   is the row's parent. It is emitted with an INLINE \`display: contents\`, so it
   generates no box of its own and its two children are laid out as items of the
   composer region above it — a column, which stacks them. Giving the anchor a
   real box is therefore what puts both entries on one line.

   No selector outranks an inline style, so that one declaration takes
   \`!important\`. The alternative — changing the composer region's direction —
   also reflows the composer card inside it, which is how an earlier attempt
   pushed the stats row out beside the card. This rule touches only the dock. */
[data-slot='conversation.composer.dock']:has(> .dsh-aq-root) {
  display: flex !important;
  flex-wrap: wrap;
  /* The region centres its children; stretch makes this row span them. */
  align-self: stretch;
  justify-content: center;
  align-items: center;
  column-gap: 12px;
  row-gap: 0;
}
/* The stats row is built to own a whole line: \`width: 100%\` claims it, its
   \`margin: 0 auto\` absorbs every remaining pixel (an auto margin on a flex item
   takes the free space before \`justify-content\` sees it), and its 32px side
   pads would leave a further 32px beside this row. Sharing the line therefore
   needs all three neutralized on both rows, leaving the anchor's 12px gap as
   the only separation. \`[data-composer-stats]\` is the seam ui-chat's own
   stylesheet already targets, so no hashed class is named. */
[data-slot='conversation.composer.dock']:has(> .dsh-aq-root)
  > :is([data-composer-stats], .dsh-aq-root) {
  width: auto;
  margin: 0;
  padding-left: 0;
  padding-right: 0;
}
.dsh-aq-root {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  /* 4px matches the stats row's own top pad, so the two baselines agree. */
  padding-top: 4px;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}
.dsh-aq-anchor {
  display: inline-flex;
  min-width: 0;
}
.dsh-aq-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font: inherit;
  font-variant-numeric: tabular-nums;
  line-height: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.dsh-aq-pill:hover,
.dsh-aq-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-aq-mark {
  width: 14px;
  height: 14px;
  flex: none;
}
/* The pill's two figures live in one labelled span, so the separator between
   them is ordinary inline content with its own margins rather than a third flex
   item spaced by the pill's gap. Mirrors StatsPills' \`.label\`/\`.sep\` pair. */
.dsh-aq-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-aq-sep {
  color: var(--dsw-alias-separator-primary);
  margin: 0 6px;
}
.dsh-aq-limited {
  color: var(--dsw-alias-state-error-primary);
}
/* The panel is ui-chat's stat-dialog surface, declaration for declaration
   (stat-dialog.module.css): menu background, 12px radius, elevation-prominent
   shadow, 12px text at 18px leading, and the same max-content sizing between a
   300px floor and a 440px cap — each yielded to a viewport narrower than itself
   by the 12px placement margin, so the floor can never push the panel past the
   clamp. Placement comes from the shared \`useAnchoredPosition\`, so a panel near
   either window edge stops exactly where the session-stats dialogs stop. */
.dsh-aq-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: max-content;
  min-width: min(300px, calc(100vw - 24px));
  max-width: min(440px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
}
/* Heading row: the section name at the primary weight, as the stat dialogs'
   own heading has it. */
.dsh-aq-title {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.dsh-aq-title-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-aq-title-label svg {
  width: 14px;
  height: 14px;
  flex: none;
}
/* Rule under the heading, above its rows. */
.dsh-aq-title-rule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
/* Label/value grid: the label column sizes to its own text down to 76px, the
   value column takes the rest, every figure right-aligned and tabular. */
.dsh-aq-details {
  display: grid;
  grid-template-columns: minmax(76px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-aq-details dt,
.dsh-aq-details dd {
  min-width: 0;
  margin: 0;
}
.dsh-aq-details dd {
  color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
/* A value that is context rather than a figure of its own, both as a whole cell
   and as the trailing half of one. */
.dsh-aq-muted,
.dsh-aq-details dd.dsh-aq-muted {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-aq-details dd.dsh-aq-limited,
.dsh-aq-details dd.dsh-aq-error {
  color: var(--dsw-alias-state-error-primary);
}
`

    /** One brand mark as an inline SVG that inherits the current text color. */
    function Mark({ path }) {
      return h('svg', {
        className: 'dsh-aq-mark',
        viewBox: '0 0 24 24',
        fill: 'currentColor',
        fillRule: 'evenodd',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': true,
      }, h('path', { d: path }))
    }

    /** Display the upstream `—` sentinel rather than a misleading zero. */
    function formatBalance(value) {
      if (value === null || value === undefined) return '—'
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) return '—'
      return parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    }

    /** A percent is an integer upstream; anything else did not come from there. */
    function formatPercent(value) {
      return Number.isInteger(value) ? `${value}%` : '—'
    }

    /**
     * Compact remaining time: `1小时30分`, `2天6小时`, `45分`.
     * @param iso - the upstream `resetsAt` timestamp.
     * @param now - current epoch ms, so the caller's tick drives the reading.
     * @returns the remaining span, or null when the timestamp is unusable.
     */
    function formatRemaining(iso, now) {
      const target = Date.parse(iso)
      if (Number.isNaN(target)) return null
      const totalMinutes = Math.floor((target - now) / 60000)
      if (totalMinutes <= 0) return '即将重置'
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
      if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`
      return `${minutes}分`
    }

    /**
     * Today's spend as it reads after the balance: `今日 -¥0.56`, or
     * `今日 ¥0.00` when the day has a sample and nothing has been spent yet.
     * @param balance - one provider's balance reading from the host snapshot.
     * @returns the spend text, or null while the host has folded no day yet.
     */
    function spendDetail(balance) {
      const today = balance.today
      if (today === null || today === undefined) return null
      return `今日 ${today.spend > 0 ? '-' : ''}¥${formatBalance(today.spend)}`
    }

    /**
     * Local wall-clock `HH:MM` for the start of the day's balance series.
     * @param iso - the host's `since` timestamp.
     * @returns the local time, or `—` when the timestamp is unusable.
     */
    function formatClock(iso) {
      const at = new Date(Date.parse(iso))
      if (Number.isNaN(at.getTime())) return '—'
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /**
     * The resting reading for one provider, or null when it has none to show.
     *
     * Both figures a pill can carry are returned separately — the headline and
     * the second reading behind a separator — because the two pills are the
     * same shape: `¥12.34 · 今日 -¥0.56` and `5 小时 42% · 重置于 12分`.
     * @param entry - one provider reading from the host snapshot.
     * @param now - current epoch ms, driving the plan countdown.
     * @returns the headline, the text after its separator (possibly null), and
     *   whether the provider has hit its limit.
     */
    function restingReading(entry, now) {
      if (entry.status === 'error') return null
      if (entry.kind === 'tokens' && entry.balance !== null) {
        return {
          text: `¥${formatBalance(entry.balance.totalBalance)}`,
          detail: spendDetail(entry.balance),
          limited: false,
        }
      }
      if (entry.kind === 'plan' && entry.plan !== null) {
        const rolling = entry.plan.rolling
        if (rolling === undefined) return null
        const remaining = formatRemaining(rolling.resetsAt, now)
        return {
          text: `${entry.rollingLabel ?? '滚动'} ${formatPercent(rolling.percent)}`,
          detail: remaining === null ? null : `重置于 ${remaining}`,
          limited: entry.status === 'rate-limited',
        }
      }
      return null
    }

    /** The currency mark for one balance row: `¥` for CNY, the code otherwise. */
    function currencyMark(currency) {
      return currency === 'CNY' ? '¥' : String(currency)
    }

    /**
     * One provider's full reading: a heading, its rule, and every figure the
     * host published for it, in the stat dialogs' own seat.
     *
     * Every figure keeps its label: the heading names the provider only, since
     * a bare number in its right-hand seat leaves the reader to guess what it
     * counts.
     * @param props - the provider reading and the current epoch ms.
     */
    function ProviderPanel({ entry, now }) {
      const rows = []
      if (entry.status === 'error') {
        rows.push(
          h('dt', { key: 'error-label' }, '读取失败'),
          h('dd', { key: 'error-value', className: 'dsh-aq-error' }, entry.error?.message ?? '读取失败'),
        )
      } else if (entry.kind === 'tokens' && entry.balance !== null) {
        const today = entry.balance.today
        rows.push(
          h('dt', { key: 'total-label' }, '总余额'),
          h('dd', { key: 'total-value' },
            `${currencyMark(entry.balance.currency)}${formatBalance(entry.balance.totalBalance)}`),
          // The day's coverage qualifies the figure beside it, so it rides that
          // row's own LABEL — a series that began at 09:12 has not seen the
          // morning, and the row says so rather than letting a partial total
          // read as the whole day. Muted: it is context, not a second amount.
          today === null || today === undefined ? null : h('dt', { key: 'spend-label' },
            '今日消耗',
            h('span', { className: 'dsh-aq-muted' },
              ` (${formatClock(today.since)} · ${today.samples} 次采样)`)),
          today === null || today === undefined ? null : h('dd', { key: 'spend-value' },
            `¥${formatBalance(today.spend)}`),
          today === null || today === undefined || today.topUp <= 0 ? null : h('dt', { key: 'topup-label' }, '今日充值'),
          today === null || today === undefined || today.topUp <= 0 ? null : h('dd', { key: 'topup-value' },
            `¥${formatBalance(today.topUp)}`),
          h('dt', { key: 'topped-label' }, '充值'),
          h('dd', { key: 'topped-value' }, `¥${formatBalance(entry.balance.toppedUpBalance)}`),
          h('dt', { key: 'granted-label' }, '赠送'),
          h('dd', { key: 'granted-value' }, `¥${formatBalance(entry.balance.grantedBalance)}`),
        )
      } else if (entry.kind === 'plan' && entry.plan !== null) {
        for (const { key, label } of WINDOW_ROWS) {
          const window = entry.plan[key]
          if (window === undefined) continue
          const remaining = formatRemaining(window.resetsAt, now)
          rows.push(
            h('dt', { key: `${key}-label` }, key === 'rolling' ? (entry.rollingLabel ?? '滚动') : label),
            h('dd', {
              key: `${key}-value`,
              className: window.status === 'rate-limited' ? 'dsh-aq-limited' : null,
            },
              `${formatPercent(window.percent)}${remaining === null ? '' : ' · '}`,
              remaining === null ? null : h('span', { className: 'dsh-aq-muted' }, `重置于 ${remaining}`)),
          )
        }
      }
      if (rows.length === 0) return null
      return h(React.Fragment, null,
        h('div', { className: 'dsh-aq-title' },
          h('span', { className: 'dsh-aq-title-label' },
            h(Mark, { path: entry.kind === 'tokens' ? DEEPSEEK_MARK : OPENCODE_MARK }),
            entry.displayName)),
        h('div', { className: 'dsh-aq-title-rule', 'aria-hidden': true }),
        h('dl', { className: 'dsh-aq-details' }, ...rows),
      )
    }

    /**
     * The ambient balance/limit reading mounted under the composer card.
     * @param props - the dock slot's standard props.
     */
    function QuotaReading({ useSessions }) {
      // A session switch is a cheap signal that the account state may have
      // moved, so the resting row re-reads then as well as on its own tick.
      const currentSessionId = typeof useSessions === 'function' ? useSessions(state => state.current) : undefined
      const [data, setData] = useState(null)
      // Which provider's panel is open, by id. One at a time: the two pills are
      // separate controls with separate panels, so "open" is not a row state.
      const [openId, setOpenId] = useState(null)
      const [now, setNow] = useState(() => Date.now())
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      /**
       * One anchor ref per provider id, holding that pill's element.
       *
       * The placement effect keys on the ref OBJECT, not on what it points at:
       * a single shared ref would keep its identity while its `current` moved
       * from one pill to the next, so opening a second pill straight from the
       * first would leave the panel where the first one sat. Handing each pill
       * its own object is what makes a switch a placement change.
       */
      const anchors = useRef({})
      const closedAnchor = useRef(null)
      const anchorFor = (id) => (anchors.current[id] ??= { current: null })

      /** Stable close callback: the dismissal effect resubscribes when it changes. */
      const closePanel = useCallback(() => { setOpenId(null) }, [])

      const load = useCallback((signal) => {
        fetch(API_PATH, { cache: 'no-store', headers: { Accept: 'application/json' }, signal })
          .then(async (response) => {
            if (signal.aborted) return
            try {
              const next = JSON.parse(await response.text())
              if (!signal.aborted) setData(next)
            } catch {
              // A malformed body leaves the previous reading in place; the row
              // is ambient and must never blank itself on a bad response.
            }
          })
          .catch(() => {
            // Network and abort failures are equally non-fatal here.
          })
      }, [])

      useEffect(() => {
        const controller = new AbortController()
        load(controller.signal)
        return () => { controller.abort() }
      }, [load, currentSessionId])

      useEffect(() => {
        let inFlight = null
        const timer = setInterval(() => {
          // A tick that finds the previous request still running cancels it:
          // its answer is about to be superseded anyway.
          inFlight?.abort()
          const controller = new AbortController()
          inFlight = controller
          load(controller.signal)
        }, POLL_MS)
        return () => {
          clearInterval(timer)
          inFlight?.abort()
        }
      }, [load])

      // The reset countdown needs its own tick: it is derived from `resetsAt`
      // against the wall clock and moves even when no new reading arrives. The
      // resting row shows it too, so the tick runs while collapsed as well.
      useEffect(() => {
        const timer = setInterval(() => { setNow(Date.now()) }, 30000)
        return () => { clearInterval(timer) }
      }, [])

      // Outside pointerdown closes; the portaled panel counts as inside. Escape
      // stays local, one listener while a panel is open.
      useDismissOnOutsidePointer(rootRef, openId !== null, closePanel, panelRef)
      useEffect(() => {
        if (openId === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpenId(null)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [openId])

      // The panel is portaled and placed by the shared primitive: above its own
      // pill, clamped to the viewport margin, and re-placed on scroll, resize,
      // and any change of the panel's own height.
      const pos = useAnchoredPosition({
        open: openId !== null,
        anchorRef: openId === null ? closedAnchor : anchorFor(openId),
        panelRef,
        side: 'top',
        gap: PANEL_GAP,
        margin: PANEL_MARGIN,
      })

      const entries = Array.isArray(data?.providers) ? data.providers : []
      if (entries.length === 0) return null
      const readings = entries.map(entry => ({ entry, reading: restingReading(entry, now) }))
      if (readings.every(item => item.reading === null)) return null
      const openEntry = entries.find(entry => entry.id === openId)

      return h('div', { className: 'dsh-aq-root', ref: rootRef },
        // One pill per provider, each its own button and its own panel. The row
        // carries no separator between them: the root's own 12px gap is the
        // same separation the stats pills use, and each pill separates its two
        // figures internally instead.
        ...readings.map(({ entry, reading }) => h('span', {
          key: entry.id,
          className: 'dsh-aq-anchor',
        },
          h('button', {
            type: 'button',
            ref: (node) => { anchorFor(entry.id).current = node },
            className: 'dsh-aq-pill',
            'aria-haspopup': 'dialog',
            'aria-expanded': openId === entry.id,
            'aria-label': `${entry.displayName} 余额与用量`,
            title: `点击查看 ${entry.displayName} 明细`,
            onClick: () => { setOpenId(current => (current === entry.id ? null : entry.id)) },
          },
            h(Mark, { path: entry.kind === 'tokens' ? DEEPSEEK_MARK : OPENCODE_MARK }),
            h('span', { className: 'dsh-aq-label' },
              h('span', { className: reading === null || !reading.limited ? null : 'dsh-aq-limited' },
                reading === null ? '—' : reading.text),
              // The second figure rides the resting row: how much of the window
              // is left is half of what the percentage means, and a day's
              // coverage is part of its total.
              reading?.detail == null ? null : h('span', { className: 'dsh-aq-sep', 'aria-hidden': true }, '·'),
              reading?.detail == null ? null : h('span', null, reading.detail),
            ),
          ),
        )),
        // Portaled to the body so the panel layers above modal overlays
        // (z 1100) instead of inside the composer's own stacking context.
        openEntry === undefined ? null : createPortal(
          h('div', {
            ref: panelRef,
            className: 'dsh-aq-panel',
            role: 'dialog',
            'aria-label': `${openEntry.displayName} 余额与用量`,
            style: pos ?? MEASURE_STYLE,
          }, h(ProviderPanel, { entry: openEntry, now })),
          document.body,
        ),
      )
    }

    /** Services required by the browser plugin; the dock seat is supplied by the layout. */
    const inject = ['slots']

    /**
     * Mount the reading into the composer dock, the ambient row below the
     * composer card that the session stats pills already occupy.
     * @param ctx - client cordis context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-account-quota')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'account-quota: styles')

      // `order: 10` places the reading after the stats pills in the same row
      // without taking their cell: `conversation.composer.dock` is a list slot,
      // so a fresh id is additive.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'account-quota-reading',
        order: 10,
        label: '账户余额与用量',
      }, QuotaReading))
    }

    exports.name = 'account-quota'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
