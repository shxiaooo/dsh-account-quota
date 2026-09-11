# dsh-account-quota

DeepSeek Harness（DSH）Web 插件：在**输入框下方的常驻行**显示账户真实余额与用量，
与同一行的会话统计胶囊（`2 轮 72 步 · 269 tok/s`）保持一致的排版和配色。

```
              [2 轮 72 步 · 269 tok/s]  [6M tok · 缓存命中 98%]   ← 会话统计（另一插件）
  [🐋 ¥12.34 · 今日 -¥0.56]   [⬛ 5 小时 42% · 重置于 12分]        ← 本插件
```

**两个胶囊各自可点**，各开各的明细面板（DeepSeek：总余额、今日消耗（后面跟着统计起点
与采样次数）、充值/赠送；
OpenCode Go：滚动、每周、每月用量与各自的重置倒计时）。胶囊**之间**没有分隔点 ——
用整行的 12px 间距分开，与统计行的两个胶囊一致；分隔点放在胶囊**内部**，
用来分开它自己的两个数字。

## 只显示上游真实数据

**卡片上每个数字都直接来自提供方 API，没有任何本地推算。** 两个适配器：

| 提供方 | kind | 数据源 | 凭据 |
|---|---|---|---|
| `deepseek` | `tokens` | `https://api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |
| `deepseek-go` | `plan` | `https://opencode.ai/zen/go/v1/usage` | `OPENCODEGO_API_KEY` |

两个接口发布的**全部**字段就是这些：

```jsonc
// GET api.deepseek.com/user/balance
{ "is_available": true,
  "balance_infos": [ { "currency": "CNY", "total_balance": "12.34",
                       "granted_balance": "0.00", "topped_up_balance": "12.34" } ] }

// GET opencode.ai/zen/go/v1/usage
{ "usage": {
    "rolling": { "status": "ok", "percent": 42, "resetsAt": "2026-03-04T09:30:00Z" },
    "weekly":  { "status": "ok", "percent": 17, "resetsAt": "2026-03-08T00:00:00Z" },
    "monthly": { "status": "ok", "percent": 65, "resetsAt": "2026-03-15T11:45:00Z" } } }
```

**两个端点都不发布 token 数或消费金额。** 探测过的其他路径
（`/user/usage`、`/dashboard/billing/usage`、`/token-usage`、`/stats`、`/quota`、`/credits`）
全部 404。

v0.5.0 因此**删除了**早期版本的本地统计：它折叠本机会话日志里的
`assistant/message.usage`，再乘一张定价表。那个数字只覆盖本机、且只在日志还在时有效，
却和覆盖全账号的服务端百分比并排显示，容易引出错误对比。

## 「今日消耗」从哪来

余额接口是唯一能反映账号级消费的数据源，而且只以**差值**的形式反映：一分钟前 `12.90`，
现在 `12.34`。所以 Host 半保存一条余额序列，把它折叠成 `balance.today`。

**记账规则** —— 当天的样本按时间排序后：

```
今日消耗 = Σ max(0, vᵢ₋₁ − vᵢ)          今日充值 = Σ max(0, vᵢ − vᵢ₋₁)
```

- 用**逐段正差值累加**，而不是「首个余额 − 当前余额」：没有充值时两者结果完全相同，
  有充值时前者才不会把一笔充值读成负消费。
- 序列**落盘**，所以刷新页面、第二个标签页、另一个会话、重启主机读到的都是同一条序列。
  Client 半不持有任何记账状态，它只是渲染 Host 折叠好的结果。
  两个 Host 进程同时写仍有极窄的「后写覆盖先写」窗口（读盘与改名之间），丢掉的
  只是中间一个样本：折叠按相邻样本的差值累加，少一个样本只是把两段并成一段，
  当天的消耗不变（除非丢的那段里正好有一笔充值）。
- 余额是**账号级**的：别的机器、脚本、官方 App 花掉的钱一样会让余额下降，
  因此都会被计入 —— 不需要任何按会话的记账。
