# 知乎实体抽取工具

把一个知乎问题变成一份带赞数、时间、溯源的结构化报告。

**先读 [`playbook.md`](./playbook.md)** —— 那里记录了所有踩过的坑和判断依据。
本文档只讲怎么用。

## 前置条件

1. Edge 里加载好 Panerelay 扩展。**推荐一次性注册为持久化未打包扩展**（`edge://extensions`
   → 开发人员模式 → 加载解压缩的扩展 → `%USERPROFILE%\.panerelay\extension`），
   之后普通启动 Edge 也能连上 —— 详见 `SKILL.md`「先决条件」。
   兜底：`~/.panerelay/start-edge.cmd`（等价于带 `--load-extension` 启动）。
2. 自检：

   ```bash
   node check-bridge.mjs
   ```

   三行全 OK 才继续。`FAIL` 时脚本会说明原因；断了直接跑
   `node ensure-bridge.mjs --fix`（会重启 Edge，**先问用户**）。
3. **手上是一个链接时，第一跳是 `node link.mjs "<URL>"`** —— 见下方脚本清单。

## 一条命令

```bash
node pipeline.mjs <问题ID> --preset <预设名>
```

例：

```bash
node pipeline.mjs 28193957 --preset books
```

产物（目录按 `$ZHIHU_QUANT_OUT` → `<skill>/config.json` 的 `outDir` → `~/Documents/zhihu-quant` 解析，见文末「输出目录」）：

| 文件 | 内容 |
|---|---|
| `q<ID>-answers-full.json` | 全部回答：正文全文 + 赞数 + 发布时间 + 评论数 |
| `q<ID>-entities.json` | 规范化实体 + 抽取统计（含**被过滤掉的内容**，用于核对口径） |
| `q<ID>-<问题标题>.html` | 主报告 |
| `q<ID>-<问题标题>.md` | Markdown 版 |

抓取耗时参考：380 条回答约 5 分钟（并发 3），519 条约 7 分钟。

## 回答汇总页（不做事先定实体类型时用这条）

要的是「把 N 条回答汇总成一页读」，而不是统计某类实体时，走这条：

```bash
node fetch-answers-api.mjs <问题ID>                              # ① 分页抓全量全文（>1000 条也拿得全）
node summarize-answers.mjs q<ID>-answers-full.json               # ② 逐条摘要 + 全局综述
node extract-themes-llm.mjs q<ID>-answers-full.json              # ③ 抽观点（观点讨论题）
node extract-books-llm.mjs q<ID>-answers-full.json               # ③' 抽书单（书单题）—— 二选一或都跑
node render-answers.mjs q<ID>-answers-full.json                  # ④ 渲染 q<ID>-汇总.html
node build-index.mjs                                             # ⑤（可选）刷新目录里的 index.html 总索引
```

产物：`q<ID>-汇总.html`（概览 / 综述 / 观点排行 / 书单排行 / 全部回答，均支持双向筛选）、
`q<ID>-themes.json`、`q<ID>-books-llm.json`、`q<ID>-summaries.json`。
`render-answers.mjs` 会自动按实际存在的区块编号，缺哪个就不渲染哪一节。

### 「有哪些……故事」类征集题：加 `--profile stories`

默认提示词是给读书/观点题写的，直接套到故事征集题上会答非所问
（综述问「分几派」「入门阅读顺序（带书名）」，标签要求区分「原因 vs 方案」）。加 `--profile stories`：

```bash
node fetch-answers-api.mjs  <问题ID>
node summarize-answers.mjs  q<ID>-answers-full.json --profile stories
node extract-themes-llm.mjs q<ID>-answers-full.json --profile stories
node render-answers.mjs     q<ID>-answers-full.json
node build-index.mjs
```

`stories` 档：摘要改为「谁与谁、因为什么事、最后怎么样」；综述改为
**反复出现的母题 / 结局的几种形态 / 值得先读的故事**（并在 `digest.labels` 里带上这三节标题）；
标签体系归纳的是**关系原型 + 结局形态**（如「多年暗恋不敢说」「重逢已各自成家」），不是观点。

