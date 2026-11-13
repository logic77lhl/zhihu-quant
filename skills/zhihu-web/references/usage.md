# 怎么用（一页速查）

**只讲操作。** 踩坑记录与判断依据在 [`playbook.md`](./playbook.md) / [`pipeline-v2.md`](./pipeline-v2.md)，
本文回答的是「我要 X，该跑什么、什么时候算跑完」。

```powershell
$SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
```

---

## 第 -1 步：手上是一个链接 → 先跑 `link.mjs`

用户贴一个知乎链接过来时，**不要自己判断该走哪条路，也不要 webfetch**：

```powershell
node "$SCRIPTS\link.mjs" "<URL>"
```

它做三件事：识别链接类型（问题 / 回答 / 专栏 / 用户 / 收藏夹 / 搜索 / 热榜）→
报桥接状态与已有产物 → **打印下一跳该照抄哪一条命令**。

| 退出码 | 含义 | 该做什么 |
|---|---|---|
| 0 | 桥接可用 | 按它打印的命令继续 |
| **3** | **产物已存在** | **复用，从 ② 开始，别重抓** |
| 4 | 桥接断 | 见下方「桥接断了」两条路 |

**为什么要专门有这一跳**（2026-10-16 实测事故）：用户贴了一个问题链接，会话依次试了
`panerelay zhihu question`（桥接断）→ webfetch → 开 harness 浏览器（未登录 403）→
用户手动登录后才拿到数据，期间还报了一次误导性的 `Site command failed`。
整轮没走 skill 的既定路线，因为**skill 里没有「你手上是 URL」的第一跳**。

---

## 第 0 步：先判三件事，再动手

| 要判的 | 怎么判 | 判错的代价 |
|---|---|---|
| **① 题型** | 看问题问的是什么（见下方四条路线） | 抽取路径整个跑偏（例：拿书单提示词去跑 CPU 题） |
| **② 要不要数字** | 答案里是否要出现**赞数 / 时间 / 评论数** | 走官方 CLI 就永远拿不到这些字段 |
| **③ 产物是否已存在** | `node "$SCRIPTS\precheck.mjs" <问题ID>` | 白抓一遍（实测事故：约 400 次请求） |

**②的判据很简单**：要数字 → 必须走本 skill（Panerelay，复用 Edge 登录态）；
只找内容、不要数字 → 官方 `zhihu` skill 更省事。

---

## 四条路线（照抄）

### 路线 A：观点讨论题 → 汇总页

> 例：「为什么我读三百本书没长进」「如何看待 XX」

```powershell
node "$SCRIPTS\precheck.mjs" <问题ID>                              # ⓪ 闸门，见下
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>                     # ① 全量全文（>1000 条也拿全；单排序+覆盖检查）
node "$SCRIPTS\summarize-answers.mjs" q<ID>-answers-full.json      # ② 逐条摘要 + 综述（--model 默认 auto）
node "$SCRIPTS\extract-themes-llm.mjs" q<ID>-answers-full.json     # ③ 观点聚类
node "$SCRIPTS\render-answers.mjs" q<ID>-answers-full.json         # ④ → q<ID>-汇总.html
node "$SCRIPTS\verify-output.mjs" q<ID>-answers-full.json --html q<ID>-汇总.html
node "$SCRIPTS\build-index.mjs"                                    # ⑤ 刷新 index.html（可选）
```

**耗时基线（2026-10-16 实测，question/2091879195533997422，38 条回答）**：

| 阶段 | 耗时 | 说明 |
|---|---|---|
| ① 抓取 | ~2s | 2 页 default + 1 次 created 覆盖检查（旧行为 4 页） |
| ② 摘要 + 综述 | ~20s | 12 批 / 并发 5；同轮含 1 次上游 503 收尾重试 |
| ③ 观点聚类 | ~9s | 归纳 16 标签 + 38 条打标 |
| ④ 渲染 / 校验 | 0.2s / 0.13s | 纯本地 |
| **合计** | **~30s** | 大题时抓取按 ~0.6 秒/页线性增长（3898 条 ≈ 3 分钟，单排序后） |

