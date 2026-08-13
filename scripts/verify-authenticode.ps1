[CmdletBinding()]
param(
    [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Path,
    [bool]$RequireTimestamp = $true,
    [string]$ApprovedThumbprint = $env:SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT
)

$ErrorActionPreference = 'Stop'

if (-not $IsWindows) {
    throw 'SIGNATURE_VERIFICATION_FAILED: Authenticode 验证仅支持 Windows，不能跳过正式发布签名验证。'
}

function ConvertTo-NormalizedThumbprint {
    param(
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    $normalized = [regex]::Replace($Value, '[\s:]', '').ToUpperInvariant()
    if ($normalized -notmatch '^[0-9A-F]{40}$') {
        throw 'SIGNATURE_VERIFICATION_FAILED: 批准的 Authenticode 证书指纹必须是 40 位十六进制 SHA-1 指纹（可包含空白或冒号分隔符）。'
    }
    return $normalized
}

$normalizedApprovedThumbprint = ConvertTo-NormalizedThumbprint -Value $ApprovedThumbprint

if ($null -eq $Path -or $Path.Count -eq 0) {
    $releaseRoot = Join-Path $PSScriptRoot '..\src-tauri\target\release'
    $Path = @(
        (Join-Path $releaseRoot 'screenpilot.exe'),
        (Join-Path $releaseRoot 'bundle\msi\*.msi'),
        (Join-Path $releaseRoot 'bundle\nsis\*.exe')
    )
}

$artifacts = @()
foreach ($candidate in $Path) {
    $matches = @(Get-ChildItem -Path $candidate -File -ErrorAction SilentlyContinue)
    if ($matches.Count -eq 0) {
        throw "SIGNATURE_VERIFICATION_FAILED: 找不到待验证发布物：$candidate"
    }
    $artifacts += $matches
}
$artifacts = @($artifacts | Sort-Object -Property FullName -Unique)

$signerThumbprint = $null
foreach ($artifact in $artifacts) {
    $signature = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "SIGNATURE_VERIFICATION_FAILED: $($artifact.FullName) 状态为 $($signature.Status)：$($signature.StatusMessage)"
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "SIGNATURE_VERIFICATION_FAILED: $($artifact.FullName) 缺少签名证书。"
    }
    $artifactThumbprint = ConvertTo-NormalizedThumbprint -Value $signature.SignerCertificate.Thumbprint
    if ($null -ne $normalizedApprovedThumbprint -and $artifactThumbprint -ne $normalizedApprovedThumbprint) {
        throw "SIGNATURE_VERIFICATION_FAILED: $($artifact.FullName) 的签名证书不在组织批准的证书指纹门禁内。"
    }
    if ($null -eq $signerThumbprint) {
        $signerThumbprint = $artifactThumbprint
    }
    elseif ($artifactThumbprint -ne $signerThumbprint) {
        throw "SIGNATURE_VERIFICATION_FAILED: $($artifact.FullName) 与其他发布物使用了不同的签名证书。"
    }
    if ($RequireTimestamp -and $null -eq $signature.TimeStamperCertificate) {
        throw "SIGNATURE_VERIFICATION_FAILED: $($artifact.FullName) 缺少可信时间戳。"
    }
    Write-Host "SIGNATURE_VALID: $($artifact.FullName)"
    Write-Host "  Subject: $($signature.SignerCertificate.Subject)"
    Write-Host "  Thumbprint: $($signature.SignerCertificate.Thumbprint)"
    if ($null -ne $signature.TimeStamperCertificate) {
        Write-Host "  Timestamp authority: $($signature.TimeStamperCertificate.Subject)"
    }
}

Write-Host "SIGNATURE_VERIFICATION_PASSED: 已验证 $($artifacts.Count) 个发布物。"
