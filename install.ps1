<#
.SYNOPSIS
    zhihu-quant 安装器 —— 让本机具备「用已登录的 Edge 读取知乎量化数据」的能力。

.DESCRIPTION
    做四件事：
      1. 部署 Panerelay 扩展到 %USERPROFILE%\.panerelay\extension，并补上 host_permissions
      2. 写 Native Messaging 注册表项（官方 setup 脚本漏写这步，会导致 doctor 假阳性）
      3. 开启 Edge 开发者模式（侧载解压缩扩展的前提）
      4. 创建「Edge (Panerelay)」桌面快捷方式（普通方式启动 Edge 则扩展不加载）

    可选：把 zhihu-web Skill 装进 opencode。

    需要管理员吗？不需要。注册表只写 HKCU。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File install.ps1 -OutDir D:\reports -NoSkill
#>
[CmdletBinding()]
param(
  [string]$OutDir = "$env:USERPROFILE\Documents\zhihu-quant",
  [switch]$NoSkill,
  [switch]$AllSkills,     # 默认只装到已存在的 agent；加此参数装到全部
  [switch]$Force          # 已安装也重新部署
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtSrc   = Join-Path $RepoRoot 'extension'
$InstallDir = Join-Path $env:USERPROFILE '.panerelay'
$ExtDst   = Join-Path $InstallDir 'extension'
$EXT_ID   = 'panplnkjlkoceaonlmpdekjphgmbggmi'
$HOST_KEY = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$EXT_ID"

$script:n = 0
function Step($msg) { $script:n++; Write-Host ""; Write-Host "[$script:n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "    XX  $msg" -ForegroundColor Red; exit 1 }

function Find-Edge {
  # 优先问注册表，其次扫标准安装路径
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
  )
  foreach ($k in $keys) {
    try { $p = (Get-ItemProperty $k -ErrorAction Stop).'(default)'; if ($p -and (Test-Path $p)) { return $p } } catch {}
  }
  foreach ($p in @(
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:LOCALAPPDATA}\Microsoft\Edge\Application\msedge.exe"
  )) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

Write-Host ""
Write-Host "  zhihu-quant 安装器" -ForegroundColor White
Write-Host "  复用已登录的 Edge 读取知乎的赞数 / 发布时间 / 评论数" -ForegroundColor DarkGray

# ── 0. 前置检查 ─────────────────────────────────────────────
Step '检查前置条件'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die '找不到 node。需要 Node.js 20+，请先安装：https://nodejs.org' }
$nodeVer = (& node --version) -replace '^v',''
if ([int]($nodeVer.Split('.')[0]) -lt 20) { Die "Node 版本过低（$nodeVer），需要 20 或更高" }
Ok "Node $nodeVer"

$edge = Find-Edge
if (-not $edge) {
  Warn '未检测到 Microsoft Edge'
  Write-Host ''
  Write-Host '    本方案依赖 Edge —— Chrome 155 硬性禁用了 --load-extension，日志会写：' -ForegroundColor Yellow
  Write-Host '      --load-extension is not allowed in Google Chrome, ignoring' -ForegroundColor DarkYellow
  Write-Host '    请先安装 Edge：https://www.microsoft.com/edge' -ForegroundColor Yellow
  exit 1
}
$edgeVer = (Get-Item $edge).VersionInfo.ProductVersion
Ok "Edge $edgeVer"

if (-not (Test-Path (Join-Path $ExtSrc 'manifest.json'))) {
  Die "扩展源目录不完整：$ExtSrc"
}
Ok '扩展源文件完整'

# ── 1. 部署扩展 ─────────────────────────────────────────────
Step '部署 Panerelay 扩展'

$already = (Test-Path (Join-Path $ExtDst 'manifest.json')) -and (-not $Force)
if ($already) {
  Ok "已存在于 $ExtDst（-Force 可重新部署）"
} else {
  New-Item -ItemType Directory -Force -Path $ExtDst | Out-Null
  robocopy $ExtSrc $ExtDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
  Ok "已复制到 $ExtDst"
}

# ── 2. 修补 manifest ─────────────────────────────────────────
Step '修补 manifest（关键）'