`render-answers.mjs` / `build-index.mjs` 会**自动识别**（无书单产物但有标签 = 故事题），
把页面文案从「观点/主张」换成「故事母题/故事」，无需额外传参。

### 故事征集题还要加两步：内容性质

```bash
node enrich-flags.mjs          q<ID>-answers-full.json <问题ID>   # ① 补 answer_type 等标志
node classify-content-llm.mjs  q<ID>-answers-full.json --all    # ② 逐条判 真实/小说/改编/无关
node render-answers.mjs        q<ID>-answers-full.json          # ③ 自动出徽章 + 筛选
```

> **新抓取不再需要第 ① 步。** `fetch-answers-api.mjs` 的 `include=` 已含
> `answer_type` / `author.is_advertiser` / `author.user_type`。
> `enrich-flags.mjs` 只用于补救「在补字段之前抓的旧产物」。

### 出「去盐选版」时，综述也必须换口径

`--exclude-paid` 只影响正文榜单和母题聚合，**综述是 summarize 阶段生成的**。
如果沿用全量综述，页面会出现「榜单已剔盐选、综述还在推荐被剔掉的付费小说」——
实测原版综述的「值得先读的故事」第 4 条就是一条 2519 赞的严选小说。

```bash
# 逐条摘要沿用缓存，只重建综述（约 10 秒）
node summarize-answers.mjs q<ID>-answers-full.json --profile stories --exclude-paid --only-digest --rebuild-digest
node render-answers.mjs    q<ID>-answers-full.json --exclude-paid --out q<ID>-汇总-去盐选.html
```

综述按「剔除口径」存在同一个 `summaries.json` 的 `digests` 映射里（key 形如 `all|nokind`、
`nopaid|nokind`），渲染时按开关自动选对应那份。**同一份逐条摘要可同时服务两版页面。**

### 跑完必须校验

```bash
node verify-output.mjs q<ID>-answers-full.json                    # 校验 JSON 产物
node verify-output.mjs q<ID>-answers-full.json --html q<ID>-汇总.html   # 连页面一起校验
```

退出码 0 = 可用。实体类问题跑的是同一条命令 —— `--entities` 有默认值
（`q<ID>-entities.json`），存在就自动校验：

```bash
node verify-output.mjs q<ID>-answers-full.json \
  --entities q<ID>-entities.json \
  --html "q<ID>-<报告标题>.html"          # 报告页也认，模板自动判别
```

它检查三类东西：

**JSON 产物**：基线自洽（赞数合计为 0 / 正文字数为 0 / 重复 ID → FAIL，不再只打印）、
孤儿 ID、空 kind、枚举合法性、覆盖率、溯源链接、口径自洽。

**实体产物**（`--entities`，默认 `q<ID>-entities.json`）：实体名不得以「数字+空白」开头
（捕获组吞了裸前缀的碎片，如 `3 3200G` → FAIL）、实体名唯一、
**归一账目必须闭合**（`before - after === Σ(members - 1)`）、
被合并的写法不得仍作为独立实体存在。

**渲染后的 HTML**（传 `--html`）：**先判模板** ——
交互汇总页（`render-answers.mjs`，内嵌 `<script id="data">`）与
静态报告页（`render-report.mjs`，数据已渲成 DOM、**没有**数据块）结构不同，断言也不同：

- 汇总页：页面回答 ID 是否都来自源数据、剔除开关是否真的生效（剔了就不该有 `paid` 残留）、
  综述口径是否与剔除范围一致、回答是否带 `kind` 字段
- 报告页：页面实体行（`data-n`）必须与 `entities.json` **一一对应**（只渲了 TOP N 会 FAIL）、
  页头统计卡的「正文总字数 / 回答赞数总计」必须与源数据一致
- 两者共同：有无未插值的模板变量 `${...}`

> 报告页的统计卡**找不到就 FAIL**，不让校验静默跳过 —— 标签一改，宁可响亮地报
> 「模板改过了，闸门要同步更新」，也不要假装检查过了。

**LLM 阶段的失败是静默的**，不跑这一步就会把错的数字写进报告。
渲染层也有自己的 bug 面（模板变量没插值、综述选错口径），所以出页面后要再校验一次。

