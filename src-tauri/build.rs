use std::path::PathBuf;
use std::process::Command;

fn main() {
    link_clang_runtime();
    tauri_build::build()
}

/// whisper.cpp's Metal backend is Objective-C that checks the OS version with `@available`, and
/// clang turns that into a call to `__isPlatformVersionAtLeast`. The symbol lives in clang's own
/// runtime library, which the final link does not always pull in (it did not on the macOS release
/// runner), so the build failed with "symbol(s) not found". Naming the archive at the end of the
/// link line supplies it; where the linker already has the symbol, the archive is simply not used.
fn link_clang_runtime() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let resource_dir = Command::new("xcrun")
        .args(["clang", "--print-resource-dir"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .or_else(|| {
            Command::new("clang")
                .arg("--print-resource-dir")
                .output()
                .ok()
                .filter(|output| output.status.success())
        });
    let Some(output) = resource_dir else { return };
    let runtime = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
        .join("lib/darwin/libclang_rt.osx.a");
    if runtime.is_file() {
        println!("cargo:rustc-link-arg={}", runtime.display());
    }
}