$mf = Join-Path $ExtDst 'manifest.json'
$j = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $j.host_permissions) {
  $j | Add-Member -NotePropertyName host_permissions -NotePropertyValue @('*://*.zhihu.com/*', '*://zhihu.com/*')
  # ConvertTo-Json 默认深度 2，够用；-Depth 10 保险
  $j | ConvertTo-Json -Depth 10 | Set-Content $mf -Encoding UTF8
  Ok '已补上 host_permissions'
} else {
  Ok 'host_permissions 已存在'
}

$check = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $check.host_permissions -or $check.host_permissions.Count -eq 0) {
  Die 'host_permissions 修补失败 —— 没有它，扩展读不到任何 Cookie，所有请求会返回 401'
}
if (-not $check.key) { Warn 'manifest 缺少 key 字段，扩展 ID 会变（native messaging 将连不上）' }
Ok "扩展 ID: $EXT_ID"

# ── 3. Native Messaging 注册表 ───────────────────────────────
Step '注册 Native Messaging 主机'

# 官方 @panerelay/setup 在某些情况下不写这一项，导致 doctor 报假阳性。这里显式补写。
$nativeHostJson = Join-Path $InstallDir 'native-messaging\org.panerelay.bridge.json'
$bundle = Join-Path $InstallDir 'hosts\0.11.1\native-host.bundle.cjs'
if (-not (Test-Path $bundle)) { Warn "未找到 native host bundle: $bundle（若之后报连接失败，运行 npx @panerelay/setup 补装）" }

if (Test-Path (Split-Path $nativeHostJson)) { Ok "native-messaging 配置已存在" }

if (-not (Test-Path $HOST_KEY)) {
  New-Item -Path $HOST_KEY -Force | Out-Null
  Ok "已创建 $HOST_KEY"
} else {
  Ok '注册表项已存在'
}

# ── 4. Edge 开发者模式 ──────────────────────────────────────
Step '开启 Edge 开发者模式'

$edgeRunning = @(Get-Process msedge -ErrorAction SilentlyContinue).Count
if ($edgeRunning -gt 0) {
  Warn "Edge 正在运行（$edgeRunning 个进程）。Preferences 在 Edge 运行时修改会被覆盖 —— 请关闭 Edge 后重跑安装脚本"
} else {
  $pref = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default\Preferences'
  if (Test-Path $pref) {
    $p = Get-Content $pref -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $p.extensions) { $p | Add-Member -NotePropertyName extensions -NotePropertyValue ([PSCustomObject]@{}) }
    if (-not $p.extensions.ui) { $p.extensions | Add-Member -NotePropertyName ui -NotePropertyValue ([PSCustomObject]@{}) }
    $p.extensions.ui | Add-Member -NotePropertyName developer_mode -NotePropertyValue $true -Force
    $p | ConvertTo-Json -Depth 20 -Compress | Set-Content $pref -Encoding UTF8 -NoNewline
    Ok "已设置 $pref"
  } else {
    Warn "找不到 Preferences（Edge 可能还没运行过）：$pref"
    Warn '先正常启动一次 Edge 并关闭，再重跑本脚本'
  }
}

# ── 5. 启动脚本 + 快捷方式 ──────────────────────────────────
Step '创建启动方式'

$launcher = Join-Path $InstallDir 'start-edge.cmd'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$cmd = @"
@echo off
REM 必须走这个入口 —— 双击普通 Edge 图标不会加载扩展，Panerelay 不可用
setlocal
set "EDGE=$edge"
set "EXT=$ExtDst"

if not exist "%EXT%\manifest.json" (
  echo [x] 找不到扩展: %EXT%
  echo     请重新运行仓库的 install.ps1
  pause & exit /b 1
)

tasklist /FI "IMAGENAME eq msedge.exe" 2>nul | find /I "msedge.exe" >nul
if not errorlevel 1 (
  echo [!] Edge 正在运行 —— 启动参数不会生效，请先完全关闭 Edge
  pause & exit /b 2
)

