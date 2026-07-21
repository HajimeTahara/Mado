use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use toml_edit::{value, DocumentMut, Item, Table};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CodexProjectTrustStatus {
    pub trusted: bool,
    pub trust_level: Option<String>,
    pub project_path: String,
    pub config_path: String,
    pub config_exists: bool,
}

pub fn project_trust_status(
    app: &AppHandle,
    root_path: &str,
) -> Result<CodexProjectTrustStatus, String> {
    let project_path = canonical_project_path(root_path)?;
    let config_path = codex_user_config_path(app)?;
    let config_exists = config_path.is_file();
    let trust_level = if config_exists {
        let doc = read_codex_config(&config_path)?;
        read_project_trust_level(&doc, &project_path)
    } else {
        None
    };
    Ok(CodexProjectTrustStatus {
        trusted: trust_level.as_deref() == Some("trusted"),
        trust_level,
        project_path,
        config_path: display_path(&config_path),
        config_exists,
    })
}

pub fn set_project_trust(
    app: &AppHandle,
    root_path: &str,
    trusted: bool,
) -> Result<CodexProjectTrustStatus, String> {
    let project_path = canonical_project_path(root_path)?;
    let config_path = codex_user_config_path(app)?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Codex config フォルダを作成できませんでした ({}): {error}",
                parent.display()
            )
        })?;
    }

    let mut doc = if config_path.is_file() {
        read_codex_config(&config_path)?
    } else {
        DocumentMut::new()
    };
    set_project_trust_level(
        &mut doc,
        &project_path,
        if trusted { "trusted" } else { "untrusted" },
    );
    fs::write(&config_path, doc.to_string()).map_err(|error| {
        format!(
            "Codex config を更新できませんでした ({}): {error}",
            config_path.display()
        )
    })?;

    project_trust_status(app, root_path)
}

fn canonical_project_path(root_path: &str) -> Result<String, String> {
    let path = PathBuf::from(root_path);
    let canonical = fs::canonicalize(&path).map_err(|error| {
        format!(
            "プロジェクトフォルダを正規化できませんでした ({}): {error}",
            path.display()
        )
    })?;
    Ok(normalize_codex_project_path(&display_path(&canonical)))
}

fn normalize_codex_project_path(path: &str) -> String {
    let without_extended_prefix = if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = path.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        path.to_string()
    };
    without_extended_prefix.to_ascii_lowercase()
}

fn codex_user_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("ユーザーホームフォルダの取得に失敗しました: {error}"))?;
    Ok(home.join(".codex").join("config.toml"))
}

fn read_codex_config(path: &Path) -> Result<DocumentMut, String> {
    let text = fs::read_to_string(path).map_err(|error| {
        format!(
            "Codex config を読み込めませんでした ({}): {error}",
            path.display()
        )
    })?;
    text.parse::<DocumentMut>().map_err(|error| {
        format!(
            "Codex config の TOML 解析に失敗しました ({}): {error}",
            path.display()
        )
    })
}

fn read_project_trust_level(doc: &DocumentMut, project_path: &str) -> Option<String> {
    doc.get("projects")?
        .as_table()?
        .get(project_path)?
        .as_table()?
        .get("trust_level")?
        .as_value()?
        .as_str()
        .map(str::to_string)
}

fn set_project_trust_level(doc: &mut DocumentMut, project_path: &str, trust_level: &str) {
    if !matches!(doc.get("projects"), Some(Item::Table(_))) {
        doc.insert("projects", Item::Table(Table::new()));
    }
    let projects = doc["projects"]
        .as_table_mut()
        .expect("projects table was just inserted");
    if !matches!(projects.get(project_path), Some(Item::Table(_))) {
        projects.insert(project_path, Item::Table(Table::new()));
    }
    let project = projects
        .get_mut(project_path)
        .and_then(Item::as_table_mut)
        .expect("project table was just inserted");
    project.insert("trust_level", value(trust_level));
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().to_string()
}