慢的从来不是脚本本身。**看日志区分两类"慢"**：
`[~] 批命中上游限额…延后重试` 是上游抖动（正常，会自动补）；
连续 `HTTP 503` + 每批 4 次退避刷屏 = 模型路由挂了 —— 检查 `--model` 是否被显式设成了老默认值。

### 路线 B：实体题（书单 / 库名 / 硬件）→ 实体榜

> 例：「像《置身事内》一样的神书」「真正懂CPU的人，都选了什么CPU？」

```powershell
node "$SCRIPTS\precheck.mjs" <问题ID>
node "$SCRIPTS\pipeline.mjs" <问题ID> --preset cpu      # books | pythonlibs | cpu
```

`pipeline.mjs` 自己做桥接自检 → 抓取 → 抽实体 → 出 HTML+MD 报告。
改预设重跑加 `--skip-fetch` 省掉抓取那几分钟。

**⚠️ 两条必须知道的限制：**

- **书单题不要用正则预设。** `--preset books` 只认书名号，系统性漏掉裸书名，
  漏掉的恰好是推荐量最高的那几本 → 书单排行改用 `extract-books-llm.mjs`。
- **跨品类同形命名必须先排掉。** CPU 型号与主板芯片组 / 显卡共用 `B650M`、`GTX750` 这类写法，
  正则分不出品类 —— 不显式排除的话榜单头部会被主板占满。
  写预设前先读 [`presets.md`](./presets.md)，**先看数据再写规则**。
- **同一实体的多种写法要归一。** `i5-12400F` 与 `12400F` 是同一颗 U，不合并就把赞数拆成两份。
  在预设里写 `normalize.stripPrefixes`，合并按**去重后的回答数**（并集）而不是相加
  —— 写法和实测数据见 [`presets.md`](./presets.md) 的「别名归一」一节。

### 路线 C：故事征集题 → 汇总页 + 性质徽章

> 例：「有哪些平淡却心酸的暗恋故事」

```powershell
node "$SCRIPTS\precheck.mjs" <问题ID>
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>
node "$SCRIPTS\classify-content-llm.mjs" q<ID>-answers-full.json --all        # 判 真实/小说/改编/无关
node "$SCRIPTS\summarize-answers.mjs"    q<ID>-answers-full.json --profile stories
node "$SCRIPTS\extract-themes-llm.mjs"   q<ID>-answers-full.json --profile stories
node "$SCRIPTS\render-answers.mjs"       q<ID>-answers-full.json
node "$SCRIPTS\verify-output.mjs"        q<ID>-answers-full.json --html q<ID>-汇总.html
```

**`--profile stories` 三个脚本都要传**，否则综述口径对不上（会出现「共识要点」这类读书题词汇）。
**`--all` 不能省** —— 抽样会低估/高估头部，而头部正是读者唯一会看的部分。

要出「去盐选版」时综述必须一起换口径：

```powershell
node "$SCRIPTS\summarize-answers.mjs" q<ID>-answers-full.json --profile stories --exclude-paid --only-digest --rebuild-digest
node "$SCRIPTS\render-answers.mjs"    q<ID>-answers-full.json --exclude-paid --out q<ID>-汇总-去盐选.html
```

### 路线 D：只要数据，不要页面

```powershell
node "$SCRIPTS\precheck.mjs" <问题ID>
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>          # → q<ID>-answers-full.json
```

拿到 JSON 就走。需要单条详情用 `panerelay zhihu answer-detail <回答ID> --json`。

---

## 四个闸门：跑不过不许往下走