### 抓取：为什么用 `fetch-answers-api.mjs` 而不是 `fetch-answers.mjs`

`panerelay zhihu question <id> --limit 1000` **单次最多 1000 条且没有分页参数**。
回答数超过 1000 的问题（例：question/1937248651517863299 有 3707 条）会被截断 ——
即使两种排序合并也只拿到 1597 条。

`fetch-answers-api.mjs` 直接打 `/api/v4/questions/<qid>/answers` 分页接口：

- `limit` 上限是 **20**（试过 50/100 会返回空），3707 条 = 186 页/排序
- 该接口在 `include=data[*].content` 时返回**全文 HTML**，本地去标签后与
  `answer-detail --max-content 0` 的纯文本**逐字一致**（实测 6/6，含 3792 字长文）
- 所以 **186 次请求拿到全部 3707 条全文**，而不是 3707 次逐条抓取（约 47 分钟）→ 约 4 分钟
- **排序：只抓 `default` 即可，created 不增量。** 2026-10-16 A/B 实测（question/650705759，703 条）：
  `default` 703 条 ⊇ `created` 659 条，仅 created 有的 **0 条**；小问题 38=38 完全一致；
  两排序 totals 相同。脚本默认「default 全量 + created 首屏覆盖检查」，检查不通过才补抓 created 全量
  （旧的「双排序全抓」= 请求数翻倍，纯浪费；「两排序集合不同」的老结论来自
  `question --limit 1000` 截断场景，不适用于分页接口）
- ⚠️ `panerelay fetch` 传 URL 时 **`&` 会被 cmd.exe 当命令分隔符**（URL 被截断），
  必须改用可重复的 `--query` 参数逐个传，不要拼在 URL 里

`fetch-answers.mjs` 保留给 <1000 条的问题，两者输出格式完全一致。

### 为什么书单不能靠正则抽

`extract-entities.mjs --preset books` 只认「书名号 + 引号 + 词典」，**会系统性漏掉裸书名**。
实测在 question/491790104 上漏掉了最高频的《以利为利》（14 条回答提到）和
《转型中的地方政府》（15 条），于是那份书单实际是「谁恰好带了书名号」的筛选结果。
`extract-books-llm.mjs` 改用模型逐条读全文，能抓裸书名、合并同书异名，并区分
推荐 / 劝退 / 顺带提及。**做书单排行请用后者。**

### 书单排序口径

- **问题本体不计入排行**。《置身事内》在 52~67 条回答里被提到，但大多是顺口一提或
  与其他书比较（均赞远低于其他书），把它排第一是把「问题本身」当成「推荐结果」。
- 排序默认用**阻尼热度** `Σ log10(1+该回答赞数)`，兼顾「多少人推荐」与「推荐的人多有分量」。
  另可切「推荐人数」（忽略回答质量）与「赞数和」（会被单条超高赞回答拉偏）。
- 只列**被 ≥2 条回答明确推荐**的书；只被 1 条提到的（本题 217 个）不构成共识，不列入。
- **一句话书名投票计入排行**：正文只有「大国大城」四个字的回答，本质是一张选票，
  不能因为模型判成「仅提及」就丢掉（<40 字的回答里 mention 一律提升为 rec）。

### 「全部回答」区为什么不平铺

204 条回答里，**141 条赞数 <10，107 条正文 <80 字**，前 20 条占总赞数 92%。
把 204 条平铺成卡片，等于用 74 张卡片的篇幅展示 74 次「我也投这本书」。所以：

- **默认折叠低信息量**（正文 <80 字），只列有实质内容的 97 条；被折叠的书名投票
  已经计入上面的书单，信息不丢。
- **卡片瘦身**：默认只显示 `作者 · 赞 · 时间 · AI 摘要 · 推荐的书`，正文点开才看。
- **书 ↔ 回答双向联动**：点书单里的「看回答」→ 筛出推荐该书的回答；
  点回答里的书名标签 → 反向筛选。这是替代「一条条看」的关键。
- **分段渲染**：回答多时一次只铺 120 条，点「显示更多」继续，避免 3000+ 卡片把浏览器拖死。

### 观点排行（观点讨论题用）

「为什么…」「如何看待…」这类题没有「实体」可统计，走 `extract-themes-llm.mjs`：

