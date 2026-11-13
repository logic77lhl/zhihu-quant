# 换机部署指南

> 按本机实测写成。每一步都标注了**为什么**和**怎么验证**，不是照抄命令。
> 全部在 Windows 上验证；macOS / Linux 的差异单独标注。
>
> ⚠️ 本文件是 `skills/zhihu-web/references/setup.md` 的同步副本，改一处要改两处。

---

## 0. 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| **Node.js** | **≥ 22.5** | Panerelay 官方只要求 ≥20，但 `ck-count.mjs` / `zhihu-cookies.mjs` 用了 `node:sqlite`，**22.5 才引入**。装 22.5 以下这两条读 Cookie 的命令会直接失败 |
| **Edge 或 Chrome** | Chromium ≥116 | 扩展是 MV3，`minimum_chrome_version: 116` |
| **OpenCode** | 1.18+ | skill 的宿主。skill 目录是 `~/.config/opencode/skills/` |
| 网络 | 能访问 npm | 装 Panerelay |

验证 Node 版本：

```powershell
node --version     # 期望 v22.5.0 或更高
```

---

## 1. Panerelay —— 浏览器登录态通道（**最关键的一步**）

整个 skill 的数据来源。**没有它，抓取一步都跑不了。**

### 1.1 装 Native Host + 全局 CLI

```powershell
npx --yes @panerelay/setup
```

这一步会：

- 创建 `~/.panerelay/`（`bin/` `native-messaging/` `hosts/` `extension/` `src/`）
- 装全局 `panerelay` 命令
- **写注册表**，把 Native Messaging 主机注册给浏览器：

```
HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\org.panerelay.bridge
HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\org.panerelay.bridge
  → C:\Users\<你>\.panerelay\native-messaging\org.panerelay.bridge.json
```

（macOS / Linux 写到 Edge 与 Chrome 各自的 per-user 目录，`setup` 会自动处理。）

### 1.2 装知乎站点适配器

```powershell
npx --yes @panerelay/setup add zhihu
# 或装全部内置适配器
npx --yes @panerelay/setup add --all
```

验证：`panerelay zhihu --help` 应该能看到 `answer-detail` / `question` 等命令。

### 1.3 装浏览器扩展 —— **三条路，优先「注册成持久扩展」**

> 2026-10-16 更新：本机最大的坑不是「怎么装上」，而是**装上之后只用命令行临时加载** ——
> Edge 一重启（或后台模式自动拉起）扩展就没了，于是「桥接断了」变成常态。
> **持久注册**消除这个摩擦；命令行临时加载降级为调试/兜底手段。

#### 路线 A：把未打包扩展注册成持久扩展（**当前推荐**）

```powershell
Test-Path "$env:USERPROFILE\.panerelay\extension\manifest.json"    # 应为 True
```

在 Edge 里：`edge://extensions` → 打开左下角「开发人员模式」→ 点「加载解压缩的扩展」→
选择 `%USERPROFILE%\.panerelay\extension`。

之后**普通启动 Edge 也会加载扩展**，包括后台模式自动拉起的实例。
不需要 `--load-extension`、不需要 1.5 的启动脚本（降级为兜底），也不会撞上 1.6 的死循环。

代价：Edge 以「开发者模式」标记加载，浏览器升级后偶发提示/禁用，重新加载一次即可。
验证：`node scripts/check.mjs`（看 `attachedCookieCount > 0`）。

#### 路线 B：Chrome 应用商店（签名版，零补丁）

扩展 ID：`panplnkjlkoceaonlmpdekjphgmbggmi`

```
https://chromewebstore.google.com/detail/panerelay/panplnkjlkoceaonlmpdekjphgmbggmi
```

商店版是签名发布的、权限完整，**不需要 1.4 的补丁**。
前提：Edge 允许来自其他商店的扩展（`edge://extensions` 里的开关）且网络可达。
注意商店版版本可能与本机适配器（`fetch-adapters/zhihu/0.11.1`）不一致 —— 装完先跑 `check.mjs`。

