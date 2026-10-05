use tauri::{AppHandle, WebviewWindow};

#[cfg(target_os = "macos")]
mod macos;

#[cfg(not(target_os = "macos"))]
pub mod common;

#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
pub use common::*;

pub fn default(
    app_handle: &AppHandle,
    main_window: WebviewWindow,
    preference_window: WebviewWindow,
) {
    // 开发模式下默认不自动打开调试器（会与透明主窗口一起闪烁）。
    // 需要调试时取消下面两行的注释即可。
    // #[cfg(debug_assertions)]
    // main_window.open_devtools();

    platform(app_handle, main_window.clone(), preference_window.clone());
}
