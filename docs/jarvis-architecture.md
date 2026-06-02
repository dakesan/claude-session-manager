# Jarvis Architecture — CSM の上に音声駆動の自律オーケストレーターを作る

> CSM（Claude Session Manager）を「ジャービスの手足」として使い、その上に
> 「耳・口・脳」を乗せて、音声で自律的に Claude Code セッションを起動・統括する
> システムを構築するための設計ドキュメント。

## 0. 背景：CSM がすでに提供しているもの

CSM は本設計の **実行基盤（手足）** に相当する。新規に作るのは「耳・口・脳」だけでよい。

CSM が提供済みの能力：

- tmux 上で `claude --session-id <uuid> --remote-control` を起動し、セッションを管理
- セッションのライフサイクル管理（作成 / 停止 / respawn / restore / 削除）
- REST API と **MCP サーバー** による完全なプログラム操作
- cron ベースのスケジューラ（定時にセッションを起動）
- 複数マシンのセッションを1つのダッシュボードに集約（マルチノード）
- メッセージ送信・ファイル添付・トランスクリプト取得

重要な設計的含意：CSM は **「Claude が Claude を管理する」** ことを前提に作られている
（MCP に `create_session` / `message` 等が露出している）。Jarvis 役の Claude に
CSM MCP を渡すだけで、自分の判断で子セッションを起こし・指示し・回収できる。

## 1. 全体像：4層アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  🎙️ Voice I/O 層   ウェイクワード/STT/TTS    │ ← 新規
├─────────────────────────────────────────────┤
│  🧠 Orchestrator 層  (Jarvis本体 = Claude)   │ ← 新規（中心）
│     ・意図理解  ・計画  ・セッション統括      │
├─────────────────────────────────────────────┤
│  🔌 CSM API/MCP 層   (既存・そのまま使う)     │
│     create/message/stop/schedules ...        │
├─────────────────────────────────────────────┤
│  🦾 tmux + Claude Code セッション群 (手足)    │
└─────────────────────────────────────────────┘
```

データフロー（1コマンドの往復）：

```
発話 → ウェイクワード検出 → STT → テキスト
     → Orchestrator が意図分類・計画
     → CSM API/MCP 呼び出し（子セッション起動 or 指示）
     → 子セッションが作業（tmux 内の Claude Code）
     → トランスクリプト取得 → 音声向けに要約 → TTS → 発話
