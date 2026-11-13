# zj CLI —— 产物的查询 / 口径 / 简报

> 定位：抓取之后的**最后一公里**。只读本地产物，零依赖，零网络请求。

## 为什么需要它

2026-10-29 实测：30 条回答抓取耗时 1 秒，但接手的人还要：

1. 用 `node -e` 猜 JSON 结构（产物是**裸数组**，不是 `{answers:[...]}`）
2. 在 PowerShell 里连踩两次引号/编码解析
3. 手工读全文写综述

瓶颈早就不是"抓不到"，而是"抓到了没人写"。`zj.mjs` 把结构、口径、简报三件事固化成命令，
让机器只写它算得出来的部分，观点位置留 `<!-- 待填 -->`。

## 命令

```powershell
$S = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"

node "$S\zj.mjs" stats    2098800126764508086     # 人类可读口径摘要
node "$S\zj.mjs" manifest 2098800126764508086     # 写 q<ID>-manifest.json
node "$S\zj.mjs" brief    2098800126764508086 --out q<ID>-简报.md
node "$S\zj.mjs" q        2098800126764508086 --top 10 --links
node "$S\zj.mjs" q        2098800126764508086 --json --fields votes,comments,created_at
node "$S\zj.mjs" q        2098800126764508086 --type normal --min-votes 50
```

`<id|url>` 两者都收；`--dir` 显式指定产物目录（默认按 `$ZHIHU_QUANT_OUT → config.json → ~/Documents/zhihu-quant` 解析）。

## 输出模式（写死在代码里，不靠临场判断）

| 样本量 | 模式 | 说明 |
|---|---|---|
| ≤ 40 | `brief` | 一屏简报：机器读数 + 前 8 条 + 口径表 + 待填占位 |
| 41–200 | `compact` | 同上，前 15 条，摘录更长 |
| > 200 | `full` | 拒绝出简报（`--force` 可绕过）——请走 `summarize-answers → extract-themes-llm → render-answers` |

30 条的题出一整页 HTML 是浪费，800 条的题出简报是骗人。阈值不是审美，是防错。

## manifest 里有什么

`q<ID>-manifest.json` 是**下游唯一可信的口径来源**：

- `count` / `platform.totals` / `platform.missing`：实抓与平台总数的差值
- `coverage.pages`：完成页 / 失败页
- `coverage.fetchedSorts` vs `coverage.onlyCoverChecked`：**哪些排序真的翻完了页**
  （`created` 常只做首屏覆盖检查，绝不能写成"双排序全量"——这是口径错误，不只是措辞）
- `fields.*.missing`：每个字段的空值数（`0` 是有效值，不算缺失）
- `stats.votes` / `stats.chars` / `stats.time`：合计、中位、P90、前 3 占比、按天分布
- `warnings`：只写能从数据里证出来的问题
  - `平台 totals 比实抓多 N 条`
  - `正文中位数 <120 字` → 疑似 `question` 命令的 200 字符截断产物
  - `感谢数全缺` → 旧产物，需重抓 / enrich
  - 严选付费 / 机构号条数
  - 无 `state.json` → **完整性未知**（不声称完整）

## 退出码

| 码 | 含义 | 动作 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 用法错误 | 看 `--help` |
| 2 | 产物不存在 | 先 `fetch-answers-api.mjs <ID>` |
| 3 | 样本量超出简报阈值 | 走全量流水线，或 `--force` |
| 4 | 产物在别的目录 | **不猜**：显式 `--dir`，或先合并目录 |

退出码 4 是刻意的：产物散落在多个目录是实测事故（`Default Project/` 与 `zhihu-quant/` 各一份），
静默读错目录会让整份报告建立在错误的样本上。

## 简报的边界

简报是**骨架**，不是成品。它保证：

- 所有数字可回溯到 `manifest.json` 与产物 sha256
- 观点位置是显式占位符，不会出现"机器编的结论"

它**不**保证：

- 立场分布 / 数字冲突 / 最强反方 —— 这些要到 P1（`--profile debate` + 数字账本）才有
- 内容性质（严选 / 虚构 / 灌水）判定 —— 故事征集题仍必须跑 `classify-content-llm.mjs`

## 自测

```powershell
node "$S\test-zj.mjs"     # 43 条断言：统计口径 / 字段缺失 / 覆盖 / 阈值 / 告警 / 截断
```

口径算错不会报错，只会让报告更自信地错。所以测试断言的是数字本身，不是"跑通"。
