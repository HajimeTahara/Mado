import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Camera,
  Check,
  Copy,
  FileText,
  FolderSearch,
  History,
  Languages,
  Loader2,
  Moon,
  PanelTop,
  Paperclip,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload
} from "lucide-react";
import type { AttachedFile, Message, OperationPreview, Provider, ProviderSettings } from "./types";
import { askProvider, captureScreenshotTranslation, planFileOperation, translateToJapanese } from "./tauri";

const defaultSettings: ProviderSettings = {
  provider: "openai",
  model: "gpt-4.1-mini",
  endpoint: "https://api.openai.com/v1",
  alwaysOnTop: false,
  translucent: true,
  theme: "dark"
};

const providerDefaults: Record<Provider, { model: string; endpoint: string }> = {
  openai: { model: "gpt-4.1-mini", endpoint: "https://api.openai.com/v1" },
  anthropic: { model: "claude-3-5-haiku-latest", endpoint: "https://api.anthropic.com" },
  openrouter: { model: "openai/gpt-4.1-mini", endpoint: "https://openrouter.ai/api/v1" },
  ollama: { model: "llama3.2", endpoint: "http://localhost:11434" }
};

const welcome: Message = {
  id: "welcome",
  role: "assistant",
  content:
    "こんにちは、Mado です。短い質問、英文の和訳、ファイル操作のプレビューをここで扱えます。危ない操作は必ず確認してから進めます。",
  createdAt: new Date().toISOString()
};

function App() {
  const [settings, setSettings] = useState<ProviderSettings>(() => readStorage("mado-settings", defaultSettings));
  const [messages, setMessages] = useState<Message[]>(() => readStorage("mado-history", [welcome]));
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [activePanel, setActivePanel] = useState<"chat" | "files" | "settings">("chat");
  const scrollRef = useRef<HTMLDivElement>(null);

  const latestUserText = useMemo(() => {
    return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  }, [messages]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.translucent = String(settings.translucent);
    localStorage.setItem("mado-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("mado-history", JSON.stringify(messages.slice(-18)));
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || isBusy) {
      return;
    }

    setInput("");
    setIsBusy(true);
    const userMessage = makeMessage("user", text);
    setMessages((current) => [...current, userMessage]);

    if (looksLikeFileOperation(text)) {
      const operation = await planFileOperation(text);
      setPreview(operation);
      setActivePanel("files");
    }

    const answer = await askProvider(text, settings.provider, settings.model);
    setMessages((current) => [...current, makeMessage("assistant", answer)]);
    setIsBusy(false);
  }

  async function handleTranslateSelection() {
    const sourceText = files.find((file) => file.text)?.text ?? latestUserText;
    setIsBusy(true);
    const translated = await translateToJapanese(sourceText);
    setMessages((current) => [...current, makeMessage("assistant", translated)]);
    setIsBusy(false);
  }

  async function handleScreenshot() {
    setIsBusy(true);
    const result = await captureScreenshotTranslation();
    setMessages((current) => [...current, makeMessage("assistant", result)]);
    setIsBusy(false);
  }

  async function handleFiles(incoming: FileList | File[]) {
    const parsed = await Promise.all(Array.from(incoming).map(readFile));
    setFiles((current) => [...parsed, ...current].slice(0, 8));
    setActivePanel("files");
  }

  function updateProvider(provider: Provider) {
    setSettings((current) => ({
      ...current,
      provider,
      model: providerDefaults[provider].model,
      endpoint: providerDefaults[provider].endpoint
    }));
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="Mado controls">
        <button className="brand" type="button" onClick={() => setActivePanel("chat")} title="Mado">
          <PanelTop size={18} />
          <span>Mado</span>
        </button>
        <div className="topbar-actions">
          <button type="button" className="icon-button" title="会話" onClick={() => setActivePanel("chat")}>
            <Bot size={18} />
          </button>
          <button type="button" className="icon-button" title="ファイル" onClick={() => setActivePanel("files")}>
            <Paperclip size={18} />
          </button>
          <button type="button" className="icon-button" title="設定" onClick={() => setActivePanel("settings")}>
            <Settings size={18} />
          </button>
        </div>
      </section>

      <section className="workspace">
        <section className="conversation" aria-label="Conversation">
          <div className="message-list">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-icon">
                  {message.role === "user" ? <Sparkles size={15} /> : <Bot size={15} />}
                </div>
                <p>{message.content}</p>
              </article>
            ))}
            {isBusy && (
              <article className="message assistant">
                <div className="message-icon">
                  <Loader2 className="spin" size={15} />
                </div>
                <p>考えています...</p>
              </article>
            )}
            <div ref={scrollRef} />
          </div>

          <div className="quick-actions" aria-label="Quick actions">
            <button type="button" onClick={handleTranslateSelection}>
              <Languages size={16} />
              和訳
            </button>
            <button type="button" onClick={handleScreenshot}>
              <Camera size={16} />
              スクショ
            </button>
            <button type="button" onClick={() => setPreview(null)}>
              <ShieldCheck size={16} />
              確認
            </button>
          </div>

          <label
            className="drop-strip"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void handleFiles(event.dataTransfer.files);
            }}
          >
            <Upload size={16} />
            <span>{files.length ? `${files.length} 件のファイルを保持中` : "ファイルをドロップ、または選択"}</span>
            <input
              type="file"
              multiple
              accept=".txt,.md,.pdf,.docx,.html"
              onChange={(event) => {
                if (event.target.files) {
                  void handleFiles(event.target.files);
                }
              }}
            />
          </label>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSend();
            }}
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="短い質問、和訳、ファイル操作を入力"
              rows={3}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void handleSend();
                }
              }}
            />
            <button className="send-button" type="submit" disabled={!input.trim() || isBusy} title="送信">
              <Send size={18} />
            </button>
          </form>
        </section>

        <aside className="panel" aria-label="Side panel">
          {activePanel === "chat" && <HistoryPanel messages={messages} />}
          {activePanel === "files" && <FilesPanel files={files} preview={preview} />}
          {activePanel === "settings" && (
            <SettingsPanel settings={settings} setSettings={setSettings} updateProvider={updateProvider} />
          )}
        </aside>
      </section>
    </main>
  );
}