echo [*] 启动 Edge + Panerelay ...
start "" "%EDGE%" --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension="%EXT%"
echo [OK] 已启动。自检: panerelay zhihu whoami
endlocal
"@
# 用 ASCII 写，避免 cmd 读 UTF-8 中文乱码
$cmdAscii = [regex]::Replace($cmd, '[^\x00-\x7F]', '?')
Set-Content -Path $launcher -Value $cmdAscii -Encoding ASCII
Ok "已写入 $launcher"

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = "$env:USERPROFILE\Desktop" }
$lnk = Join-Path $desktop 'Edge (Panerelay).lnk'
try {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = $launcher
  $sc.WorkingDirectory = $InstallDir
  $sc.Description = '带 Panerelay 扩展启动 Edge（普通方式启动则 Panerelay 不可用）'
  $sc.IconLocation = "$edge,0"
  $sc.Save()
  Ok "已创建桌面快捷方式：$lnk"
} catch { Warn "快捷方式创建失败（$($_.Exception.Message)），可手动运行 $launcher" }

# ── 6. 输出目录 ─────────────────────────────────────────────
Step '配置输出目录'

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cfg = [PSCustomObject]@{
  outDir          = $OutDir
  extensionDir    = $ExtDst
  extensionId     = $EXT_ID
  installedAt     = (Get-Date).ToString('o')
}
$cfgPath = Join-Path $RepoRoot 'config.json'
$cfg | ConvertTo-Json -Depth 5 | Set-Content $cfgPath -Encoding UTF8
Ok "输出目录：$OutDir"
Ok "配置文件：$cfgPath"

# ── 7. Skill ────────────────────────────────────────────────
Step '安装 Agent Skill'

if ($NoSkill) {
  Warn '-NoSkill 已指定，跳过'
} else {
  $skillSrc = Join-Path $RepoRoot 'skills\zhihu-web'
  if (-not (Test-Path (Join-Path $skillSrc 'SKILL.md'))) {
    Warn '仓库里没有 skills/zhihu-web，跳过'
  } else {
    $targets = @(
      @{ name = 'opencode';    path = "$env:USERPROFILE\.config\opencode\skills"; detect = "$env:USERPROFILE\.config\opencode" },
      @{ name = 'Claude Code'; path = "$env:USERPROFILE\.claude\skills";        detect = "$env:USERPROFILE\.claude" },
      @{ name = 'Codex';        path = "$env:USERPROFILE\.codex\skills";        detect = "$env:USERPROFILE\.codex" }
    )
    # 只装到「已存在该 agent 配置目录」的地方，避免凭空创建用不到的 agent 环境。
    # 想强制装到全部，加 -AllSkills。
    $selected = if ($AllSkills) { $targets } else { $targets | Where-Object { Test-Path $_.detect } }
    if (-not $selected) {
      Warn '未检测到任何已安装的 agent（opencode / Claude Code / Codex），跳过 Skill 安装'
      Warn '如需强制安装，加 -AllSkills 参数'
    }
    $installed = @()
    foreach ($t in $selected) {
      $dst = Join-Path $t.path 'zhihu-web'
      if (Test-Path $dst) { Warn "$($t.name)：$dst 已存在，跳过（-Force 可覆盖）"; continue }
      New-Item -ItemType Directory -Force -Path $t.path | Out-Null
      Copy-Item $skillSrc $dst -Recurse -Force
      $installed += $t.name
    }
    if ($installed.Count) { Ok "已安装到：$($installed -join '  ')" }
  }
}

# ── 完成 ────────────────────────────────────────────────────
$checkCmd = 'node "' + $RepoRoot + '\skills\zhihu-web\scripts\check-bridge.mjs"'
$pipeCmd  = 'node "' + $RepoRoot + '\skills\zhihu-web\scripts\pipeline.mjs" <question-id> --preset books'

Write-Host ''
Write-Host '  安装完成' -ForegroundColor Green
Write-Host ''
Write-Host '  接下来三步：' -ForegroundColor White
Write-Host '    1. 用桌面新出现的「Edge (Panerelay)」快捷方式启动 Edge' -ForegroundColor Gray
Write-Host '       重要：普通 Edge 图标启动的话，扩展不会加载，Panerelay 不可用' -ForegroundColor DarkGray
Write-Host '    2. 在 Edge 里登录 zhihu.com' -ForegroundColor Gray
Write-Host '    3. 跑一次自检：' -ForegroundColor Gray
Write-Host ('         ' + $checkCmd) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  然后抓一个知乎问题：' -ForegroundColor White
Write-Host ('         ' + $pipeCmd) -ForegroundColor DarkCyan
Write-Host ''
Write-Host '  遇到问题先读 docs/PLAYBOOK.md，那里记录了所有已知坑。' -ForegroundColor DarkGray
Write-Host ''