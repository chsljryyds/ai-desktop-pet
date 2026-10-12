use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, WebviewWindow};

const PREFERENCE_LABEL: &str = "preference";
const MODELS_DIR: &str = "custom-models";
const MAX_RESOURCE_ID_LEN: usize = 64;

pub fn ensure_import_window(label: &str) -> Result<(), String> {
    if label == PREFERENCE_LABEL {
        Ok(())
    } else {
        Err("unauthorized_window".into())
    }
}

fn validate_resource_id(resource_id: &str) -> Result<(), String> {
    if resource_id.is_empty()
        || resource_id.len() > MAX_RESOURCE_ID_LEN
        || !resource_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("invalid_resource_id".into());
    }

    Ok(())
}

fn reject_symlink(path: &Path, code: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(code.into()),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("source_missing".into()),
    }
}

/// Confirms the source is a real directory, contains a top-level `.model3.json`,
/// and has no symlink anywhere in the tree. Nothing is created.
fn validate_source(source: &Path) -> Result<PathBuf, String> {
    let meta = fs::symlink_metadata(source).map_err(|_| "source_missing".to_string())?;

    if meta.file_type().is_symlink() {
        return Err("source_symlink".into());
    }

    if !meta.is_dir() {
        return Err("source_not_directory".into());
    }

    let mut found_model = false;
    walk_source(source, source, &mut found_model)?;

    if !found_model {
        return Err("model_not_found".into());
    }

    source
        .canonicalize()
        .map_err(|_| "source_missing".to_string())
}

fn walk_source(root: &Path, dir: &Path, found_model: &mut bool) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|_| "source_missing".to_string())?;

    for entry in entries {
        let entry = entry.map_err(|_| "source_missing".to_string())?;
        let file_type = entry
            .file_type()
            .map_err(|_| "source_missing".to_string())?;

        if file_type.is_symlink() {
            return Err("tree_symlink".into());
        }

        if file_type.is_dir() {
            walk_source(root, &entry.path(), found_model)?;
            continue;
        }

        if file_type.is_file() && dir == root {
            let name = entry.file_name();
            let name = name.to_string_lossy();

            if name.ends_with(".model3.json") {
                *found_model = true;
            }
        }
    }

    Ok(())
}

fn prepare_models_root(app_data: &Path) -> Result<PathBuf, String> {
    let app_meta = fs::symlink_metadata(app_data).map_err(|_| "models_root_invalid".to_string())?;

    if app_meta.file_type().is_symlink() || !app_meta.is_dir() {
        return Err("models_root_invalid".into());
    }

    let app_canon = app_data
        .canonicalize()
        .map_err(|_| "models_root_invalid".to_string())?;
    let root = app_canon.join(MODELS_DIR);

    reject_symlink(&root, "models_root_invalid")?;

    if root.exists() && !root.is_dir() {
        return Err("models_root_invalid".into());
    }

    if !root.exists() {
        fs::create_dir(&root).map_err(|_| "models_root_invalid".to_string())?;
    }

    let canon = root
        .canonicalize()
        .map_err(|_| "models_root_invalid".to_string())?;

    if canon.parent() != Some(app_canon.as_path())
        || canon.file_name().and_then(|name| name.to_str()) != Some(MODELS_DIR)
    {
        return Err("models_root_invalid".into());
    }

    Ok(canon)
}

fn overlaps(source: &Path, dest: &Path) -> bool {
    source == dest || source.starts_with(dest) || dest.starts_with(source)
}

fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    let entries = fs::read_dir(source).map_err(|err| format!("import_failed:{err}"))?;

    for entry in entries {
        let entry = entry.map_err(|err| format!("import_failed:{err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("import_failed:{err}"))?;
        let target = dest.join(entry.file_name());

        if file_type.is_symlink() {
            return Err("tree_symlink".into());
        }

        if file_type.is_dir() {
            fs::create_dir(&target).map_err(|err| format!("import_failed:{err}"))?;
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target).map_err(|err| format!("import_failed:{err}"))?;
        } else {
            return Err("import_failed:unsupported file".into());
        }
    }

    Ok(())
}

