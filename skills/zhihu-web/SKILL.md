---
name: zhihu-web
display_name: 知乎网页数据
description: >-
  读取知乎网页端真实数据：回答的赞同数（赞数）、发布时间、评论数、感谢数、完整正文全文，
  以及热度排序、时间分布等需要登录态的量化指标。复用本机 Edge 已登录的会话直接调用知乎接口，
  补上官方开放平台 CLI 不返回的字段。用户提到赞数、赞同数、点赞数、投票数、评论数、发布时间、
  感谢数、回答热度排序、时间分布、按时间排序，或需要统计某个知乎问题下全部回答的量化数据时使用。
  也用于需要回答全文（非摘要）的场景。
  还用于识别与剔除回答里的**盐选/严选付费内容、虚构小说、机构号投稿、灌水**——
  即「哪些是知乎严选」「哪些其实是小说/虚构」「去掉盐选」「只看真实经历」「故事征集题」这类需求，
  可给回答打性质徽章并支持按性质筛选。
  注意「收藏数」知乎接口不暴露，拿不到。不涉及这些字段的纯内容检索仍用官方 zhihu Skill。
---

# 知乎网页数据（登录态通道）

> **▶ 不知道该跑哪条命令 → 先读 [`references/usage.md`](./references/usage.md)。**
> 四条路线的完整命令、三个闸门的通过判据、故障症状查找表，都在那一页。
> 本文是**权威细节**（字段、限速、坑），usage.md 是**操作手册**。
>
> **▶ 拿到一个知乎链接（问题 / 回答 / 专栏 / 用户 / 收藏夹）→ 先跑 `link.mjs`，它是"给链接"的第一跳：**
>
> ```powershell
> $SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"   # 本文所有命令都用这个变量
> node "$SCRIPTS\link.mjs" "<URL>"
> ```
>
> 它识别链接类型 → 报桥接状态与已有产物 → **打印下一跳该照抄哪一条命令**（退出码 0 可继续 / 3 产物已在别重抓 / 4 桥接断）。
> 桥接断时它直接给出两条路（`ensure-bridge.mjs --fix` 或 harness 浏览器通道）。
> **不要 webfetch 知乎页面** —— 未签名的抓取只会拿到登录墙或 403，徒增一轮误诊。

## ⛔ 最高优先级规则：不要对知乎做压测/性能测试

**这条独立于下面所有内容。它不会「弄坏账号」，但会浪费配额、产生假数据、并浪费一整轮诊断。**

### 403 的三种原因 + 签名要求的**精确范围**（2026-10-15 逐端点实测）

知乎的 403 至少有三种原因，**混淆它们会把诊断带进死路**：

| | 缺客户端签名 | 频率限流 | 登录态失效 |
|---|---|---|---|
| 响应体 | `{"error":{"message":"请求参数异常，请升级客户端后重试。","code":10003}}` | 通常无结构化 code | 通常无结构化 code |
| 作用域 | **单个端点**（见下表） | 会话 / IP 级 | 会话级 |
| 判别 | 该端点恒定 403，与频率无关 | 换个 endpoint 也一样 403 | 所有端点都 401/403 |
| 会恢复吗 | ❌ 等再久也不会 | ✅ 窗口过后会 | ❌ 需重新登录 |

#### 签名要求的实际范围：**只有一个端点**

```
✅ /api/v4/questions/{id}/answers    200   ← 管线主力
✅ /api/v4/answers/{id}              200
✅ /api/v4/questions/{id}/feeds      200
✅ /api/v4/me                        200
✅ /api/v3/feed/...                  200
❌ /api/v4/questions/{id}  【详情】   403 code=10003   ← 唯一受限的
```

**复核命令**（想确认时自己跑，别猜）：

```powershell
node scripts/check.mjs --endpoints <问题ID>     # 逐个打印上表
```

#### ⚠️ 这里的教训比结论更重要

**上一个 AI 拿「问题详情」的 403，外推成「`questions|answers|members` 这一类都要签名」，
然后基于这个没验证过的推断去修（加 `inPageContext`），结果把本来能用的通路挖断了。**

外推方向是错的：**签名要求是端点级的，不是路径前缀级的。**
子路径（`/answers`、`/feeds`）与父路径（`/{id}`）的要求可以完全不同。

**规则**：只对**你要用的那个确切端点**做判断。不要因为兄弟端点 403 就推断整个前缀家族 403。
判不出来就说不确定，不要替服务端下结论。

#### 另一个陷阱：`inPageContext` 字段会让旧扩展静默挂死

给请求加扩展不认识的字段（如 `inPageContext: true`）时，**旧 bundle 会静默丢弃且不回包**，
native host 只能干等到 35 秒超时（`30s + 5s`，出处 `browser-relay.ts:1076`）。

表现为「命令卡 35 秒后报 `Browser-backed request timed out`」，**完全看不出是字段问题**。

