use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    env,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

const CODEX_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
pub struct ChatHistoryMessage {
    role: String,
    content: String,
}

pub struct CodexAgentState {
    conversation: Mutex<CodexConversation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProgressEvent {
    pub kind: String,
    pub event_type: String,
    pub message: String,
    pub command: Option<String>,
    pub file_path: Option<String>,
}

#[derive(Default)]
struct CodexConversation {
    thread_id: Option<String>,
    project_path: Option<String>,
}

impl CodexAgentState {
    pub fn new() -> Self {
        Self {
            conversation: Mutex::new(CodexConversation::default()),
        }
    }

    pub fn reset(&self) {
        if let Ok(mut conversation) = self.conversation.lock() {
            conversation.thread_id = None;
        }
    }

    pub fn ask<F>(
        &self,
        input: &str,
        model: &str,
        history: &[ChatHistoryMessage],
        project_path: Option<&str>,
        progress: F,
    ) -> Result<String, String>
    where
        F: FnMut(CodexProgressEvent),
    {
        let mut conversation = self
            .conversation
            .lock()
            .map_err(|_| "Codex 会話状態を取得できませんでした。".to_string())?;
        conversation.ask(input, model, history, project_path, progress)
    }
}

impl CodexConversation {
    fn ask<F>(
        &mut self,
        input: &str,
        model: &str,
        history: &[ChatHistoryMessage],
        project_path: Option<&str>,
        mut progress: F,
    ) -> Result<String, String>
    where
        F: FnMut(CodexProgressEvent),
    {
        let project_path = project_path.map(str::to_string);
        if self.project_path != project_path {
            self.thread_id = None;
            self.project_path = project_path.clone();
        }

        let prompt = build_codex_prompt(input, history);
        progress(status_event("codex/start", "Codex を起動しています..."));
        let mut client = CodexAppServerClient::start("codex", self.project_path.as_deref())?;
        client.initialize()?;
        progress(status_event("codex/initialized", "Codex に接続しました"));

        let thread_result = if let Some(thread_id) = self.thread_id.as_deref() {
            progress(status_event(
                "thread/resume",
                "Codex thread を再開しています...",
            ));
            client.request(
                "thread/resume",
                thread_params(thread_id, model, self.project_path.as_deref()),
                CODEX_TIMEOUT,
            )?
        } else {
            progress(status_event(
                "thread/start",
                "Codex thread を開始しています...",
            ));
            client.request(
                "thread/start",
                thread_params("", model, self.project_path.as_deref()),
                CODEX_TIMEOUT,
            )?
        };

        let thread_id = extract_thread_id(&thread_result)
            .or_else(|| self.thread_id.clone())
            .ok_or_else(|| "Codex thread id を取得できませんでした。".to_string())?;
        self.thread_id = Some(thread_id.clone());

        client.request(
            "turn/start",
            turn_params(&thread_id, &prompt, model, self.project_path.as_deref()),
            CODEX_TIMEOUT,
        )?;
        progress(status_event("turn/start", "応答ターンを開始しました"));
        client.wait_for_turn(progress)
    }
}

struct CodexAppServerClient {
    child: Child,
    stdin: ChildStdin,
    receiver: mpsc::Receiver<Result<Value, String>>,
    stashed: VecDeque<Value>,
    next_id: i64,
}

impl CodexAppServerClient {
    fn start(executable: &str, cwd: Option<&str>) -> Result<Self, String> {
        let command_spec = resolve_codex_command(executable);
        let mut command = Command::new(&command_spec.program);
        command.args(&command_spec.prefix_args);
        if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
            command.current_dir(cwd);
        }
        command
            .args(["app-server", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let mut child = command.spawn().map_err(|error| {
            format!(
                "Codex CLI を起動できませんでした: {error}\n試行コマンド: {}",
                command_spec.display
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex CLI の stdin を開けませんでした。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex CLI の stdout を開けませんでした。".to_string())?;
        let (sender, receiver) = mpsc::channel();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if line.trim().is_empty() => {}
                    Ok(line) => {
                        let parsed = serde_json::from_str::<Value>(&line).map_err(|error| {
                            format!("Codex app-server 応答の解析に失敗しました: {error}")
                        });
                        if sender.send(parsed).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(format!(
                            "Codex app-server 出力の読み取りに失敗しました: {error}"
                        )));
                        break;
                    }
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            receiver,
            stashed: VecDeque::new(),
            next_id: 1,
        })
    }

    fn initialize(&mut self) -> Result<(), String> {
        self.request(
            "initialize",
            json!({
                "clientInfo": {
                    "name": "mado",
                    "title": "Mado",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }),
            Duration::from_secs(30),
        )?;
        self.notify("initialized", json!({}))?;
        Ok(())
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_json(json!({
            "id": id,
            "method": method,
            "params": params
        }))?;

        loop {
            let message = self.next_message(timeout)?;
            if is_server_request(&message) {
                self.decline_request(&message)?;
                continue;
            }
            if message.get("id").and_then(Value::as_i64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(format_codex_error(error));
                }
                return Ok(message.get("result").cloned().unwrap_or_else(|| json!({})));
            }
            self.stashed.push_back(message);
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_json(json!({
            "method": method,
            "params": params
        }))
    }

    fn wait_for_turn<F>(&mut self, mut progress: F) -> Result<String, String>
    where
        F: FnMut(CodexProgressEvent),
    {
        let mut deltas = String::new();
        let mut completed_messages = Vec::new();

        loop {
            let message = self.next_message(CODEX_TIMEOUT)?;
            if is_server_request(&message) {
                self.decline_request(&message)?;
                continue;
            }

            let Some(method) = message.get("method").and_then(Value::as_str) else {
                continue;
            };
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

            match method {
                "item/agentMessage/delta" => {
                    if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                        deltas.push_str(delta);
                    }
                }
                "item/started" => {
                    if let Some(event) = progress_event_from_item(method, &params) {
                        progress(event);
                    }
                }
                "item/completed" => {
                    if let Some(event) = progress_event_from_item(method, &params) {
                        progress(event);
                    }
                    if let Some(item) = params.get("item") {
                        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
                        if item_type == "agentMessage" {
                            if let Some(text) = item.get("text").and_then(Value::as_str) {
                                let text = text.trim();
                                if !text.is_empty() {
                                    completed_messages.push(text.to_string());
                                }
                            }
                        }
                    }
                }
                "turn/completed" => {
                    progress(status_event("turn/completed", "応答ターンが完了しました"));
                    let content = completed_messages
                        .last()
                        .cloned()
                        .unwrap_or_else(|| deltas.trim().to_string());
                    return if content.trim().is_empty() {
                        Err("Codex の応答本文が空でした。".to_string())
                    } else {
                        Ok(content)
                    };
                }
                "error" => {
                    let message = format_codex_error(&params);
                    progress(status_event("error", &message));
                    return Err(message);
                }
                _ => {}
            }
        }
    }

    fn next_message(&mut self, timeout: Duration) -> Result<Value, String> {
        if let Some(message) = self.stashed.pop_front() {
            return Ok(message);
        }
        match self.receiver.recv_timeout(timeout) {
            Ok(Ok(message)) => Ok(message),
            Ok(Err(error)) => Err(error),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("Codex app-server の応答がタイムアウトしました。".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("Codex app-server が終了しました。".to_string())
            }
        }
    }

    fn decline_request(&mut self, message: &Value) -> Result<(), String> {
        let Some(id) = message.get("id").and_then(Value::as_i64) else {
            return Ok(());
        };
        self.write_json(json!({
            "id": id,
            "result": {
                "decision": "decline"
            }
        }))
    }

    fn write_json(&mut self, payload: Value) -> Result<(), String> {
        let line = serde_json::to_string(&payload)
            .map_err(|error| format!("Codex app-server 送信データの作成に失敗しました: {error}"))?;
        writeln!(self.stdin, "{line}")
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("Codex app-server への送信に失敗しました: {error}"))
    }
}

struct CodexCommandSpec {
    program: String,
    prefix_args: Vec<String>,
    display: String,
}

fn resolve_codex_command(executable: &str) -> CodexCommandSpec {
    let requested = env::var("MADO_CODEX_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| executable.to_string());

    for candidate in codex_command_candidates(&requested) {
        if candidate.is_file() {
            return command_spec_for_path(candidate);
        }
    }

    CodexCommandSpec {
        program: requested.clone(),
        prefix_args: Vec::new(),
        display: requested,
    }
}

fn codex_command_candidates(requested: &str) -> Vec<PathBuf> {
    let requested_path = PathBuf::from(requested);
    if requested_path.is_absolute() || requested.contains('\\') || requested.contains('/') {
        return vec![requested_path];
    }

    let mut candidates = Vec::new();
    if cfg!(windows) {
        let names = [
            format!("{requested}.cmd"),
            format!("{requested}.exe"),
            requested.to_string(),
        ];
        for dir in windows_codex_search_dirs() {
            for name in &names {
                candidates.push(dir.join(name));
            }
        }
    }

    candidates.push(PathBuf::from(requested));
    candidates
}

#[cfg(windows)]
fn windows_codex_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(app_data.join("npm"));
    }
    if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(user_profile.join("AppData").join("Roaming").join("npm"));
        dirs.push(
            user_profile
                .join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WindowsApps"),
        );
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local_app_data.join("Microsoft").join("WindowsApps"));
    }
    dirs
}