function HistoryPanel({ messages }: { messages: Message[] }) {
  return (
    <div className="panel-section">
      <div className="panel-title">
        <History size={16} />
        <h2>履歴</h2>
      </div>
      <div className="history-list">
        {messages
          .filter((message) => message.role === "user")
          .slice(-6)
          .reverse()
          .map((message) => (
            <p key={message.id}>{message.content}</p>
          ))}
      </div>
    </div>
  );
}

function FilesPanel({ files, preview }: { files: AttachedFile[]; preview: OperationPreview | null }) {
  return (
    <div className="panel-section">
      <div className="panel-title">
        <FolderSearch size={16} />
        <h2>ファイル</h2>
      </div>

      {preview && (
        <div className={`operation-preview ${preview.action === "delete" ? "danger" : ""}`}>
          <div className="preview-heading">
            {preview.action === "delete" ? <Trash2 size={17} /> : <ShieldCheck size={17} />}
            <strong>{preview.summary}</strong>
          </div>
          <dl>
            <div>
              <dt>元</dt>
              <dd>{preview.source}</dd>
            </div>
            {preview.destination && (
              <div>
                <dt>先</dt>
                <dd>{preview.destination}</dd>
              </div>
            )}
          </dl>
          {preview.warnings.map((warning) => (
            <p className="warning" key={warning}>
              {warning}
            </p>
          ))}
          <div className="file-list compact">
            {preview.files.map((file) => (
              <div className="file-row" key={file.path}>
                <FileText size={16} />
                <span>{file.name}</span>
              </div>
            ))}
          </div>
          <button type="button" className="confirm-button" disabled>
            <Check size={16} />
            実行は未実装
          </button>
        </div>
      )}

      <div className="file-list">
        {files.length === 0 && <p className="empty">テキスト、Markdown、HTML はプレビューできます。</p>}
        {files.map((file) => (
          <article className="file-card" key={file.id}>
            <div>
              <FileText size={16} />
              <strong>{file.name}</strong>
            </div>
            <p>{formatBytes(file.size)} / {file.status === "ready" ? "読取済み" : "プレビュー対象外"}</p>
            {file.text && <pre>{file.text.slice(0, 360)}</pre>}
          </article>
        ))}
      </div>
    </div>
  );
}

function SettingsPanel({
  settings,
  setSettings,
  updateProvider
}: {
  settings: ProviderSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProviderSettings>>;
  updateProvider: (provider: Provider) => void;
}) {
  return (
    <div className="panel-section">
      <div className="panel-title">
        <Settings size={16} />
        <h2>設定</h2>
      </div>

      <label className="field">
        <span>プロバイダー</span>
        <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="openrouter">OpenRouter</option>
          <option value="ollama">Ollama</option>
        </select>
      </label>

      <label className="field">
        <span>モデル</span>
        <input
          value={settings.model}
          onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}
        />
      </label>

      <label className="field">
        <span>エンドポイント</span>
        <input
          value={settings.endpoint}
          onChange={(event) => setSettings((current) => ({ ...current, endpoint: event.target.value }))}
        />
      </label>

      <div className="toggle-grid">
        <button
          type="button"
          className={settings.theme === "dark" ? "selected" : ""}
          onClick={() => setSettings((current) => ({ ...current, theme: "dark" }))}
        >
          <Moon size={16} />
          Dark
        </button>
        <button
          type="button"
          className={settings.theme === "light" ? "selected" : ""}
          onClick={() => setSettings((current) => ({ ...current, theme: "light" }))}
        >
          <Sun size={16} />
          Light
        </button>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.translucent}
          onChange={(event) => setSettings((current) => ({ ...current, translucent: event.target.checked }))}
        />
        半透明
      </label>

      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.alwaysOnTop}
          onChange={(event) => setSettings((current) => ({ ...current, alwaysOnTop: event.target.checked }))}
        />
        常に手前
      </label>

      <p className="settings-note">API キー保存と実プロバイダー接続は次の段階で OS の認証情報ストアに接続します。</p>
    </div>
  );
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function makeMessage(role: Message["role"], content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

function looksLikeFileOperation(value: string) {
  return /move|copy|rename|delete|list|移動|コピー|リネーム|削除|一覧|ファイル|フォルダ/i.test(value);
}

async function readFile(file: File): Promise<AttachedFile> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  const readable = extension === "txt" || extension === "md" || extension === "html";

  if (!readable) {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      size: file.size,
      status: "unsupported"
    };
  }

  try {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      size: file.size,
      text: await file.text(),
      status: "ready"
    };
  } catch {
    return {
      id: crypto.randomUUID(),
      name: file.name,
      type: file.type,
      size: file.size,
      status: "error"
    };
  }
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default App;