1. **先归纳标签体系**：取高赞回答的要点，让模型归纳出 12~16 个**互斥且有区分度**的标签
   （要求 name ≤14 字、禁止「读书方法」这类笼统词）
2. **再逐条打标**：每条回答选 1~3 个标签；判为「简短赞同/调侃/无实质观点」的给空数组，不进排行
3. **排序**同样提供三档：综合热度 `Σlog10(1+赞)` / 主张人数 / 赞数和
4. **与「全部回答」双向联动**，机制和书单一样

实测 question/1937248651517863299（3667 条）：抽出 16 类观点，覆盖 3221 条回答。
「综合热度」和「主张人数」两个口径差异明显 —— 例：「量变到质变不必焦虑」338 条主张但热度排第 8
（赞数低），「缺输出闭环」400 条但热度第 4（赞数高）。

### 书单排序的一个坑

「热度」必须**只累计明确推荐该书的回答**（`recLogSum`），不能算上顺带提及。
否则被大量回答顺口提到的书会挤掉真正被推荐的 —— 实测该题按全部提及排序时，
《射雕英雄传》（推荐 5 / 提及 33）排第 1，只算推荐后掉出前 15。

## 复用已有数据

改完预设重跑时不用重新抓（省 5-7 分钟）：

```bash
node pipeline.mjs 28193957 --preset books --skip-fetch
```

## 选项

```
--preset <name>        用哪个预设（见 presets/）
--config <path>        用自定义配置文件
--dict <file.txt>      往词典里追加词（一行一个，# 开头为注释）
--concurrency <n>      抓取并发，默认 3。不要超过 3，再高无收益
--sleep <ms>           每次调用后间隔，默认 60
--limit <n>            只抓前 n 条（调试用）
--skip-fetch           复用已有的 answers-full.json
```

## 分步执行

管线里任何一步都可以单独跑：

```bash
node fetch-answers.mjs 28193957 --concurrency 3 --sleep 60
node extract-entities.mjs q28193957-answers-full.json --preset books --out q28193957-entities.json
node render-report.mjs q28193957-entities.json --answers q28193957-answers-full.json
node test-preset-rules.mjs cpu        # 改过 rules / dict / 边界开关就跑一次
```

## 换实体类型

**写一个 `presets/xxx.json`，不用改代码。** 字段说明见 [`presets/_README.md`](../scripts/presets/_README.md)。

现成预设：

| 预设 | 用途 |
|---|---|
| `books` | 书名（`《》` + 引号 + 词典，三层）。⚠️ **正则版会系统性漏掉裸书名**，做书单排行改用 `extract-books-llm.mjs` |
| `pythonlibs` | Python 库名（行内代码 + PyPI 链接 + 词典） |
| `cpu` | CPU 型号（带前缀规则 `i5-12400F`/`Ryzen 7500F` + 省略前缀词典 `12400F`/`7800X3D`）。用于**硬件/商品推荐题** |

⚠️ 已写进文档的预设必须真实存在，反之亦然 —— `check-docs.mjs` 第 7 节会比对
`presets/` 目录与本文表格，两边不一致直接 FAIL。

写新预设的顺序：

1. **先看数据再写规则** —— 跑一次抓取，然后打印几条正文看看这个领域的文本长什么样
2. 先上高精度规则，再考虑词典
3. 看 `extraction.rejectedSample`，如果被拒的里面大半是真实实体，说明过滤太狠
4. **人工验证 TOP 20 的溯源上下文** —— 榜单头部错了整份报告就没意义

## 脚本清单

