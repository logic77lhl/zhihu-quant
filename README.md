# zhihu-quant

用**你已登录的 Edge 会话**读取知乎的量化数据 —— 赞数、发布时间、评论数、热度排序、时间分布，
并把某个问题下 N 条回答里的实体（书名 / 库名 / 公司 / 概念）抽出来去重、统计、溯源，生成交互式 HTML 报告。

一条命令跑完，**不需要人工逐条看回答**。

```
zhihu.com/question/28193957   380 条回答，98,556 字全文
        ↓  一条命令
555 本书的提及排名 + 赞数 + 发布年份 + 每条的原文上下文
```

---

## 为什么需要这个

知乎官方开放平台 CLI 只返回 4 个字段，**拿不到赞数、发布时间、评论数，也没有任何排序参数**。
用搜索去补赞数只能命中约 28%，且得到的只是粗略热度代理。

Panerelay 走另一条路：复用浏览器里已登录的会话，由扩展代发请求，能拿到完整字段。

但**直接从零装 Panerelay 会踩三个坑**，本项目已经把它们解决了：

| 坑 | 现象 | 真实原因 |
|---|---|---|
| 侧载扩展拿不到任何 Cookie | 所有请求 401「身份未经过验证」 | manifest 缺 `host_permissions`，`chrome.cookies.getAll()` 返回空数组 |
| `doctor` 报扩展已连接但实际不可用 | 假阳性 | 官方 setup 脚本没写 Native Messaging 注册表项 |
| 换了台电脑就废 | 扩展不加载 | 双击普通 Edge 图标不会带 `--load-extension` 参数 |

**这个仓库是一个安装包，不是代码集合。** 环境修复都固化了。

---

## 快速开始

```powershell
git clone <repo-url>
cd zhihu-quant
powershell -ExecutionPolicy Bypass -File install.ps1
```

然后三步：

1. 用桌面新出现的 **「Edge (Panerelay)」** 快捷方式启动 Edge
   —— 普通 Edge 图标启动的话扩展不会加载，后面全都跑不了
2. 在 Edge 里登录 zhihu.com
3. 自检：

```powershell
node pipeline\check-bridge.mjs
```

看到三行 OK 就可以开工了：

```powershell
node pipeline\pipeline.mjs 28193957 --preset books
```

380 条回答约 5 分钟，519 条约 7 分钟。产出 HTML 报告，自动用默认浏览器打开都不做，直接看文件。

---

## 系统要求

- **Windows**（安装脚本用了注册表和 `WScript.Shell` 建快捷方式）
- **Microsoft Edge** —— **必须是 Edge，不能是 Chrome**
  Chrome 155 硬性禁用了 `--load-extension`，日志会写
  `--load-extension is not allowed in Google Chrome, ignoring`
- **Node.js 20+**
- 有 npm（用于 `npx @panerelay/setup`，装官方 native host）

不需要管理员权限，注册表只写 `HKCU`。

---

## 目录结构

```
install.ps1          一键安装
uninstall.ps1        卸载（默认保留报告数据）
extension/           预构建的 Panerelay 扩展，已打好 host_permissions 补丁
pipeline/            抓取 → 抽取 → 渲染
  pipeline.mjs         一键管线
  check-bridge.mjs     健康检查
  fetch-answers.mjs    抓全部回答（全文 + 赞数 + 时间 + 评论）
  extract-entities.mjs 按预设抽实体
  render-report.mjs    实体 → HTML + Markdown
  presets/             实体类型定义（换类型只改 JSON，不改代码）
skills/zhihu-web/    Agent Skill，可选安装
docs/PLAYBOOK.md     实战手册：所有踩过的坑与判断依据
config.json          安装时生成，记录输出目录等
```

---

## 常用命令

```powershell
# 一键跑完整流程
node pipeline\pipeline.mjs <问题ID> --preset books

# 改完预设重跑，跳过重新抓取（省 5-7 分钟）
node pipeline\pipeline.mjs <问题ID> --preset books --skip-fetch

# 只健康检查
node pipeline\check-bridge.mjs

# 换实体类型：写一个 presets/xxx.json
node pipeline\pipeline.mjs <问题ID> --preset mylib

# 给词典加词
node pipeline\extract-entities.mjs <answers.json> --preset books --dict extra.txt
```

选项：

