#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `ataraxia mcp ...` runs the MCP server on stdio instead of the app.
    if args.first().map(String::as_str) == Some("mcp") {
        if let Err(message) = ataraxia_lib::mcp::run_cli(&args[1..]) {
            eprintln!("ataraxia mcp: {message}");
            std::process::exit(1);
        }
        return;
    }
    ataraxia_lib::run()
}