| 脚本 | 作用 |
|---|---|
| **`link.mjs`** | **"给链接"的第一跳**。`node link.mjs <URL\|ID>` → 识别链接类型（问题/回答/专栏/用户/收藏夹/搜索/热榜）→ 报桥接状态与已有产物 → **打印下一跳该照抄哪条命令**。退出码：0 可继续 / **3 产物已在（别重抓，从②开始）** / 4 桥接断（给出 `ensure-bridge --fix` 与 harness 浏览器两条路）/ 1 认不出的链接（不猜 ID）。**新会话拿到 URL 就该从这跑起**（2026-10-16 事故：没有这一跳时，会话依次试 panerelay→webfetch→harness 浏览器，全程跑偏） |
| **`ensure-bridge.mjs`** | **桥接修复**。默认只探测；`--fix` = 结束后台 Edge → 带扩展重启 → 轮询复验（约 30 秒）。安全闸：只杀「纯后台模式」（无窗口）的 Edge，检测到窗口会**拒绝执行**除非 `--fix --force`；`--mode=normal\|load` 可强制启动方式（扩展已持久注册时自动用 normal）。**agent 跑 `--fix` 前必须先问用户**（会重启浏览器） |
| `pipeline.mjs` | 一键管线（抓取 → 抽取 → 渲染） |
| **`precheck.mjs`** | **开工前置闸门**（⓪）。查产物是否已完整、输出目录解析、桥接是否通。退出码：0 READY / **3 产物已完整（从②开始复用，`--force` 才重抓）** / 4 桥接不通 / 5 产物散落在非解析目录 / **6 发布版轻检不通过（`--publish`）**。`fetch-answers-api.mjs` **已内建同一道闸**（产物完整直接 exit 3，不发网络请求），单独跑它的价值在于「被下游 import」，不在于「记得先跑」。`--dirs` 只看目录解析；`--publish` 只看发布版是否存在/过期/联系方式/占比（完整核对走 `verify-publish.mjs`） |
| **`check-bridge.mjs`** | 桥接与 Cookie 注入健康检查（`pipeline.mjs` 内部调用）。三行全 OK 才继续 |
| **`bridge-advice.mjs`** | **桥接故障指引文案来源**（单一来源，供 `doctor.mjs` / `check.mjs` / `check-bridge.mjs` / `precheck.mjs` / `link.mjs` import）。2026-10-16 起首选建议是 `ensure-bridge.mjs --fix`，并给出「持久注册未打包扩展」的治本做法与 `start-edge.cmd` 兜底。**指引指向不存在的文件等于没有指引**（2026-10-15 事故：`.lnk` 丢失时 `check.mjs` 指向它，用户只能停下来问） |
| `fetch-answers.mjs` | 抓取全部回答（全文+赞数+时间+评论），支持断点续跑（<1000 条用） |
| `fetch-answers-api.mjs` | **分页抓全量全文**（>1000 条也能拿全，走 API 分页）。默认**只抓 `default` 排序 + created 覆盖检查**（跳过重复请求，省一半）；`--sorts both` 双排序全抓（旧行为）、`--sorts created` 只要时间序、`--no-cover-check` 连检查也不发 |
| `extract-themes-llm.mjs` | **抽观点标签**（观点讨论题：先归纳标签体系，再逐条打标）`--profile stories` 用于故事征集题 |
| `extract-books-llm.mjs` | **读全文抽书单**（LLM，区分推荐/劝退，能抓裸书名） |
| `summarize-answers.mjs` | 逐条 AI 摘要 + 全局综述（走本地网关）`--profile stories` 用于故事征集题 |
| `render-answers.mjs` | 回答汇总页 HTML（统计/综述/观点/书单/全文检索与双向筛选）。`--exclude-paid` / `--exclude-org` / `--exclude-kind` 剔除内容并重算母题聚合，**综述按口径自动选对应版本**；自动读取 `-content-kind.json` 出徽章与筛选 |
| **`verify-output.mjs`** | **产物校验 / 回归基线**。JSON 产物：**基线自洽（赞数合计为 0 / 正文字数为 0 / 重复 ID → FAIL）**、孤儿 ID、空 kind、枚举合法性、覆盖率、溯源链接、口径自洽；实体产物（`--entities`）：碎片实体名 / 实体名唯一 / **归一账目闭合** / 被合并写法无残留；渲染后 HTML（传 `--html`）：**先判别模板**（汇总页 vs 报告页），再分别断言 —— 汇总页查剔除是否生效 / 综述口径 / kind 字段，报告页查页面实体行是否与产物一一对应 / 统计卡数字是否与源数据一致。退出码 0 = 可用。**每次跑完都该过一遍** |
| `render-publish.mjs` | **合规发布版** HTML：只保留统计 + 结论 + 短署名引用，默认剔除匿名/机构/严选，产出 `-发布版-citations.json` 引用台账。**内部汇总页（`render-answers.mjs`）不能对外发布**；五道闸门与人工清单见 `references/publish.md` |
| **`verify-publish.mjs`** | **发布版闸门**（发布前）。逐字核验引用是否原文（防改写/拼接）、页面是否搬运正文、引用占比 < 1%、剔除三类是否生效、AI 标识/撤稿联系方式是否齐备、页面数字是否与重算一致。退出码 0 = 可发；`--strict` 把 WARN 也当失败；`--json` 给自动化 |
| `publish-rules.mjs` | 发布版**剔除规则与联系方式的单一来源**（被 `render-publish` / `verify-publish` / `precheck --publish` 共同 import）。改口径只改这里，避免「渲染剔了、闸门没剔」 |
| `build-index.mjs` | 扫描目录生成 `index.html` 总索引（按问题归组，Markdown 默认收录，`--no-md` 排除） |
| **`enrich-flags.mjs`** | **轻量补抓 `answer_type`/`is_advertiser`/`user_type`/徽章，按 ID 回填已有 JSON，不重传正文**（第一次抓取漏了这些字段时用） |
| `classify-content-llm.mjs` | **判内容性质：真实经历 / 小说创作 / 改编虚构 / 与问题无关**。`--all` 全量判定（推荐），`--sample N` 抽样估比例（快但保证不了头部正确）。批次失败会**自动对半拆分重试**；未判完时退出码为 2 |
| **`eval-extraction.mjs`** | **抽取质量量化评估**：`--make-sample N` 生成分层标注样本，`--check f.json` 算精确率/召回率/F1 + 混淆矩阵 + 错例明细。改提示词/换模型前先跑它 |
| **`lock.mjs`** | **按资源 ID 的文件锁**（被 `fetch-answers-api.mjs` 使用）。活着的进程持有 → exit 3 并打印已有产物；陈旧锁（进程已死或超 6 小时）→ 接管 |
| **`llm-model.mjs`** | **LLM 模型解析**（被 4 个 LLM 脚本 + 2 个 fill-one 脚本 import）。`--model auto`（默认）开局探测模型链（默认 `global:deepseek-v4.1-flash,cn:deepseek-v4.1-flash`，可用 `ZHIHU_LLM_MODELS` 覆盖），挑第一个可用的；结果缓存 10 分钟。上游 503/429 时不再进入「每批 4 次退避重试 ×2」的慢速失败路径。显式 `--model <名字>` 时不探测。auto 模式下换上游不作废 state 缓存（严格比对会退化成整轮重算），实际用的模型记录在产物的 `resolvedModel` 字段 |
| **`opencode-llm-shim.mjs`** | **Plan B 后端**：把本地 OpenAI 兼容请求转成真实 `opencode-cli run` 会话，让流水线走 OpenCode 免费模型（不依赖本地网关）。起法与切换见「环境变量」一节 |
| `fill-one-summary.mjs` | 补单条摘要（批处理因 max_tokens 截断反复失败时） |
| `fill-one-theme.mjs` | 补单条标签（同上） |
| `extract-entities.mjs` | 按预设抽实体（正则，输出规范化 JSON） |
| **`test-preset-rules.mjs`** | **抽取规则的回归测试**：按预设的 `fixtures` 造合成语料 → 跑真的 `extract-entities.mjs` → 逐条断言「该抽到的抽到、不该抽到的没抽到」。**改任何 `rules` / `dict` / 边界开关后必跑** |
| `render-report.mjs` | 实体 JSON → HTML + Markdown |
| `ck-count.mjs` | 读 Edge Cookie 库，确认登录态 |
| `zhihu-cookies.mjs` | 同上，列出 zhihu 相关 cookie 明细 |
| `doctor.mjs` | 12+ 项环境自检，每项 FAIL 带修复指引 |
| `check.mjs` | 只看桥接与 Cookie 注入；`--endpoints <问题ID>` 逐项复核端点签名要求 |
| **`check-docs.mjs`** | **文档一致性检查**：高频结论的数字是否分叉、文档提到的开关代码是否支持、陈旧路径、断链、脚本清单、锁覆盖 |
| `publish.mjs` | 同步整个 skill 到 GitHub（`--dry` 预览；未知参数拒绝执行） |
| `test-lock.mjs` | `lock.mjs` 的行为测试（12 项，含陈旧锁/超期锁/损坏锁） |
| **`test-verify-publish.mjs`** | **发行版闸门的回归测试**（合成数据，不碰真实产物）：render → verify 基线应 0 FAIL，5 类篡改（联系方式占位符/改写引用/页脚数字/搬运正文/删 AI 标识/占比超限）必须被拦。**改 render-publish 或 verify-publish 后必跑** |
| **`test-throttle.mjs`** | **`panerelay-run.mjs` 的节流与 403 检测测试**（12 项）。改节流逻辑后必跑 |
| `test-shell-injection.mjs` | `panerelay-run.mjs` 的调用层回归测试 |
| `eval-baseline.json` | 内容性质判定的标注基线（40 条分层样本 + 人工标注 + 基线指标） |