**不要给适配器加扩展不认识的请求字段。** 该字段已从 `adapter.mjs` 移除（2026-10-15 10:57）。

### 为什么不要压测

不是因为「会封号」，而是：

- **会产生假数据**：403 响应返回很快，只测耗时的脚本会把它当成「快速成功」。
  实测因此得出过「异步并发提速 3.9 倍」的假结论，差点写进文档
- **会浪费配额**，且可能真的触发频率限流（上表第二种）
- **会浪费一整轮诊断**：三种原因混在一起，排查成本极高

要性能数据时用**单次调用**拆解耗时（进程 / 模块 / 网络），不要「并发跑 N 页看总耗时」。

### 写任何性能/基准脚本时的硬性要求

```js
const j = JSON.parse(out);
if (j.status !== 200) throw new Error('失败，本次计时作废');   // 403 会被当成「快」
```

样本小（≤10 次）、有间隔（≥1 秒）、逐档提升、**出现非 200 立即停止**。

### 已由代码强制

`scripts/panerelay-run.mjs` 是所有脚本调用知乎的唯一入口：

| 机制 | 默认值 | 行为 |
|---|---|---|
| 相邻调用最小间隔 | 120 ms | 不足则阻塞等待 |
| 每分钟调用上限 | 100 次 | 超出则阻塞到下一分钟 |
| 403 按 code 分流 | 自动 | 说明真实原因，或明确说「原因未知」 |

正常流水线约 **64 次/分钟**，不受影响。改这些值需要显式设环境变量并会打印警告。

### 遇到 403 时的正确动作

1. **读 `error.code`**，不要只看状态码
2. `code 10003` → 签名问题，**不要等、不要重试**，见下节
3. 无 code → 按上面的判别方法测两次（换个没请求过的 endpoint + `/api/v4/me`）
4. **不要连续重试**，无论哪种原因

### 当前已知：`/api/v4/questions/{id}` 详情端点要签名（2026-10-15）

**精确范围**（逐端点实测，不是外推）：

```
✅ /api/v4/questions/{id}/answers    200   ← 管线主力，能用
✅ /api/v4/answers/{id}              200
✅ /api/v4/questions/{id}/feeds      200
✅ /api/v4/me                        200
❌ /api/v4/questions/{id}  【详情】   403 code=10003
```

- 问题标题不需要调这个端点 —— 它在 `answers` 列表的 `question.title` 里就有
- 适配器 `~/.panerelay/fetch-adapters/zhihu/0.11.1/adapter.mjs` 已回滚 `inPageContext`（加它反而弄坏通路，见上）
- 随时用 `node scripts/check.mjs --endpoints <问题ID>` 逐项复核
- **不要靠等待解决** —— 这不是时间窗口问题

---

官方开放平台 CLI 只返回 4 个字段，**拿不到 `voteup_count` / `created_time` / `comment_count`**。
本 Skill 走另一条路：复用本机 Edge 已登录的会话，由浏览器扩展代发请求。

两条通道**互补，不是替代**。见下方路由表。

> **🚀 换新机器 / 首次部署：先读 [`references/setup.md`](./references/setup.md)**
> —— 完整装机步骤（Panerelay、扩展补丁、LLM 网关、产物目录），附故障排查表。
> 装完跑 `node scripts/doctor.mjs` 自检（12 项，每项 FAIL 都带修复指引）。

---

## 先决条件：Edge 必须是「带扩展」启动的

**用户双击普通 Edge 图标、扩展没加载时，本 Skill 完全不可用。**

### 推荐部署：把扩展注册成持久化未打包扩展（一次性，治本）

1. Edge 地址栏打开 `edge://extensions`
2. 左下角打开「开发人员模式」
3. 点「加载解压缩的扩展」，选这个目录：`%USERPROFILE%\.panerelay\extension`

之后**普通启动 Edge 也会加载扩展** —— 不需要 `--load-extension`、不需要特殊快捷方式，
也不会再撞上「Edge 后台模式把启动脚本判成已在运行」的死循环（`references/setup.md` 1.6）。

> 2026-10-16 起这是推荐做法。此前扩展只靠命令行 `--load-extension` 临时加载，
> 结果*桥接常态是断的*：Edge 的后台模式会自行拉起一个没有扩展的实例，
> 每次要用都得先人工把 Edge 关干净再特制启动。注册成持久扩展后这个摩擦消失。

### 断了怎么办：`ensure-bridge.mjs`（一条命令）

```powershell
node "$SCRIPTS\ensure-bridge.mjs"          # 只探测，不改任何东西
node "$SCRIPTS\ensure-bridge.mjs" --fix    # 断则修：结束后台 Edge → 带扩展重启 → 复验（约 30 秒）
```