- 跨样本区间的消耗按该区间测得的实际差值记，**不做插值**。跨本机午夜的差值直接丢弃，
  不拆分给任何一天。
- `total_balance` 只有两位小数，所以显示的数字以 ¥0.01 为步进。这是接口的分辨率，
  插件不补零、也不编造更细的小数。

**覆盖范围与它限定的那一行同排**：`balance.today.since` 是当天第一个样本的时刻，
跟在「今日消耗」这个**标签**后面 —— `今日消耗 (09:12 · 288 次采样)`，弱化色，
因为它是那一行的限定条件而不是另一个数字；金额那一列仍然只有金额。
09:12 开始的序列没有看见早晨，面板就照实说，而不是把一个残缺的合计当成全天。

## 显示内容

**常驻行**：

| 位置 | 内容 | 来源字段 |
|---|---|---|
| 第一项 | `¥12.34 · 今日 -¥0.56` | `balance_infos[].total_balance` + 当日余额序列的折叠 |
| 第二项 | `5 小时 42% · 重置于 1小时29分` | `usage.rolling.percent` + `usage.rolling.resetsAt` |

今日消耗为 0 时显示 `今日 ¥0.00`（不写 `-¥0.00`）；当天还没有样本、或余额读取失败时，
这一段整个不出现，只留余额本身。

重置倒计时由 `resetsAt - now` 实时计算，挂在常驻行上 —— 窗口还剩多久，是那个
百分比一半的含义。倒计时每 30 秒重算一次（显示精度为分钟）。

**展开面板**每个提供方一张，列出它在快照里的全部字段：

- DeepSeek 官方：总余额 / 今日消耗（`今日消耗 (09:12 · 288 次采样)`）/ 今日充值（>0 时）/ 充值 / 赠送
- OpenCode Go：滚动窗口、每周、每月百分比 + 各自的重置倒计时

面板用的是**会话统计弹窗同一套皮肤**（`ui-chat` 的 `stat-dialog`）：菜单底色、
12px 圆角、`elevation-prominent` 阴影、标题下的一条细分割线、以及
`minmax(76px, auto) minmax(0, 1fr)` 的标签/数值网格，字号 12px、行高 18px。
标题只有图标 + 提供方名 —— 每一个数字都在行里带着自己的标签，
标题右侧不放一个没有标签的裸数字。

**位置**：定位用共享的 `useAnchoredPosition`，它的 effect 依赖里包含 anchor **ref 对象
本身**，所以每个胶囊各有自己的 ref 对象 —— 若共用一个对象、只移动它的 `current`，
直接从一个胶囊点到另一个时 effect 不会重跑，面板会停在上一次打开的胶囊那里。
这条是实测出来的（jsdom 点击两个胶囊，断言两次拿到的是不同对象）。细节见下。

**宽度和位置也一致**：`width: max-content` 配合
`min-width: min(300px, calc(100vw - 24px))`、`max-width: min(440px, calc(100vw - 24px))`
—— 上下限都会给窄视口让路，所以 300px 的下限不会把面板顶出屏幕。定位用共享的
`useAnchoredPosition`（顶部对齐、间距 8px、四周留 12px 边距，滚动/缩放/面板自身
高度变化时重算），外部点击关闭用 `useDismissOnOutsidePointer`，面板经
`createPortal` 挂到 `document.body`，层级 `z-index: 1100`（在模态遮罩 1000 之上）。
这两个 hook 来自 `@deepseek-ai/dsh-client-ui-primitives`，和 `react-dom` 一样是
Web shell 的 seed 模块 —— 模块表直接应答这两个 specifier，因此本包依然不需要
任何 `import`，也不需要构建。

`percent` **是整数**：上游只返回整数，插件的校验器也据此拒绝小数
（`usage.rolling.percent must be an integer between 0 and 100`）。

整行的可用宽度来自 `align-self: stretch` 拉满的输入框区域
（比 `--dsh-chat-content-width` 的 680–920px 更宽）。窗口窄到放不下时，
`flex-wrap` 让本行换到下一行并居中，而不是挤压相邻的统计行。

