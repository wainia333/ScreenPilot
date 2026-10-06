#[cfg(debug_assertions)]
fn main() {
    screenpilot_core::capture_handoff_check::run_click_manual();
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("Run the click regression in debug mode.");
}
