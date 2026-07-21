import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CodexProgressEvent, CodexProjectTrustStatus, Message, OperationPreview, Provider } from "./types";

const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

export async function askProvider(
  input: string,
  provider: Provider,
  model: string,
  history: Message[] = [],
  projectPath?: string
) {
  if (!isTauri) {
    return localAnswer(input, provider, model);
  }

  try {
    return await invoke<string>("ask_provider", { input, provider, model, history, projectPath });
  } catch (error) {
    return `Codex への送信に失敗しました。\n\n${String(error)}`;
  }
}

export async function pickProjectFolder() {
  if (!isTauri) {
    return null;
  }

  return await invoke<string | null>("pick_project_folder");
}

export async function getCodexProjectTrustStatus(rootPath: string) {
  return await invoke<CodexProjectTrustStatus>("get_codex_project_trust_status", { rootPath });
}

export async function setCodexProjectTrust(rootPath: string, trusted: boolean) {
  return await invoke<CodexProjectTrustStatus>("set_codex_project_trust", { rootPath, trusted });
}

export async function openCodexUserConfig() {
  return await invoke<string>("open_codex_user_config");
}

export async function openCodexUserAgents() {
  return await invoke<string>("open_codex_user_agents");
}

export async function resetCodexConversation() {
  if (!isTauri) {
    return;
  }

  try {
    await invoke("reset_codex_conversation");
  } catch {
    // Reset is best-effort; a failed reset should not block starting a new local UI thread.
  }
}

export async function onCodexProgress(handler: (event: CodexProgressEvent) => void) {
  if (!isTauri) {
    return () => {};
  }

  try {
    return await listen<CodexProgressEvent>("codex-progress", ({ payload }) => handler(payload));
  } catch {
    return () => {};
  }
}

export async function translateToJapanese(text: string) {
  if (!isTauri) {
    return localTranslate(text);
  }

  try {
    return await invoke<string>("translate_text", { text });
  } catch {
    return localTranslate(text);
  }
}

export async function planFileOperation(instruction: string) {
  if (!isTauri) {
    return localOperationPreview(instruction);
  }

  try {
    return await invoke<OperationPreview>("plan_file_operation", { instruction });
  } catch {
    return localOperationPreview(instruction);
  }
}

export async function captureScreenshotTranslation() {
  if (!isTauri) {
    return "スクリーンショット翻訳の流れを確認しました。デスクトップ版ではショートカットから範囲選択、OCR、和訳プレビューへ進みます。";
  }

  try {
    return await invoke<string>("capture_screenshot_translation");
  } catch {
    return "スクリーンショット翻訳の入口を開けませんでした。権限とデスクトップ実行環境を確認してください。";
  }
}

export async function startWindowDrag() {
  if (!isTauri) {
    return;
  }

  try {
    await getCurrentWindow().startDragging();
  } catch {
    // Dragging can fail when the pointer event was not initiated on a draggable surface.
  }
}

export async function onWindowFocusChanged(handler: (focused: boolean) => void) {
  if (!isTauri) {
    return () => {};
  }

  try {
    return await getCurrentWindow().onFocusChanged(({ payload }) => handler(payload));
  } catch {
    return () => {};
  }
}

function localAnswer(input: string, provider: Provider, model: string) {
  if (looksLikeFileInstruction(input)) {
    return "これはファイル操作の依頼に見えます。右側のプレビューで対象ファイルと操作内容を確認してから実行する設計です。MVP では実行せず、プレビューだけ表示します。";
  }

  if (looksLikeTranslation(input)) {
    return localTranslate(input);
  }

  return `Mado MVP は ${provider} / ${model} の設定で受け取りました。今は安全なローカル応答モードなので、短い質問とファイル操作プレビューの流れを確認できます。`;
}

function localTranslate(text: string) {
  const cleaned = text.trim();
  if (!cleaned) {
    return "翻訳するテキストを入力してください。";
  }

  return `日本語訳プレビュー:\n${cleaned}\n\n注: この MVP ではプロバイダー接続前のローカルプレビューとして表示しています。`;
}

function localOperationPreview(instruction: string): OperationPreview {
  return {
    summary: `「${instruction || "ファイル操作"}」のプレビューを作成します。`,
    source: "ローカルフォルダ",
    destination: undefined,
    action: looksDestructive(instruction) ? "delete" : "unknown",
    requiresConfirmation: true,
    warnings: ["ブラウザプレビューでは実ファイル一覧を読みません。Tauri 版で対象を確認します。"],
    files: []
  };
}

function looksLikeTranslation(value: string) {
  return /translate|翻訳|和訳|日本語/i.test(value);
}

function looksLikeFileInstruction(value: string) {
  return /move|copy|rename|delete|list|移動|コピー|リネーム|削除|一覧|ファイル|フォルダ/i.test(value);
}

function looksDestructive(value: string) {
  return /delete|remove|削除|消して/i.test(value);
}
