[CmdletBinding()]
param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\src-tauri\target\release\screenpilot.exe'),
    [ValidateRange(1, 60)]
    [int]$StartupTimeoutSeconds = 20,
    [switch]$AllowUnsupportedPlatformSkip
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    $message = '真实应用 smoke 仅支持 Windows。'
    if ($AllowUnsupportedPlatformSkip) {
        Write-Warning "SMOKE_SKIPPED: $message"
        exit 0
    }
    throw "SMOKE_FAILED: $message 未显式指定 -AllowUnsupportedPlatformSkip，因此本次验证失败。"
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "SMOKE_FAILED: 找不到待启动的构建产物：$ExecutablePath"
}

$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if ([System.IO.Path]::GetExtension($resolvedExecutable) -ne '.exe') {
    throw "SMOKE_FAILED: 构建产物不是 Windows 可执行文件：$resolvedExecutable"
}

$stream = [System.IO.File]::OpenRead($resolvedExecutable)
try {
    if ($stream.Length -lt 2 -or $stream.ReadByte() -ne 0x4D -or $stream.ReadByte() -ne 0x5A) {
        throw "SMOKE_FAILED: 构建产物缺少有效 PE 文件头：$resolvedExecutable"
    }
}
finally {
    $stream.Dispose()
}

$process = $null
try {
    $process = Start-Process -FilePath $resolvedExecutable -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $consecutiveWebViewProbes = 0
    $webViewProcessId = $null
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            throw "SMOKE_FAILED: ScreenPilot 在 WebView2 初始化前提前退出，退出码 $($process.ExitCode)。"
        }

        $processSnapshot = @(Get-CimInstance -ClassName Win32_Process)
        $descendants = @()
        $pendingParentIds = @($process.Id)
        while ($pendingParentIds.Count -gt 0) {
            $nextParentIds = @()
            foreach ($parentId in $pendingParentIds) {
                $children = @($processSnapshot | Where-Object { $_.ParentProcessId -eq $parentId })
                $descendants += $children
                $nextParentIds += @($children | ForEach-Object { [int]$_.ProcessId })
            }
            $pendingParentIds = $nextParentIds
        }
        $webView = $descendants | Where-Object { $_.Name -ieq 'msedgewebview2.exe' } | Select-Object -First 1
        if ($null -ne $webView) {
            $consecutiveWebViewProbes += 1
            $webViewProcessId = [int]$webView.ProcessId
            if ($consecutiveWebViewProbes -ge 2) { break }
        }
        else {
            $consecutiveWebViewProbes = 0
        }
        Start-Sleep -Milliseconds 250
    }

    if ($consecutiveWebViewProbes -lt 2) {
        throw "SMOKE_FAILED: ScreenPilot 在 $StartupTimeoutSeconds 秒内未稳定创建 WebView2 子进程。"
    }
    $process.Refresh()
    if ($process.HasExited) {
        throw "SMOKE_FAILED: ScreenPilot 在 WebView2 初始化后提前退出，退出码 $($process.ExitCode)。"
    }
    Write-Host "SMOKE_PASSED: 已启动真实 Windows 应用，并连续观测到进程树中的 WebView2 子进程（ScreenPilot PID $($process.Id)，WebView2 PID $webViewProcessId）。"
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            [void]$process.WaitForExit(5000)
        }
        $process.Dispose()
    }
}
