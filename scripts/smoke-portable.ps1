[CmdletBinding()]
param(
    [string]$ExecutablePath = (Join-Path $PSScriptRoot '..\release\ScreenPilot-0.1.6-portable\ScreenPilot.exe'),
    [string]$ReportPath = (Join-Path $PSScriptRoot '..\release\portable-smoke.json')
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Portable smoke requires Windows with WebView2.' }
$sourceExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$portableSmokeDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('ScreenPilot-portable-smoke-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $portableSmokeDirectory)
$testExecutable = Join-Path $portableSmokeDirectory 'ScreenPilot.exe'
Copy-Item -LiteralPath $sourceExecutable -Destination $testExecutable
$initialFiles = @(Get-ChildItem -LiteralPath $portableSmokeDirectory -Force)
if ($initialFiles.Count -ne 1 -or $initialFiles[0].Name -ne 'ScreenPilot.exe') {
    throw 'Portable smoke directory must initially contain only the application EXE.'
}

$originalTaskPath = $env:PATH
$restrictedTaskPath = @(
    (Join-Path $env:SystemRoot 'System32'),
    $env:SystemRoot,
    (Join-Path $env:SystemRoot 'System32\Wbem')
) -join ';'
$launchFailure = $null
try {
    # Only this test shell and its child processes receive the restricted PATH.
    $env:PATH = $restrictedTaskPath
    foreach ($runtimeName in @('node', 'npm', 'bun', 'deno', 'python', 'karakeep')) {
        if (Get-Command -Name $runtimeName -CommandType Application -ErrorAction SilentlyContinue) {
            throw "Unexpected auxiliary runtime on restricted PATH: $runtimeName"
        }
    }
    & (Join-Path $PSScriptRoot 'smoke-windows.ps1') -ExecutablePath $testExecutable
}
catch {
    $launchFailure = $_
}
finally {
    $env:PATH = $originalTaskPath
}

$report = [ordered]@{
    executable = $sourceExecutable
    isolatedDirectory = $portableSmokeDirectory
    initialFiles = @('ScreenPilot.exe')
    restrictedPath = $restrictedTaskPath
    auxiliaryRuntimesOnPath = @()
    sha256 = (Get-FileHash -LiteralPath $sourceExecutable -Algorithm SHA256).Hash
    launch = if ($null -eq $launchFailure) { 'passed: stable application and descendant WebView2 processes observed' } else { 'blocked or failed: ' + $launchFailure.Exception.Message }
    finalFiles = @(Get-ChildItem -LiteralPath $portableSmokeDirectory -Force | Select-Object -ExpandProperty Name)
    scope = 'Launch and process initialization only. Live server/model integration requires user-configured credentials and was not tested by this script.'
    completedAt = [DateTime]::UtcNow.ToString('o')
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding utf8
if ($null -ne $launchFailure) { throw $launchFailure }
Write-Host "PORTABLE_SMOKE_PASSED: $ReportPath"