安全闸：只在 Edge 是「纯后台模式」（无窗口，杀掉不可见）时才直接结束；
检测到用户开着窗口会**拒绝执行**，除非显式 `--fix --force`。
**agent 跑 `--fix` 前必须先问用户** —— 这是用户可见的机器状态变更。

### 兜底：`start-edge.cmd`

`~/.panerelay/start-edge.cmd` 仍然可用，等价于「带 `--load-extension` 启动 Edge」。
但它要求 Edge 已完全退出（后台模式会让它判成"已在运行"而拒绝启动）。
桌面快捷方式 `Edge (Panerelay)` 只是这个 `.cmd` 的双击包装，**不是必需**；
想要图标：`powershell -ExecutionPolicy Bypass -File ~/.panerelay/make-shortcut.ps1`。

> 2026-10-15 修正：本文与 5 个脚本此前都写成「必须点桌面那个快捷方式」。
> 当时那个 `.lnk` 恰好丢失，于是 `check.mjs` 给出的是一条**指向不存在文件的指引**，
> 接手的人只能停下来问用户 —— 而直接跑 `.cmd` 当时完全可行。
> **指引指向一个不存在的文件，等于没有指引。**

需要检查时跑：

```bash
node scripts/doctor.mjs        # 全量自检（推荐）
node scripts/check.mjs         # 只看桥接与 Cookie
```

`doctor.mjs` 会检查：Node 版本、Panerelay 桥接与 Cookie 注入、知乎适配器、
**LLM 网关密钥 + 模型列表 + 一次真实 chat 调用**（后者能抓出「HTTP 200 但返回空」
这类静默故障，只查 `/models` 是查不出来的）、产物目录可写性。
每项 FAIL 都带修复指引。

输出 `OK` 即可继续。输出 `BRIDGE_DOWN` 时的**正确动作**：

1. 报出状态与已验证的内容（不要自己乱试通路）
2. 征得用户同意后跑 `node "$SCRIPTS\ensure-bridge.mjs" --fix`
3. 用户不方便时改走 **harness 浏览器通道**（不依赖 Edge，但登录态独立、需先在那里登录；见 `references/usage.md`）
4. 指引文本统一来自 `scripts/bridge-advice.mjs`（单一来源，别再往脚本里硬编码）

**不要反复重试、不要改浏览器配置 —— 那是用户状态，先问。**

---

## 路由表

| 你要什么 | 用什么 | 命令 |
|---|---|---|
| **手上是一个知乎链接** | **路由** | `node "$SCRIPTS\link.mjs" "<URL>"` ← **第一跳**，它打印下面该跑哪条 |
| **产物已在盘上：查内容 / 要口径 / 出简报** | **zj CLI** | `node "$SCRIPTS\zj.mjs" stats <ID>` / `brief <ID>` / `q <ID> --top 10`（见 [`references/zj-cli.md`](./references/zj-cli.md)） |
| 问题下全部回答 + **赞数** | Panerelay | `panerelay zhihu question <数字ID> --limit 1000 --json`（**最多 1000 条**，更多见下方汇总流水线） |
| 回答的**发布时间 / 评论数 / 全文** | Panerelay | `panerelay zhihu answer-detail <回答ID> --json` |
| **把一个问题做成一页能读完的汇总** | **汇总流水线** | 见下方「汇总流水线」 |
| **对外发布（合规版报告）** | render-publish | `node "$SCRIPTS\render-publish.mjs" q<ID>-answers-full.json --contact "你的联系方式"`（见 [`references/publish.md`](./references/publish.md)） |
| **发布前自检（报告能不能发）** | **verify-publish** | `node "$SCRIPTS\verify-publish.mjs" q<ID>-发布版.html` ← **0 FAIL 才能发**；`precheck.mjs <ID> --publish` 只看有没有/过没过期 |
| **把数据做成视频（竖版短片 / 横版长片）** | **data-video skill** | 本 skill 只负责备料（`answers-full.json` + 统计产物）；分镜、渲染、闸门走 `data-video`（见 [`references/video.md`](./references/video.md)） |
| 按发布时间排序 | Panerelay | 同上 + `--sort created` |
| 热榜 / 搜索 / 用户 / 收藏夹 | Panerelay | `panerelay zhihu hot` / `search` / `user` / `collections` |
| 确认登录账号 | Panerelay | `panerelay zhihu whoami --json` |
| 任意已知 URL（需登录态） | Panerelay | `panerelay fetch "<url>" --response json` |
| 只找内容、不需要量化指标 | 官方 CLI | 用 `zhihu` Skill |
| 自己的数据（收藏/浏览/分享） | 官方 CLI | 用 `zhihu` Skill 的 `me *` |
| **桥接断了、又不想动 Edge** | **harness 浏览器** | 见 `references/usage.md`「兜底通道：harness 浏览器」——登录态独立（与 Edge 不共享）、**当前端到端未验证**，只作兜底 |

