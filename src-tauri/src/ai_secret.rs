use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const PREFERENCE_LABEL: &str = "preference";
const CHAT_LABEL: &str = "chat";
const MAX_KEY_LENGTH: usize = 4096;
const MAX_BASE_URL_LENGTH: usize = 2048;
const SECRET_FILE: &str = "ai-key.json";

struct AiSecret {
    base_url: String,
    key: String,
}

#[derive(Serialize, Deserialize)]
struct StoredSecret {
    base_url: String,
    key: String,
}

struct SecretCache {
    loaded: bool,
    secret: Option<AiSecret>,
}

/// API key for this computer. The file is the source of truth across restarts.
/// The cache is not `Debug` or `Serialize`, so the key cannot leak through logs.
#[derive(Default)]
pub struct AiSecretState(Mutex<SecretCache>);

impl Default for SecretCache {
    fn default() -> Self {
        Self {
            loaded: false,
            secret: None,
        }
    }
}

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
        Err(format!(
            "window `{label}` is not allowed to access the AI key"
        ))
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

fn storage_error() -> String {
    "AI key storage unavailable".into()
}

fn secret_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|_| storage_error())?;

    fs::create_dir_all(&dir).map_err(|_| storage_error())?;

    Ok(dir.join(SECRET_FILE))
}

fn read_secret(path: &Path) -> Result<Option<AiSecret>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage_error()),
    };

    let stored: StoredSecret = match serde_json::from_slice(&bytes) {
        Ok(stored) => stored,
        Err(_) => return Ok(None),
    };

    if validate_base_url(&stored.base_url).is_err() || validate_key(&stored.key).is_err() {
        return Ok(None);
    }

    Ok(Some(AiSecret {
        base_url: stored.base_url,
        key: stored.key,
    }))
}

fn write_secret(path: &Path, secret: &AiSecret) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| storage_error())?;
    }

    let payload = serde_json::to_vec(&StoredSecret {
        base_url: secret.base_url.clone(),
        key: secret.key.clone(),
    })
    .map_err(|_| storage_error())?;

    let temporary = path.with_extension("json.tmp");

    remove_secret(&temporary)?;

    if create_private(&temporary, &payload).is_err() || fs::rename(&temporary, path).is_err() {
        let _ = fs::remove_file(&temporary);

        return Err(storage_error());
    }

    Ok(())
}

/// Creates the file owner-only from the start, so the key is never readable by other users.
fn create_private(path: &Path, payload: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();

    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.mode(0o600);
    }

    options.open(path)?.write_all(payload)
}

fn remove_secret(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err(storage_error()),
    }
}

fn load(app: &AppHandle, state: &AiSecretState) -> Result<(), String> {
    {
        let cache = state.0.lock().map_err(|_| storage_error())?;

        if cache.loaded {
            return Ok(());
        }
    }

    let secret = read_secret(&secret_path(app)?)?;
    let mut cache = state.0.lock().map_err(|_| storage_error())?;

    if cache.loaded {
        return Ok(());
    }

    cache.secret = secret;
    cache.loaded = true;

    Ok(())
}

#[tauri::command]
pub fn set_ai_key(
    app: AppHandle,
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
    base_url: String,
    key: String,
) -> Result<(), String> {
    ensure_label(webview_window.label(), &[PREFERENCE_LABEL])?;
    validate_base_url(&base_url)?;
    validate_key(&key)?;

    let secret = AiSecret { base_url, key };

    write_secret(&secret_path(&app)?, &secret)?;

    let mut cache = state.0.lock().map_err(|_| storage_error())?;

    cache.secret = Some(secret);
    cache.loaded = true;

    Ok(())
}

#[tauri::command]
pub fn get_ai_key(
    app: AppHandle,
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
    base_url: String,
) -> Result<Option<String>, String> {
    ensure_label(webview_window.label(), &[CHAT_LABEL, PREFERENCE_LABEL])?;
    load(&app, &state)?;

    let cache = state.0.lock().map_err(|_| storage_error())?;

    Ok(cache
        .secret
        .as_ref()
        .filter(|secret| secret.base_url == base_url)
        .map(|secret| secret.key.clone()))
}

#[tauri::command]
pub fn get_ai_key_status(
    app: AppHandle,
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
) -> Result<AiKeyStatus, String> {
    ensure_label(webview_window.label(), &[CHAT_LABEL, PREFERENCE_LABEL])?;
    load(&app, &state)?;

    let cache = state.0.lock().map_err(|_| storage_error())?;

    Ok(AiKeyStatus {
        configured: cache.secret.is_some(),
        base_url: cache.secret.as_ref().map(|secret| secret.base_url.clone()),
    })
}

#[tauri::command]
pub fn clear_ai_key(
    app: AppHandle,
    webview_window: WebviewWindow,
    state: State<'_, AiSecretState>,
) -> Result<(), String> {
    ensure_label(webview_window.label(), &[PREFERENCE_LABEL])?;
    load(&app, &state)?;
    remove_secret(&secret_path(&app)?)?;

    let mut cache = state.0.lock().map_err(|_| storage_error())?;

    cache.secret = None;
    cache.loaded = true;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_secret(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();

        path.push(format!(
            "bongo-ai-key-{}-{}-{name}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));

        path
    }

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
        assert!(!storage_error().contains(key));
    }

    #[test]
    fn base_url_validation() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:8080/v1").is_ok());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("ftp://example.com").is_err());
    }

    #[test]
    fn saved_key_can_be_read_after_the_cache_is_gone() {
        let path = temp_secret("roundtrip");
        let secret = AiSecret {
            base_url: "https://api.example.com/v1".into(),
            key: "sk-persist-0000".into(),
        };

        write_secret(&path, &secret).unwrap();

        let restored = read_secret(&path).unwrap().expect("stored key");

        assert_eq!(restored.base_url, secret.base_url);
        assert_eq!(restored.key, secret.key);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;

            assert_eq!(mode, 0o600);
        }

        remove_secret(&path).unwrap();

        assert!(read_secret(&path).unwrap().is_none());
        let _ = fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn replaces_a_stale_temp_file_and_keeps_the_key_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let path = temp_secret("stale-temp");
        let temporary = path.with_extension("json.tmp");

        fs::write(&temporary, b"old").unwrap();
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644)).unwrap();

        write_secret(
            &path,
            &AiSecret {
                base_url: "https://api.example.com/v1".into(),
                key: "sk-persist-0000".into(),
            },
        )
        .unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;

        assert_eq!(mode, 0o600);
        assert!(!temporary.exists());

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn a_damaged_file_does_not_return_a_key_or_its_contents() {
        let path = temp_secret("damaged");

        fs::write(&path, b"sk-leaked-secret {not json").unwrap();

        let restored = read_secret(&path).expect("damage is treated as missing");

        assert!(restored.is_none());

        let _ = fs::remove_file(path);
    }
}
