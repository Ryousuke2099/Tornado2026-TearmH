# Tornado2026 交換日記(写真→AI動画化)プロトタイプ

Tornado2026(チーム「トルネードポテト」)の「夜行性アプリ」内、伊熊涼介・星野愛喜担当パートの実装。
技術方針の詳細は KarpathyVault の `wiki/hackathon/tornado2026/video-pipeline-tech-stack.md` を参照。

## 構成

- `frontend/` — Next.js。写真アップロードUI、生成された動画のプレビュー。
- `video-service/` — Node.js(Express) + FFmpeg(`fluent-ffmpeg` + `ffmpeg-static`)。
  写真を受け取り、クロップ・ズーム・カット割りして予告編風のmp4を生成するAPI。

## 開発の進め方(2026-08-29までのプロトタイプ検証に向けて)

1. `video-service` を先に動かす(フロントなしでcurlで動画生成を確認できる状態にする)。
2. `frontend` から `video-service` の `/generate` を呼び、アップロード→プレビューの一連の流れを繋ぐ。
3. AIによるスタイル選定(JSONパラメータ出力)を実装済み。写真を見てテンポ・色味・ズーム強さ・
   人物/背景の重み付け・SEの雰囲気を選び、FFmpeg側はその値通りに機械的に動画を組み立てる
   (`video-service/src/pipeline/selectStyle.js`)。

## セットアップ

```bash
cd video-service && npm install
cd ../frontend && npm install
```

`ffmpeg-static` がバイナリを同梱するため、システムに別途 ffmpeg をインストールする必要はない。

`video-service/.env.example` を `video-service/.env` にコピーし、`GEMINI_API_KEY`(無料枠あり、優先)または
`ANTHROPIC_API_KEY` を設定するとAIによるスタイル選定が有効になる(`GEMINI_API_KEY`→`ANTHROPIC_API_KEY`の順で
使う)。どちらも未設定でも動画生成自体は失敗せず、固定のデフォルトスタイルにフォールバックする。

## 起動

```bash
# video-service (デフォルト port 4000)
cd video-service && npm run dev

# frontend (デフォルト port 3000, video-serviceのURLは .env.local で指定)
cd frontend && npm run dev
```