| 闸门 | 命令 | 通过判据 |
|---|---|---|
| **开工前** | `precheck.mjs <问题ID>` | 退出码 0。**3 = 产物已完整（复用，从②开始，别重抓）**；4 = 桥接不通；5 = 产物散落在非解析目录 |
| **交付前** | `verify-output.mjs <answers.json> [--entities <实体.json>] --html <页面>` | 退出码 **0**。非 0 说明产物里有静默错误（孤儿 ID / 覆盖率不足 / 赞数为 0 / 重复行 / 剔除没生效 / 碎片实体名 / 归一账目不闭合 / 报告页行数与产物不符） |
| **改抽取规则后** | `test-preset-rules.mjs [预设名]` | 退出码 **0**。改过 `rules` / `dict` / `dictLeftGuard` / `dictRightGuard` 就跑 —— 抽取规则改坏是**静默**的，只会变成错的名字 |
| **改文档后** | `check-docs.mjs` | 退出码 0。查跨文档数字是否分叉、开关是否真存在、断链、预设与脚本清单 |

`--entities` 有默认值 `q<ID>-entities.json`，文件在就自动校验，不用手动传。

`--html` **两种页面都收**，脚本自己判别模板：汇总页（有数据块）查剔除/口径，
报告页（无数据块、数据已渲成 DOM）查「页面实体行 ↔ 产物」和统计卡数字。
**传错文件不会得到一个吓人的 FAIL，而是被认出来是哪种模板。**

`precheck` **已经内建在 `fetch-answers-api.mjs` 里**（产物完整时直接 exit 3，不发网络请求），
单独跑它的价值在于「被别的脚本 import」，不在于「记得先跑」。

---

## 兜底通道：harness 浏览器（不依赖 Edge）

> **⚠️ 验证状态（2026-10-16）：机制已验证，端到端未验证。**
> 已实测：`browser.evaluate` 可用；**未登录**时页面上下文 fetch 明确失败
> （`/api/v4/me` → `401 AuthenticationInvalidRequest`，`/api/v4/questions/{id}/answers` → `403`）。
> **本机尚未在该浏览器里登录过知乎**，因此"登录后能取到与 Panerelay 同源字段"只有
> 2026-10-16 会话的历史记录佐证，**没有当场复现**。要用这条道，先按下面的步骤打通并核对字段。
> 日常优先修桥接（`ensure-bridge.mjs --fix`）——它更快、有流水线。

Edge/Panerelay 全断、又不想动 Edge 时，还有一条路：**harness 自带的浏览器工具**
（Review 面板里那个浏览器）。它有自己独立的登录态容器（**与 Edge 的登录态不共享**，
在 Edge 里登录对它无效）。

**前提：在里面登录过一次知乎。** 未登录时接口会明确回报：

- `/api/v4/me` → `401 {"error":{"code":100,"name":"AuthenticationInvalidRequest"}}`（实测 2026-10-16）
- `/api/v4/questions/{id}/answers` → `403`

### 做法（agent 照做）

```js
// ① 打开目标页 —— 必须在知乎域内，页面上下文才带得上知乎自己的请求签名
const t = await tools.browser.tabs.open({ url: "https://www.zhihu.com/question/<问题ID>" });

// ② 在**页面上下文**里 fetch（不是从 Code Mode 直接 fetch）
const r = await tools.browser.evaluate({
  tabID: t.id,
  script: `(async () => {
    const res = await fetch("/api/v4/questions/<问题ID>/answers?limit=20&include=data%5B*%5D.voteup_count,data%5B*%5D.created_time,data%5B*%5D.comment_count,data%5B*%5D.content", { credentials: "include" });
    return { status: res.status, data: (await res.json()).data };
  })()`
});
// r.value = { status, data } —— r.value.data[] 里就是回答
```

**硬性注意（每条都踩过）**：

- **ID 一律写成字符串。** 19 位回答 ID 超过 JS 安全整数，当数字字面量写会**静默丢精度**
  （页面里看到的是一个相近但不存在的 ID）。
- `script` 里可以 `await`（用 async IIFE 包一层）；**Code Mode 外层没有 `setTimeout`**，
  要等待就在页面脚本里 await。
- `/api/v4/questions/{id}` **详情**端点即使登录也 403（`code 10003`，要签名）——
  标题从 answers 列表的 `question.title` 取，别为它再撞一次。