> 旧脚本已清理完毕（早先文档提到的 `_old-*.mjs` 现已不存在，别再找）。
> 仍在但已降级的三个：`fetch-answers.mjs`（仅 <1000 条时用，>1000 走 `fetch-answers-api.mjs`）、
> `ck-count.mjs` / `zhihu-cookies.mjs`（查 Cookie 库，日常诊断已被 `doctor.mjs` 取代）。

## 硬性要求

- **正文必须取全文。** `question` 命令的 `content` 被截断到 200 字符（中位数 36），
  用它做抽取会漏掉 3/4 的内容 —— 要么逐条 `answer-detail --max-content 0`，
  要么走 `fetch-answers-api.mjs`（分页接口本身就返回全文 HTML）。
- **`question` 收数字 ID，不收 URL。** 从回答 URL 取 ID 用正则 `answer/(\d+)`。
- **排序：分页抓取下 default 是 created 的超集**（2026-10-16 A/B：703 ⊇ 659，仅 created 多 0 条）。
  管线默认单排序 + created 覆盖检查；`--sorts both` 才是双排序全抓。

## 模型与 reasoning

四个 LLM 脚本（`summarize-answers` / `extract-themes-llm` / `extract-books-llm` / `classify-content-llm`）
默认 **`--model auto`**：开局探测模型链挑可用的（默认 `global:deepseek-v4.1-flash,cn:deepseek-v4.1-flash`），
`reasoning_effort: "none"`（配置里标注 x0.00，免费）。
**为什么要 auto（2026-10-16 实测）**：上游限额期间 `global:` 返回 503，而每批的失败重试是
「4 次 × 1.2~1.5s 退避，失败后二分拆批再来一遍」——单批几十秒、整轮几分钟空转零产出。
同一时刻 `cn:` 正常（38 条 / 12 批 / 20 秒跑完）。auto 用一次 1-token 探测（约 1.5s）换掉整段空转。
切换：`--model <id>`（显式指定则**不探测**，行为与旧版一致）/ `--effort <none|minimal|...|off>`。