## 为何与统计行同排

`conversation.composer.dock` 是 list 槽位：每个注册项渲染成一个**片段兄弟节点**，
而输入框区域把它们纵向堆叠。新增一项因此默认会**另起一行**落在 ui-chat 的 stats 行下面。

本插件不去改输入框区域的方向 —— **那样会连带重排输入框卡片**：卡片是
`width: 100%` 且带 `max-width`，一旦区域变成横向 flex，卡片就成为可收缩的 flex 项，
而它远窄于区域宽度，于是 stats 行会挤到卡片旁边、卡片被压窄。改为把
**dock 锚点本身**变成一行：

```css
[data-slot='conversation.composer.dock']:has(> .dsh-aq-root) {
  display: flex !important;
  flex-wrap: wrap;
  align-self: stretch;      /* 区域是纵向 flex，stretch 让本行占满宽度 */
  justify-content: center;
  align-items: center;
  column-gap: 12px;
  row-gap: 0;
}
[data-slot='conversation.composer.dock']:has(> .dsh-aq-root)
  > :is([data-composer-stats], .dsh-aq-root) {
  width: auto;
  margin: 0;
  padding-left: 0;
  padding-right: 0;
}
```

**为什么需要 `!important`。** 每个槽位渲染点外面都套了一层 `[data-slot="…"]` 锚点，
harness 给它的是**内联** `style="display: contents"`。内联样式在层叠中高于任何
普通作者规则，因此把它变成真实盒子的这一条声明必须带 `!important`。

这一步正是让修复保持局部的原因：输入框区域与它里面的卡片**完全不受影响**，
只有 dock 这一行改变布局。

**为什么还要第二条规则。** 锚点成为 flex 行后，stats 行在里面仍是「独占一行」的写法：

| stats 行的声明 | 后果 |
|---|---|
| `width: 100%` | 想占满整行，把本插件的行挤到剩余宽度里 |
| `margin: 0 auto` | **flex 项上的 auto 外边距会先吞掉全部剩余空间**，`justify-content` 再也看不到这些空间 —— 这才是把本行推到最右端的主因 |
| `padding: 0 32px` | 两行各自的 32px 侧内边距叠加，中间凭空多出 64px |

所以共享一行必须把这三条在两行上都中和掉，只留锚点自己的 `12px` 间距。
stats 行用 `[data-composer-stats]` 定位 —— 那是 ui-chat 自己样式表已经在用的接缝，
因此无需引用任何哈希类名。

选择器锚定在**本插件自己的类名**上，因此：

- 只有本插件挂载时规则才生效；卸载后锚点与 stats 行完全恢复宿主原本的样式。
- 不引用其他包的 class，也不依赖哈希类名。
- 卡片与输入框区域不参与这两条规则。
- 不支持 `:has()` 的浏览器忽略这两条规则，退回未修改的堆叠布局 —— 降级而非损坏。

已用 jsdom 实测：

- 挂载时：锚点 `display` 为 `flex`（`!important` 覆盖内联的 `contents`），
  `align-self: stretch`、`column-gap: 12px`；stats 行与本行的 `width` 为 `auto`、
  `margin` 与侧内边距为 `0px`。
- **输入框区域仍为 `column`，卡片仍为 `column` / `width: 100%` / `max-width: 952px`**
  —— 即两者完全未被本插件影响。
- 卸载时：锚点回到 `contents`，stats 行回到 `width: 100%` / `margin: auto` /
  `padding: 32px`，与其出厂值一致；规则匹配数为 0。
- 特异性：第二条规则 `0,3,0` 覆盖 stats 行的 `0,1,0`，与注入顺序无关。

## 安装

```sh
pnpm dsh plugin --profile web add link:~/dsh-account-quota
```

安装后**重启** `dsh web`：浏览器半在启动时组装进 boot graph。

## 配置