#### 路线 C：命令行临时侧载（旧路径，仅调试/应急）

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --disable-features=DisableLoadExtensionCommandLineSwitch `
  --load-extension="$env:USERPROFILE\.panerelay\extension"
```

**只在调试或应急时用**：每次启动都要带这一串，Edge 的后台模式还会与它打架（1.6）。
`ensure-bridge.mjs --fix` 与 `start-edge.cmd` 内部走的就是这条命令。

> Edge 路径在别的机器上可能是 `C:\Program Files\Microsoft\Edge\Application\msedge.exe`（无 x86）。
> `doctor.mjs` 会两个都查。

**注意**：Edge 136+ 禁止在默认 `--user-data-dir` 上开远程调试。**不要**用目录联接绕过路径检查 ——
实测会导致浏览器判定 Cookie 无法解密（App-Bound Encryption 与路径绑定），**清空整个 Cookie 库**。

### 1.4 ⚠️ 侧载路径必做：补 `host_permissions`

**这一步不做，后面所有抓取都会 401，而且报错极具误导性。**

现象：桥接通了、账号也登录了，但服务端一律返回「身份未经过验证」。
**真实原因不是风控也不是没登录，是扩展缺少静态 host 授权** ——
没有它 `chrome.cookies.getAll()` 返回**空数组**，Panerelay 拿空 Cookie 表去注入。

打开 `%USERPROFILE%\.panerelay\extension\manifest.json`，在**顶层**加：

```json
"host_permissions": [
  "*://*.zhihu.com/*",
  "*://zhihu.com/*"
]
```

改完**重启 Edge** 生效。验证方式见第 4 步的 `Cookie 注入` 检查
（看 `attachedCookieCount > 0`，**`whoami` 通过不代表 Cookie 注入成功**）。

### 1.5 生成启动脚本与快捷方式（**仅兜底；走路线 A 时不需要**）

`start-edge.cmd` 和桌面快捷方式都含**本机绝对路径**，换机必须重建。

> **这两样现在都只是兜底。** 扩展注册成持久扩展（1.3 路线 A）后，普通启动 Edge 就能用。
> 需要应急启动时也可以直接跑 `node scripts/ensure-bridge.mjs --fix`（内含同样的启动命令）。
> `.lnk` 仅为双击便利，丢了不影响任何功能。

```powershell
$P = "$env:USERPROFILE\.panerelay"
$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# 生成 start-edge.cmd
# 注意 if not errorlevel 1 那个分支：Edge 的后台模式会自动用 --no-startup-window
# 重新拉起进程（无窗口、无 --load-extension），导致脚本误判「已在运行」。
# 提示里要讲清这一点，否则用户会以为是自己没关干净。详见 setup.md 1.6 节。
@"
@echo off
setlocal
set "EXT=$P\extension"
if not exist "%EXT%\manifest.json" ( echo [x] 缺扩展: %EXT% & pause & exit /b 1 )
tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 (
  echo [!] Edge 已在运行，无法带扩展启动（命令行参数对已运行的实例无效）。
  echo.
  echo     注意 Edge 的后台模式可能已自动拉起一个无窗口进程。
  echo     可靠做法是连续执行下面两行（中间不要留间隔）：
  echo       taskkill /F /IM msedge.exe /T
  echo       start "" "%~f0"
  pause & exit /b 2
)
start "" "$edge" --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension="%EXT%"
echo [OK] 已启动。等 5-10 秒后验证: node scripts/check.mjs
endlocal
"@ | Set-Content -Encoding OEM "$P\start-edge.cmd"

# 生成桌面快捷方式
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Edge (Panerelay).lnk")
$sc.TargetPath = "$P\start-edge.cmd"
$sc.WorkingDirectory = $P
$sc.IconLocation = "$edge,0"
$sc.Save()
```

**只在兜底场景用 `start-edge.cmd`**（走 1.3 路线 A 持久注册时，普通图标启动即可）。

### 1.6 ⚠️ Edge 的后台模式会让快捷方式「永远启动不了」

**现象**：双击快捷方式，弹出 `[!] Edge 已经在运行，请先完全退出`，
但你明明没开 Edge 窗口；或者你关掉了所有窗口、再点快捷方式，还是这个提示。