**判断标准很简单：答案里要不要出现数字。** 要数字走 Panerelay，不要数字走官方 CLI。

## 能拿到哪些量化字段（实测，2026-10）

别猜字段名，也别假设官方文档列的都拿得到。实测结论：

| 字段 | 能否拿到 | 怎么拿 |
|---|---|---|
| 赞同数 `voteup_count` | ✅ | 回答列表 / 详情接口默认返回 |
| 评论数 `comment_count` | ✅ | 同上 |
| 发布时间 `created_time` | ✅ | unix 秒，需自行转 ISO |
| 更新时间 `updated_time` | ✅ | 同上 |
| 正文全文 | ✅ | 列表接口 `include=data[*].content` 即返回全文 HTML（见 pipeline-v2 第 2 节） |
| **感谢数 `thanks_count`** | ⚠️ | **必须显式写进 `include=`**，否则不返回 |
| **是否盐选/严选付费** `answer_type` | ⚠️ | **三值：`normal` / `paid` / `paid_column_content`**，必须显式写进 `include=`，默认不返回。**判定用 `!== 'normal'`，不要写 `=== 'paid'`——会漏掉 `paid_column_content`**（实测 q665321619：normal 1960 / paid 101 / paid_column_content 3） |
| **是否机构号/广告主** | ⚠️ | `author.user_type="organization"` / `author.is_advertiser`，同样要显式 include |
| **收藏数** | ❌ | **接口不暴露**。加 `favorite_count` 到 include 会被**静默丢弃**（无报错）；`answer-detail` 也没有这个字段 |

用户要求「收藏数」时**直接说明拿不到**，不要反复试参数。
替代口径：用赞同数 + 评论数 + 感谢数作为互动量代理。

`answer-detail` 只返回 `id/author/votes/comments/question_id/question_title/url/created_at/updated_at/content`，
**没有感谢数**，要感谢数必须走列表接口。

### 故事征集题还要判「这内容是真是编的」

`answer_type` 只能告诉你**是不是严选付费内容**，告诉不了你是不是小说。
而实测故事征集题的头部排序**被虚构内容主导**（见 `references/content-kind.md`）：

- 全题 0.56% 的严选内容占了 Top100 赞数的 **45.1%**（严选会被推荐位加权）
- 全量判定后虚构内容占 **16%**，虚构率随篇幅陡增：**200 字以下 1.4%、1000–3000 字 25.5%、3000 字以上 60%**

**做故事征集题必须加一步内容性质判定**，否则读者会把小说当真实故事读：

```powershell
$S = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
node "$S\classify-content-llm.mjs" q<ID>-answers-full.json --all    # 逐条判 真实/小说/改编/无关
node "$S\render-answers.mjs"       q<ID>-answers-full.json          # 自动出徽章+筛选
node "$S\verify-output.mjs"        q<ID>-answers-full.json          # 校验（退出码 0 才算跑完）
```

新抓取的产物已自带 `answer_type` 等字段，**不需要**再跑 `enrich-flags.mjs`
（那只用于补救补字段之前抓的旧产物）。

**`--all` 不能省。** 抽样能估量级但保证不了头部正确：实测抽样版把虚构率高估 2.6 倍
（39.6% vs 15.0%），分层比例同样被带偏（1000–3000 字估 47.4%、实测 25.5%），
且排第 1 的 42036 赞回答因分章写法是「一我换同桌了」（无点号）没被抓到。
完整实测见 [`references/content-kind.md`](./references/content-kind.md)。

**要出「去盐选版」时综述也得换口径**，否则会出现「榜单已剔盐选、综述还在推荐被剔掉的付费小说」
（实测原版综述推荐的第 4 条就是一条 2519 赞的严选小说）：

```powershell
node "$S\summarize-answers.mjs" q<ID>-answers-full.json --profile stories --exclude-paid --only-digest --rebuild-digest
node "$S\render-answers.mjs"    q<ID>-answers-full.json --exclude-paid --out q<ID>-汇总-去盐选.html
```

## 汇总流水线（回答数多 / 要成页阅读）

**动手前读 [`references/pipeline-v2.md`](./references/pipeline-v2.md)** ——
全量抓取、观点聚类、排行口径、模型配置的实测记录与踩坑清单。

脚本**内含在 skill 里**：`skills/zhihu-web/scripts/`（30 个 `.mjs` + `presets/`）。
下面的 `$SCRIPTS` 都指这个目录 —— 装完 skill 即可用，不需要另外安放。

