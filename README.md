# Mado

Mado is a small desktop AI assistant for quick questions, lightweight file tasks, and everyday translation.

It is not intended to replace full AI coding or research apps. Mado is the small window you open when you want a short answer, a quick file operation, or an instant Japanese translation without switching context.

## Concept

Mado lives on the desktop as a compact, always-available assistant.

- Ask simple questions in one to three turns
- Translate English text, documents, and screenshots into Japanese
- Run simple natural-language file operations with confirmation
- Stay lightweight, fast, and visually calm
- Work well alongside Rainmeter, Flow Launcher, Codex, Claude, and other larger tools

## Initial Use Cases

### Quick Q&A

Use Mado for small questions that do not need a full chat workspace.

Examples:

- "このエラーはどういう意味?"
- "この英文を自然な日本語にして"
- "このコマンドの意味を短く説明して"

### File Translation

Drop or attach a file and translate it into Japanese.

Initial target formats:

- `.txt`
- `.md`
- `.pdf`
- `.docx`
- `.html`

Possible output formats:

- Japanese text preview
- Markdown export
- Translated copy next to the original file

### Screenshot Translation

Capture a screenshot, extract text, and translate it into Japanese.

Typical flow:

1. Press a global shortcut
2. Select a screen area or capture the current window
3. Mado extracts visible text
4. Mado shows a Japanese translation

### Natural-Language File Operations

Mado can help with small file tasks, but destructive or broad operations must require confirmation.

Examples:

- "Downloads の PDF を Documents に移動して"
- "このフォルダの画像を日付順に並べて"
- "最近ダウンロードした zip を一覧にして"
- "このファイル名を日本語にリネームして"

## Safety Model

Mado should never silently perform risky local operations.

Rules:

- Read-only operations can run directly when the target is clear
- File edits, moves, renames, and deletes require a preview
- Deletes require explicit confirmation
- Bulk operations require a file list before execution
- API keys are stored in the OS credential store when possible
- The assistant should show what it is about to do in plain language

Example confirmation:

```text
I will move 3 PDF files from Downloads to Documents/Reading.

- paper-a.pdf
- invoice-2026-07.pdf
- manual.pdf

Proceed?
```

## MVP

The first working version should include:

- Small desktop window
- Global shortcut to show/hide
- Text input and response area
- Provider setting for OpenAI / Anthropic / OpenRouter / local Ollama
- Short conversation history
- File drag-and-drop
- Text and Markdown translation
- Screenshot capture to Japanese translation
- Safe file operation preview

## Non-Goals

Mado should stay small.

It does not need to be:

- A full replacement for Codex, Claude Desktop, or ChatGPT
- A long-running agent workspace
- A full document editor
- A browser automation platform
- A complex project management tool

## Possible Tech Stack

Recommended:

- Tauri
- React
- TypeScript
- Rust sidecar commands for safe local file operations
- SQLite for local lightweight history

Alternative:

- Electron + React for faster prototyping
- Python backend for OCR and document processing

## 使用ライブラリ

| 種類 | ライブラリ / ツール | 用途 |
| --- | --- | --- |
| Desktop shell | Tauri 2 | 小さなデスクトップウィンドウ、透明/枠なしウィンドウ、トレイ常駐、Rust コマンド、アプリ設定 |
| Frontend | React 18 | チャット UI、設定パネル、ファイルプレビュー |
| Language | TypeScript | UI 実装の型安全性 |
| Build | Vite 8 | フロントエンド開発サーバーと本番ビルド |
| Icons | lucide-react | ボタンやパネルのアイコン |
| Tauri plugin | tauri-plugin-global-shortcut | `Ctrl+Alt+M` の表示 / 非表示ショートカット |
| Rust crates | serde / serde_json | Tauri コマンドの入出力データ整形 |
| Rust crates | rfd | ネイティブフォルダ選択ダイアログ |
| Rust crates | toml_edit | Codex user config の project trust 設定更新 |
| External tool | Codex CLI | `app-server --stdio` 経由の Codex agent 会話 |

## Project Structure

The app implementation lives under `app/`.

```text
app/
  src/        React + TypeScript UI
  src-tauri/ Tauri + Rust desktop shell
```

Run development commands from `app/`.

```bash
cd app
npm install
npm run dev
```

On Windows, you can also start the desktop app from the repository root.

```bat
start-mado.bat
```

## Architecture Sketch

```text
Desktop UI
  -> Chat input
  -> Response viewer
  -> File drop area
  -> Screenshot button

App Core
  -> Provider router
  -> Conversation state
  -> Translation pipeline
  -> File-operation planner

Local Tools
  -> File scanner
  -> Safe move/copy/rename
  -> Screenshot capture
  -> OCR

External AI Providers
  -> OpenAI
  -> Anthropic
  -> OpenRouter
  -> Ollama
```

## Design Direction

Mado should feel like a desktop utility, not a full web app.

- Compact by default
- Always-on-top option
- Dark and light themes
- Semi-transparent mode
- Keyboard-first interaction
- Minimal visual noise
- Clear confirmations for actions

## Roadmap

### Phase 1: Chat Window

- Basic Tauri shell
- Text prompt and streamed response
- Provider settings
- Global shortcut
- Local conversation history

### Phase 2: Translation

- Drag-and-drop file translation
- Markdown/text preview
- Screenshot capture
- OCR to Japanese translation

### Phase 3: File Operations

- Natural-language file intent parsing
- Preview before execution
- Move/copy/rename support
- Undo log for completed operations

### Phase 4: Desktop Polish

- Tray icon
- Always-on-top toggle
- Rainmeter-friendly compact theme
- Flow Launcher integration
- Optional clipboard watcher

## Name Notes

Mado means "window" in Japanese.

The name fits the goal: a small AI window on the desktop that opens only when needed.

Other candidate names:

- Komado
- Desklet AI
- QuickPane
- Hikari
- MiniPilot