**原因**：Edge 的「启动增强 / 后台扩展应用」会在进程被杀后**自动用
`--no-startup-window` 把 Edge 拉起来**。这个自动拉起的进程：

- 没有窗口，用户看不见
- **命令行里没有 `--load-extension`**，所以扩展不加载
- 但 `tasklist` 能查到 `msedge.exe` → 脚本判定「已在运行」→ 拒绝启动

于是形成死循环：脚本拒绝 → 用户以为关干净了 → 其实后台又被拉起来了。

**验证**（看命令行里有没有 `--load-extension`）：

```powershell
Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
  Where-Object { $_.CommandLine -match 'load-extension' } |
  Measure-Object | Select-Object -ExpandProperty Count
```

返回 `0` 就是「跑着的 Edge 没带扩展」。

**可靠的做法**：杀进程与启动之间**不要留间隔**，一条命令里连续执行：

```powershell
taskkill /F /IM msedge.exe /T
Start-Sleep -Milliseconds 500
Start-Process "$env:USERPROFILE\.panerelay\start-edge.cmd" -WorkingDirectory "$env:USERPROFILE\.panerelay"
```

**注意**：手动 `Stop-Process` 后再单独点快捷方式**往往来不及** —— 中间那几秒足够
后台模式把 Edge 重新拉起。必须连续执行。

**验证启动成功**：等 5~10 秒（扩展 service worker 是懒加载的），然后

```powershell
node scripts/check.mjs     # 看 attachedCookieCount > 0
```

`attachedCookieCount` 是比 `whoami` 更可靠的指标 —— 后者只验证桥接连通，
不验证 Cookie 注入。

**根治**（按优先级）：

1. **把扩展注册成持久扩展**（1.3 路线 A）—— 后台模式拉起的实例也会加载扩展，这个死循环从此不成立
2. 关掉 Edge 的「启动增强」与「关闭 Microsoft Edge 后继续运行后台扩展应用」（`edge://settings/system`）——
   但这是浏览器设置，**不要替用户改**，告诉他路径让他自己决定
3. 真断了就跑 `node scripts/ensure-bridge.mjs --fix`：一条命令完成「杀 → 起 → 轮询复验」，
   且只在无窗口时杀进程（有窗口会拒绝，除非 `--force`）

> 2026-10-16：手工流程（`taskkill` 后 500ms 内必须连着启动）对 agent 很容易做错，
> `ensure-bridge.mjs` 把这段固化了；实测无 Edge 进程时约 7 秒恢复。

### 1.7 本机补丁台账（哪些文件被改过、怎么复核）

`~/.panerelay` 不是干净的上游安装：本机在上面打过补丁，且**没有 git**（历史版本靠 `*.bak-*`）。
换机/升级后按这张表逐项复核，别凭印象。

| 文件 | 改动 | 现状（2026-10-16 复核） | 复核方式 |
|---|---|---|---|
| `extension/manifest.json` | 补 `host_permissions`（知乎域） | ✅ 在 | 搜 `host_permissions` |
| `extension/`（bundle） | 重建时含 `inPageContext` 页面上下文传输 + `withStage` 诊断 | ✅ 在（**但已不使用**） | `grep -r inPageContext extension/` |
| `hosts/0.11.1/native-host.bundle.cjs` | 扩展白名单校验器允许 `inPageContext` | ✅ 在 | `grep -n inPageContext hosts/0.11.1/native-host.bundle.cjs` |
| `fetch-adapters/zhihu/0.11.1/adapter.mjs` | **已回滚**：不再发送 `inPageContext` | ⚠️ 有意为之 | 搜 `inPageContext`，只应出现在注释里 |
| `src/` | 上游源码 + 本机改动，混合 | 无 git、有 `*.bak-*` | 用 `LastWriteTime` 判断先后 |

**为什么不把 `inPageContext` 用回去**：它的目的是绕过 `/api/v4/questions/{id}` 的签名要求，
而实测该端点是**唯一受限端点**，且问题标题在 answers 列表的 `question.title` 里本来就有。
加它反而引入「旧 bundle 静默丢弃字段 → 35 秒超时」的风险（见 SKILL.md 专节）。