```bash
$SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
node "$SCRIPTS\precheck.mjs" <问题ID>                          # ⓪ 开工前置检查（产物/目录/桥接）
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>      # ① 全量全文，>1000 条也能拿全
node "$SCRIPTS\summarize-answers.mjs" q<ID>-answers-full.json   # ② 逐条摘要 + 综述
node "$SCRIPTS\extract-themes-llm.mjs" q<ID>-answers-full.json  # ③ 分类（按题型选 profile）
node "$SCRIPTS\extract-books-llm.mjs" q<ID>-answers-full.json   # ③' 书单（书单题才用）
node "$SCRIPTS\render-answers.mjs" q<ID>-answers-full.json      # ④ → q<ID>-汇总.html
node "$SCRIPTS\build-index.mjs"                                 # ⑤ → index.html
```

### ⓪ `precheck.mjs`：不是建议，是闸门

**`fetch-answers-api.mjs` 已经内建这道闸**，产物完整时直接 `exit 3`，不发任何网络请求。
你仍然可以单独跑它——但**它的价值在于"被下游 import"，不在于"记得先跑"**。

```
node "$SCRIPTS\precheck.mjs" <问题ID>     # 查产物/目录/桥接
node "$SCRIPTS\precheck.mjs" --dirs       # 只看输出目录解析与候选目录
```

| 退出码 | 含义 | 该做什么 |
|---|---|---|
| 0 | READY | 开工 |
| **3** | **产物已完整** | **复用，从 ② 开始。**`--force` 才重抓 |
| 4 | 桥接不通 | 跑 `node "$SCRIPTS\ensure-bridge.mjs" --fix`（会重启 Edge，**先问用户**）；或改走 harness 浏览器通道。**不要反复重试、不要自行改浏览器配置** |
| 5 | 产物散落在非解析目录 | 先选定/合并目录，别两边各抓一份 |

**实测事故（2026-10-15）**：产物两小时前就在盘上，会话没查就重抓了一遍——
换了另一条通路、正文被截断到 200 字、还落错目录，约 400 次请求白花，
而且基于截断文本报了一份错的「型号提及榜」。
`lock.mjs` 拦得住"两个会话同时抓"，**拦不住"已经抓完还要再抓"**，这是另一道闸。

### 先判题型，再决定跑哪一步（重要）

题型不同，抽取路径完全不同。**先看问题问的是什么，别默认跑书单**：

| 题型 | 例子 | 要跑的抽取 | 参数 |
|---|---|---|---|
| **书单/资源推荐题** | 「像《置身事内》一样的神书」 | `extract-books-llm.mjs` | 默认 |
| **实物/商品推荐题** | 「真正懂CPU的人，都选了什么CPU？」 | **实体抽取**（`pipeline.mjs --preset cpu`） | 见下方「实体」一节 |
| **观点讨论题** | 「为什么我读三百本书没长进」 | `extract-themes-llm.mjs` | 默认 |
| **故事征集题** | 「有哪些平淡却心酸的暗恋故事」 | `extract-themes-llm.mjs` **+ 内容性质判定** | **`--profile stories`** |
| 纯检索 / 只要全文 | 「如何评价 X」 | 只跑 ① ② ④ | — |

> ⚠️ **「推荐什么」不等于「书单」。** 实体是 CPU 型号 / 相机 / 键盘 / 工具这类**裸词**时，
> 走**实体抽取**而不是 `extract-books-llm.mjs`（后者提示词是为书名写的）。
> 现成预设：`books` / `pythonlibs` / `cpu`；换实体类型写 `scripts/presets/xxx.json` 即可。
> ⚠️ CPU 这类型号与**主板芯片组 / 显卡**共用同一套字母数字命名（`B650M`、`GTX750`），
> 正则分不出品类 —— **写预设时必须显式排除跨品类 token**，否则榜单头部会被主板占满。

`--profile stories` 会把提示词从「归纳观点」切换成「归纳故事原型与结局形态」，
综述项的标签也会跟着换（母题 / 结局形态 / 值得先读的故事），不再出现「共识要点」这类读书题词汇。
**`summarize-answers.mjs` 也要传同一个 `--profile`**，否则综述口径对不上。

**故事征集题额外必跑** `classify-content-llm.mjs --all`（题型表里的「内容性质判定」就是它）。
原因：这类题的回答里混着盐选付费内容、虚构小说和灌水，而按赞数排的头部
**约 60% 的赞数来自虚构内容**。不判定就出报告，读者会把小说当真实故事读。

> ⚠️ **`enrich-flags.mjs` 不在必跑之列。** 新抓的产物已自带 `answer_type`
> （见上方「内容性质」一节），只有**补字段之前抓的旧产物**才需要补一遍。
> 详见 [`references/content-kind.md`](./references/content-kind.md)。

题型判断不了就先跑 ① ②，看前 20 条高赞回答长什么样再定。

### 产物目录不在脚本目录

脚本里**没有硬编码输出目录**，按这个顺序解析：

```
$ZHIHU_QUANT_OUT  →  <skill>/config.json 的 outDir  →  ~/Documents/zhihu-quant
```

