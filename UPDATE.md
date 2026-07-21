# UPDATE

## ver 0.1.3

- Mado 用のテキストなしアイコンを追加。
- ダークモード向け、ライトモード向け、アプリ本体向けの PNG/SVG と Windows 用 ICO を作成。
- アイコン確認用の `docs/ICON.md` と `docs/assets/icons/` を追加。

## ver 0.1.2

- Vite の開発サーバーが Tauri/Rust の生成物を監視しないようにし、Windows で `mado_lib.dll` がロック中に `EBUSY` で落ちる問題を修正。
- `Ctrl+Alt+M` が既に登録済みの場合でも、アプリ本体は起動を続けるように修正。

## ver 0.1.1

- アプリ実装を `app/` 配下へ移動し、ルート直下をドキュメントとリポジトリ管理ファイル中心に整理。
- `app/src/` に React + TypeScript UI、`app/src-tauri/` に Tauri + Rust 側を集約。
- README に新しいプロジェクト構成と開発コマンドの場所を追記。
- Windows 向けにルート直下から起動できる `start-mado.bat` を追加。

## ver 0.1.0

- README の MVP に沿って Tauri + React + TypeScript の初期アプリを作成。
- 小型デスクトップウィンドウ、チャット入力、応答エリア、短いローカル履歴を追加。
- OpenAI / Anthropic / OpenRouter / Ollama のプロバイダー設定画面を追加。
- テキスト、Markdown、HTML のファイル選択 / ドロップとプレビューを追加。
- 和訳ボタン、スクリーンショット翻訳の入口、安全なファイル操作プレビューを追加。
- Rust 側にローカル応答、翻訳プレビュー、ファイル操作プレビュー、`Ctrl+Alt+M` 表示 / 非表示ショートカットを追加。
- MVP 段階では実 AI 接続、OCR、破壊的なファイル操作の実行は未接続。安全のため操作実行ボタンは無効。
