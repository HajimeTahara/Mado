import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  FileText,
  FolderOpen,
  Loader2,
  Mic,
  Moon,
  Plus,
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
  ProviderSettings
} from "./types";
import {
  applyCodexProjectDefaults,
  askProvider,
  getCodexProjectTrustStatus,
  onCodexProgress,
  onWindowFocusChanged,
  openCodexDefaultAgents,
  openCodexDefaultConfig,
  pickProjectFolder,
  planFileOperation,
  resetCodexConversation,
  respondCodexApproval,
  setCodexProjectTrust,
  startWindowDrag
} from "./tauri";

const defaultSettings: ProviderSettings = {
  provider: "codex",
  model: "gpt-5.6-terra",
  reasoningEffort: "medium",
  endpoint: "codex app-server --stdio",
  alwaysOnTop: false,
  translucent: true,
  backgroundMode: "transparent",
  theme: "dark",
  inputTransparent: false,
  messageTransparent: false,
  textColor: ""
};

const codexModelOptions = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.4-nano", label: "GPT-5.4 nano" }
] as const;

const codexReasoningOptions = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" }
] as const;

const maxStoredMessages = 200;

type TrustPrompt = {
  status: CodexProjectTrustStatus;
  selectedPath: string;
  isApplying: boolean;
  error?: string;
};