所以**产物不在脚本目录旁边**。找不到 `q<ID>-answers-full.json` 时，
先 `echo $env:ZHIHU_QUANT_OUT` 和查 `config.json`（没有这个文件就说明在用最后的默认值），
别急着重抓。
（历史上默认目录是 `Documents\Default Project\`，重构后改了，两边都可能有旧产物。）

**优先走这条而不是下面的实体管线**，三个原因：

- `question --limit 1000` 拿不全（实测 3707 条只拿到 1597 条），要分页接口
- **正则抽书名的召回是坏的**：只认《》，漏掉裸书名，而漏掉的恰好是最高频的那几本
- 观点讨论题、故事征集题根本没有「实体」可抽

---

## 要统计某个问题下的实体（库名 / 书名 / 公司 / 概念）

**不要手写脚本，`pipeline.mjs` 已经是一条命令：**

```bash
node "$SCRIPTS\pipeline.mjs" <问题ID> --preset books
```

它会自己做桥接自检 → 抓全部回答全文 → 抽实体 → 出 HTML 报告。
抓取 380 条回答约 5 分钟（并发 3），中断重跑会续。

注意两条限制：回答数 >1000 时它拿不全（内部 `fetch-answers.mjs` 受 `--limit 1000` 限制），
要换 `fetch-answers-api.mjs`；做书单排行请改用 `extract-books-llm.mjs`，因为正则只认书名号、
漏掉裸书名，漏掉的恰好是推荐量最高的那几本。理由见 `references/pipeline-v2.md` 第 2、3 节。

改预设重跑时加 `--skip-fetch` 省掉这几分钟。

**换实体类型：写一个 `scripts/presets/xxx.json` 就行，不用改代码。**
现成预设：`books`（书名）、`pythonlibs`（Python 库名）、`cpu`（CPU 型号）。

**同一实体有多种写法时（`i5-12400F` / `12400F`），预设里加 `normalize.stripPrefixes`
做别名归一** —— 不合并会把赞数拆散、榜单头部直接错。
合并按**去重后的回答数（并集）**，不是把两个计数相加。
写法见 [`references/presets.md`](./references/presets.md) 的「别名归一」一节。

### 动手前必须知道的三件事

1. **`question` 命令的 `content` 被截断到 200 字符（中位数仅 36）。**
   做实体抽取必须用 `answer-detail --max-content 0` 逐条取全文，两者差 3.8 倍。
   管线已经处理，但你手写脚本时别踩。
2. **并发上限是 3。** 实测并发 6/10 速率不再提升（瓶颈在每次调用起 Node 进程），且并发 3 时零失败、无 DNR 串扰。
3. **抽取必须显式过滤噪音，且不能静默丢弃被过滤的内容。**
   中文弯引号大量用于强调（`对"中国"有见解`），《》里也常装概念而非书名（`《三农问题》`）。
   被过滤的记进 `extraction.rejectedSample` / `contextGuardDroppedSample`，
   并在报告「数据口径」里写明规模 —— 让口径可查。

### 报告口径的硬性要求

- 正文是全文不是摘要，避免读者以为数据不全
- 样本量差值要说明原因（多少条已删除/隐藏拿不到）
- **「最高赞」是代理指标**：它是「提到该实体的回答里赞数最高那条」的赞数，不等于实体本身热度，必须标注
- 噪音过滤的规模要写出来（"滤掉 132 条"），而不是让人以为本来就没有
- 缺失值标出来，不要用 0 冒充

---

## 调用纪律

### 0. 别拿 `--help` 去试探会写外部状态的脚本

**`--help` 不是安全选项。** 脚本没实现它时，参数会被忽略、脚本照常执行。

实测踩过：`node publish.mjs --help` —— 本以为只是查用法，
实际**直接开始向 GitHub 推送**（好在 blob 上传失败，没产生提交）。

`publish.mjs` 现在**已在工具层加固**：识别 `--help` 只打印用法，
**任何未知参数一律拒绝执行**（exit 1），不再静默忽略。

但这条纪律对**其他**会写外部状态的脚本仍然适用。凡是
`publish` / `push` / `write` / `delete` 这类命令，
**先读脚本头部注释确认用法，不要用任何方式试探**。

### 1. 读 Panerelay 命令的参数用 `--help`（只读命令才行）

每个命令的参数和输出字段都可能和你以为的不一样：

```bash
panerelay zhihu question --help
```

### 2. 输出是顶层 JSON 数组

```js
const rows = JSON.parse(stdout);   // 不是 .items / .data
```

### 3. Node 里一律经 `panerelay-run.mjs` 调用，不要自己拼 shell

**不要**这样写（会把 URL 里的 `&` 当命令分隔符，命令被从中间劈开，
前半段「碰巧成功」、后半段变成独立命令报错 —— 表现为 exit code 非 0，
**看起来像服务端返回了错误**，极具误导性）：

```js
spawnSync('cmd.exe', ['/c', 'panerelay', 'fetch', url, '--response', 'json'])  // ❌
```

**应当**这样写：

```js
import { panerelay } from './panerelay-run.mjs';        // skill 内 / tools 内各有一份
const r = panerelay(['fetch', url, '--response', 'json'], { timeout: 90000 });
if (!r.ok) throw new Error(r.text);
const data = JSON.parse(r.text);
```

`panerelay-run.mjs` 的做法是**绕开 `.cmd` 垫片、直接用 node 跑 CLI 真实入口**，
参数走数组传递，全程不经过任何 shell，因此不存在分隔符解析问题。
找不到 node 入口时才退回 cmd 垫片，并手动给含特殊字符的参数加引号。
回归测试见 `scripts/test-shell-injection.mjs`。

（历史教训：直接 `spawnSync('panerelay.cmd', ...)` 会**静默全部失败** ——
无报错、exit 0、stdout 为空。那是另一回事，别和上面这条混。）

### 4. `question` 只收数字 ID，不收 URL

从回答 URL 里取 ID：正则是 `answer/(\d+)`。

### 5. 排序：只用 `default`（2026-10-16 修正）

旧结论「两种排序返回的集合不同，单一排序会漏」**来自 `question --limit 1000` 的截断场景，不适用于分页接口**。
分页抓取下 A/B 实测（question/650705759，703 条）：`default` 703 条 ⊇ `created` 659 条，
**仅 created 有的 0 条**；小问题 38 = 38 完全一致；两排序 `totals` 相同。

`fetch-answers-api.mjs` 现在的默认行为：**只翻 `default` 的全部页**，再取 created 首屏做覆盖检查 ——
全覆盖则跳过（省一半请求），有缺失才退回双排序全抓。要强制旧行为：`--sorts both`。

### 6. `--limit` 上限 1000 —— 有绕法，别将就

`question` 单次最多 1000 条且**没有分页参数**。回答数更多时不要「换问题」，也不要只跑两遍排序
（实测 3707 条，两种排序合并也只有 1597 条）。正确做法是走分页接口，
见 [`references/pipeline-v2.md`](./references/pipeline-v2.md) 第 2 节。

用 `--query` 逐个传参数，**不要把参数拼进 URL** —— `&` 会被 cmd.exe 当成命令分隔符。

---

## 限速与并发

两条通道各有各的上限，**都不是越高越好**：

| 通道 | 并发上限 | 实测依据 |
|---|---|---|
| Panerelay（抓知乎） | **3** | 并发 3→8→12 吞吐只提升 1.0~1.09x；扩展内部用 DNR session 规则注入 Cookie，高并发会串扰。2026-10-16 复核：12 页同题 A/B 并发 1 / 3 / 6 = 0.75 / **0.59** / 0.64 秒/页（单请求裸耗时 487ms，其中纯进程启动 125ms）—— 并发 3 已是甜点 |
| 本地 LLM 网关（127.0.0.1:7863） | **5** | 并发 12 时 15 个批次只成功 6 个 —— 加并发换来的是失败不是速度 |

- 调用之间留 60~350ms 间隔
- `answer-detail` 是逐条调用，约 1.2 秒/条；分页接口每页 20 条，约 1.5 页/秒
- 抓取的真正杠杆是**减少请求数**（单排序 + 覆盖检查，见 §5），不是提高并发
- LLM 脚本默认 `--model auto`：上游 503/429 自动切模型，不再进入「每批 4 次退避重试」的慢速失败路径；
  批次命中 429/5xx 会等 5 秒收尾重试一轮（细节见 `references/scripts.md`「模型与 reasoning」）
- 命中风控（返回 401 / 空 body）就退避重试，不要硬冲；连续 401 先自查
  `attachedCookieCount`，别当成服务端故障

### ⚠️ 并发会话没有锁

**两个会话同时跑同一个问题 ID，脚本不会互相察觉，会各自完整抓一遍。**
实测发生过：两个会话各抓一次 question/303487786，浪费约 400 次请求，
产出两份等价数据（3,898 / 3,895 条，ID 交集 3,895）。

**开工前先查产物是否已存在**：

```powershell
Get-ChildItem @($env:ZHIHU_QUANT_OUT, "$env:USERPROFILE\Documents\zhihu-quant") `
  -Filter "q<ID>-*" -ErrorAction SilentlyContinue
```

