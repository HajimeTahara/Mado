use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
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

#[derive(Default)]
struct CodexConversation {
    thread_id: Option<String>,
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

    pub fn ask(
        &self,
        input: &str,
        model: &str,
        history: &[ChatHistoryMessage],
    ) -> Result<String, String> {
        let mut conversation = self
            .conversation
            .lock()
            .map_err(|_| "Codex 会話状態を取得できませんでした。".to_string())?;
        conversation.ask(input, model, history)
    }
}

impl CodexConversation {
    fn ask(
        &mut self,
        input: &str,
        model: &str,
        history: &[ChatHistoryMessage],
    ) -> Result<String, String> {
        let prompt = build_codex_prompt(input, history);
        let mut client = CodexAppServerClient::start("codex")?;
        client.initialize()?;

        let thread_result = if let Some(thread_id) = self.thread_id.as_deref() {
            client.request(
                "thread/resume",
                thread_params(thread_id, model),
                CODEX_TIMEOUT,
            )?
        } else {
            client.request("thread/start", thread_params("", model), CODEX_TIMEOUT)?
        };

        let thread_id = extract_thread_id(&thread_result)
            .or_else(|| self.thread_id.clone())
            .ok_or_else(|| "Codex thread id を取得できませんでした。".to_string())?;
        self.thread_id = Some(thread_id.clone());

        client.request(
            "turn/start",
            turn_params(&thread_id, &prompt, model),
            CODEX_TIMEOUT,
        )?;
        client.wait_for_turn()
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
    fn start(executable: &str) -> Result<Self, String> {
        let mut command = Command::new(executable);
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

        let mut child = command
            .spawn()
            .map_err(|error| format!("Codex CLI を起動できませんでした: {error}"))?;
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

    fn wait_for_turn(&mut self) -> Result<String, String> {
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
                "item/completed" => {
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
                "error" => return Err(format_codex_error(&params)),
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

impl Drop for CodexAppServerClient {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn thread_params(thread_id: &str, model: &str) -> Value {
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
    params
}

fn turn_params(thread_id: &str, prompt: &str, model: &str) -> Value {
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