/// Deletes only the directory this import just created. Refuses the model root,
/// anything outside it, and never receives the user's source path.
fn remove_created_dest(models_root: &Path, dest: &Path) -> Result<(), String> {
    if !dest.exists() {
        return Ok(());
    }

    let root = models_root
        .canonicalize()
        .map_err(|err| format!("import_failed:{err}"))?;
    let canon = dest
        .canonicalize()
        .map_err(|err| format!("import_failed:{err}"))?;

    if canon == root || canon.parent() != Some(root.as_path()) {
        return Err("import_failed:refused to delete unexpected path".into());
    }

    fs::remove_dir_all(&canon).map_err(|err| format!("import_failed:{err}"))
}

/// Window check happens before any directory is created. `app_data` is chosen by
/// the caller (the command uses Tauri's app data dir); the destination is always
/// `custom-models/<resource_id>`.
pub fn import_custom_model_for(
    label: &str,
    app_data: &Path,
    resource_id: &str,
    source: &Path,
) -> Result<PathBuf, String> {
    ensure_import_window(label)?;
    validate_resource_id(resource_id)?;

    let source_canon = validate_source(source)?;
    let models_root = prepare_models_root(app_data)?;
    let dest = models_root.join(resource_id);

    if dest.parent() != Some(models_root.as_path()) {
        return Err("invalid_resource_id".into());
    }

    if fs::symlink_metadata(&dest).is_ok() {
        return Err("dest_exists".into());
    }

    if overlaps(&source_canon, &dest) {
        return Err("path_conflict".into());
    }

    fs::create_dir(&dest).map_err(|err| format!("import_failed:{err}"))?;

    if let Err(err) = copy_tree(&source_canon, &dest) {
        let cleanup = remove_created_dest(&models_root, &dest);

        if let Err(cleanup_err) = cleanup {
            return Err(format!("{err}; {cleanup_err}"));
        }

        return Err(err);
    }

    Ok(dest)
}

