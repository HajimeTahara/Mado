mod codex_agent;
mod codex_trust;

use codex_agent::{ChatHistoryMessage, CodexAgentState};
use codex_trust::CodexProjectTrustStatus;
use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::SystemTime,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    WebviewWindow, WindowEvent,
};
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPlacement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

const MIN_WINDOW_WIDTH: u32 = 340;
const MIN_WINDOW_HEIGHT: u32 = 420;

#[tauri::command]
async fn ask_provider(
    window: tauri::Window,
    state: tauri::State<'_, CodexAgentState>,
    input: String,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
    history: Option<Vec<ChatHistoryMessage>>,
    project_path: Option<String>,
) -> Result<String, String> {
    if provider == "codex" {
        let state = state.inner().clone();
        let history = history.unwrap_or_default();
        let answer = tauri::async_runtime::spawn_blocking(move || {
            state.ask(
                &input,
                &model,
                reasoning_effort.as_deref(),
                &history,
                project_path.as_deref(),
                |event| {
                    let _ = window.emit("codex-progress", event);
                },
            )
        })
        .await;
        return Ok(match answer {
            Ok(Ok(answer)) => answer,
            Ok(Err(error)) => format!(
                "Codex に接続できませんでした。\n\n{error}\n\nCodex CLI のインストール、ログイン状態、`codex app-server --stdio` が利用できるかを確認してください。"
            ),
            Err(error) => format!("Codex の実行タスクが停止しました。\n\n{error}"),
        });
    }

    if looks_like_translation(&input) {
        return Ok(translate_text(input));
    }

    if looks_like_file_operation(&input) {
        return Ok("これはファイル操作の依頼に見えます。Mado は実行前に対象ファイルと操作内容をプレビューします。MVP では安全のため実行ボタンを無効にしています。".to_string());
    }

    Ok(format!(
        "Mado MVP は {provider} / {model} の設定で受け取りました。\n\n実プロバイダー接続前のローカル応答モードです。短い質問とファイル操作プレビューの流れを確認できます。"
    ))
}

#[tauri::command]
fn reset_codex_conversation(state: tauri::State<'_, CodexAgentState>) {
    state.reset();
}

#[tauri::command]
fn respond_codex_approval(
    state: tauri::State<'_, CodexAgentState>,
    approval_id: String,
    decision: String,
) -> Result<(), String> {
    state.respond_approval(&approval_id, &decision)
}

#[tauri::command]
fn pick_project_folder() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("プロジェクトを開く")
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_codex_project_trust_status(
    app: AppHandle,
    root_path: String,
) -> Result<CodexProjectTrustStatus, String> {
    codex_trust::project_trust_status(&app, &root_path)
}

#[tauri::command]
fn set_codex_project_trust(
    app: AppHandle,
    root_path: String,
    trusted: bool,
) -> Result<CodexProjectTrustStatus, String> {
    codex_trust::set_project_trust(&app, &root_path, trusted)
}

#[tauri::command]
fn open_codex_user_config(app: AppHandle) -> Result<String, String> {
    open_codex_user_file(
        &app,
        "config.toml",
        "# Codex user config\n\n# Example:\n# model = \"gpt-5\"\n",
    )
}

#[tauri::command]
fn open_codex_user_agents(app: AppHandle) -> Result<String, String> {
    open_codex_user_file(
        &app,
        "AGENTS.md",
        "# AGENTS.md\n\nこのファイルに Codex のデフォルト指示を書けます。\n",
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
        "これはプレビューです。ファイルの移動、コピー、リネーム、削除はまだ実行しません。"
            .to_string(),
    ];

    if action == "delete" {
        warnings.push("削除は明示的な確認が必要です。".to_string());
    }

    if files.is_empty() {
        warnings.push(
            "条件に合うファイルが見つからないか、対象フォルダを読めませんでした。".to_string(),
        );
    }

    OperationPreview {
        summary: format!(
            "{} 件の候補を見つけました。操作: {}",
            files.len(),
            action_label(action)
        ),
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
        .manage(CodexAgentState::new())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    let _ = save_window_placement(&webview_window);
                }
            }
            WindowEvent::ScaleFactorChanged { .. } => {
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    let _ = update_window_max_size(&webview_window);
                    let _ = save_window_placement(&webview_window);
                }
            }
            _ => {}
        })
        .setup(|app| {
            configure_desktop_panel(app.handle())?;
            setup_tray(app.handle())?;

            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
            let shortcut_for_handler = shortcut.clone();

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if shortcut == &shortcut_for_handler
                            && event.state() == ShortcutState::Pressed
                        {
                            if let Some(window) = app.get_webview_window("main") {
                                toggle_window(&window);
                            }
                        }
                    })
                    .build(),
            )?;

            if let Err(error) = app.global_shortcut().register(shortcut) {
                eprintln!("Mado shortcut was not registered: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ask_provider,
            reset_codex_conversation,
            respond_codex_approval,
            pick_project_folder,
            get_codex_project_trust_status,
            set_codex_project_trust,
            open_codex_user_config,
            open_codex_user_agents,
            translate_text,
            capture_screenshot_translation,
            plan_file_operation
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mado");
}

fn configure_desktop_panel(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_decorations(false);
        let _ = window.set_shadow(false);
        let _ = window.set_skip_taskbar(true);
        update_window_max_size(&window)?;
        let _ = restore_window_placement(&window);
    }

    Ok(())
}

