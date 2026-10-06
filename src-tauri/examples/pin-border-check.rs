#[cfg(debug_assertions)]
fn main() {
    screenpilot_core::check_native_pin_follower();
    println!("Native pin follower: 100 synchronous moves and binding cleanup passed.");
}
#[cfg(not(debug_assertions))]
fn main() {
    panic!("Run the isolated native check in debug mode.");
}