```

## 2. 各層の設計

### 2.1 🎙️ Voice I/O 層

束ねる常駐プロセス（Python 推奨）が「音声 ⇄ テキスト」を担当し、
テキスト化したコマンドを Orchestrator に渡す。

| 機能 | 推奨候補 | 備考 |
|---|---|---|
| ウェイクワード | openWakeWord / Picovoice Porcupine | "Jarvis" のカスタムワード作成可。ローカル常時待受 |
| STT | whisper.cpp（ローカル）/ Deepgram Nova / OpenAI | 日本語なら Whisper large-v3 か Deepgram |
| TTS | ElevenLabs / OpenAI TTS / VOICEVOX | VOICEVOX は日本語キャラ声・ローカル |

UX 上の注意：

- **割り込み（barge-in）** … TTS 読み上げ中にユーザーが話し始めたら停止できること。
- **PTT フォールバック** … 初期はウェイクワード無しのボタン押し（Push-To-Talk）で十分。

### 2.2 🧠 Orchestrator 層（新規開発の中心）

「ジャービスの脳」。2つの実装ルートがある。

| ルート | 中身 | 向き |
|---|---|---|
| **A. CSMセッションとして動かす** | Jarvis用プロンプト＋CSM MCP を持った常駐 Claude Code セッションを1本 | 最速 MVP・コード最小 |
| **B. 独立サービスとして書く** | Claude Agent SDK で常駐サービスを書き、CSM の REST を叩く | 自律ループ・割り込み制御を作り込む |

Orchestrator の責務：

1. **意図分類** … 「新規タスク起動」／「既存セッションへの指示」／「状況報告要求」
   ／「雑談・即答」のいずれか。
2. **セッション統括** … 下記 CSM API を用いる。
3. **音声向け要約** … 子のトランスクリプトは長い。TTS の前に必ず
   「2文に要約」する整形ステップを挟む（音声 UX の肝）。

利用する CSM エンドポイント（既存）：

| 目的 | API |
|---|---|
| 子セッション起動 | `POST /api/sessions` `{prompt, name?, cwd?, model?}` → `rcUrl` |
| 指示を送る | `POST /api/sessions/:id/message` |
| 状態一覧 | `GET /api/sessions?lifecycle=active` |
| 結果取得 | `GET /api/sessions/:id/transcript` |
| 停止 | `POST /api/sessions/:id/stop` |
| 定時起動 | `POST /api/schedules` |

MCP 経由なら同等のツール（`create_session`, `message`(send), `list_sessions`,
`get_logs`, `create_schedule` ...）がそのまま使える。

### 2.3 🔁 自律性（プロアクティブ・ループ）

「自律的に立ち上げる／報告する」の核。

- **定時トリガ** … CSM の cron スケジューラを利用。
  例：「毎朝9時に Jarvis にデイリーブリーフを生成させる」を `POST /api/schedules`。
- **状態変化トリガ** … CSM は現状 push イベントを持たないため、Orchestrator が
  `GET /api/sessions` を数十秒間隔でポーリングし、`working → waiting`
  （子が完了 / 確認待ち）を検知 → 「Aのタスク終わりました、結果は〜」と
  能動的に音声通知する。

> 将来 push 化したい場合は CSM 側に lifecycle webhook を1本足すのが最も効く（§4 参照）。

## 3. 段階導入計画

いきなり全部作らない。脳と手足の接続を最初に検証する。

| Phase | 内容 | 目的 |
|---|---|---|
| **Phase 0**（半日） | CSM MCP を入れた「Jarvis セッション」を1本立て、テキストで「〜を別セッションで始めて」と頼み、子が起動することを確認 | 脳⇄手足の接続検証 |
| **Phase 1** | Phase 0 の入出力に STT + TTS を被せて音声化。ウェイクワード無し・PTT で十分 | 音声 I/O 確立 |
| **Phase 2** | ポーリング監視 ＋ 音声プロアクティブ通知（完了報告） | 自律報告 |
| **Phase 3** | ウェイクワード常時待受、スケジュール連携、マルチノード対応 | 常駐ジャービス化 |

## 4. CSM 側に足すと効く拡張（任意）

現状の CSM はポーリング前提だが、Jarvis 用途なら以下で体験が跳ねる。

- **Lifecycle Webhook** … `working → waiting/stopped` 遷移時に HTTP POST を飛ばす。
  実装位置：`src/scheduler.ts` / `src/claude-cli.ts` の状態遷移検知部
  （現状は `~/.claude/csm-logs/lifecycle.log` への記録のみ）。
  → ポーリング不要・即時音声通知が可能になる。
- **TTS 向け要約エンドポイント** … `GET /api/sessions/:id/summary`。
  直近トランスクリプトを N 文に要約して返す。読み上げ前処理をサーバー側に寄せる。

## 5. 既知の制約・考慮点

- **認証なし** … CSM は CORS/auth を持たず、ネットワーク層（Tailscale 等）で守る前提。
  Jarvis を常駐させるなら、Voice/Orchestrator ↔ CSM 間は信頼ネットワーク内に閉じる。
- **状態はプロセス由来** … セッション状態は PID 生存＋tmux 存在から導出される。
  内部ステートマシンではないため、状態検知はやや遅延しうる（RC URL 捕捉に最大 ~13s 等）。
- **イベントは pull** … push 通知機構は未実装。プロアクティブ通知はポーリングか §4 の webhook で実現。
- **トランスクリプトが真実の源** … 履歴は Claude ネイティブの JSONL（`~/.claude/projects/`）。
  要約・整形はこれを読んで行う。

## 6. まとめ

- 実行基盤（手足）は CSM がすでに提供済み。**新規開発は Voice I/O と Orchestrator の2層に集中**できる。
- 最速ルートは「CSM MCP を持った Jarvis セッションを1本立てる」こと（Phase 0）。
- 自律通知は当面ポーリングで実現し、必要になったら CSM に lifecycle webhook を追加する。
