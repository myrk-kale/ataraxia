#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// The line `ataraxia --version` prints.
fn version_line() -> String {
    format!("ataraxia {}", env!("CARGO_PKG_VERSION"))
}

fn main() {
    // Answered before anything starts the app or opens a window.
    if matches!(std::env::args().nth(1).as_deref(), Some("--version" | "-V")) {
        println!("{}", version_line());
        return;
    }
    ataraxia_lib::run()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_line_names_the_program_and_the_crate_version() {
        let line = version_line();
        assert_eq!(line, format!("ataraxia {}", env!("CARGO_PKG_VERSION")));
        assert!(!line.contains('\n'));
        assert!(line.split(' ').nth(1).is_some_and(|v| v.contains('.')));
    }
}
