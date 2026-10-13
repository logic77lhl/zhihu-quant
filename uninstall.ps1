<#
.SYNOPSIS
    卸载 zhihu-quant，恢复安装前的状态。

.DESCRIPTION
    默认行为（保守）：
      - 删除扩展目录 %USERPROFILE%\.panerelay
      - 删除 Native Messaging 注册表项
      - 删除桌面「Edge (Panerelay)」快捷方式
      - 关闭 Edge 开发者模式（仅当本脚本是它唯一的开启者时，见下方说明）
      - 删除已安装到 agent 的 zhihu-web Skill
      - **不删除**输出目录里的报告数据

    加 -PurgeData 会连同报告数据一起删除。
    加 -KeepSkill / -KeepShortcut 可跳过对应清理。

    需要管理员吗？不需要。注册表只涉及 HKCU。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData
#>
[CmdletBinding()]
param(
  [switch]$PurgeData,
  [switch]$KeepSkill,
  [switch]$KeepShortcut
)

$ErrorActionPreference = 'Continue'
$InstallDir = Join-Path $env:USERPROFILE '.panerelay'
$EXT_ID   = 'panplnkjlkoceaonlmpdekjphgmbggmi'
$HOST_KEY = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$EXT_ID"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Step($m) { Write-Host ''; Write-Host "[*] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Skip($m) { Write-Host "    --  $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "    !!  $m" -ForegroundColor Yellow }

Write-Host ''
Write-Host '  zhihu-quant 卸载器' -ForegroundColor White

$edgeRunning = Get-Process msedge -ErrorAction SilentlyContinue
if ($edgeRunning) {
  Write-Host ''
  Warn 'Edge 正在运行。关闭它再继续，否则 Preferences 的修改会被覆盖回去。'
  $ans = Read-Host '    现在关闭 Edge 并继续？(y/N)'
  if ($ans -ne 'y') { Write-Host '    已取消'; exit 0 }
  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

# 1. 扩展
Step '删除扩展'
if (Test-Path $InstallDir) {
  Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) { Warn "删除失败（可能有文件被占用）：$InstallDir" }
  else { Ok "已删除 $InstallDir" }
} else { Skip "不存在：$InstallDir" }

# 2. 注册表
Step '删除 Native Messaging 注册表项'
if (Test-Path $HOST_KEY) {
  Remove-Item $HOST_KEY -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $HOST_KEY) { Warn "删除失败：$HOST_KEY" } else { Ok "已删除 $HOST_KEY" }
} else { Skip '注册表项不存在' }

# 3. 快捷方式
Step '删除桌面快捷方式'
if ($KeepShortcut) {
  Skip '-KeepShortcut 已指定'
} else {
  $desktop = [Environment]::GetFolderPath('Desktop')
  if (-not $desktop) { $desktop = "$env:USERPROFILE\Desktop" }
  $lnk = Join-Path $desktop 'Edge (Panerelay).lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Ok '已删除' } else { Skip '不存在' }
}

# 4. 开发者模式
Step '关闭 Edge 开发者模式'
$pref = Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data\Default\Preferences'
if (Test-Path $pref) {
  try {
    $p = Get-Content $pref -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($p.extensions -and $p.extensions.ui -and $p.extensions.ui.developer_mode) {
      $p.extensions.ui.developer_mode = $false
      $p | ConvertTo-Json -Depth 20 -Compress | Set-Content $pref -Encoding UTF8 -NoNewline
      Ok '已关闭'
    } else { Skip '原本就是关闭的' }
  } catch { Warn "读取失败，跳过：$($_.Exception.Message)" }
} else { Skip 'Preferences 不存在' }

# 5. Skill
Step '删除 Agent Skill'
if ($KeepSkill) {
  Skip '-KeepSkill 已指定'
} else {
  $targets = @(
    "$env:USERPROFILE\.config\opencode\skills\zhihu-web",
    "$env:USERPROFILE\.claude\skills\zhihu-web",
    "$env:USERPROFILE\.codex\skills\zhihu-web"
  )
  $found = $false
  foreach ($t in $targets) {
    if (Test-Path $t) { Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue; Ok "已删除 $t"; $found = $true }
  }
  if (-not $found) { Skip '未找到已安装的 Skill' }
}

# 6. 报告数据
Step '报告数据'
$cfgPath = Join-Path $RepoRoot 'config.json'
$outDir = $null
if (Test-Path $cfgPath) {
  try { $outDir = (Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).outDir } catch {}
}
if (-not $outDir) { $outDir = "$env:USERPROFILE\Documents\zhihu-quant" }

if ($PurgeData) {
  if (Test-Path $outDir) {
    Remove-Item $outDir -Recurse -Force -ErrorAction SilentlyContinue
    Ok "已删除 $outDir"
  } else { Skip "不存在：$outDir" }
} else {
  Skip "保留（加 -PurgeData 可删除）：$outDir"
}

Write-Host ''
Write-Host '  卸载完成' -ForegroundColor Green
Write-Host ''
Write-Host '  说明：官方 Panerelay CLI 本身（npx @panerelay/setup）未被改动。' -ForegroundColor DarkGray
Write-Host '  如果要连它一起移除，另行运行：npx --yes @panerelay/setup uninstall' -ForegroundColor DarkGray
Write-Host ''