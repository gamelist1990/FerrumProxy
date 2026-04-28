#[tauri::command]
fn shared_client_runtime() -> &'static str {
    "FerrumProxy shared-service client runtime is available"
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![shared_client_runtime])
        .run(tauri::generate_context!())
        .expect("error while running FerrumProxy client");
}
