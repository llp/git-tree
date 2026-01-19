// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod git;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            git::get_commits,
            git::checkout_ref,
            git::get_commit_changes,
            git::compare_commits,
            git::clone_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
