import { useEffect, useRef, useState } from "react";
import {
  FileText,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  Mic,
  Moon,
  Plus,
  Send,
  Settings,
  ShieldCheck,
  Sun,
  Upload
} from "lucide-react";
import type {
  AttachedFile,
  CodexProgressEvent,
  CodexProjectTrustStatus,
  Message,
  OpenedProject,
  OperationPreview,
  Provider,
  ProviderSettings
} from "./types";
import {
  askProvider,
  getCodexProjectTrustStatus,
  onCodexProgress,
  onWindowFocusChanged,
  openCodexUserAgents,
  openCodexUserConfig,
  pickProjectFolder,
  planFileOperation,
  resetCodexConversation,
  setCodexProjectTrust,
  startWindowDrag
} from "./tauri";

const defaultSettings: ProviderSettings = {
  provider: "codex",
  model: "gpt-5",
  endpoint: "codex app-server --stdio",
  alwaysOnTop: false,
  translucent: true,
  backgroundMode: "transparent",
  theme: "dark",
  inputTransparent: false,
  messageTransparent: false,
  textColor: ""
};

const providerDefaults: Record<Provider, { model: string; endpoint: string }> = {
  codex: { model: "gpt-5", endpoint: "codex app-server --stdio" },
  openai: { model: "gpt-4.1-mini", endpoint: "https://api.openai.com/v1" },
  anthropic: { model: "claude-3-5-haiku-latest", endpoint: "https://api.anthropic.com" },
  openrouter: { model: "openai/gpt-4.1-mini", endpoint: "https://openrouter.ai/api/v1" },
  ollama: { model: "llama3.2", endpoint: "http://localhost:11434" }
};

const maxStoredMessages = 200;

type TrustPrompt = {
  status: CodexProjectTrustStatus;
  selectedPath: string;
  isApplying: boolean;
  error?: string;
};

