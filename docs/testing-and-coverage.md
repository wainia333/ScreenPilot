# 测试与覆盖率边界

`npm run test:coverage` 对 `vite.config.ts` 中明确列出的生产前端模块执行 V8 覆盖率门禁。报告中的 `All files` 只代表该清单，不代表整个仓库，也不代表 Rust 后端。

当前清单覆盖：

- 外部链接桥接；
- 桌面运行时、真实 Tauri 适配器与浏览器回退适配器；
- 历史、提示词优化、设置、文本翻译页面及其辅助逻辑；
- Vision 的 ScreenPilot 适配层与请求生命周期逻辑；
- 共享 hooks、Markdown、安全文案、主题与 UI 控件。

明确排除：

- `src/vendor/**`：通过 `scripts/vendor-integrity.json`、适配层测试和端到端测试约束，避免用大体量 vendor 文件稀释业务覆盖率；
- 测试文件、测试基础设施、声明文件；
- `main.tsx` 与应用组合入口：由生产构建和 Playwright 路由测试验证，不用低价值的行执行率充数；
- CSS、静态资源与 Rust 源码。

全局门槛为 statements 55%、branches 48%、functions 58%、lines 58%。该门槛包含当前尚未被单测直接执行的真实 Tauri 与 Vision 适配代码，因此会暴露关键集成层的覆盖缺口，而不会继续显示少量纯函数的虚高 80%。提高门槛前应先补充对应行为测试，不应通过缩小 include 清单来提高数字。

Rust 质量由 `cargo test --locked`、`cargo fmt --check` 和 Clippy `-D warnings` 门禁。项目目前没有稳定的 Rust 行覆盖率采集，不应把前端百分比解释为全项目覆盖率。

CI 还会在声明支持范围的 Node 20.19 与 Node 24 上分别执行前端检查、覆盖率、扫描和生产构建；Windows 原生任务另行执行 Playwright、Rust/前端完整验证、release 构建及真实 WebView2 启动 smoke。

`scripts/smoke-windows.ps1` 会启动实际 release EXE，并按 `ParentProcessId` 递归确认 ScreenPilot 进程树稳定创建了 WebView2 子进程。它验证原生进程与 WebView2 初始化边界，不伪装成真实 Tauri IPC、快捷键、剪贴板、截图或凭据业务集成测试；这些系统级路径仍需专门的 Windows 集成环境。

## Vendor 完整性基线

`npm run scan` 只读取仓库内 `scripts/vendor-integrity.json` 和明确的生产接入文件，不依赖开发机绝对路径、同级目录或外部规范文件，也不限制 README、审查报告等 Markdown。清单对受控 UTF-8 文本统一换行到 LF 后计算 SHA-256，因此不受 Windows `core.autocrlf` 影响。

受控文件只有在完整审查差异后才可更新基线：

```powershell
npm run vendor:lock -- --accept-reviewed-changes
npm run scan
```

扫描会递归拒绝未登记的 vendor 生产 `.ts`、`.tsx` 和 `.css` 文件（测试文件除外）。更新命令会自动把已审查的新生产文件加入清单，列出每个新增或变化文件的新旧哈希，并拒绝在 CI 中自动改写基线。不能为了通过扫描而在未审查差异时运行该命令。
