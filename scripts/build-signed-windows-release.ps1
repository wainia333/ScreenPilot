[CmdletBinding()]
param(
    [string]$CertificateBase64 = $env:SCREENPILOT_AUTHENTICODE_PFX_BASE64,
    [string]$CertificatePassword = $env:SCREENPILOT_AUTHENTICODE_PFX_PASSWORD,
    [string]$ApprovedCertificateThumbprint = $env:SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT,
    [ValidatePattern('^https?://')]
    [string]$TimestampServer = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'

function Remove-SigningEnvironment {
    Remove-Item Env:SCREENPILOT_AUTHENTICODE_PFX_BASE64 -ErrorAction SilentlyContinue
    Remove-Item Env:SCREENPILOT_AUTHENTICODE_PFX_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT -ErrorAction SilentlyContinue
}

if (-not $IsWindows) {
    throw 'SIGNED_RELEASE_FAILED: Authenticode 正式发布仅支持 Windows。'
}
if ([string]::IsNullOrWhiteSpace($CertificateBase64)) {
    Remove-SigningEnvironment
    throw 'SIGNED_RELEASE_FAILED: 缺少 SCREENPILOT_AUTHENTICODE_PFX_BASE64；正式发布禁止降级为未签名构建。'
}
if ([string]::IsNullOrWhiteSpace($CertificatePassword)) {
    Remove-SigningEnvironment
    throw 'SIGNED_RELEASE_FAILED: 缺少 SCREENPILOT_AUTHENTICODE_PFX_PASSWORD；正式发布禁止降级为未签名构建。'
}
if ([string]::IsNullOrWhiteSpace($ApprovedCertificateThumbprint)) {
    Remove-SigningEnvironment
    throw 'SIGNED_RELEASE_FAILED: 缺少 SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT；正式发布必须绑定组织批准的签名证书。'
}
$normalizedApprovedThumbprint = [regex]::Replace($ApprovedCertificateThumbprint, '[\s:]', '').ToUpperInvariant()
if ($normalizedApprovedThumbprint -notmatch '^[0-9A-F]{40}$') {
    Remove-SigningEnvironment
    throw 'SIGNED_RELEASE_FAILED: SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT 必须是 40 位十六进制 SHA-1 指纹（可包含空白或冒号分隔符）。'
}

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "SIGNED_RELEASE_FAILED: 命令执行失败（退出码 $LASTEXITCODE）：$FilePath $($ArgumentList -join ' ')"
    }
}

function Test-CodeSigningCertificate {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    if (-not $Certificate.HasPrivateKey) { return $false }
    $eku = $Certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } | Select-Object -First 1
    if ($null -eq $eku) { return $false }
    $typedEku = [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
        $eku.RawData,
        $eku.Critical
    )
    return $null -ne ($typedEku.EnhancedKeyUsages | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' } | Select-Object -First 1)
}

function Set-VerifiedSignature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$LiteralPath,
        [Parameter(Mandatory = $true)]
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate
    )
    if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
        throw "SIGNED_RELEASE_FAILED: 找不到待签名发布物：$LiteralPath"
    }
    $result = Set-AuthenticodeSignature `
        -LiteralPath $LiteralPath `
        -Certificate $Certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer $TimestampServer
    if ($result.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "SIGNED_RELEASE_FAILED: $LiteralPath 签名后状态为 $($result.Status)：$($result.StatusMessage)"
    }
    $verified = Get-AuthenticodeSignature -LiteralPath $LiteralPath
    if ($verified.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $verified.TimeStamperCertificate) {
        throw "SIGNED_RELEASE_FAILED: $LiteralPath 写入后重新验证失败：$($verified.StatusMessage)"
    }
    Write-Host "SIGNED: $LiteralPath"
}

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Remove-SigningEnvironment
Push-Location $projectRoot
try {
    Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('run', 'verify')
    Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @('run', 'release', '--', '--no-bundle')
}
finally {
    Pop-Location
}