顶层字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `requestTimeoutMs` | `10000` | 单次上游请求超时（**覆盖响应体读取**，不只是建立连接） |
| `maxResponseBytes` | `65536` | 上游响应体上限；**边读边判**，超限即中止传输 |
| `cacheMs` | `60000` | 快照新鲜度下限，**同时是 Host 半的采样周期**（见下） |
| `statePath` | `$DSH_HOME/account-quota/state.json` | 余额序列落盘位置；`$DSH_HOME` 未设置时回退 `~/.dsh` |

`cacheMs` 同时承担两个角色，因为它们问的是同一个问题 —— 「账户的画面可以有多旧」：
定时采样按这个周期把缓存填上，而周期内的 HTTP GET 直接从内存应答，不再打上游。
代价是**与浏览器是否打开无关的固定请求量**：默认 `60000` 即每个适配器每天约 1440 次
（一天两次请求合计约 2880 次）。它换来的是当天起点能落在零点附近，而不是「用户早上
第一次打开界面的时刻」。另外，未知的配置键会**直接报错**而不是被忽略。

提供方适配器：

```yaml
- id: account-quota
  config:
    cacheMs: 60000
    providers:
      deepseek:
        kind: tokens
        displayName: DeepSeek 官方
        apiKeyEnv: DEEPSEEK_API_KEY
        balanceUrl: https://api.deepseek.com/user/balance
        currency: CNY
      deepseek-go:
        kind: plan
        displayName: OpenCode Go
        apiKeyEnv: OPENCODEGO_API_KEY
        usageUrl: https://opencode.ai/zen/go/v1/usage
        rollingLabel: 5 小时      # 上游窗口策略，非本插件常量
```

- `kind: plan` 要求 `usageUrl` 返回 `usage.rolling|weekly|monthly`。
- `kind: tokens` 要求 `balanceUrl` 返回 `{ is_available, balance_infos: [...] }`。
- `rollingLabel` 是滚动窗口的显示名。窗口长度属于上游策略，故可配置而非硬编码。
- **写 `providers` 会替换内置表而不是追加**：本部署的两个路由就是内置表。
  合并会把没配置的默认项留成真实适配器，而它要的凭据恰恰是自带
  `providers` 的部署不会设置的 —— 那一行只会显示「凭据未配置」，白占位置。
  要保留内置的某一项就照抄一遍（patch 本来也必须重写整份 `config`）。

## 刷新节奏

两个适配器在**同一次刷新里一起取**，所以 DeepSeek 余额与 OpenCode Go 用量是同一个节奏：

| 环节 | 周期 | 在哪 |
|---|---|---|
| 上游采样（每个适配器一次请求） | `cacheMs`，默认 **60 秒** | Host |
| 浏览器重读快照（本机 HTTP，不打上游） | `POLL_MS`，**60 秒** | Client |
| 重置倒计时重算 | **30 秒** | Client |

界面上的数字最多比上游旧约 60 秒（再加一次请求耗时）。采样与浏览器无关：
所有标签页关掉后 Host 仍按 `cacheMs` 继续采，当天的起点才不会漂到「早上第一次开界面」
的时刻。要省请求量就调大 `cacheMs`，代价是零点后的第一段消耗会被并进更大的区间。

## 工作原理

- **Host 半**（`lib/index.js`）：注入 `webServer`、`credentials`。每个适配器在
  一次刷新里**并行**请求，单源失败（缺凭据、超时、401）只让该项显示错误，
  不影响其他项。
  - **采样的时钟归 Host，不归浏览器。** 一个按 `cacheMs` 跑的定时器在挂载时就采一次，
    之后每周期一次，与是否打开标签页无关。请求驱动的刷新在没人开页面时会完全停下，
    而那正是隔夜差值发生的时候 —— 当天的起点必须在那之前采到。
  - 每次刷新把余额读数追加进序列：**先读盘合并、再原子改名写入**，所以第二个 Host
    进程是把自己的样本并进来，而不是覆盖掉对方的。
  - `cacheMs` 内的 GET 直接复用快照（定时器通常刚填过），HEAD 永不触发刷新。
    它是定时器被清掉后的兜底路径。
  - API key 只在本进程解析，`redirect: 'error'` 拒绝跟随重定向。
  - 同一个故障只告警一次，消息变化时才再报 —— 采样器会跑满整个进程生命周期。
