use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};

const PREFERENCE_LABEL: &str = "preference";
const CHAT_LABEL: &str = "chat";
const MAX_KEY_LENGTH: usize = 4096;
const MAX_BASE_URL_LENGTH: usize = 2048;
const KEYRING_ACCOUNT: &str = "ai-api-key";
/// Plaintext files written by an earlier build. They are migrated once and then deleted.
const LEGACY_FILES: [&str; 2] = ["ai-key.json", "ai-key.json.tmp"];

struct AiSecret {
    base_url: String,
    key: String,
}

#[derive(Serialize, Deserialize)]
struct StoredSecret {
    base_url: String,
    key: String,
}

#[derive(Default)]
struct SecretCache {
    loaded: bool,
    secret: Option<AiSecret>,
}

/// API key kept in the system credential store (macOS Keychain, Windows Credential Manager,
/// Linux Secret Service), never in a file the webview file APIs can reach.
/// Only the Rust commands below read it, and they check the calling window.
/// The cache is not `Debug` or `Serialize`, so the key cannot leak through logs.
#[derive(Default)]
pub struct AiSecretState(Mutex<SecretCache>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiKeyStatus {
    configured: bool,
    base_url: Option<String>,
}

/// One credential slot. Errors carry no detail so nothing about the key can be echoed.
trait SecretStore {
    fn read(&self) -> Result<Option<String>, ()>;
    fn write(&self, payload: &str) -> Result<(), ()>;
    fn delete(&self) -> Result<(), ()>;
}

struct KeyringStore(keyring::Entry);

impl KeyringStore {
    fn open(app: &AppHandle) -> Result<Self, String> {
        keyring::Entry::new(&app.config().identifier, KEYRING_ACCOUNT)
            .map(Self)
            .map_err(|_| storage_error())
    }
}

impl SecretStore for KeyringStore {
    fn read(&self) -> Result<Option<String>, ()> {
        match self.0.get_password() {
            Ok(payload) => Ok(Some(payload)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn write(&self, payload: &str) -> Result<(), ()> {
        self.0.set_password(payload).map_err(|_| ())
    }

    fn delete(&self) -> Result<(), ()> {
        match self.0.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
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

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map_err(|_| storage_error())
}

/// Damaged or invalid content reads as no key, without reporting what was there.
fn parse_secret(payload: &[u8]) -> Option<AiSecret> {
    let stored: StoredSecret = serde_json::from_slice(payload).ok()?;

    if validate_base_url(&stored.base_url).is_err() || validate_key(&stored.key).is_err() {
        return None;
    }

    Some(AiSecret {
        base_url: stored.base_url,
        key: stored.key,
    })
}

fn encode_secret(secret: &AiSecret) -> Result<String, String> {
    serde_json::to_string(&StoredSecret {
        base_url: secret.base_url.clone(),
        key: secret.key.clone(),
    })
    .map_err(|_| storage_error())
}

fn read_legacy(dir: &Path) -> Option<AiSecret> {
    LEGACY_FILES
        .iter()
        .find_map(|name| fs::read(dir.join(name)).ok().and_then(|bytes| parse_secret(&bytes)))
}

fn remove_legacy(dir: &Path) -> Result<(), String> {
    for name in LEGACY_FILES {
        match fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(storage_error()),
        }
    }

    Ok(())
}

/// Reads the stored key. A key found only in a legacy plaintext file is moved into the store;
/// the files are deleted once the store holds the key. If the store cannot be written, the
/// files are kept so the key is not lost, and an error is returned.
fn load_secret(store: &dyn SecretStore, legacy_dir: &Path) -> Result<Option<AiSecret>, String> {
    let stored = store.read().map_err(|_| storage_error())?;
    let mut secret = stored.as_deref().and_then(|payload| parse_secret(payload.as_bytes()));

    if secret.is_none() {
        if let Some(legacy) = read_legacy(legacy_dir) {
            store
                .write(&encode_secret(&legacy)?)
                .map_err(|_| storage_error())?;
            secret = Some(legacy);
        }
    }

    remove_legacy(legacy_dir)?;

    Ok(secret)
}

fn save_secret(store: &dyn SecretStore, legacy_dir: &Path, secret: &AiSecret) -> Result<(), String> {
    store
        .write(&encode_secret(secret)?)
        .map_err(|_| storage_error())?;

    remove_legacy(legacy_dir)
}

/// Removes the key from the store and every plaintext copy an earlier build may have left,
/// including a temp file from a write that was interrupted before its rename.
/// The files are removed even when the store fails, so clearing never leaves plaintext behind.
fn clear_secret(store: &dyn SecretStore, legacy_dir: &Path) -> Result<(), String> {
    let deleted = store.delete();

    remove_legacy(legacy_dir)?;

    deleted.map_err(|_| storage_error())
}

fn load(app: &AppHandle, state: &AiSecretState) -> Result<(), String> {
    let mut cache = state.0.lock().map_err(|_| storage_error())?;

    if cache.loaded {
        return Ok(());
    }

    cache.secret = load_secret(&KeyringStore::open(app)?, &config_dir(app)?)?;
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

    save_secret(&KeyringStore::open(&app)?, &config_dir(&app)?, &secret)?;

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
    clear_secret(&KeyringStore::open(&app)?, &config_dir(&app)?)?;

    let mut cache = state.0.lock().map_err(|_| storage_error())?;

    cache.secret = None;
    cache.loaded = true;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const KEY: &str = "sk-persist-0000";
    const BASE: &str = "https://api.example.com/v1";

    #[derive(Default)]
    struct MemoryStore {
        payload: RefCell<Option<String>>,
        broken: bool,
    }

    impl SecretStore for MemoryStore {
        fn read(&self) -> Result<Option<String>, ()> {
            if self.broken { Err(()) } else { Ok(self.payload.borrow().clone()) }
        }

        fn write(&self, payload: &str) -> Result<(), ()> {
            if self.broken {
                return Err(());
            }

            *self.payload.borrow_mut() = Some(payload.into());

            Ok(())
        }

        fn delete(&self) -> Result<(), ()> {
            if self.broken {
                return Err(());
            }

            *self.payload.borrow_mut() = None;

            Ok(())
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bongo-ai-key-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));

        fs::create_dir_all(&dir).unwrap();

        dir
    }

    fn secret() -> AiSecret {
        AiSecret {
            base_url: BASE.into(),
            key: KEY.into(),
        }
    }

    fn write_legacy(dir: &Path) {
        let payload = encode_secret(&secret()).unwrap();

        for name in LEGACY_FILES {
            fs::write(dir.join(name), &payload).unwrap();
        }
    }

    fn legacy_left(dir: &Path) -> Vec<&'static str> {
        LEGACY_FILES.into_iter().filter(|name| dir.join(name).exists()).collect()
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
    fn saved_key_lives_in_the_store_and_not_in_a_file() {
        let dir = temp_dir("roundtrip");
        let store = MemoryStore::default();

        save_secret(&store, &dir, &secret()).unwrap();

        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);

        let restored = load_secret(&store, &dir).unwrap().expect("stored key");

        assert_eq!(restored.base_url, BASE);
        assert_eq!(restored.key, KEY);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_removes_the_store_entry_and_both_legacy_files() {
        let dir = temp_dir("clear");
        let store = MemoryStore::default();

        save_secret(&store, &dir, &secret()).unwrap();
        write_legacy(&dir);
        assert_eq!(legacy_left(&dir), LEGACY_FILES.to_vec());

        clear_secret(&store, &dir).unwrap();

        assert!(legacy_left(&dir).is_empty());
        assert!(store.payload.borrow().is_none());
        assert!(load_secret(&store, &dir).unwrap().is_none());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn clear_removes_legacy_files_even_when_the_store_is_empty() {
        let dir = temp_dir("clear-empty");
        let store = MemoryStore::default();

        write_legacy(&dir);
        clear_secret(&store, &dir).unwrap();

        assert!(legacy_left(&dir).is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_legacy_file_is_moved_into_the_store_and_deleted() {
        let dir = temp_dir("migrate");
        let store = MemoryStore::default();

        write_legacy(&dir);

        let restored = load_secret(&store, &dir).unwrap().expect("migrated key");

        assert_eq!(restored.key, KEY);
        assert!(legacy_left(&dir).is_empty());
        assert!(store.payload.borrow().as_deref().is_some_and(|payload| payload.contains(BASE)));

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_leftover_temp_file_alone_is_migrated_and_deleted() {
        let dir = temp_dir("temp-only");
        let store = MemoryStore::default();

        fs::write(dir.join(LEGACY_FILES[1]), encode_secret(&secret()).unwrap()).unwrap();

        assert!(load_secret(&store, &dir).unwrap().is_some());
        assert!(legacy_left(&dir).is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn saving_a_key_deletes_stale_legacy_files() {
        let dir = temp_dir("save-stale");
        let store = MemoryStore::default();

        write_legacy(&dir);
        save_secret(&store, &dir, &secret()).unwrap();

        assert!(legacy_left(&dir).is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn an_unavailable_store_keeps_the_key_until_cleared_and_never_echoes_it() {
        let dir = temp_dir("broken");
        let store = MemoryStore {
            broken: true,
            ..Default::default()
        };

        write_legacy(&dir);

        let error = load_secret(&store, &dir).err().expect("store error");

        assert!(!error.contains(KEY));
        assert_eq!(legacy_left(&dir), LEGACY_FILES.to_vec());
        assert!(save_secret(&store, &dir, &secret()).is_err());
        assert_eq!(legacy_left(&dir), LEGACY_FILES.to_vec());

        assert!(clear_secret(&store, &dir).is_err());
        assert!(legacy_left(&dir).is_empty());

        let _ = fs::remove_dir_all(dir);
    }

    /// Talks to the real system credential store under a test-only service name.
    /// Run by hand: `cargo test --lib -- --ignored system_store`.
    #[test]
    #[ignore]
    fn system_store_round_trip() {
        let store = KeyringStore(
            keyring::Entry::new("com.chsljryyds.aipet.keyring-test", KEYRING_ACCOUNT).unwrap(),
        );
        let dir = temp_dir("system");

        store.delete().unwrap();
        save_secret(&store, &dir, &secret()).unwrap();

        let restored = load_secret(&store, &dir).unwrap().expect("stored key");

        assert_eq!(restored.key, KEY);

        clear_secret(&store, &dir).unwrap();

        assert!(store.read().unwrap().is_none());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn damaged_content_reads_as_no_key() {
        let dir = temp_dir("damaged");
        let store = MemoryStore::default();

        *store.payload.borrow_mut() = Some("sk-leaked-secret {not json".into());
        fs::write(dir.join(LEGACY_FILES[0]), b"sk-leaked-secret {not json").unwrap();

        assert!(load_secret(&store, &dir).unwrap().is_none());
        assert!(legacy_left(&dir).is_empty());

        let _ = fs::remove_dir_all(dir);
    }
}
