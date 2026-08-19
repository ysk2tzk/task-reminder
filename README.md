# task-reminder

`実行支援.md` を人間向けの基本設計書、`AGENT.md` を実装仕様書として使い分ける、PWA + Vercel + Supabase 前提のタスクリマインダーです。

## できること

- タスク登録・編集・有効/無効切り替え
- `once / daily / weekly` に応じた予定生成
- ホームで超過中タスクと今日これからのタスクを表示
- 完了 / スキップの履歴管理
- Web Push 購読登録と Service Worker 受信
- PWA manifest / Service Worker 対応
- 外部 Cron からの定刻・再通知送信

## 前提

- データの正本は Supabase
- Google Calendar は OAuth 接続済みの場合に完了実績を登録します
- Web Push を本番利用するには `.env.example` の環境変数設定が必要

## 起動

ローカル確認だけなら静的ファイル配信でUIは動きます。例:

```bash
npm run serve:static
```

その後 `http://localhost:4173` を開いてください。

ただしこの方法では `api/` が動かないため、保存・Push・外部 Cron のデバッグはできません。

Web Push や API を含めて動かす場合は、ローカルで `Vercel dev` を使います。

## ローカルデバッグ手順

### 1. 依存関係を入れる

```bash
npm install
```

### 2. Supabase にテーブルを作る

Supabase SQL Editor で [実行支援_DDL.sql](/home/netforce/task-reminder/実行支援_DDL.sql:1) を実行してください。

### 3. 環境変数を用意する

`.env.example` をもとに `.env.local` を作成します。

```bash
cp .env.example .env.local
```