fn window_placement_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Mado 設定フォルダの取得に失敗しました: {error}"))?;
    Ok(dir.join("window-placement.json"))
}

fn save_window_placement(window: &WebviewWindow) -> Result<(), String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("ウィンドウ位置の取得に失敗しました: {error}"))?;
    let size = window
        .inner_size()
        .map_err(|error| format!("ウィンドウサイズの取得に失敗しました: {error}"))?;
    let placement = WindowPlacement {
        x: position.x,
        y: position.y,
        width: size.width.max(MIN_WINDOW_WIDTH),
        height: size.height.max(MIN_WINDOW_HEIGHT),
    };
    let path = window_placement_path(window.app_handle())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Mado 設定フォルダを作成できませんでした ({}): {error}",
                parent.display()
            )
        })?;
    }
    let text = serde_json::to_string_pretty(&placement)
        .map_err(|error| format!("ウィンドウ配置設定の作成に失敗しました: {error}"))?;
    fs::write(&path, text).map_err(|error| {
        format!(
            "ウィンドウ配置設定を書き込めませんでした ({}): {error}",
            path.display()
        )
    })
}

fn restore_window_placement(window: &WebviewWindow) -> Result<(), String> {
    let path = window_placement_path(window.app_handle())?;
    if !path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(&path).map_err(|error| {
        format!(
            "ウィンドウ配置設定を読み込めませんでした ({}): {error}",
            path.display()
        )
    })?;
    let mut placement = serde_json::from_str::<WindowPlacement>(&text).map_err(|error| {
        format!(
            "ウィンドウ配置設定を解析できませんでした ({}): {error}",
            path.display()
        )
    })?;
    placement.width = placement.width.max(MIN_WINDOW_WIDTH);
    placement.height = placement.height.max(MIN_WINDOW_HEIGHT);

    let _ = window.set_size(Size::Physical(PhysicalSize::new(
        placement.width,
        placement.height,
    )));
    window
        .set_position(Position::Physical(PhysicalPosition::new(
            placement.x,
            placement.y,
        )))
        .map_err(|error| format!("ウィンドウ位置を復元できませんでした: {error}"))
}

fn update_window_max_size(window: &WebviewWindow) -> tauri::Result<()> {
    let monitor = match window.current_monitor()? {
        Some(monitor) => Some(monitor),
        None => window.primary_monitor()?,
    };

    if let Some(monitor) = monitor {
        let max_size = monitor.work_area().size;
        let scale_factor = monitor.scale_factor();
        let max_width = f64::from(max_size.width) / scale_factor;
        let max_height = f64::from(max_size.height) / scale_factor;
        window.set_max_size(Some(LogicalSize::new(max_width, max_height)))?;
    }

    Ok(())
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "表示 / 非表示", true, Option::<&str>::None)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, Option::<&str>::None)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray_builder = TrayIconBuilder::with_id("mado")
        .tooltip("Mado")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    toggle_window(&window);
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    toggle_window(&window);
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    Ok(())
}

fn toggle_window(window: &WebviewWindow) {
    match window.is_visible() {
        Ok(true) => {
            let _ = window.hide();
        }
        _ => {
            let _ = update_window_max_size(window);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn open_codex_user_file(
    app: &AppHandle,
    file_name: &str,
    default_content: &str,
) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("ユーザーホームフォルダの取得に失敗しました: {error}"))?;
    let codex_dir = home.join(".codex");
    fs::create_dir_all(&codex_dir).map_err(|error| {
        format!(
            "Codex 設定フォルダを作成できませんでした ({}): {error}",
            codex_dir.display()
        )
    })?;

    let path = codex_dir.join(file_name);
    if !path.exists() {
        fs::write(&path, default_content).map_err(|error| {
            format!(
                "Codex 設定ファイルを作成できませんでした ({}): {error}",
                path.display()
            )
        })?;
    }

    open_path_with_default_app(&path)?;
    Ok(path.to_string_lossy().to_string())
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        let path_text = path.to_string_lossy().to_string();
        command.args(["/C", "start", "", &path_text]);
        command
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        command.arg(path);
        command
    } else {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };

    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command.spawn().map_err(|error| {
        format!(
            "既定のアプリで開けませんでした ({}): {error}",
            path.display()
        )
    })?;
    Ok(())
}

fn looks_like_translation(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("translate")
        || lower.contains("翻訳")
        || lower.contains("和訳")
        || lower.contains("日本語")
}

fn looks_like_file_operation(value: &str) -> bool {
    let lower = value.to_lowercase();
    [
        "move",
        "copy",
        "rename",
        "delete",
        "list",
        "移動",
        "コピー",
        "リネーム",
        "削除",
        "一覧",
        "ファイル",
        "フォルダ",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn infer_action(instruction: &str) -> &'static str {
    let lower = instruction.to_lowercase();
    if lower.contains("delete")
        || lower.contains("remove")
        || lower.contains("削除")
        || lower.contains("消して")
    {
        "delete"
    } else if lower.contains("copy") || lower.contains("コピー") {
        "copy"
    } else if lower.contains("rename") || lower.contains("リネーム") || lower.contains("名前")
    {
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
    } else if lower.contains("document")
        || lower.contains("documents")
        || lower.contains("ドキュメント")
    {
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

    if !(lower.contains("move")
        || lower.contains("copy")
        || lower.contains("移動")
        || lower.contains("コピー"))
    {
        return None;
    }

    if lower.contains("document") || lower.contains("documents") || lower.contains("ドキュメント")
    {
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