#[cfg(not(windows))]
fn windows_codex_search_dirs() -> Vec<PathBuf> {
    Vec::new()
}

fn command_spec_for_path(path: PathBuf) -> CodexCommandSpec {
    if is_windows_command_script(&path) {
        let shell = env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let path_text = path.display().to_string();
        return CodexCommandSpec {
            program: shell,
            prefix_args: vec!["/C".to_string(), path_text.clone()],
            display: format!("{path_text} app-server --stdio"),
        };
    }

    let path_text = path.display().to_string();
    CodexCommandSpec {
        program: path_text.clone(),
        prefix_args: Vec::new(),
        display: format!("{path_text} app-server --stdio"),
    }
}

fn is_windows_command_script(path: &Path) -> bool {
    cfg!(windows)
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"))
            .unwrap_or(false)
}

fn status_event(event_type: &str, message: &str) -> CodexProgressEvent {
    CodexProgressEvent {
        kind: "status".to_string(),
        event_type: event_type.to_string(),
        message: message.to_string(),
        command: None,
        file_path: None,
    }
}

fn progress_event_from_item(method: &str, params: &Value) -> Option<CodexProgressEvent> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("item");
    let phase = if method == "item/started" {
        "開始"
    } else {
        "完了"
    };

    match item_type {
        "commandExecution" => {
            let command = first_json_text(item, &["command"]);
            Some(CodexProgressEvent {
                kind: "command".to_string(),
                event_type: method.to_string(),
                message: if command.is_empty() {
                    format!("{phase}: コマンド実行")
                } else {
                    format!("{phase}: {command}")
                },
                command: if command.is_empty() {
                    None
                } else {
                    Some(command)
                },
                file_path: None,
            })
        }
        "mcpToolCall" => {
            let server = item.get("server").and_then(Value::as_str).unwrap_or("");
            let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
            let tool_name = [server, tool]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join(".");
            Some(CodexProgressEvent {
                kind: "command".to_string(),
                event_type: method.to_string(),
                message: if tool_name.is_empty() {
                    format!("{phase}: MCP tool call")
                } else {
                    format!("{phase}: {tool_name}")
                },
                command: if tool_name.is_empty() {
                    None
                } else {
                    Some(tool_name)
                },
                file_path: None,
            })
        }
        "reasoning" => Some(CodexProgressEvent {
            kind: "reasoning".to_string(),
            event_type: method.to_string(),
            message: format!("{phase}: 推論"),
            command: None,
            file_path: None,
        }),
        "fileChange" => {
            let path = first_json_text(
                item,
                &[
                    "path",
                    "filePath",
                    "targetPath",
                    "relativePath",
                    "absolutePath",
                ],
            );
            Some(CodexProgressEvent {
                kind: "fileChange".to_string(),
                event_type: method.to_string(),
                message: if path.is_empty() {
                    format!("{phase}: ファイル変更")
                } else {
                    format!("{phase}: {path}")
                },
                command: None,
                file_path: if path.is_empty() { None } else { Some(path) },
            })
        }
        "agentMessage" => None,
        _ => Some(CodexProgressEvent {
            kind: "status".to_string(),
            event_type: method.to_string(),
            message: format!("{phase}: {item_type}"),
            command: None,
            file_path: None,
        }),
    }
}

