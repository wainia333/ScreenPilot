#[cfg(debug_assertions)]
fn main() {
    screenpilot_core::tray_menu_check::run();
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("Run this isolated popup check in debug mode.");
}
