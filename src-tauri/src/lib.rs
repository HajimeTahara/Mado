use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    time::SystemTime,
};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
    name: String,
    path: String,
    size: u64,
    modified: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationPreview {
    summary: String,
    source: String,
    destination: Option<String>,
    action: String,
    requires_confirmation: bool,
    warnings: Vec<String>,
    files: Vec<FilePreview>,
}

#[tauri::command]
fn ask_provider(input: String, provider: String, model: String) -> String {
    if looks_like_translation(&input) {
        return translate_text(input);
    }

    if looks_like_file_operation(&input) {
        return "これはファイル操作の依頼に見えます。Mado は実行前に対象ファイルと操作内容をプレビューします。MVP では安全のため実行ボタンを無効にしています。".to_string();
    }

    format!(
        "Mado MVP は {provider} / {model} の設定で受け取りました。\n\n実プロバイダー接続前のローカル応答モードです。短い質問、和訳、ファイル操作プレビューの流れを確認できます。"
    )
}

#[tauri::command]
fn translate_text(text: String) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "翻訳するテキストを入力してください。".to_string();
    }

    format!(
        "日本語訳プレビュー:\n{trimmed}\n\n注: この MVP ではプロバイダー接続前のローカルプレビューとして表示しています。"
    )
}

#[tauri::command]
fn capture_screenshot_translation() -> String {
    "スクリーンショット翻訳の入口を確認しました。次の段階では範囲選択、OCR、和訳プレビューをこのボタンに接続します。".to_string()
}

#[tauri::command]
fn plan_file_operation(instruction: String) -> OperationPreview {
    let action = infer_action(&instruction);
    let source = infer_source(&instruction);
    let destination = infer_destination(&instruction);
    let extensions = infer_extensions(&instruction);
    let files = scan_files(&source, &extensions);

    let mut warnings = vec![
        "これはプレビューです。ファイルの移動、コピー、リネーム、削除はまだ実行しません。".to_string(),
    ];

    if action == "delete" {
        warnings.push("削除は明示的な確認が必要です。".to_string());
    }

    if files.is_empty() {
        warnings.push("条件に合うファイルが見つからないか、対象フォルダを読めませんでした。".to_string());
    }

    OperationPreview {
        summary: format!("{} 件の候補を見つけました。操作: {}", files.len(), action_label(action)),
        source: source.display().to_string(),
        destination: destination.map(|path| path.display().to_string()),
        action: action.to_string(),
        requires_confirmation: action != "list",
        warnings,
        files,
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
            let shortcut_for_handler = shortcut.clone();

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &shortcut_for_handler && event.state() == ShortcutState::Pressed {
                            if let Some(window) = app.get_webview_window("main") {
                                toggle_window(&window);
                            }
                        }
                    })
                    .build(),
            )?;

            app.global_shortcut().register(shortcut)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ask_provider,
            translate_text,
            capture_screenshot_translation,
            plan_file_operation
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mado");
}

fn toggle_window(window: &WebviewWindow) {
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn looks_like_translation(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("translate") || lower.contains("翻訳") || lower.contains("和訳") || lower.contains("日本語")
}

fn looks_like_file_operation(value: &str) -> bool {
    let lower = value.to_lowercase();
    ["move", "copy", "rename", "delete", "list", "移動", "コピー", "リネーム", "削除", "一覧", "ファイル", "フォルダ"]
        .iter()
        .any(|needle| lower.contains(needle))
}

fn infer_action(instruction: &str) -> &'static str {
    let lower = instruction.to_lowercase();
    if lower.contains("delete") || lower.contains("remove") || lower.contains("削除") || lower.contains("消して") {
        "delete"
    } else if lower.contains("copy") || lower.contains("コピー") {
        "copy"
    } else if lower.contains("rename") || lower.contains("リネーム") || lower.contains("名前") {
        "rename"
    } else if lower.contains("move") || lower.contains("移動") {
        "move"
    } else {
        "list"
    }
}

fn action_label(action: &str) -> &'static str {
    match action {
        "delete" => "削除",
        "copy" => "コピー",
        "rename" => "リネーム",
        "move" => "移動",
        _ => "一覧",
    }
}

fn infer_source(instruction: &str) -> PathBuf {
    let lower = instruction.to_lowercase();
    let home = home_dir();

    if lower.contains("download") || lower.contains("ダウンロード") {
        home.join("Downloads")
    } else if lower.contains("document") || lower.contains("documents") || lower.contains("ドキュメント") {
        home.join("Documents")
    } else if lower.contains("desktop") || lower.contains("デスクトップ") {
        home.join("Desktop")
    } else {
        env::current_dir().unwrap_or_else(|_| home)
    }
}

fn infer_destination(instruction: &str) -> Option<PathBuf> {
    let lower = instruction.to_lowercase();
    let home = home_dir();

    if !(lower.contains("move") || lower.contains("copy") || lower.contains("移動") || lower.contains("コピー")) {
        return None;
    }

    if lower.contains("document") || lower.contains("documents") || lower.contains("ドキュメント") {
        Some(home.join("Documents"))
    } else if lower.contains("desktop") || lower.contains("デスクトップ") {
        Some(home.join("Desktop"))
    } else if lower.contains("download") || lower.contains("ダウンロード") {
        Some(home.join("Downloads"))
    } else {
        None
    }
}

fn infer_extensions(instruction: &str) -> Vec<&'static str> {
    let lower = instruction.to_lowercase();
    if lower.contains("pdf") {
        vec!["pdf"]
    } else if lower.contains("zip") {
        vec!["zip"]
    } else if lower.contains("画像") || lower.contains("image") || lower.contains("photo") {
        vec!["png", "jpg", "jpeg", "webp", "gif"]
    } else if lower.contains("markdown") || lower.contains(".md") {
        vec!["md"]
    } else if lower.contains("text") || lower.contains("txt") {
        vec!["txt"]
    } else {
        Vec::new()
    }
}

fn scan_files(source: &Path, extensions: &[&str]) -> Vec<FilePreview> {
    let Ok(entries) = fs::read_dir(source) else {
        return Vec::new();
    };

    let mut files: Vec<FilePreview> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }

            if !extensions.is_empty() {
                let extension = path.extension()?.to_string_lossy().to_lowercase();
                if !extensions.iter().any(|candidate| *candidate == extension) {
                    return None;
                }
            }

            Some(FilePreview {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.display().to_string(),
                size: metadata.len(),
                modified: metadata.modified().ok().and_then(format_time),
            })
        })
        .collect();

    files.sort_by(|left, right| right.modified.cmp(&left.modified));
    files.truncate(20);
    files
}

fn format_time(time: SystemTime) -> Option<String> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs().to_string())
}

fn home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}