- **Client 半**（`lib/client.js`）：注册到 `conversation.composer.dock`
  （输入框下方的环境条目行，与 `stats` 并排，`list` 槽位加法共存）。
  样式逐条对齐 `StatsPills.module.css`：13px 次级字号、
  `--dsw-alias-label-tertiary` 颜色、`gap: 12px`、`tabular-nums`、
  `·` 分隔符。**缺数据显示 `—` 而非 0**，避免被读成"余额为零"。

品牌图标内联自 [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons)
（MIT）：每条 `fill="currentColor"` 的 24 单位 path，因此自动继承本行文字颜色与悬停态，
且不产生任何 `import` —— `link:` 安装的包从自身真实路径解析裸标识符，
在此 `import` 会 `ERR_MODULE_NOT_FOUND`。

上游错误映射为 `MISSING_CREDENTIAL`、`UNAUTHORIZED`、`NOT_ENTITLED`、
`UPSTREAM_RATE_LIMITED`、`TIMEOUT` 等结构化错误。

## 限制

- 仅适用于 **web** profile；headless 中该行因缺少 `webServer` 保持 pending。
- **不显示 token 数**：上游不发布，见上文。需要这个数只能自行估算，而那正是 v0.5.0 移除的东西。
- **消费金额只有当天、且只是差值的和**：上游不发布逐请求消费，只有余额。所以
  1) 只有当天，没有历史；2) 分辨率是 ¥0.01；3) 当天起点是**当天第一次采样**，
  不是 00:00 —— 主机若在 09:00 才启动，凌晨的消耗不在这个数里，面板会在「今日消耗」
后面标出这个起点。
  跨本机午夜的差值被丢弃而不是摊分。
- **需要 Host 在跑**：`dsh web` 停止期间不采样。序列在盘上，重启后接着算，
  但停机期间的消耗会落进下一个采样区间，或被零点边界丢弃。
- **百分比只有整数**：上游 `percent` 是整数。网页控制台的小数位（如 `8.8%`）
  没有对应 API。
- 两个凭据都需存在；缺哪个哪项显示错误，另一项照常。
- **超时覆盖到响应体读完为止**：只发头再挂住的提供方会让请求超时（`TIMEOUT`），
  而不会把刷新永久挂起 —— 采样器的在途标志一旦卡住就再也不会恢复采样。
- **`maxResponseBytes` 在传输中生效**：超限即取消读取，不会先把整个响应体读进内存再判断。
- 路由没有鉴权，但 `dsh web` 默认只绑 `127.0.0.1`。用 `webStartup.host: 0.0.0.0`
  暴露到局域网时，这个路由（余额与用量）和 GUI 其他接口一样对同网段可读。

## 自测

```sh
node selftest.js
```

用替身 Context、可改的假 `fetch` 和本文件自己掌控的时钟驱动真实的 `apply()`，
断言的是插件实际产出的快照与它实际写下的文件。覆盖：逐段累加、中途充值、
跨日重置、双 Host 进程合并同一条序列、损坏文件、不可写路径、缺凭据、HEAD 不触发刷新。

Client 半不在自测范围内 —— 渲染它需要 React，而 `link:` 安装无法从本目录解析。
它的文案用真实 React 的 `renderToStaticMarkup` 单独核对过（常驻行的四种状态与两个面板），
其中 `react-dom` 与 `ui-primitives` 用替身喂入，只核对结构与文案。

## 来源与许可

本仓库是 [`zer0zio-stack/dsh-opencode-go-quota`](https://github.com/zer0zio-stack/dsh-opencode-go-quota)
v0.4.0 的 fork，MIT 许可，原始版权归 `zer0zio-stack` 所有。v0.5.0 起的上游 API
适配、余额序列、面板与本次改名都在 `PATCHES.md` 里逐版本记录，方便日后与上游对齐。
