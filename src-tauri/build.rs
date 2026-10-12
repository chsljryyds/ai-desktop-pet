fn main() {
    // Listing a command here turns on the app ACL. Every invoke_handler command
    // must be included, otherwise that command is denied in every window.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "import_custom_model",
            "start_device_listening",
            "start_gamepad_listing",
            "stop_gamepad_listing",
            "set_ai_key",
            "get_ai_key",
            "get_ai_key_status",
            "clear_ai_key",
        ]),
    ))
    .expect("failed to run tauri-build");
}