- 产出要**落盘成流水线认的格式**才能接下游：JSON 数组，单条字段
  `id, author{name}, votes, comments, thanks, created_at, updated_at, question_id, question_title, url, content, answer_type, author_type, is_advertiser`
  （`created_at` 是 ISO 字符串，`votes` 来自 `voteup_count`）。落到 `q<ID>-answers-full.json`
  后即可跑 ② 之后的步骤。
- 这条通道**一次一页、没有分页流水线、没有并发** —— 只作兜底，不作主力。
  要全量数据优先修桥接（`ensure-bridge.mjs --fix`）。

---

## 症状 → 动作

| 症状 | 真实原因 | 该做什么 |
|---|---|---|
| 用户贴了个链接，会话不知道该从哪开始 | 没有"给链接"的第一跳 | 跑 `node "$SCRIPTS\link.mjs" "<URL>"`，照它打印的下一跳做。**别 webfetch 知乎** |
| `BRIDGE_DOWN` | Edge 不是带扩展启动的 | 先跑 `node "$SCRIPTS\ensure-bridge.mjs" --fix`（会重启 Edge，**先问用户**；有窗口会拒绝，需 `--force`）。不想动 Edge 就走上面的 harness 浏览器通道。**不要反复重试** |
| 脚本中文输出在 PowerShell 里是乱码 | 控制台解码与脚本输出的 UTF-8 不一致 | 命令前加 `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;`（实测可修） |
| 桥接通但 `attachedCookieCount=0` | 扩展缺 `host_permissions` | 见 SKILL.md「两个已知的、会误导人的坑」① |
| `403` + `code 10003` | **该端点**要客户端签名 | 只对这一个端点下结论。换个端点 200 是正常的 —— **不要外推成「这一类都要签名」** |
| 命令卡 35 秒后 `Browser-backed request timed out` | 给适配器加了旧扩展不认识的请求字段，被静默丢弃 | 去掉该字段。别怀疑网络 |
| 找不到 `q<ID>-*.json` | 产物不在脚本目录旁 | `precheck.mjs --dirs` 看目录解析；别急着重抓 |
| 摘要覆盖率 < 98% | LLM 批次静默失败 | 重跑同一命令，state 会续跑 |
| 赞数合计为 0 | `votes` 字段名对不上 | `verify-output` 现在会直接 FAIL（见其「基线自洽」节） |
| 页面残留 `${xxx}` | 模板变量没插值 | `verify-output --html` 会 FAIL |
| 实体名出现 `3 3200G` / `55600X` 这类没人这么写的名字 | 抽取规则的**捕获组吞了裸前缀**（阶级数字） | 改预设规则，把 `[3579]\s?` 放到捕获组**外**（`references/presets.md` 硬性约束 3）。**别去改显示名规则兜底** |
| 中文语境里明明在聊某个型号，榜单上却没有 | 规则开头的 `\b` 在**汉字前面不成立**（`锐龙7 8700G` 这类整片漏） | 把 `\b` 换成 `(?<![\w])`。改完跑 `test-preset-rules.mjs` |
| 词典词明明出现在回答里却没被抽到 | 词典边界把汉字也算作边界 | 判断该词是不是**独特 token**：是 → `dictLeftGuard` / `dictRightGuard` 设 `"loose"`；不是（如「原则」「断裂」）→ 保持严格，否则会多出假书 |
| 实体计数看着偏大 | 别名归一把「相加」当成了「合并」 | 合并必须是**回答 ID 的并集**；`verify-output` 的归一账目断言会先拦一道 |

---

## 两条不会过期的纪律

1. **通路不通 = 报告你验证过的东西 + 等用户操作。** 替代方案可以提，但必须显式声明
   「这是绕路 + 数据质量哪里受损」。自己改浏览器配置 / 换数据源硬凑，都是错的。
2. **结论的范围不得大于实测的范围。** 测了一个端点就说一个端点，测了一份产物就说这份产物。
   今天最贵的一次错误不是「不知道」，是**用一次测量宣布了一个更大的规律**。

> 能自动检查的，写成工具；不能自动检查的，才写成规则。
> 规则读过照样会被违反（`verify-output.mjs` 就是为此存在的），闸门不会。
