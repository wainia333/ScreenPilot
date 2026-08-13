# Windows 正式发布签名

普通开发与本地构建不读取签名证书：`npm run build`、`npm run release -- --no-bundle` 仍可生成未签名的测试产物。只有手动触发 `.github/workflows/signed-windows-release.yml` 或显式运行 `npm run release:signed:windows` 时，才进入正式 Authenticode 流程。

本地执行签名或签名验证需要 Windows 与 PowerShell 7 (`pwsh`)；GitHub 的 Windows runner 已提供该环境。

## GitHub Actions secrets 与批准证书

在 GitHub 的 `windows-release` 受保护环境中配置以下 secrets，并为该环境启用所需的审批规则：

- `SCREENPILOT_AUTHENTICODE_PFX_BASE64`：代码签名 PFX 的 Base64 内容。
- `SCREENPILOT_AUTHENTICODE_PFX_PASSWORD`：PFX 密码。

还必须在同一个受保护环境中配置 environment variable `SCREENPILOT_AUTHENTICODE_CERT_THUMBPRINT`，值为组织批准发布证书的 40 位 SHA-1 指纹。证书指纹是公开标识，不属于私钥或密码，因此使用受环境审批保护的 variable；PFX 和密码仍只能存为 secrets。正式 workflow 会先检查该变量的格式，签名前要求 PFX 中的代码签名证书与它一致，并在发布物独立验证阶段再次逐项比对。

任一 secret 或批准指纹缺失、PFX 无效、证书不含私钥或 Code Signing EKU、证书与批准指纹不一致、证书过期、时间戳失败时，正式发布任务会直接失败，不会回退为未签名发布。

## 签名顺序

`scripts/build-signed-windows-release.ps1` 会：

1. 完成 TypeScript、ESLint、前端覆盖率、项目扫描与 Rust 质量门禁，并构建未打包的 `screenpilot.exe`；
2. 使用 SHA-256 和可信时间戳签署主程序；
3. 将已签名主程序打入 MSI 与 NSIS；
4. 再签署 MSI 和 NSIS 外层安装包；
5. 对三个发布物执行独立 Authenticode 状态与时间戳验证；
6. 输出 `src-tauri/target/release/bundle/SHA256SUMS.txt`。

PFX 仅在进程内以内存临时密钥加载，脚本不会把证书写入仓库或持久证书存储。

正式发布应通过手动 GitHub workflow 执行；workflow 会在签名前额外运行完整 Playwright 套件和固定版本的 RustSec 依赖审计。直接在本地调用签名脚本时，应先自行执行 `npm run test:e2e`，并通过环境变量或 `-ApprovedCertificateThumbprint` 参数提供批准证书指纹。

## 独立验证

在 Windows 上下载正式发布产物后执行：

```powershell
npm run verify:signatures:windows -- -ApprovedThumbprint '0123456789ABCDEF0123456789ABCDEF01234567' .\screenpilot.exe .\ScreenPilot.msi .\ScreenPilot-setup.exe
```

验证必须逐项输出 `SIGNATURE_VALID`，最后输出 `SIGNATURE_VERIFICATION_PASSED`。省略 `-ApprovedThumbprint` 时仍可对本地测试文件执行通用的有效性、时间戳和同证书检查；任何正式发布验证都必须提供批准指纹，不能只依赖人工阅读日志。真实证书、外部时间戳服务、SmartScreen 信誉及安装/升级行为只能在正式发布环境中完成最终验证。
