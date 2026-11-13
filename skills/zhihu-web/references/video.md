# 知乎数据 → 视频：本 skill 只到"备料"为止

> **渲染与闸门不在本 skill**：分镜、出帧、配音、成片、封面、两道自动闸门都在
> **`data-video`** skill（`~/.config/opencode/skills/data-video/`）。
> 本文只讲"知乎侧要准备什么"，以及为什么这样切。

## 分工

```
zhihu-web（本 skill）                        data-video（渲染侧）
  抓取 → q<ID>-answers-full.json  ─────►      facts.spec.mjs ──► facts.json
  聚类 → q<ID>-themes.json                    shots-*.json（旁白/画面写 {{f:key}}）
  书单 → q<ID>-books-llm.json        ─────►     └─► frames → audio → mp4 + 封面 + 发布文案
  汇总 → q<ID>-summaries.json
```

接口就是**产物 JSON**，两个 skill 不互相 import。换数据源（非知乎）时，`data-video` 不用改。

## 备料清单

| 要准备 | 来源 | 用途 |
|---|---|---|
| `q<ID>-answers-full.json` | `fetch-answers-api.mjs` | 全部统计的底数（含 votes/comments/thanks/created_at/content/answer_type/author） |
| `q<ID>-themes.json` | `extract-themes-llm.mjs` | 观点地图类的镜头（`taxonomy` + `perAnswer`） |
| `q<ID>-books-llm.json` / 词典法书名表 | `extract-books-llm.mjs` / `extract-entities.mjs` | 书单排行类镜头 |
| `q<ID>-summaries.json` | `summarize-answers.mjs` | 需要"观点摘要"的镜头 |
| 剔除口径 | `answer_type !== 'normal'`、`author.user_type === 'organization'`、`is_advertiser`、匿名 | 统计与引用前剔除（与发布版报告同一套规则） |

## 知乎侧的铁律

1. **每个数字都要能在 `facts.spec.mjs` 里复算出来**。本项目吃过两次记忆值的亏：
   「曼昆提及率」记成 44%（真实 36%）、「《国富论》劝退」记成 1 条（真实 8 条）。
   到了 `data-video` 那边，手打数字会被 `precheck-video.mjs` 直接拦下。
2. **口径要跟着数字走**：提及次数是"字符串命中"，不是"推荐"；「热度」是 Σlog10(1+赞) 的代理指标。
   镜头里的 `note` 要把口径写出来。
3. **先跑 `verify-output.mjs` 再谈做视频**：汇总产物本身没过校验，视频只会放大错误。
4. **快照时间必须写进 `meta.credit`**（来源行）与声明卡；赞数在持续变化。
5. 剔除集要重算，不要沿用内部版的旧数字（"剔了但数字还是老的"是踩过的坑）。

## 观点标签的特殊注意

- `themes.json` 的标签是 **AI 辅助归纳**的，镜头里要标明这一点（本项目横版长片在标签排行的 `note` 里写了）
- 标签名要与 `taxonomy[].name` 完全一致（`facts.spec.mjs` 按名字取数，取不到会直接抛错——这是刻意的）
- 覆盖不了全部回答（本项目 16 类覆盖 496/673），差额要在画面里交代

## 合规（知乎场景的额外注意）

- 引用压到 1–2 句 + 署名 + 原答链接 + 「发表于知乎」；**不转载全文**
- 匿名用户、机构号/广告主、严选付费内容不进统计也不进引用
- 不给书籍封面图（改文字卡），不使用他人头像/截图
- 完整要求见 `data-video` 的 `references/compliance.md` 与本 skill 的 `references/publish.md`

## 发布版报告（另一条出口）

同一个快照还能出**对外发布的合规版报告**：`render-publish.mjs`（见 [`publish.md`](./publish.md)）。
视频与报告共用同一套剔除规则与 facts 口径，**不要各算一套数字**。

## TODO

- [x] `SKILL.md` 路由表增加"要做视频 / 要对外发布"两行（2026-10-19 完成）
- [ ] `precheck.mjs` 增加发布版产物检查（是否有 `-发布版.html`、`--contact` 是否为占位符、引用占比是否超阈值）
- [ ] 增加 `verify-publish.mjs`：自动校验"页面不含任何非引用正文""引用总量占比 < 1%""无匿名/机构内容""AI 标识存在"
  —— 视频侧的两道闸门已在 `data-video` 落地，报告侧还差这一道