function App() {
  const [settings, setSettings] = useState<ProviderSettings>(() => readSettings());
  const [messages, setMessages] = useState<Message[]>(() => readMessages());
  const [openedProject, setOpenedProject] = useState<OpenedProject | null>(() =>
    readStorage<OpenedProject | null>("mado-opened-project", null)
  );
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt | null>(null);
  const [progressEvents, setProgressEvents] = useState<CodexProgressEvent[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsPopoverRef = useRef<HTMLElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.translucent = String(settings.translucent);
    document.documentElement.dataset.background = settings.backgroundMode;
    document.documentElement.dataset.inputTransparent = String(settings.inputTransparent);
    document.documentElement.dataset.messageTransparent = String(settings.messageTransparent);
    if (settings.textColor) {
      document.documentElement.style.setProperty("--mado-text-color", settings.textColor);
    } else {
      document.documentElement.style.removeProperty("--mado-text-color");
    }
    localStorage.setItem("mado-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("mado-history", JSON.stringify(messages.slice(-maxStoredMessages)));
  }, [messages]);

  useEffect(() => {
    if (openedProject) {
      localStorage.setItem("mado-opened-project", JSON.stringify(openedProject));
    } else {
      localStorage.removeItem("mado-opened-project");
    }
  }, [openedProject]);

  useEffect(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }

    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  }, [files.length, isBusy, messages, preview]);

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

  useEffect(() => {
    if (!isSettingsOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (settingsPopoverRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) {
        return;
      }
      setIsSettingsOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isSettingsOpen]);

  useEffect(() => {
    let unlisten = () => {};

    void onWindowFocusChanged((focused) => {
      if (!focused) {
        setIsSettingsOpen(false);
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => unlisten();
  }, []);

  useEffect(() => {
    let unlisten = () => {};

    void onCodexProgress((event) => {
      setProgressEvents((current) => [...current, event].slice(-24));
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => unlisten();
  }, []);

  async function handleSend() {
    const text = input.trim();
    if (!text || isBusy) {
      return;
    }

    setInput("");
    setIsBusy(true);
    setProgressEvents([]);
    const userMessage = makeMessage("user", text);
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);

    if (looksLikeFileOperation(text)) {
      const operation = await planFileOperation(text);
      setPreview(operation);
    }

    try {
      const answer = await askProvider(text, settings.provider, settings.model, messages, openedProject?.path);
      setMessages((current) => [...current, makeMessage("assistant", answer)]);
    } finally {
      setIsBusy(false);
    }
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
    setMessages([]);
    setInput("");
    setFiles([]);
    setPreview(null);
    setProgressEvents([]);
    setIsSettingsOpen(false);
    void resetCodexConversation();
  }

  async function handleOpenProject() {
    if (isBusy || trustPrompt) {
      return;
    }

    try {
      const selectedPath = await pickProjectFolder();
      if (!selectedPath) {
        return;
      }
      const status = await getCodexProjectTrustStatus(selectedPath);
      if (status.trusted) {
        openProject(status.projectPath, true);
        return;
      }
      setTrustPrompt({ status, selectedPath, isApplying: false });
    } catch (error) {
      setMessages((current) => [...current, makeMessage("assistant", `プロジェクトを開けませんでした。\n\n${String(error)}`)]);
    }
  }

  async function handleTrustDecision(trusted: boolean) {
    if (!trustPrompt || trustPrompt.isApplying) {
      return;
    }

    setTrustPrompt((current) => (current ? { ...current, isApplying: true, error: undefined } : current));
    try {
      const status = await setCodexProjectTrust(trustPrompt.selectedPath, trusted);
      openProject(status.projectPath, status.trusted);
      setTrustPrompt(null);
    } catch (error) {
      setTrustPrompt((current) =>
        current ? { ...current, isApplying: false, error: `Codex trust 設定を更新できませんでした。\n${String(error)}` } : current
      );
    }
  }

  function openProject(path: string, trusted: boolean) {
    setOpenedProject({ path, trusted });
    setMessages([]);
    setFiles([]);
    setPreview(null);
    setProgressEvents([]);
    void resetCodexConversation();
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
        <div
          className="drag-strip"
          aria-label="ウィンドウを移動"
          onPointerDown={(event) => {
            if (event.button === 0) {
              void startWindowDrag();
            }
          }}
        />
        <section className="conversation-board" aria-label="会話">
          <div className="message-list" ref={messageListRef}>
            <div className="message-stack">
              {messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <p>{message.content}</p>
                </article>
              ))}
              {preview && <OperationPreviewCard preview={preview} />}
              {files.length > 0 && <FileSummary files={files} />}
              {isBusy && progressEvents.length > 0 && <CodexProgress events={progressEvents} />}
              {isBusy && (
                <article className="message assistant status">
                  <Loader2 className="spin" size={15} />
                  <p>考えています...</p>
                </article>
              )}
            </div>
          </div>
        </section>

        <form
          className="prompt-row"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
        >
          <div className="prompt-main">
            {openedProject && <ProjectBadge project={openedProject} />}
            <div className="input-wrap">
              <button
                className={`project-button ${openedProject ? "active" : ""}`}
                type="button"
                onClick={() => void handleOpenProject()}
                disabled={isBusy}
                title={openedProject ? `プロジェクト: ${openedProject.path}` : "プロジェクトを開く"}
                aria-label="プロジェクトを開く"
              >
                <Plus size={16} />
              </button>
              <label className="upload-button" title="ファイルアップロード">
                <Upload size={16} />
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
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Welcome to Mado!"
                rows={1}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
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
          </div>
          <div className="panel-actions" aria-label="操作">
            <button className="icon-button send-icon" type="submit" disabled={!input.trim() || isBusy} title="送信">
              <Send size={22} />
            </button>
            <button className="icon-button" type="button" onClick={handleNewChat} title="新規チャット Ctrl+Shift+N">
              <MessageSquarePlus size={21} />
            </button>
            <button
              ref={settingsButtonRef}
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

        {isSettingsOpen && (
          <aside ref={settingsPopoverRef} className="settings-popover" aria-label="設定">
            <SettingsPanel settings={settings} setSettings={setSettings} updateProvider={updateProvider} />
          </aside>
        )}
        {trustPrompt && (
          <TrustProjectDialog
            prompt={trustPrompt}
            onTrust={() => void handleTrustDecision(true)}
            onOpenWithoutTrust={() => void handleTrustDecision(false)}
            onCancel={() => setTrustPrompt(null)}
          />
        )}
      </section>
    </main>
  );
}

function TrustProjectDialog({
  prompt,
  onTrust,
  onOpenWithoutTrust,
  onCancel
}: {
  prompt: TrustPrompt;
  onTrust: () => void;
  onOpenWithoutTrust: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-dialog-title">
        <div className="trust-title">
          <FolderOpen size={17} />
          <h2 id="trust-dialog-title">Codex trust</h2>
        </div>
        <p>このプロジェクトを Codex の trusted project として登録しますか?</p>
        <dl className="trust-details">
          <div>
            <dt>Project</dt>
            <dd>{prompt.status.projectPath}</dd>
          </div>
          <div>
            <dt>Codex config</dt>
            <dd>{prompt.status.configPath}</dd>
          </div>
        </dl>
        <p className="trust-note">Trust すると、このプロジェクト内の `.codex/config.toml` を Codex CLI が読み込みます。</p>
        {prompt.error && <p className="trust-error">{prompt.error}</p>}
        <div className="trust-actions">
          <button type="button" onClick={onCancel} disabled={prompt.isApplying}>
            キャンセル
          </button>
          <button type="button" onClick={onOpenWithoutTrust} disabled={prompt.isApplying}>
            Trustせずに開く
          </button>
          <button type="button" className="primary" onClick={onTrust} disabled={prompt.isApplying}>
            {prompt.isApplying ? "設定中..." : "Trustして開く"}
          </button>
        </div>
      </section>
    </div>
  );
}

function ProjectBadge({ project }: { project: OpenedProject }) {
  return (
    <div className={`project-badge ${project.trusted ? "trusted" : "untrusted"}`} title={project.path}>
      <FolderOpen size={17} />
      <span>{project.path}</span>
    </div>
  );
}

function CodexProgress({ events }: { events: CodexProgressEvent[] }) {
  return (
    <article className="codex-progress" aria-label="Codex の処理状況">
      <div className="progress-heading">
        <Loader2 className="spin" size={15} />
        <strong>Codex 実行中</strong>
      </div>
      <div className="progress-list">
        {events.slice(-8).map((event, index) => (
          <div className={`progress-row ${event.kind}`} key={`${event.eventType}-${index}-${event.message}`}>
            <span className="progress-dot" />
            <div>
              <span className="progress-kind">{progressKindLabel(event.kind)}</span>
              <p>{event.command || event.filePath || event.message}</p>
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function progressKindLabel(kind: CodexProgressEvent["kind"]) {
  switch (kind) {
    case "command":
      return "Command";
    case "fileChange":
      return "File";
    case "reasoning":
      return "Reasoning";
    default:
      return "Status";
  }
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
  const [fileOpenStatus, setFileOpenStatus] = useState("");

  async function openCodexFile(kind: "config" | "agents") {
    setFileOpenStatus("開いています...");
    try {
      const path = kind === "config" ? await openCodexUserConfig() : await openCodexUserAgents();
      setFileOpenStatus(`開きました: ${path}`);
    } catch (error) {
      setFileOpenStatus(`開けませんでした: ${String(error)}`);
    }
  }

  return (
    <div className="panel-section">
      <div className="panel-title">
        <Settings size={16} />
        <h2>設定</h2>
      </div>

      <section className="settings-category" aria-labelledby="connection-settings-title">
        <h3 id="connection-settings-title">接続</h3>

        <div className="setting-group">
          <h4>プロバイダー</h4>
          <label className="field">
            <span>サービス</span>
            <select value={settings.provider} onChange={(event) => updateProvider(event.target.value as Provider)}>
              <option value="codex">Codex</option>
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
        </div>

        <p className="settings-note">
          {settings.provider === "codex"
            ? "Codex はローカルの Codex CLI とログイン状態を使用します。"
            : "API キー保存と実プロバイダー接続は次の段階で OS の認証情報ストアに接続します。"}
        </p>
      </section>

      <section className="settings-category" aria-labelledby="codex-file-settings-title">
        <h3 id="codex-file-settings-title">Codex ファイル</h3>

        <div className="setting-group">
          <h4>デフォルト設定</h4>
          <div className="settings-action-grid">
            <button type="button" onClick={() => void openCodexFile("config")}>
              config.toml
            </button>
            <button type="button" onClick={() => void openCodexFile("agents")}>
              AGENTS.md
            </button>
          </div>
          {fileOpenStatus && <p className="settings-note file-open-status">{fileOpenStatus}</p>}
        </div>
      </section>

      <section className="settings-category" aria-labelledby="display-settings-title">
        <h3 id="display-settings-title">表示</h3>

        <div className="setting-group">
          <h4>外観</h4>
          <div className="toggle-group" aria-label="背景">
            <span>背景</span>
            <div className="toggle-grid">
              <button
                type="button"
                className={settings.backgroundMode === "transparent" ? "selected" : ""}
                onClick={() => setSettings((current) => ({ ...current, backgroundMode: "transparent" }))}
              >
                透明
              </button>
              <button
                type="button"
                className={settings.backgroundMode === "solid" ? "selected" : ""}
                onClick={() => setSettings((current) => ({ ...current, backgroundMode: "solid" }))}
              >
                背景あり
              </button>
            </div>
          </div>

          <div className="toggle-group" aria-label="テキストボックス">
            <span>テキストボックス</span>
            <div className="toggle-grid">
              <button
                type="button"
                className={settings.inputTransparent ? "selected" : ""}
                onClick={() => setSettings((current) => ({ ...current, inputTransparent: !current.inputTransparent }))}
              >
                入力欄を透明
              </button>
              <button
                type="button"
                className={settings.messageTransparent ? "selected" : ""}
                onClick={() =>
                  setSettings((current) => ({ ...current, messageTransparent: !current.messageTransparent }))
                }
              >
                履歴を透明
              </button>
            </div>
          </div>

          <div className="toggle-group" aria-label="テーマ">
            <span>テーマ</span>
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
          </div>

          <div className="color-setting">
            <label className="field">
              <span>文字色</span>
              <input
                type="color"
                value={settings.textColor || defaultTextColor(settings.theme)}
                onChange={(event) => setSettings((current) => ({ ...current, textColor: event.target.value }))}
              />
            </label>
            <button
              type="button"
              className="text-reset-button"
              onClick={() => setSettings((current) => ({ ...current, textColor: "" }))}
            >
              既定に戻す
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
        </div>

        <div className="setting-group">
          <h4>ウィンドウ</h4>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.alwaysOnTop}
              onChange={(event) => setSettings((current) => ({ ...current, alwaysOnTop: event.target.checked }))}
            />
            常に手前
          </label>
        </div>
      </section>

      <section className="settings-category" aria-labelledby="operation-settings-title">
        <h3 id="operation-settings-title">操作</h3>

        <div className="setting-group">
          <h4>ショートカット</h4>
          <dl className="shortcut-list">
            <div>
              <dt>Enter</dt>
              <dd>送信</dd>
            </div>
            <div>
              <dt>Shift + Enter</dt>
              <dd>改行</dd>
            </div>
            <div>
              <dt>Ctrl + Shift + N</dt>
              <dd>新規チャット</dd>
            </div>
            <div>
              <dt>Ctrl + Alt + M</dt>
              <dd>表示 / 非表示</dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}

function readMessages(): Message[] {
  return readStorage<Message[]>("mado-history", []).filter((message) => message.id !== "welcome");
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readSettings(): ProviderSettings {
  const settings = {
    ...defaultSettings,
    ...readStorage<Partial<ProviderSettings>>("mado-settings", {})
  };

  if (settings.provider !== "codex") {
    return {
      ...settings,
      provider: "codex",
      model: providerDefaults.codex.model,
      endpoint: providerDefaults.codex.endpoint
    };
  }

  return settings;
}

function defaultTextColor(theme: ProviderSettings["theme"]) {
  return theme === "light" ? "#222622" : "#f4f4f0";
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
