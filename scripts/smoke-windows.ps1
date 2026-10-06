[CmdletBinding()]
param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\src-tauri\target\release\screenpilot.exe'),
    [ValidateRange(1, 60)]
    [int]$StartupTimeoutSeconds = 20,
    [switch]$AllowUnsupportedPlatformSkip,
    [switch]$AllowExistingInstanceSkip,
    [switch]$RequireCaptureRuntime
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

$fileReadyDeadline = [DateTime]::UtcNow.AddSeconds(10)
$stream = $null
while ($null -eq $stream) {
    try {
        $stream = [System.IO.File]::OpenRead($resolvedExecutable)
    }
    catch {
        # A newly copied EXE can still be held by a file scanner. Keep the
        # preflight bounded and preserve other I/O failures as real failures.
        $ioFailure = if ($_.Exception.InnerException -is [System.IO.IOException]) { $_.Exception.InnerException } else { $_.Exception }
        $temporaryIoFailure = $ioFailure -is [System.IO.IOException] -and
            (($ioFailure.HResult -band 0xFFFF) -in @(32, 33))
        if (-not $temporaryIoFailure -or [DateTime]::UtcNow -ge $fileReadyDeadline) { throw }
        Start-Sleep -Milliseconds 250
    }
}
try {
    if ($stream.Length -lt 2 -or $stream.ReadByte() -ne 0x4D -or $stream.ReadByte() -ne 0x5A) {
        throw "SMOKE_FAILED: 构建产物缺少有效 PE 文件头：$resolvedExecutable"
    }
}
finally {
    $stream.Dispose()
}

function Get-RunningScreenPilotInstance {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetExecutable
    )

    $targetItem = Get-Item -LiteralPath $TargetExecutable
    $targetProductName = $targetItem.VersionInfo.ProductName
    if ([string]::IsNullOrWhiteSpace($targetProductName)) {
        $targetProductName = 'ScreenPilot'
    }

    try {
        $processSnapshot = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    }
    catch {
        throw "SMOKE_PRECONDITION_FAILED: 无法枚举现有 Windows 进程，不能确认 ScreenPilot 单实例测试环境：$($_.Exception.Message)"
    }

    $matches = foreach ($candidate in $processSnapshot) {
        $candidateName = [string]$candidate.Name
        $candidatePath = [string]$candidate.ExecutablePath
        $sameExecutable = -not [string]::IsNullOrWhiteSpace($candidatePath) -and
            [string]::Equals($candidatePath, $TargetExecutable, [System.StringComparison]::OrdinalIgnoreCase)
        $knownScreenPilotName = $candidateName -match '(?i)^screenpilot(?:[_-][^\\/]*)?\.exe$'
        $sameProduct = $false

        if (-not [string]::IsNullOrWhiteSpace($candidatePath) -and
            (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
            try {
                $candidateProductName = (Get-Item -LiteralPath $candidatePath -ErrorAction Stop).VersionInfo.ProductName
                $sameProduct = -not [string]::IsNullOrWhiteSpace($candidateProductName) -and
                    [string]::Equals(
                        $candidateProductName,
                        $targetProductName,
                        [System.StringComparison]::OrdinalIgnoreCase
                    )
            }
            catch {
                # Protected processes can deny metadata reads. The exact executable path and
                # well-known ScreenPilot file names remain sufficient detection signals.
            }
        }

        if ($sameExecutable -or $knownScreenPilotName -or $sameProduct) {
            [pscustomobject]@{
                ProcessId = [int]$candidate.ProcessId
                Name = $candidateName
                ExecutablePath = $candidatePath
            }
        }
    }

    # CIM can omit an elevated process on restricted desktops. A known process
    # name is still enough to avoid handing the smoke launch to that instance.
    $nameMatches = @(Get-Process -Name 'screenpilot*' -ErrorAction SilentlyContinue | ForEach-Object {
        [pscustomobject]@{ ProcessId = $_.Id; Name = $_.ProcessName; ExecutablePath = '' }
    })
    return @(@($matches) + $nameMatches | Sort-Object -Property ProcessId -Unique)
}

$existingInstances = @(Get-RunningScreenPilotInstance -TargetExecutable $resolvedExecutable)
if ($existingInstances.Count -gt 0) {
    $instanceDetails = $existingInstances | ForEach-Object {
        $displayPath = if ([string]::IsNullOrWhiteSpace($_.ExecutablePath)) {
            '<路径不可读取>'
        }
        else {
            $_.ExecutablePath
        }
        "PID $($_.ProcessId), $($_.Name), $displayPath"
    }
    $message = '检测到已运行的 ScreenPilot 实例。真实应用 smoke 必须在没有同产品实例时运行，' +
        '否则单实例转交会让测试观测到错误的进程树。请先正常退出这些实例后重试。检测结果：' +
        ($instanceDetails -join '; ')
    if ($AllowExistingInstanceSkip) {
        Write-Warning "SMOKE_SKIPPED: $message"
        exit 0
    }
    throw "SMOKE_PRECONDITION_FAILED: $message 如调用方明确接受未执行测试，可使用 -AllowExistingInstanceSkip。"
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
        if ($RequireCaptureRuntime) {
            $legacy = $descendants | Where-Object { $_.Name -match '(?i)^(python|pythonw|ffmpeg)\.exe$' }
            if ($legacy) { throw 'SMOKE_FAILED: 截图仍启动了外部运行时。' }
        }
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
if ($RequireCaptureRuntime) {
    Write-Host 'CAPTURE_RUNTIME_PASSED: 启动进程树不包含 Python、Qt 截图侧车或 FFmpeg。截图交互需另行运行 capture 测试。'
}
