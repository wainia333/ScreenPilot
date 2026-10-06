#[cfg(debug_assertions)]
fn main() {
    screenpilot_core::capture_handoff_check::run();
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("Run this isolated WebView check in debug mode.");
}
