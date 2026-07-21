import { useEffect, useMemo, useRef, useState } from "react";
import {
  FileText,
  Loader2,
  MessageSquarePlus,
  Mic,
  Moon,
  Send,
  Settings,
  ShieldCheck,
  Sun,
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
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

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleNewChat();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

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
  }

  function updateProvider(provider: Provider) {
    setSettings((current) => ({
      ...current,
      provider,
      model: providerDefaults[provider].model,
      endpoint: providerDefaults[provider].endpoint
    }));
  }

  function handleNewChat() {
    setMessages([welcome]);
    setInput("");
    setFiles([]);
    setPreview(null);
    setIsSettingsOpen(false);
  }

  return (
    <main className="shell">
      <section
        className="mado-panel"
        aria-label="Mado"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void handleFiles(event.dataTransfer.files);
        }}
      >
        <form
          className="prompt-row"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
        >
          <div className="input-wrap">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="こんにちは"
              rows={1}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void handleSend();
                }
              }}
            />
            <button
              className={`mic-button ${isVoiceMode ? "active" : ""}`}
              type="button"
              onClick={() => setIsVoiceMode((current) => !current)}
              title="音声入力に切り替え"
              aria-pressed={isVoiceMode}
            >
              <Mic size={17} />
            </button>
          </div>
          <div className="panel-actions" aria-label="操作">
            <button className="icon-button send-icon" type="submit" disabled={!input.trim() || isBusy} title="送信">
              <Send size={22} />
            </button>
            <button className="icon-button" type="button" onClick={handleNewChat} title="新規チャット Ctrl+Shift+N">
              <MessageSquarePlus size={21} />
            </button>
            <button
              className={`icon-button ${isSettingsOpen ? "active" : ""}`}
              type="button"
              onClick={() => setIsSettingsOpen((current) => !current)}
              title="設定"
              aria-expanded={isSettingsOpen}
            >
              <Settings size={22} />
            </button>
          </div>
        </form>

        <section className="conversation-board" aria-label="会話">
          <div className="message-list">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <p>{message.content}</p>
              </article>
            ))}
            {preview && <OperationPreviewCard preview={preview} />}
            {files.length > 0 && <FileSummary files={files} />}
            {isBusy && (
              <article className="message assistant status">
                <Loader2 className="spin" size={15} />
                <p>考えています...</p>
              </article>
            )}
            <div ref={scrollRef} />
          </div>
        </section>

        <div className="utility-row" aria-label="補助操作">
          <button type="button" onClick={handleTranslateSelection}>
            和訳
          </button>
          <button type="button" onClick={handleScreenshot}>
            スクショ
          </button>
          <label className="file-picker">
            <Upload size={14} />
            <span>{files.length ? `${files.length} 件` : "ファイル"}</span>
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
          {preview && (
            <button type="button" onClick={() => setPreview(null)}>
              プレビューを閉じる
            </button>
          )}
        </div>

        {isSettingsOpen && (
          <aside className="settings-popover" aria-label="設定">
            <SettingsPanel settings={settings} setSettings={setSettings} updateProvider={updateProvider} />
          </aside>
        )}
      </section>
    </main>
  );
}

function OperationPreviewCard({ preview }: { preview: OperationPreview }) {
  return (
    <article className={`operation-preview ${preview.action === "delete" ? "danger" : ""}`}>
      <div className="preview-heading">
        <ShieldCheck size={16} />
        <strong>{preview.summary}</strong>
      </div>
      <p>元: {preview.source}</p>
      {preview.destination && <p>先: {preview.destination}</p>}
      {preview.warnings.map((warning) => (
        <p className="warning" key={warning}>
          {warning}
        </p>
      ))}
      {preview.files.length > 0 && (
        <div className="file-list compact">
          {preview.files.map((file) => (
            <div className="file-row" key={file.path}>
              <FileText size={15} />
              <span>{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function FileSummary({ files }: { files: AttachedFile[] }) {
  return (
    <article className="file-summary">
      <FileText size={15} />
      <p>{files.length} 件のファイルを保持中</p>
    </article>
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

export default App;