#[tauri::command]
pub async fn import_custom_model(
    webview_window: WebviewWindow,
    app: AppHandle,
    from_path: String,
    resource_id: String,
) -> Result<String, String> {
    ensure_import_window(webview_window.label())?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "models_root_invalid".to_string())?;
    let dest = import_custom_model_for(
        webview_window.label(),
        &app_data,
        &resource_id,
        Path::new(&from_path),
    )?;

    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("bongo-import-{nanos}-{n}"));

        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_model(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("cat.model3.json"), b"{\"Version\":3}").unwrap();
        let resources = dir.join("resources");
        fs::create_dir_all(&resources).unwrap();
        fs::write(resources.join("cover.png"), b"png").unwrap();
    }

    fn marker(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }

        fs::write(path, contents).unwrap();
    }

    #[test]
    fn rejects_non_preference_windows_without_creating_directories() {
        for label in ["chat", "main", "other"] {
            let root = scratch();
            let source = root.join("source");
            write_model(&source);
            let app_data = root.join("app");
            fs::create_dir_all(&app_data).unwrap();

            let err = import_custom_model_for(label, &app_data, "model1", &source).unwrap_err();

            assert_eq!(err, "unauthorized_window");
            assert!(!app_data.join(MODELS_DIR).exists());
        }
    }

    #[test]
    fn preference_imports_into_an_isolated_child_directory() {
        let root = scratch();
        let source = root.join("source");
        write_model(&source);
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let sibling = app_data.join("custom-models-evil");
        marker(&sibling.join("keep.txt"), "keep");

        let dest = import_custom_model_for("preference", &app_data, "model_1-a", &source).unwrap();

        assert_eq!(dest.file_name().unwrap(), "model_1-a");
        assert_eq!(dest.parent().unwrap().file_name().unwrap(), MODELS_DIR);
        assert_eq!(
            fs::read(dest.join("cat.model3.json")).unwrap(),
            b"{\"Version\":3}"
        );
        assert_eq!(
            fs::read(dest.join("resources").join("cover.png")).unwrap(),
            b"png"
        );
        assert_eq!(fs::read(sibling.join("keep.txt")).unwrap(), b"keep");
        assert!(source.join("cat.model3.json").exists());
    }

    #[test]
    fn rejects_path_escape_and_prefix_tricks() {
        let root = scratch();
        let source = root.join("source");
        write_model(&source);
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();

        for id in [
            "../outside",
            "..",
            ".",
            "a/b",
            "a\\b",
            "a.b",
            "",
            "has space",
            "模型",
        ] {
            let err = import_custom_model_for("preference", &app_data, id, &source).unwrap_err();
            assert_eq!(err, "invalid_resource_id", "{id}");
        }

        assert!(!outside.join("cat.model3.json").exists());
        assert!(!app_data.join(MODELS_DIR).exists());
    }

    #[test]
    fn rejects_missing_invalid_and_existing_targets_without_overwrite() {
        let root = scratch();
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let source = root.join("source");
        write_model(&source);

        assert_eq!(
            import_custom_model_for("preference", &app_data, "id", &root.join("missing"))
                .unwrap_err(),
            "source_missing"
        );
        assert_eq!(
            import_custom_model_for(
                "preference",
                &app_data,
                "id",
                &source.join("cat.model3.json")
            )
            .unwrap_err(),
            "source_not_directory"
        );

        let empty = root.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            import_custom_model_for("preference", &app_data, "id", &empty).unwrap_err(),
            "model_not_found"
        );
        assert!(!app_data.join(MODELS_DIR).exists());

        let first = import_custom_model_for("preference", &app_data, "id", &source).unwrap();
        marker(&first.join("keep.txt"), "original");
        let err = import_custom_model_for("preference", &app_data, "id", &source).unwrap_err();

        assert_eq!(err, "dest_exists");
        assert_eq!(fs::read(first.join("keep.txt")).unwrap(), b"original");
        assert!(source.join("cat.model3.json").exists());
    }

    #[test]
    fn rejects_copying_a_parent_into_its_own_child() {
        let root = scratch();
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let models = app_data.join(MODELS_DIR);
        fs::create_dir_all(&models).unwrap();
        let source = root.join("source");
        write_model(&source);

        assert_eq!(
            import_custom_model_for("preference", &app_data, "child", &app_data).unwrap_err(),
            "model_not_found"
        );
        assert!(!models.join("child").exists());

        write_model(&app_data);
        assert_eq!(
            import_custom_model_for("preference", &app_data, "child", &app_data).unwrap_err(),
            "path_conflict"
        );
        assert!(!models.join("child").exists());
        let _ = source;
    }

    #[cfg(unix)]
    #[test]
    fn rejects_nested_copies_and_symlinks() {
        let root = scratch();
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let models = app_data.join(MODELS_DIR);
        fs::create_dir_all(&models).unwrap();
        let source = root.join("source");
        write_model(&source);

        let linked = root.join("linked");
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert_eq!(
            import_custom_model_for("preference", &app_data, "child", &linked).unwrap_err(),
            "source_symlink"
        );

        let nested = root.join("nested");
        write_model(&nested);
        std::os::unix::fs::symlink(&source, nested.join("escape")).unwrap();
        assert_eq!(
            import_custom_model_for("preference", &app_data, "child", &nested).unwrap_err(),
            "tree_symlink"
        );
        assert!(!models.join("child").exists());

        let root_link = root.join("root-link");
        fs::create_dir_all(root.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), &root_link).unwrap();
        let linked_app = root_link;
        assert_eq!(
            import_custom_model_for("preference", &linked_app, "child", &source).unwrap_err(),
            "models_root_invalid"
        );
        assert!(!root.join("elsewhere").join(MODELS_DIR).exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleans_up_a_partial_copy_and_keeps_the_source() {
        let root = scratch();
        let app_data = root.join("app");
        fs::create_dir_all(&app_data).unwrap();
        let source = root.join("source");
        write_model(&source);
        let status = std::process::Command::new("mkfifo")
            .arg(source.join("blocked.pipe"))
            .status()
            .expect("mkfifo");

        assert!(status.success());

        let err = import_custom_model_for("preference", &app_data, "partial", &source).unwrap_err();

        assert!(err.starts_with("import_failed"), "{err}");
        assert!(!app_data.join(MODELS_DIR).join("partial").exists());
        assert!(source.join("cat.model3.json").exists());
    }
}