已有 `-answers-full.json` 就直接跳过抓取；已有 `-summaries.json` 就跳过摘要。
**不要靠"没看到输出"判断没跑过** —— 输出可能落在另一个目录。

另外：脚本目录是共享的，多会话同时改同一批脚本会互相覆盖。
动脚本前先看文件的 `LastWriteTime`。

---

## 跑长任务时的坑

**动手前读 [`references/pipeline-v2.md`](./references/pipeline-v2.md) 第 10 节** ——
六个实测踩过的坑，每条都带复现步骤：

- `| Select-Object -First N` 会**杀掉上游进程**（实测 3898 条只跑完 752 条）
- 「脚本存在」不等于「功能存在」（重跑报「0 批待处理」不一定是跑完了）
- 失败批写空值会让续跑永远跳过（`{kind:''}` 是 truthy）
- 模型会臆造不存在的 ID，统计前必须清孤儿
- 写进文档的每个数字都要拿数据对账
- 别用 `--out` 换路径来出「另一个口径」的产物

---

## 健康检查

底层任意请求的返回里都有 `attachedCookieCount`：

```bash
panerelay fetch "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=2" --response json
```

`attachedCookieCount > 0` 才说明 Cookie 真的挂上了。这个字段比看 `whoami` 更可靠 ——
`whoami` 只验证桥接连通，不验证 Cookie 注入。

