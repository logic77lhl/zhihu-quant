# zhihu-web skill

OpenCode Skill「知乎网页数据（登录态通道）」及其配套流水线脚本。
复用本机 Edge 已登录的会话直接调用知乎接口，补上官方开放平台 CLI 不返回的字段
（赞数、评论数、发布时间、感谢数、完整正文）。

**自包含**：脚本就在 `skills/zhihu-web/scripts/`，装完 skill 即可用，不需要另外安放任何东西。

## 🚀 换新机器 → 直接看 [SETUP.md](./SETUP.md)

完整装机步骤，按本机实测写成，每一步都有**为什么**和**怎么验证**：

1. 前置条件（Node ≥22.5 / Edge / OpenCode）
2. **Panerelay** —— 浏览器登录态通道（扩展两条路、Native Host、知乎适配器、侧载补丁）
3. **本地 LLM 网关** —— workbuddy2api（三个 LLM 脚本依赖它）
4. 装 skill（一条 `Copy-Item`）
5. **自检**：`node skills/zhihu-web/scripts/doctor.mjs`（12 项，每项 FAIL 带修复指引）
6. 首次跑通验证 + 9 条故障排查表

装完自检应输出 `通过 12 / 警告 0 / 失败 0`。

## 仓库结构

```
skills/zhihu-web/
  SKILL.md                  Skill 主入口（路由表、调用纪律、字段可用性）
  references/
    setup.md                换机部署（= 仓库根 SETUP.md）
    pipeline-v2.md          流水线手册：全量抓取 / 观点聚类 / 排行口径 / 模型配置
    playbook.md             实体统计老流程 + 历史踩坑
    scripts.md              脚本参数速查
    presets.md              写新抽取预设
    publish.md              发布到仓库的规则与流程
    usage.md                日常用法与兜底通道
    content-kind.md         盐选 / 小说 / 机构号等内容性质判定
    video.md                数据 → 视频的交接说明
    zj-cli.md               知乎官方 CLI（zhihu-cli）字段差异备忘
  scripts/                  42 个脚本 + presets/ + repo-template/
    fetch-answers-api.mjs     ① 全量抓取（分页，>1000 条也能拿全）
    summarize-answers.mjs     ② 逐条摘要 + 全局综述
    extract-themes-llm.mjs    ③ 观点聚类 / 故事母题（--profile stories）
    extract-books-llm.mjs     ③' 书单抽取
    render-answers.mjs        ④ → q<ID>-汇总.html
    build-index.mjs           ⑤ → index.html
    panerelay-run.mjs         Panerelay 调用层（唯一允许执行 panerelay 的地方）
    doctor.mjs / check.mjs    环境自检
    publish.mjs               发布到本仓库
    ...                       另有 fill-one-*、classify-content-llm、enrich-flags 等
```

## 装

```powershell
$SKILLS = "$env:USERPROFILE\.config\opencode\skills"
Copy-Item -Recurse .\skills\zhihu-web $SKILLS\
```

就这一步。然后：

```powershell
node "$SKILLS\zhihu-web\scripts\doctor.mjs"
```

## 快速上手

```powershell
$SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>                     # ① 全量全文
node "$SCRIPTS\summarize-answers.mjs" q<ID>-answers-full.json      # ② 摘要 + 综述
node "$SCRIPTS\extract-themes-llm.mjs" q<ID>-answers-full.json     # ③ 分类
node "$SCRIPTS\extract-books-llm.mjs" q<ID>-answers-full.json      # ③' 书单题
node "$SCRIPTS\render-answers.mjs" q<ID>-answers-full.json         # ④ → q<ID>-汇总.html
node "$SCRIPTS\build-index.mjs"                                    # ⑤ → index.html
```

**先判题型再决定跑哪步**（书单题 / 观点题 / 故事征集题走不同路径），见 `skills/zhihu-web/SKILL.md`。

产物目录按 `$ZHIHU_QUANT_OUT` → `<skill>/config.json` 的 `outDir` → `~/Documents/zhihu-quant` 解析。

## 已知限制

- **收藏数拿不到** —— 知乎接口不暴露（`favorite_count` 加进 include 会被静默丢弃）
- **感谢数要显式 include** —— `thanks_count`
- **`question --limit 1000`** —— 超过 1000 条的问题必须走 `fetch-answers-api.mjs` 分页
- **并发上限** —— Panerelay 3、本地 LLM 网关 5，调高只会换来失败
- **并发会话无锁** —— 两个会话跑同一问题 ID 会各自完整抓一遍

## 安全说明

仓库**不包含任何凭据**。`.gitignore` 排除 `config.json`、`service.json`、`opencode.jsonc`、`.env`、`*.key`、`*.state.json`。
密钥一律从环境变量读取（`WB2API_KEY`）。

`workbuddy2api-panel`（本地 LLM 网关）是**独立项目，不属于本仓库**，按 `SETUP.md` 第 2 节单独部署。