最低限必要なのは次です。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `CRON_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

VAPID 鍵は次で生成できます。

```bash
npx web-push generate-vapid-keys
```

### 4. ローカル起動する

反復デバッグは、まずローカル専用サーバーを使うのがおすすめです。

```bash
npm run dev:local
```

これは `.env.local` を直接読み込み、静的ファイルと `api/*` をまとめて `http://localhost:3000` で起動します。

Vercel 本番挙動に寄せて確認したい場合は、次も使えます。

```bash
npx vercel dev
```

または:

```bash
npm run dev:vercel
```

起動後は `http://localhost:3000` を開きます。

## デバッグの進め方

### 最初に確認する順番

1. `GET /api/public-config` が返る
2. `GET /api/state` が返る
3. 画面からタスク登録できる
4. Supabase に `tasks` と `task_occurrences` が入る
5. 完了・スキップで状態更新できる
6. Push 購読できる
7. `jobs-dispatch` を手動実行して再通知を確認する

### 手動で叩くと便利な API

```bash
curl http://localhost:3000/api/public-config
curl http://localhost:3000/api/state
curl -X POST http://localhost:3000/api/push-test \
  -H "Content-Type: application/json" \
  -d '{"title":"実行支援のテスト通知","body":"ローカルデバッグ中です。"}'
curl -X GET http://localhost:3000/api/jobs-dispatch \
  -H "Authorization: Bearer replace-with-a-long-random-string"
```

`jobs-dispatch` の `Authorization` は `.env.local` の `CRON_SECRET` に合わせてください。

### ブラウザで見る場所

- `Console`
  - フロントエンドの例外
- `Network`
  - `/api/state` の保存失敗
  - `/api/push-subscriptions` の登録失敗
  - `/api/push-test` の送信失敗
- `Application`
  - Service Worker の登録状態
  - Push Subscription の有無
  - Notification 権限

### 症状別の見方

- 画面は出るが保存できない
  - `POST /api/state` のレスポンス
  - `vercel dev` 側ログ
  - Supabase のテーブル定義差分
- 通知権限は許可したのに Push が来ない
  - `GET /api/public-config`
  - `POST /api/push-subscriptions`
  - `push_subscriptions` テーブル
  - ブラウザの Service Worker 状態
- 再通知されない
  - `task_occurrences.status`
  - `task_occurrences.next_notification_at`
  - `GET /api/jobs-dispatch` の返却値
  - 旧不具合で同一 `task_id + scheduled_at` の重複 row が残っている場合は `node scripts/cleanup-occurrence-duplicates.mjs` で整理する
- 完了時に Google Calendar が同期されない
  - 設定画面で Google Calendar が接続済みか確認する
  - `app_settings.google_refresh_token` が保存されているか確認する
  - `task_occurrences.google_event_id` と `calendar_sync_error` を確認する

### ローカル開発時の通知仕様

- `pushSupported: true` のとき
  - Web Push を使います
  - 購読登録と `jobs-dispatch` 実行が必要です
- `pushSupported: false` のとき
  - ページを開いたままなら、通知権限を使ったローカル通知で確認できます
  - この補助通知は `npm run dev:local` での反復デバッグ向けです
  - 起動時点で古い `pending` 通知が溜まっていても、即時一括通知せず次回スロットへ繰り延べます
  - ページを閉じている間のバックグラウンド通知は行いません

## Web Push 構成

- `GET /api/public-config`
  - VAPID 公開鍵を返します
- `GET /api/state`
  - Supabase 上の `tasks / task_occurrences / app_settings` を返します
  - 読み込み前に `task_occurrences` の重複 row を自動整理します
- `POST /api/state`
  - フロントの状態を Supabase に同期します
- `POST /api/push-subscriptions`
  - `push_subscriptions` に購読情報を登録します
- `POST /api/push-test`
  - 最新の購読先へテスト通知を送ります
- `GET /api/jobs-dispatch`
  - `cron-job.org` または手動実行で呼び出し、期限到来した pending タスクを再通知します
- `GET /api/google-calendar-connect`
  - Google OAuth の開始 URL を返します
- `GET /api/google-calendar-callback`
  - OAuth code を交換して `app_settings` に保存します
- `POST /api/google-calendar-test`
  - 接続済み Calendar にテストイベントを登録します
- `POST /api/google-calendar-disconnect`
  - Google Calendar 接続情報を解除します

## 必要な環境変数

`.env.example` を参照してください。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `CRON_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

## 本番 Push セットアップ

本番 Push を有効にするには次の環境変数が必要です。

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `CRON_SECRET`

### 1. VAPID 鍵を作る

```bash
npx web-push generate-vapid-keys
```

### 2. Vercel の環境変数に登録する

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`
- `CRON_SECRET`

### 3. デプロイ後に設定画面で確認する

- `Push 通知状態` の `サーバー連携` が `有効`
- `モード` が `本番 Push`
- `不足している環境変数` が表示されない
- `通知を購読する` ボタンが出る

### 4. 購読登録する

- 端末で設定画面を開く
- `通知を購読する` を押す
- ブラウザ通知を許可する

### 5. テスト通知する

- 設定画面の `テスト通知` を押す
- 必要なら API でも確認する

```bash
curl -X POST https://<your-domain>/api/push-test \
  -H "Content-Type: application/json" \
  -d '{"title":"実行支援のテスト通知","body":"本番 Push の確認です。"}'
```

### 6. 定刻通知を確認する

- `cron-job.org` が `/api/jobs-dispatch` を 5 分おきに実行します
- `pending` かつ `next_notification_at <= 現在時刻` の occurrence が通知対象です
- 手動確認する場合は次を使えます

```bash
curl -X GET https://<your-domain>/api/jobs-dispatch \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## cron-job.org で 5 分 Cron を動かす

2026年8月12日時点では、Vercel Hobby の Cron は 1 日 1 回までです。  
そのため、このプロジェクトでは無料の外部 Cron として `cron-job.org` を使い、5 分おきに `/api/jobs-dispatch` を叩く運用を前提にしています。

### 1. Vercel を先にデプロイする

まず本体アプリを Vercel にデプロイします。

```bash
npx vercel --prod
```

デプロイ後の URL を控えます。例:

```text
https://task-reminder.vercel.app
```

### 2. cron-job.org でジョブを作る

必要なのは次の 2 つです。

- `DISPATCH_BASE_URL`
  例: `https://task-reminder.vercel.app`
- `CRON_SECRET`
  Vercel 側に設定したものと同じ値

`cron-job.org` で新しい Cron job を作成し、次を設定します。

- URL
  - `https://<your-domain>/api/jobs-dispatch`
- Method
  - `GET`
- Headers
  - `Authorization: Bearer <CRON_SECRET>`
- Schedule
  - 5 分ごと

### 3. 動作確認する

作成後に `Run now` 相当の手動実行ができる場合は、それで疎通確認するのがおすすめです。

レスポンスが `200` で、本文に `dispatchedOccurrences` と `sentCount` が返れば動作確認できます。

### 4. API を手動で叩いて確認する

必要なら、直接次でも確認できます。

```bash
curl -X GET https://<your-domain>/api/jobs-dispatch \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## Google Calendar セットアップ

### 1. Google Cloud で OAuth クライアントを作成する

- Google Calendar API を有効化する
- OAuth 同意画面を設定する
- 認証済みリダイレクト URI に本番とローカルの callback を登録する

例:

- `http://localhost:3000/api/google-calendar-callback`
- `https://<your-domain>/api/google-calendar-callback`

### 2. 環境変数を設定する

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

ローカル確認時は、`.env.local` の `GOOGLE_OAUTH_REDIRECT_URI` を `http://localhost:3000/api/google-calendar-callback` に合わせます。

### 3. 接続してテストする

- 設定画面を開く
- `Google で接続する` を押す
- Google ログインと同意を完了する
- `テスト登録` でイベント作成を確認する

## 補足

- 初回は Supabase 上のデータが空なら空画面で始まります
- `python`/静的配信では UI 確認のみ、`vercel dev` または `npm run dev:vercel` では API を含めた挙動確認ができます
- ローカル反復デバッグは `npm run dev:local` が最も安定します
- 2026年8月12日時点で Vercel Hobby の Cron は 1日1回制限です
- `cron-job.org` は無料で 5 分ごとの HTTP 実行に使えます
- Google Calendar の完了同期は `POST /api/state` 保存後にサーバー側で実行します
