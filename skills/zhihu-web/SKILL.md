---
name: zhihu-web
display_name: 知乎网页数据
description: >-
  读取知乎网页端真实数据：回答的赞同数（赞数）、发布时间、评论数、收藏数、完整正文全文，
  以及热度排序、时间分布等需要登录态的量化指标。复用本机 Edge 已登录的会话直接调用知乎接口，
  补上官方开放平台 CLI 不返回的字段。用户提到赞数、赞同数、点赞数、投票数、评论数、发布时间、
  收藏数、回答热度排序、时间分布、按时间排序，或需要统计某个知乎问题下全部回答的量化数据时使用。
  也用于需要回答全文（非摘要）的场景。不涉及这些字段的纯内容检索仍用官方 zhihu Skill。
---

# 知乎网页数据（登录态通道）

官方开放平台 CLI 只返回 4 个字段，**拿不到 `voteup_count` / `created_time` / `comment_count`**。
本 Skill 走另一条路：复用本机 Edge 已登录的会话，由浏览器扩展代发请求。

两条通道**互补，不是替代**。见下方路由表。

---

## 先决条件：Edge 必须是「带扩展」启动的

**用户双击普通 Edge 图标，扩展不会加载，本 Skill 完全不可用。**

必须用桌面快捷方式 **`Edge (Panerelay)`** 启动
（指向 `%USERPROFILE%\.panerelay\start-edge.cmd`（安装器生成））。

需要检查时跑：

```bash
node <仓库根目录>/pipeline/check-bridge.mjs
```

（安装器会把 check-bridge.mjs 复制到本 Skill 的 scripts/check.mjs，两者等价。）

输出 `OK` 即可继续。输出 `BRIDGE_DOWN` 说明 Edge 没带扩展启动 —— **告诉用户点桌面那个快捷方式，
不要尝试自己修浏览器配置**。

---

## 路由表

| 你要什么 | 用什么 | 命令 |
|---|---|---|
| 问题下全部回答 + **赞数** | Panerelay | `panerelay zhihu question <数字ID> --limit 1000 --json` |
| 回答的**发布时间 / 评论数 / 全文** | Panerelay | `panerelay zhihu answer-detail <回答ID> --json` |
| 按发布时间排序 | Panerelay | 同上 + `--sort created` |
| 热榜 / 搜索 / 用户 / 收藏夹 | Panerelay | `panerelay zhihu hot` / `search` / `user` / `collections` |
| 确认登录账号 | Panerelay | `panerelay zhihu whoami --json` |
| 任意已知 URL（需登录态） | Panerelay | `panerelay fetch "<url>" --response json` |
| 只找内容、不需要量化指标 | 官方 CLI | 用 `zhihu` Skill |
| 自己的数据（收藏/浏览/分享） | 官方 CLI | 用 `zhihu` Skill 的 `me *` |

**判断标准很简单：答案里要不要出现数字。** 要数字走 Panerelay，不要数字走官方 CLI。

---

## 要统计某个问题下的实体（库名 / 书名 / 公司 / 概念）

**不要手写脚本，`pipeline/pipeline.mjs` 已经是一条命令：**

```bash
node pipeline/pipeline.mjs <问题ID> --preset books
```

它会自己做桥接自检 → 抓全部回答全文 → 抽实体 → 出 HTML 报告。
抓取 380 条回答约 5 分钟（并发 3），中断重跑会续。

改预设重跑时加 `--skip-fetch` 省掉这几分钟。

> 路径说明：Skill 本身不假设仓库位置。执行前先确定仓库根目录
> （安装器建的 `config.json` 里没有它，用 `where` / 搜索 `pipeline.mjs` 定位，
> 或问用户）。下面的命令请把 `pipeline/` 换成实际路径。

**换实体类型：写一个 `pipeline/presets/xxx.json` 就行，不用改代码。**
现成预设：`books`（书名）、`pythonlibs`（Python 库名）。

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

### 1. 先读 `--help`，不要猜参数

每个命令的参数和输出字段都可能和你以为的不一样：

```bash
panerelay zhihu question --help
```

### 2. 输出是顶层 JSON 数组

```js
const rows = JSON.parse(stdout);   // 不是 .items / .data
```

### 3. Node 里必须走 `cmd.exe`

直接 `spawnSync('panerelay.cmd', ...)` 会**静默全部失败**（无报错、exit 0、stdout 为空）：

```js
spawnSync('cmd.exe', ['/c', 'panerelay', 'zhihu', 'question', id, '--json'], { encoding: 'utf8' })
```

### 4. `question` 只收数字 ID，不收 URL

从回答 URL 里取 ID：正则是 `answer/(\d+)`。

### 5. 两种排序都跑一遍再合并

`--sort default` 和 `--sort created` 返回的集合不同。单一排序会漏。
按 `id` 去重合并，赞数取两者较大值。

### 6. `--limit` 上限 1000

超过 1000 条的回答一个问题装不下，需要换问题或分页（`question` 无分页参数）。

---

## 限速

`answer-detail` 是逐条调用，约 1.2 秒/条。批量抓取时：

- 并发**不要超过 2-3**。扩展内部用 DNR session 规则注入 Cookie，高并发会串扰。
- 调用之间留 100-350ms 间隔。
- 命中风控（返回 401 / 空 body）就退避重试，不要硬冲。

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

- **实战手册（含全部踩坑记录与判断依据）**：读 `references/playbook.md`
  —— 动手前先读，能省掉大部分试错
- **写新的实体抽取预设**：读 `references/presets.md`
- **官方 CLI 的静默坑与路由速查**：`~/.config/opencode/notes/zhihu-cli.md`
  （若该文件不存在，说明这台机器没装官方 zhihu CLI Skill）
- **工具脚本与完整流程**：仓库里的 `README.md`

---

## 报告输出要求

统计类结论必须交代口径：

- 样本是多少条（抓到 N 条 / 平台共 M 条），**差值要说明原因**（例如已删除的回答不在列表接口返回中）
- 「最高赞」这类聚合指标要标明它是代理指标，不等于实体本身热度
- 缺失值要标出来，不要用 0 冒充
- 结论旁边挂原始链接