**换模型或换档位会自动作废 state 缓存重跑**（state 里存了 `modelTag`）。
例外：`auto` 模式下「上游从 global 换成 cn」这类**同链切换不算变化**，沿用旧缓存
（否则上游一抖动，几百批摘要全部重算）；实际使用的模型写入产物的 `resolvedModel` 字段。

LLM 批次命中 **429/5xx** 时不再直接判失败：记录后等 5 秒**收尾重试**一轮
（实测 12 批的题两次各坏 1 批，多为瞬时抖动，重试即过）。其余失败仍按「对半拆批」处理。

### 实测：哪些参数真能关 reasoning

只有两个生效，其余**静默失效**（实测 deepseek-v4.1-flash，2026-10）：

| 参数 | reasoning 字数 |
|---|---|
| `reasoning_effort: "none"` | **0** ✅ 1.1s（原 2.0s） |
| `thinking: {type:"disabled"}` | **0** ✅ 1.4s |
| `reasoning_effort: "minimal"` | 237 字 ❌ 没降 |
| `enable_thinking: false` | 182 字 ❌ 忽略 |
| `thinking: false` | 185 字 ❌ 忽略 |
| `reasoning: false` | 254 字 ❌ 忽略 |

两个反直觉的坑：

- `gpt-6-luna` 加这些参数会 **HTTP 200 但 content=0、tokens 0/0**，静默返回空
- `kimi-k2.6` 加 `reasoning_effort:"minimal"` 反而**打开**思考（591 字 / 8s），基线本来是 0