```
--preset <name>      实体预设，见 pipeline/presets/
--config <path>      自定义配置
--dict <file.txt>    往词典追加词（一行一个，# 开头为注释）
--concurrency <n>    抓取并发，默认 3。不要超过 3，再高无收益（实测）
--sleep <ms>         每次调用后间隔，默认 60
--limit <n>          只抓前 n 条（调试用）
--skip-fetch         复用已有的 answers-full.json
```

输出目录默认 `~/Documents/zhihu-quant/`，安装时可用 `-OutDir` 改。

---

## 内置预设

| 预设 | 实体 | 识别方式 |
|---|---|---|
| `books` | 书名 | `《》` + 直角/弯引号 + 精选词典，三层，带上下文守卫 |
| `pythonlibs` | Python 库名 | 行内代码 + PyPI 链接 + 精选词典 |

**新增实体类型不用改代码**，写一个 `presets/xxx.json`。字段说明见 `pipeline/presets/README.md`。

---

## 输出长什么样

每个报告包含：

- 顶部 6 张统计卡（实体数 / 扫描回答 / 正文字数 / 赞数总计 / 非零赞回答 / 时间跨度）
- 两张图表：TOP 15 实体横向条形图（对数刻度）、回答的年度分布柱状图
- 实体列表：排名、名称、来源层级、提及条数（进度条）、最高赞（进度条）、首次提及日期
- 每行可展开溯源：每条出现的赞数、评论数、发布时间、作者、**上下文原文片段**、跳转链接
- 全文搜索、来源筛选、四种排序、跟随系统明暗主题、一键导出 PDF
- 「数据口径」区块，交代样本量、过滤规模、以及**「最高赞」是代理指标**这件事

---

## 已知边界

- **「最高赞」是代理指标。** 它表示「提到该实体的回答里赞数最高那条」的赞数，不等于实体本身热度。一个实体被多条回答提及时会被最热的那条拉高。
- **采样不等于全量。** Panerelay 能看到的问题回答数可能少于官方 CLI（差值是知乎已删除或已隐藏的回答，不在列表接口返回中）。报告里会写明差值和原因。
- **词典层有误报可能。** 像「常识」「宪法」这类高频词既是书名也是普通名词。报告的溯源展开可以核对。
- **抽取质量没有量化评估。** 目前靠人工看 TOP 20 的溯源上下文。
- **只读路径可靠，写操作要谨慎。** `comment` / `like` / `favorite` 等命令会真实改变账号状态，脚本不会碰它们。

---

## 故障排查

先读 **[docs/PLAYBOOK.md](docs/PLAYBOOK.md)** —— 那里记录了所有已知坑和诊断方法。

快速对照：

| 现象 | 检查 |
|---|---|
| `Panerelay Bridge is unavailable` | Edge 是不是用「Edge (Panerelay)」快捷方式启动的？Edge 已在运行时启动参数不生效，要先完全关闭 |
| 自检显示 `Cookie 注入 attachedCookieCount=0` | 扩展 manifest 缺 `host_permissions`，重跑 `install.ps1` |
| 自检显示 `未登录` | 在 Edge 里登录 zhihu.com |
| 抓取返回 401 | 同「Cookie 注入」那行 |
| `PANERELAY_NATIVE_HOST` 缺失 | 跑 `npx --yes @panerelay/setup` |
| PowerShell 报 .ps1 语法错误 | 文件被编辑器存成了无 BOM 的 UTF-8，PowerShell 5.1 会按系统 ANSI 代码页解析。加回 BOM 即可 |

---

## 安全边界

- **本项目不需要你的知乎 Cookie。** 请求由浏览器扩展发出，Cookie 不经过任何命令行工具或模型。
- 安装脚本**只写 `HKCU`**，不碰系统级注册表，不需要管理员。
- 脚本**不读取、不导出、不打印**任何浏览器凭据。
- 仓库里**不含任何账号信息或个人路径**，全部按环境变量解析。

---

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1
```

默认保留报告数据，加 `-PurgeData` 连数据一起删。官方 Panerelay CLI 本身不受影响，
要一起移除另跑 `npx --yes @panerelay/setup uninstall`。

---

## 致谢与许可

扩展基于 [Panerelay](https://github.com/F-loat/panerelay)（MIT），本项目在其基础上补了
`host_permissions` 与 Native Messaging 注册表项。该补丁已同步至上游仓库源码，
建议上游也采纳 —— 见 PLAYBOOK 的「还没做的」一节。

知乎数据归知乎所有。本工具只做**你本来就能在浏览器里看到的内容**的批量读取与统计，
不含任何绕过风控、验证码或付费墙的逻辑。