fn first_json_text(value: &Value, keys: &[&str]) -> String {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(text) = map.get(*key).and_then(Value::as_str) {
                    let text = text.trim();
                    if !text.is_empty() {
                        return text.to_string();
                    }
                }
            }
            for nested in map.values() {
                let text = first_json_text(nested, keys);
                if !text.is_empty() {
                    return text;
                }
            }
            String::new()
        }
        Value::Array(items) => {
            for item in items {
                let text = first_json_text(item, keys);
                if !text.is_empty() {
                    return text;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn thread_params(thread_id: &str, model: &str, cwd: Option<&str>) -> Value {
    let mut params = json!({
        "approvalPolicy": "on-request",
        "approvalsReviewer": "user"
    });
    if !thread_id.is_empty() {
        params["threadId"] = json!(thread_id);
    }
    if !model.trim().is_empty() {
        params["model"] = json!(model.trim());
    }
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        params["cwd"] = json!(cwd);
    }
    params
}

fn turn_params(thread_id: &str, prompt: &str, model: &str, cwd: Option<&str>) -> Value {
    let mut params = json!({
        "threadId": thread_id,
        "input": [{
            "type": "text",
            "text": prompt,
            "text_elements": []
        }],
        "approvalPolicy": "on-request",
        "approvalsReviewer": "user"
    });
    if !model.trim().is_empty() {
        params["model"] = json!(model.trim());
    }
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        params["cwd"] = json!(cwd);
    }
    params
}

fn is_server_request(message: &Value) -> bool {
    message.get("id").is_some() && message.get("method").and_then(Value::as_str).is_some()
}

fn extract_thread_id(value: &Value) -> Option<String> {
    for key in ["threadId", "thread_id"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            let id = id.trim();
            if !id.is_empty() {
                return Some(id.to_string());
            }
        }
    }
    value
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
}