**升级 Panerelay 时**：先整目录备份，升级后按上表复核，最后跑 `node scripts/check.mjs`
（桥接 + Cookie 注入 + 端点三项一起验）。

---

## 2. 本地 LLM 网关（workbuddy2api）

`summarize-answers.mjs` / `extract-themes-llm.mjs` / `extract-books-llm.mjs`
三个脚本走**本地 OpenAI 兼容网关**，不是公网 API。

### 2.1 它是什么

一个独立项目 `workbuddy2api-panel`（**不属于本仓库**），编译产物是 `dist\wb2api.exe`，
监听 `127.0.0.1:7863`，把本机上游账号包装成 OpenAI 兼容接口。

### 2.2 装与启

```powershell
cd <你放它的目录>\workbuddy2api-panel
powershell -ExecutionPolicy Bypass -File .\install.ps1     # 首次
powershell -ExecutionPolicy Bypass -File .\start.ps1       # 启动（重复执行不会重复起）
```

它自带 `LOCAL_SETUP.md` / `README.md`，细节看那里。

### 2.3 拿 `WB2API_KEY`

密钥**就是网关自己的** `dist\config.json` 里的 `api_key` 字段（面板 UI 里也能看到）：

```powershell
(Get-Content .\dist\config.json -Raw | ConvertFrom-Json).api_key
```

设成环境变量（**三个 LLM 脚本启动时若读不到就直接退出**）：

```powershell
# 当前会话
$env:WB2API_KEY = "<值>"
# 持久化（用户级）
[Environment]::SetEnvironmentVariable('WB2API_KEY', '<值>', 'User')
```

验证：

```powershell
Invoke-WebRequest "http://127.0.0.1:7863/v1/models" `
  -Headers @{Authorization="Bearer $env:WB2API_KEY"} -UseBasicParsing | Select-Object StatusCode
# 期望 200
```

### 2.4 备选：OpenCode 免费模型 shim（Plan B）

网关缺少可用上游（欠费 / 限额 / 换机没装）时的顶班：`opencode-llm-shim.mjs` 把每个请求
转成一次真实的 OpenCode 免费模型会话，对流水线呈现同样的 OpenAI 兼容接口。
起法与用法见 `references/scripts.md`「环境变量 → Plan B」；
`--model auto` 下与网关互相切换不作废 state 缓存。

---

## 3. 装 skill 与脚本

```powershell
$SKILLS = "$env:USERPROFILE\.config\opencode\skills"