---

## 两个已知的、会误导人的坑

**① 扩展 manifest 缺 `host_permissions`（已修补，别回退）**

没有 host 授权时 `chrome.cookies.getAll()` 返回空数组，Panerelay 拿空 Cookie 表去注入，
服务端一律 401，**报错是「身份未经过验证」** —— 看起来像知乎风控或没登录，实际是本地 manifest 少一个字段。

本机已在 `%USERPROFILE%\.panerelay\extension\manifest.json` **和源码**里补上：

```json
"host_permissions": ["*://*.zhihu.com/*", "*://zhihu.com/*"]
```

换扩展目录或重新构建后**必须确认这一行还在**，否则会退回 401。

**② 不要用目录联接绕过 Edge 默认配置目录**

Chrome/Edge 136+ 禁止在默认 `--user-data-dir` 上开远程调试。
有人会试图用 junction 绕过路径检查 —— **这会导致浏览器判定 Cookie 无法解密
（App-Bound Encryption 与路径绑定），清空整个 Cookie 库。已实测踩过。**

---

## 写操作需要显式确认

`comment` / `like` / `favorite` / `follow` / `answer` / `article-create|update|delete`
会真实改变账号状态或对外发布内容。

- **只在用户明确要求时执行**，不要"顺手"点赞或收藏来测试连通性。
- 加 `--execute` 前先向用户确认目标链接。
- 执行后不要把"点成功了"当成"公开发布了"；`article-*` 的公开发布仍需用户在浏览器里完成。

---

## 详细资料

- **不知道跑哪条命令**：读 [`references/usage.md`](./references/usage.md)
  —— 四条路线的完整命令 + 三个闸门的通过判据 + 症状→动作查找表
- **汇总流水线手册（2026-10）**：读 `references/pipeline-v2.md`
  —— 全量抓取、观点聚类、排行口径、模型配置的实测记录，做汇总页前必读
- **内容性质：严选/盐选、虚构小说、灌水**：读 `references/content-kind.md`
  —— **故事征集题必读**。严选 vs 小说互不包含、严选被算法加权、
  虚构率随篇幅陡增、为什么抽样判定不可用
- **实战手册（含全部踩坑记录与判断依据）**：读 `references/playbook.md`
  —— 动手前先读，能省掉大部分试错
- **写新的实体抽取预设**：读 `references/presets.md`
- **产物已在盘上（查内容 / 口径 / 简报）**：读 [`references/zj-cli.md`](./references/zj-cli.md)
  —— `zj.mjs` 只读本地、零网络；口径由 machine 填，观点位置留占位符；自测 `test-zj.mjs`
- **对外发布（合规版报告）**：读 [`references/publish.md`](./references/publish.md)
  —— 五道硬闸门（不收录全文 / 短引用 / 剔除匿名与机构号 / 署名回链 / AI 标识）与发布前人工清单
- **把数据做成视频**：读 [`references/video.md`](./references/video.md)
  —— 本 skill 只到"备料"为止；分镜/渲染/两道闸门在 **`data-video`** skill（数字必须走 `facts.json`）
- **官方 CLI 的静默坑与路由速查**：`~/.config/opencode/notes/zhihu-cli.md`
- **换机部署**：`references/setup.md` —— 完整装机步骤 + 故障排查表
- **工具脚本与完整流程**：`references/scripts.md`

---

## 报告输出要求

统计类结论必须交代口径：

- 样本是多少条（抓到 N 条 / 平台共 M 条），**差值要说明原因**（例如已删除的回答不在列表接口返回中）
- 「最高赞」这类聚合指标要标明它是代理指标，不等于实体本身热度
- 缺失值要标出来，不要用 0 冒充
- 结论旁边挂原始链接
- **故事征集题还要交代内容性质**：虚构/改编多少条、占比多少、
  灌水多少条，以及「真实经历 ≠ 内容为真」的免责。
  没做性质判定就出报告，等于让读者把小说当真实故事读。