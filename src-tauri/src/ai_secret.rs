use serde::Serialize;
use std::sync::Mutex;
use tauri::{State, WebviewWindow};

const PREFERENCE_LABEL: &str = "preference";
const CHAT_LABEL: &str = "chat";
const MAX_KEY_LENGTH: usize = 4096;
const MAX_BASE_URL_LENGTH: usize = 2048;

struct AiSecret {
    base_url: String,
    key: String,
}

/// API key held in process memory only. Intentionally not `Debug` / `Serialize`.
#[derive(Default)]
pub struct AiSecretState(Mutex<Option<AiSecret>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    configured: bool,
    base_url: Option<String>,
}

fn ensure_label(label: &str, allowed: &[&str]) -> Result<(), String> {
    if allowed.contains(&label) {
        Ok(())
    } else {
        Err(format!("window `{label}` is not allowed to access the AI key"))
    }
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("API key is empty".into());
    }

    if key.len() > MAX_KEY_LENGTH {
        return Err("API key is too long".into());
    }

    if !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("API key contains unsupported characters".into());
    }

    Ok(())
}

fn validate_base_url(base_url: &str) -> Result<(), String> {
    if base_url.is_empty() || base_url.len() > MAX_BASE_URL_LENGTH {
        return Err("invalid base URL".into());
    }

    if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
        return Err("invalid base URL".into());
    }

    Ok(())
}

#[tauri::command]
pub fn set_ai_key(
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
    base_url: String,
    key: String,
) -> Result<(), String> {
    ensure_label(webview_window.label(), &[PREFERENCE_LABEL])?;
    validate_base_url(&base_url)?;
    validate_key(&key)?;

    let mut secret = state.0.lock().map_err(|_| "AI key state unavailable")?;

    *secret = Some(AiSecret { base_url, key });

    Ok(())
}

#[tauri::command]
pub fn get_ai_key(
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
    base_url: String,
) -> Result<Option<String>, String> {
    ensure_label(webview_window.label(), &[CHAT_LABEL, PREFERENCE_LABEL])?;

    let secret = state.0.lock().map_err(|_| "AI key state unavailable")?;

    Ok(secret
        .as_ref()
        .filter(|secret| secret.base_url == base_url)
        .map(|secret| secret.key.clone()))
}

#[tauri::command]
pub fn get_ai_key_status(
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
) -> Result<AiKeyStatus, String> {
    ensure_label(webview_window.label(), &[CHAT_LABEL, PREFERENCE_LABEL])?;

    let secret = state.0.lock().map_err(|_| "AI key state unavailable")?;

    Ok(AiKeyStatus {
        configured: secret.is_some(),
        base_url: secret.as_ref().map(|secret| secret.base_url.clone()),
    })
}

#[tauri::command]
pub fn clear_ai_key(
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
) -> Result<(), String> {
    ensure_label(webview_window.label(), &[PREFERENCE_LABEL])?;

    let mut secret = state.0.lock().map_err(|_| "AI key state unavailable")?;

    *secret = None;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowed_labels_pass() {
        assert!(ensure_label("preference", &[PREFERENCE_LABEL]).is_ok());
        assert!(ensure_label("main", &[PREFERENCE_LABEL]).is_err());
        assert!(ensure_label("chat", &[PREFERENCE_LABEL]).is_err());
        assert!(ensure_label("chat", &[CHAT_LABEL, PREFERENCE_LABEL]).is_ok());
        assert!(ensure_label("main", &[CHAT_LABEL, PREFERENCE_LABEL]).is_err());
    }

    #[test]
    fn key_validation() {
        assert!(validate_key("sk-test_ABC.123").is_ok());
        assert!(validate_key("").is_err());
        assert!(validate_key("sk test").is_err());
        assert!(validate_key("sk-中文").is_err());
        assert!(validate_key("sk-\n").is_err());
        assert!(validate_key(&"a".repeat(MAX_KEY_LENGTH + 1)).is_err());
    }

    #[test]
    fn errors_never_echo_the_key() {
        let key = "sk-secret value";
        let error = validate_key(key).unwrap_err();

        assert!(!error.contains("secret"));
    }

    #[test]
    fn base_url_validation() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("ftp://example.com").is_err());
    }
}