# 3.1 skill 本体
Copy-Item -Recurse .\skills\zhihu-web $SKILLS\
```

**就这一步。** 流水线脚本已经内含在 skill 里（`skills\zhihu-web\scripts\`，
21 个 `.mjs` + `presets/`），不需要另外安放，也不用配 PATH。

```powershell
$SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
```

### 3.2 产物目录（可选）

脚本**没有硬编码输出目录**，按这个顺序解析：

```
$ZHIHU_QUANT_OUT  →  <skill>/config.json 的 outDir  →  ~/Documents/zhihu-quant
```

要固定到自定义位置，二选一：

```powershell
[Environment]::SetEnvironmentVariable('ZHIHU_QUANT_OUT', 'D:\zhihu-out', 'User')
# 或在 skills\zhihu-web\config.json 里写 {"outDir": "D:\\zhihu-out"}
```

> 脚本内不含任何本机绝对路径，`skill` 目录整体可搬运。

---

## 4. 自检（**装完必跑**）

```powershell
node "$SKILLS\zhihu-web\scripts\doctor.mjs"
```

12 项检查，逐项 OK/WARN/FAIL，**每项 FAIL 都带修复指引**：

```
Node 版本 / Panerelay CLI / ~/.panerelay / Native Host 清单 /
扩展 host_permissions 补丁 / 桥接连通 / 登录态 / Cookie 注入 /
知乎适配器 / LLM 网关密钥 / LLM 网关 / 输出目录 / 浏览器
```

期望结尾：`通过 12 / 警告 0 / 失败 0`

> `doctor.mjs` 覆盖了旧的 `check.mjs`（后者只看桥接和 Cookie）。
> `check.mjs` 保留，作为最小桥接检查。

---

## 5. 首次跑通验证

拿一个真实存在的问题跑最小闭环（**输出到临时文件，不要覆盖已有数据**）：

```powershell
$SCRIPTS = "$env:USERPROFILE\.config\opencode\skills\zhihu-web\scripts"
node "$SCRIPTS\fetch-answers-api.mjs" 491790104 --max-pages 1 --out "$env:TEMP\probe.json"
```

期望：`完成：收 N 条 ... 已写入 ...\probe.json`
（`--max-pages 1` 只抓 1 页，几秒钟）

确认抓取通道没问题后，正式跑完整流程：

```powershell
node "$SCRIPTS\fetch-answers-api.mjs" <问题ID>
node "$SCRIPTS\summarize-answers.mjs" q<ID>-answers-full.json
node "$SCRIPTS\render-answers.mjs" q<ID>-answers-full.json
```

产物应出现在输出目录（默认 `~/Documents/zhihu-quant/`）：

```
q<ID>-answers-full.json     抓取结果
q<ID>-summaries.json        摘要 + 综述
q<ID>-汇总.html             页面
```

---

## 6. 故障排查

| 现象 | 真实原因 | 处理 |
|---|---|---|
| 报「身份未经过验证」/ 一律 401 | 扩展缺 `host_permissions`（**不是**风控、**不是**没登录） | 见 1.4，补完重启 Edge |
| `BRIDGE_DOWN` / `Bridge is unavailable` | Edge 不是用带扩展的方式启动的 | `node scripts/ensure-bridge.mjs --fix`（会重启 Edge，先问用户）；根治见 1.3 路线 A（持久注册） |
| 新会话拿到链接不知道从哪开始 | 缺"给链接"的第一跳 | `node scripts/link.mjs "<URL>"`，照它打印的下一跳做 |
| `whoami` 正常但抓取全 401 | Cookie 表为空 | 跑 `doctor.mjs`，看 `Cookie 注入` 那一项 |
| 三个 LLM 脚本一启动就退出 | 缺 `WB2API_KEY` | 见 2.3 |
| LLM 脚本报连接失败 | 网关没起 | `start.ps1` |
| `Cannot find module 'node:sqlite'` | Node < 22.5 | 升级 Node |
| URL 参数被截断 / 报「不是内部或外部命令」 | 自己拼了 `spawnSync('cmd.exe', ...)` | 改用 `panerelay-run.mjs` |
| 读不到 Edge Cookie 库 | 用目录联接绕过默认配置目录 | **不要这么干**，会清空 Cookie 库（见 1.3 注） |
| 抓取结果找不到 | 产物目录不在脚本目录 | 见 3.3，查 `$ZHIHU_QUANT_OUT` |

---

## 7. 已知限制

- **收藏数拿不到** —— 知乎接口不暴露，`favorite_count` 加进 `include` 会被静默丢弃
- **感谢数要显式 include** —— `thanks_count`，漏写就不返回
- **`question --limit 1000`** —— 超过 1000 条的问题必须走 `fetch-answers-api.mjs` 分页
- **并发上限** —— Panerelay 3、本地 LLM 网关 5，调高只会换来失败
- **并发会话无锁** —— 两个会话跑同一问题 ID 会各自完整抓一遍，开工前先查产物
- **Edge 依赖** —— 扩展没加载时 Panerelay 完全不可用（`BRIDGE_DOWN`）。
  治本 = 1.3 路线 A 持久注册；应急 = `ensure-bridge.mjs --fix`；
  兜底 = harness 浏览器通道（不依赖 Edge，但要先在 Review 面板登录过知乎，且一次一页、比 Panerelay 慢）
- **19 位回答 ID 必须当字符串** —— 超过 JS 安全整数，当数字字面量写会静默丢精度（页面脚本里尤其容易踩）