$certificateBytes = $null
$certificates = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
try {
    try {
        $certificateBytes = [Convert]::FromBase64String($CertificateBase64)
    }
    catch {
        throw 'SIGNED_RELEASE_FAILED: SCREENPILOT_AUTHENTICODE_PFX_BASE64 不是有效 Base64。'
    }

    $storageFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
    try {
        $certificates.Import($certificateBytes, $CertificatePassword, $storageFlags)
    }
    catch {
        throw "SIGNED_RELEASE_FAILED: 无法使用提供的密码加载 PFX：$($_.Exception.Message)"
    }
    $codeSigningCertificates = @($certificates | Where-Object { Test-CodeSigningCertificate $_ })
    $certificate = $codeSigningCertificates | Where-Object {
        $candidateThumbprint = [regex]::Replace($_.Thumbprint, '[\s:]', '').ToUpperInvariant()
        $candidateThumbprint -eq $normalizedApprovedThumbprint
    } | Select-Object -First 1
    if ($null -eq $certificate) {
        if ($codeSigningCertificates.Count -eq 0) {
            throw 'SIGNED_RELEASE_FAILED: PFX 中没有包含私钥且具备 Code Signing EKU 的证书。'
        }
        throw 'SIGNED_RELEASE_FAILED: PFX 中的代码签名证书与组织批准的证书指纹不一致。'
    }
    $now = [DateTime]::UtcNow
    if ($certificate.NotBefore.ToUniversalTime() -gt $now -or $certificate.NotAfter.ToUniversalTime() -le $now) {
        throw 'SIGNED_RELEASE_FAILED: Authenticode 证书当前不在有效期内。'
    }

    Push-Location $projectRoot
    try {
        $releaseRoot = Join-Path $projectRoot 'src-tauri\target\release'
        $mainExecutable = Join-Path $releaseRoot 'screenpilot.exe'
        Set-VerifiedSignature -LiteralPath $mainExecutable -Certificate $certificate

        Invoke-CheckedCommand -FilePath 'npm' -ArgumentList @(
            'run', 'tauri', '--', 'bundle', '--ci', '--no-sign', '--bundles', 'msi', 'nsis'
        )

        $msiArtifacts = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\msi') -Filter '*.msi' -File)
        $nsisArtifacts = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'bundle\nsis') -Filter '*.exe' -File)
        if ($msiArtifacts.Count -ne 1 -or $nsisArtifacts.Count -ne 1) {
            throw "SIGNED_RELEASE_FAILED: 正式发布要求恰好一个 MSI 和一个 NSIS，当前找到 MSI=$($msiArtifacts.Count)、NSIS=$($nsisArtifacts.Count)。请清理陈旧构建产物后重试。"
        }

        $installerArtifacts = @($msiArtifacts + $nsisArtifacts)
        foreach ($artifact in $installerArtifacts) {
            Set-VerifiedSignature -LiteralPath $artifact.FullName -Certificate $certificate
        }

        $allArtifacts = @((Get-Item -LiteralPath $mainExecutable)) + @($installerArtifacts)
        & (Join-Path $PSScriptRoot 'verify-authenticode.ps1') `
            -Path $allArtifacts.FullName `
            -RequireTimestamp $true `
            -ApprovedThumbprint $normalizedApprovedThumbprint

        $checksumPath = Join-Path $releaseRoot 'bundle\SHA256SUMS.txt'
        $checksumLines = $allArtifacts | ForEach-Object {
            $digest = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            $relativeName = [System.IO.Path]::GetRelativePath((Join-Path $releaseRoot 'bundle'), $_.FullName).Replace('\', '/')
            "$digest  $relativeName"
        }
        Set-Content -LiteralPath $checksumPath -Value $checksumLines -Encoding utf8NoBOM
        Write-Host "SIGNED_RELEASE_PASSED: 已生成并验证主程序、MSI、NSIS 和 $checksumPath"
    }
    finally {
        Pop-Location
    }
}
finally {
    foreach ($item in $certificates) { $item.Dispose() }
    if ($null -ne $certificateBytes) { [Array]::Clear($certificateBytes, 0, $certificateBytes.Length) }
}