function App() {
  const [settings, setSettings] = useState<ProviderSettings>(() => readSettings());
  const [selectedCodexModel, setSelectedCodexModel] = useState(() => settings.model);
  const [selectedCodexReasoning, setSelectedCodexReasoning] = useState(() => settings.reasoningEffort);
  const [messages, setMessages] = useState<Message[]>(() => readMessages());
  const [openedProject, setOpenedProject] = useState<OpenedProject | null>(() =>
    readStorage<OpenedProject | null>("mado-opened-project", null)
  );
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [preview, setPreview] = useState<OperationPreview | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt | null>(null);
  const [progressEvents, setProgressEvents] = useState<CodexProgressEvent[]>([]);
  const [pendingApproval, setPendingApproval] = useState<CodexProgressEvent | null>(null);
  const [isRespondingApproval, setIsRespondingApproval] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isCodexMenuOpen, setIsCodexMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const codexMenuRef = useRef<HTMLDivElement>(null);
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
    setSelectedCodexModel(settings.model);
    setSelectedCodexReasoning(settings.reasoningEffort);
  }, [settings.model, settings.reasoningEffort]);

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
    if (!isCodexMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (codexMenuRef.current?.contains(target)) {
        return;
      }
      setIsCodexMenuOpen(false);
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isCodexMenuOpen]);

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
      if (event.kind === "approval" && event.approvalId) {
        setPendingApproval(event);
      }
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
    setPendingApproval(null);
    setIsRespondingApproval(false);
    setPreview(null);
    const userMessage = makeMessage("user", text);
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);

    if (settings.provider !== "codex" && looksLikeFileOperation(text)) {
      const operation = await planFileOperation(text);
      setPreview(operation);
    }

    try {
      const answer = await askProvider(
        text,
        settings.provider,
        selectedCodexModel,
        selectedCodexReasoning,
        messages,
        openedProject?.path
      );
      setMessages((current) => [...current, makeMessage("assistant", answer)]);
    } finally {
      setIsBusy(false);
      setPendingApproval(null);
      setIsRespondingApproval(false);
    }
  }

  async function handleFiles(incoming: FileList | File[]) {
    const parsed = await Promise.all(Array.from(incoming).map(readFile));
    setFiles((current) => [...parsed, ...current].slice(0, 8));
  }

  function handleNewChat() {
    setMessages([]);
    setInput("");
    setFiles([]);
    setPreview(null);
    setProgressEvents([]);
    setPendingApproval(null);
    setIsRespondingApproval(false);
    setIsSettingsOpen(false);
    void resetCodexConversation();
  }

  async function handleApprovalDecision(decision: "approve" | "deny") {
    const approvalId = pendingApproval?.approvalId;
    if (!approvalId || isRespondingApproval) {
      return;
    }
    setIsRespondingApproval(true);
    try {
      await respondCodexApproval(approvalId, decision);
      setPendingApproval(null);
      setIsRespondingApproval(false);
    } catch (error) {
      setMessages((current) => [
        ...current,
        makeMessage("assistant", `Codex 承認への応答に失敗しました。\n\n${String(error)}`)
      ]);
      setIsRespondingApproval(false);
    }
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
        const defaultsError = await copyCodexDefaultsToProject(status.projectPath);
        openProject(status.projectPath, true);
        showCodexDefaultsError(defaultsError);
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
      const defaultsError = await copyCodexDefaultsToProject(status.projectPath);
      openProject(status.projectPath, status.trusted);
      showCodexDefaultsError(defaultsError);
      setTrustPrompt(null);
    } catch (error) {
      setTrustPrompt((current) =>
        current ? { ...current, isApplying: false, error: `Codex trust 設定を更新できませんでした。\n${String(error)}` } : current
      );
    }
  }

  async function copyCodexDefaultsToProject(projectPath: string) {
    try {
      await applyCodexProjectDefaults(projectPath);
      return "";
    } catch (error) {
      return String(error);
    }
  }

  function showCodexDefaultsError(error: string) {
    if (!error) {
      return;
    }
    setMessages((current) => [
      ...current,
      makeMessage("assistant", `Codex デフォルトファイルをプロジェクトへコピーできませんでした。\n\n${error}`)
    ]);
  }

  function openProject(path: string, trusted: boolean) {
    setOpenedProject({ path, trusted });
    setMessages([]);
    setFiles([]);
    setPreview(null);
    setProgressEvents([]);
    setPendingApproval(null);
    setIsRespondingApproval(false);
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
          {pendingApproval && (
            <CodexApprovalOverlay
              approval={pendingApproval}
              isResponding={isRespondingApproval}
              onApprove={() => void handleApprovalDecision("approve")}
              onDeny={() => void handleApprovalDecision("deny")}
            />
          )}
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
              <div className="codex-selectors" ref={codexMenuRef}>
                <button
                  className="codex-selector-trigger"
                  type="button"
                  onClick={() => setIsCodexMenuOpen((current) => !current)}
                  title="Codex のモデルと推論レベル"
                  aria-label="Codex のモデルと推論レベル"
                  aria-expanded={isCodexMenuOpen}
                >
                  <span>
                    {codexModelLabel(selectedCodexModel)} / {codexReasoningLabel(selectedCodexReasoning)}
                  </span>
                  <ChevronDown size={13} />
                </button>
                {isCodexMenuOpen && (
                  <CodexSelectorMenu
                    selectedModel={selectedCodexModel}
                    selectedReasoning={selectedCodexReasoning}
                    onModelChange={setSelectedCodexModel}
                    onReasoningChange={setSelectedCodexReasoning}
                    onClose={() => setIsCodexMenuOpen(false)}
                  />
                )}
              </div>
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
            <SettingsPanel settings={settings} setSettings={setSettings} />
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

function CodexSelectorMenu({
  selectedModel,
  selectedReasoning,
  onModelChange,
  onReasoningChange,
  onClose
}: {
  selectedModel: string;
  selectedReasoning: string;
  onModelChange: (value: string) => void;
  onReasoningChange: (value: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="codex-selector-menu" role="menu" aria-label="Codex モデルと推論レベル">
      <div className="selector-group-label">Reasoning</div>
      {codexReasoningOptions.map((option) => (
        <button
          className={`selector-menu-item ${selectedReasoning === option.value ? "selected" : ""}`}
          key={option.value || "default"}
          type="button"
          role="menuitemradio"
          aria-checked={selectedReasoning === option.value}
          onClick={() => {
            onReasoningChange(option.value);
            onClose();
          }}
        >
          <span>{option.label}</span>
          {selectedReasoning === option.value && <Check size={14} />}
        </button>
      ))}
      <div className="selector-divider" />
      <div className="selector-group-label">Model</div>
      {codexModelOptions.map((option) => (
        <button
          className={`selector-menu-item ${selectedModel === option.id ? "selected" : ""}`}
          key={option.id}
          type="button"
          role="menuitemradio"
          aria-checked={selectedModel === option.id}
          onClick={() => {
            onModelChange(option.id);
            onClose();
          }}
        >
          <span>{option.label}</span>
          {selectedModel === option.id && <Check size={14} />}
        </button>
      ))}
    </div>
  );
}

function codexModelLabel(value: string) {
  return codexModelOptions.find((option) => option.id === value)?.label ?? value;
}

function codexReasoningLabel(value: string) {
  return (codexReasoningOptions.find((option) => option.value === value)?.label ?? value) || "Default";
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

function CodexApprovalOverlay({
  approval,
  isResponding,
  onApprove,
  onDeny
}: {
  approval: CodexProgressEvent;
  isResponding: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div className="approval-overlay" role="presentation">
      <section className="approval-popup" role="dialog" aria-modal="false" aria-labelledby="approval-title">
        <div className="approval-title">
          <ShieldCheck size={17} />
          <div>
            <h2 id="approval-title">{approval.title || "Codex approval"}</h2>
            <p>Codex が操作の承認を求めています。</p>
          </div>
        </div>
        <dl className="approval-details">
          {approval.command && (
            <div>
              <dt>Command</dt>
              <dd>{approval.command}</dd>
            </div>
          )}
          {approval.filePath && (
            <div>
              <dt>File</dt>
              <dd>{approval.filePath}</dd>
            </div>
          )}
          {approval.cwd && (
            <div>
              <dt>Working directory</dt>
              <dd>{approval.cwd}</dd>
            </div>
          )}
          {approval.reason && (
            <div>
              <dt>Reason</dt>
              <dd>{approval.reason}</dd>
            </div>
          )}
        </dl>
        {!approval.command && !approval.filePath && !approval.reason && <p className="approval-message">{approval.message}</p>}
        <div className="approval-actions">
          <button type="button" onClick={onDeny} disabled={isResponding}>
            拒否
          </button>
          <button type="button" className="primary" onClick={onApprove} disabled={isResponding}>
            {isResponding ? "送信中..." : "承認"}
          </button>
        </div>
      </section>
    </div>
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
    case "approval":
      return "Approval";
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
  setSettings
}: {
  settings: ProviderSettings;
  setSettings: React.Dispatch<React.SetStateAction<ProviderSettings>>;
}) {
  const [fileOpenStatus, setFileOpenStatus] = useState("");

  async function openCodexFile(kind: "config" | "agents") {
    setFileOpenStatus("開いています...");
    try {
      const path = kind === "config" ? await openCodexDefaultConfig() : await openCodexDefaultAgents();
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

      <section className="settings-category" aria-labelledby="codex-default-settings-title">
        <h3 id="codex-default-settings-title">Codex</h3>

        <div className="setting-group">
          <h4>デフォルト</h4>
          <label className="field">
            <span>モデル</span>
            <select
              value={settings.model}
              onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}
            >
              {codexModelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>推論レベル</span>
            <select
              value={settings.reasoningEffort}
              onChange={(event) => setSettings((current) => ({ ...current, reasoningEffort: event.target.value }))}
            >
              {codexReasoningOptions.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="settings-category" aria-labelledby="codex-file-settings-title">
        <h3 id="codex-file-settings-title">Codex ファイル</h3>

        <div className="setting-group">
          <h4>プロジェクト用デフォルト</h4>
          <div className="settings-action-grid">
            <button type="button" onClick={() => void openCodexFile("config")}>
              config.toml
            </button>
            <button type="button" onClick={() => void openCodexFile("agents")}>
              AGENTS.md
            </button>
          </div>
          <p className="settings-note">
            プロジェクトを開くと、未作成の場合に `.codex/config.toml` と `AGENTS.md` へコピーします。
          </p>
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
      model: defaultSettings.model,
      reasoningEffort: defaultSettings.reasoningEffort,
      endpoint: defaultSettings.endpoint
    };
  }

  return {
    ...settings,
    reasoningEffort: settings.reasoningEffort ?? defaultSettings.reasoningEffort
  };
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
