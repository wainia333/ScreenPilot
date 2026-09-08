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

全局门槛为 statements 55%、branches 48%、functions 58%、lines 58%。该门槛覆盖真实 Tauri 与 Vision 适配代码，因此关键集成层的回归会进入总体统计，而不会只显示少量纯函数的虚高比例。提高门槛前应先补充对应行为测试，不应通过缩小 include 清单来提高数字。

真实 Tauri 命令适配器另设文件级 100% statements/branches/functions/lines 门槛。测试通过注入的 Tauri API 边界逐项核对命令名、camelCase 参数、事件 payload、窗口 resize/drag 与 unlisten，不依赖浏览器回退实现来间接覆盖。

Vision 的 ScreenPilot 适配层通过真实组件挂载（vendor 视图使用显式 DOM 契约夹具）验证设置加载、主题与语言、portal、翻译覆盖状态、新会话复位、事件与卸载清理，并设文件级 statements 64%、branches 42%、functions 68%、lines 68% 门槛。完整 vendor 组件继续由完整性基线和 Playwright 视觉/交互套件约束。

Rust 质量由 `cargo test --locked`、`cargo fmt --check` 和 Clippy `-D warnings` 门禁。项目目前没有稳定的 Rust 行覆盖率采集，不应把前端百分比解释为全项目覆盖率。

CI 还会在声明支持范围的 Node 20.19 与 Node 24 上分别执行前端检查、覆盖率、扫描和生产构建；Windows 原生任务另行执行 Playwright、Rust/前端完整验证、release 构建及真实 WebView2 启动 smoke。

Windows 原生与正式发布任务会固定安装 `cargo-audit 0.22.2`（使用该版本随包提供的 Cargo.lock），然后对 `src-tauri/Cargo.lock` 执行 `npm run audit:rust`。扫描需要成功取得并解析 RustSec advisory database；工具安装、数据库网络访问、已确认漏洞或扫描本身失败都会使 CI 失败，不得当作“没有漏洞”继续发布。`cargo-audit` 默认仍会列出但允许 `unmaintained`、`unsound` 等 warning，因此门禁通过只表示未检出其默认失败级别的漏洞，并不等于没有任何 RustSec 警告；这些 warning 应在依赖升级时持续评估。本地复现前可执行：

```powershell
cargo install cargo-audit --version =0.22.2 --locked --force
npm run audit:rust
```

`scripts/smoke-windows.ps1` 会先按目标路径、产品元数据和 ScreenPilot 发布文件名检测同产品进程。默认情况下，只要已有实例就以 `SMOKE_PRECONDITION_FAILED` 失败，避免 Tauri 单实例转交被误报为本次构建崩溃；脚本不会终止用户已有进程。只有明确接受“本次没有执行 smoke”的人工调用方才可传入 `-AllowExistingInstanceSkip`，并会得到 `SMOKE_SKIPPED`，CI 不使用该选项。在无已有实例时，脚本启动实际 release EXE，并按 `ParentProcessId` 递归确认本次 ScreenPilot 进程树稳定创建了 WebView2 子进程。它验证原生进程与 WebView2 初始化边界，不伪装成真实 Tauri IPC、快捷键、剪贴板、截图或凭据业务集成测试；这些系统级路径仍需专门的 Windows 集成环境。

## Windows 快捷键回归

- 文本翻译快捷键先显示不抢焦点的窗口，再读取外部选区，最后填入文本并激活。无选区、复制响应慢时，窗口出现不应等待剪贴板超时；外部选区和剪贴板恢复仍需验证。
- 选区读取未完成时再次按翻译快捷键或关闭窗口，迟到的结果不得重新打开窗口；提前输入的内容不得被迟到的选区覆盖。
- Vision 截图后保留预加载的文本翻译窗口，再次打开文本翻译不应重新创建 WebView。
- Vision 正在框选或截图弹窗尚未飞行结束时，OCR 快捷键不启动第二层截图，也不破坏 Esc。截图或纯文字对话弹窗落位后可以打开独立的 OCR翻译窗口；框选期间仅暂时隐藏 Vision，OCR 落位或取消后恢复原对话，不重置输入、截图或请求流。
- Vision 与 OCR 同时显示时，Esc 只关闭有焦点的窗口；先关闭任一窗口，再关闭另一窗口都应成功。点击切换焦点后，Vision 的延迟输入聚焦不得抢回焦点。
- OCR 框选中取消、截图失败后按 Esc、OCR 正在识别时关闭，都不得清理 Vision 的图片或取消 Vision 回答；关闭 Vision 也不得取消 OCR 请求或灰幕。
- OCR 新会话中重复按快捷键仍复用当前窗口；Esc 后能够重新截图。旧会话迟到的飞行完成通知不得解锁新会话的 OCR 切换。
- 分别以截图、纯文字进入 Vision，并在 OCR 框选中取消或 OCR 结果页按 Esc 关闭，然后关闭 Vision；等待流式回答、窗口动画或拖动回调结束后，屏幕不得残留窄条灰幕或重新出现已关闭窗口。再次启动 Vision/OCR 后仍可正常截图和关闭。

以上窗口、焦点、剪贴板和全局快捷键行为需要真实 Windows 桌面回归；Rust 状态与调用顺序测试、前端事件测试不代替原生交互验证。

## Vendor 完整性基线

`npm run scan` 只读取仓库内 `scripts/vendor-integrity.json` 和明确的生产接入文件，不依赖开发机绝对路径、同级目录或外部规范文件，也不限制 README、审查报告等 Markdown。清单对受控 UTF-8 文本统一换行到 LF 后计算 SHA-256，因此不受 Windows `core.autocrlf` 影响。

受控文件只有在完整审查差异后才可更新基线：

```powershell
npm run vendor:lock -- --accept-reviewed-changes
npm run scan
```

扫描会递归拒绝未登记的 vendor 生产 `.ts`、`.tsx` 和 `.css` 文件（测试文件除外）。更新命令会自动把已审查的新生产文件加入清单，列出每个新增或变化文件的新旧哈希，并拒绝在 CI 中自动改写基线。不能为了通过扫描而在未审查差异时运行该命令。