三个脚本都加了兜底：开了 reasoning_effort 却拿到空返回时，自动去掉该参数重试一次。

### 实测：慢的不是 reasoning，是模型

同一批 20 条回答（约 6300 字）、同一提示词：

| 配置 | 耗时/批 | 价格 |
|---|---|---|
| `global:glm-5.3-flash`（旧默认） | 14.2 – 15.9s | x0.06 |
| `global:deepseek-v4.1-flash` + `none` | **4.8 – 5.8s** | **x0.00** |

**快 2.7 倍且免费**，摘要质量逐条比对无差异。
（glm 的 reasoning 实测≈0，所以瓶颈是模型本身，不是思考。）

### 并发

本地网关并发上限约 **5**。实测并发 3→8→12 吞吐只提升 1.0~1.09x，
而并发 12 时 15 个批次只成功 6 个 —— 加并发换来的是失败而不是速度，保持 5。

## 输出目录

输出目录不是硬编码的，按 `$ZHIHU_QUANT_OUT` → `<skill>/config.json` 的 `outDir` → `~/Documents/zhihu-quant` 解析。

## 环境变量

- `WB2API_KEY` —— 本地网关（默认 `http://127.0.0.1:7863/v1`）的密钥，LLM 脚本都要，读不到直接退出
- `WB2API_BASE` —— 覆盖网关地址；指向 Plan B shim（`http://127.0.0.1:7871/v1`）即整条流水线切到 OpenCode 免费模型
- `ZHIHU_LLM_MODELS` —— 覆盖 `--model auto` 的探测链（默认 `global:deepseek-v4.1-flash,cn:deepseek-v4.1-flash`）

### Plan B：OpenCode 免费模型 shim（`opencode-llm-shim.mjs`）

本地网关没有可用上游时（欠费 / 上游限额 / 换机没装）的顶班方案。2026-10-19 实测可用：

```powershell
# 窗口 1：起 shim（默认 127.0.0.1:7871，日志打在 stdout）
node "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts\opencode-llm-shim.mjs"

# 窗口 2：跑流水线 —— 加三个环境变量即可，脚本不用改
$env:WB2API_BASE = 'http://127.0.0.1:7871/v1'
$env:WB2API_KEY  = 'shim'   # 占位，shim 不校验
$env:ZHIHU_LLM_MODELS = 'opencode:deepseek-v4.1-flash-free,opencode:glm-5.3-flash-free'
```

- 原理：免费模型只准「OpenCode 内」调用（外部直连 403 `FreeTierError`、本机 `/api/experimental/generate` 503），
  shim 把每个请求转成一次真实的 `opencode-cli run` 会话，再按 OpenAI 格式回包。
- 冒烟实测：小问题 E2E（17 条 / 6 批 / 并发 3）94.5 秒、10 次调用 0 失败；单批 7.5~60 秒，
  抖动比网关大，建议 `--concurrency 3`。排队上限（`SHIM_CONC`，默认 4）超了只是排队，不报错。
- 成功的会话自动删除；失败会话保留，sessionID 与原因在 shim 日志里（`SHIM_KEEP_SESSIONS=1` 可全留）。
- `max_tokens` / `temperature` / `reasoning_effort` 不透传（会话通路没有这些参数）；
  失败（超时 / 退出码非 0 / 空文本）返回 **503**，走脚本既有的退避重试与对半拆批，不会写出空值。
- 与网关互相切换不作废 state 缓存（`--model auto` 记 `auto` 标签）；免费额度是官方「限时」策略，别当长期依赖。
- 其他旋钮（`SHIM_PORT` / `SHIM_TIMEOUT` / `SHIM_STANDALONE` / `OPENCODE_CLI`）见脚本头注释。