fn build_codex_prompt(input: &str, history: &[ChatHistoryMessage]) -> String {
    format!(
        "<Mado向けCodex指示>\n{}\n</Mado向けCodex指示>\n\n<会話履歴>\n{}\n</会話履歴>\n\n<現在のユーザー発話>\n{}\n</現在のユーザー発話>\n\n返答:",
        mado_instructions(),
        conversation_history_text(history),
        input.trim()
    )
}

fn mado_instructions() -> &'static str {
    "あなたはデスクトップ常駐の小さなAIアシスタント Mado のチャット欄として応答します。\n\
     返答は原則として日本語で、簡潔かつ自然にしてください。\n\
     会話履歴は文脈として扱い、現在のユーザー発話に直接答えてください。\n\
     プロジェクトルールやシステム指示への了解表明だけで終えず、ユーザーが求める回答を返してください。\n\
     このUIにはまだ承認操作がないため、ローカルファイル変更やコマンド実行が必要な場合は、実行せずに確認事項と手順を説明してください。"
}

fn conversation_history_text(history: &[ChatHistoryMessage]) -> String {
    let mut lines = Vec::new();
    for item in history {
        let role = item.role.trim().to_ascii_lowercase();
        if role != "user" && role != "assistant" {
            continue;
        }
        let content = item.content.trim();
        if content.is_empty() {
            continue;
        }
        let label = if role == "user" { "User" } else { "Assistant" };
        lines.push(format!("{label}: {content}"));
    }
    let text = lines.join("\n\n");
    const MAX_HISTORY_CHARS: usize = 12_000;
    if text.len() <= MAX_HISTORY_CHARS {
        return if text.is_empty() {
            "(none)".to_string()
        } else {
            text
        };
    }
    text.chars()
        .rev()
        .take(MAX_HISTORY_CHARS)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .trim_start()
        .to_string()
}

fn format_codex_error(value: &Value) -> String {
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    if let Some(message) = value.as_str() {
        return message.to_string();
    }
    format!("Codex app-server error: {value}")
}
