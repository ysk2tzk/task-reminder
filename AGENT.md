# AGENT.md

## 1. この文書の位置づけ

`AGENT.md` は、このリポジトリの実装仕様書です。
人間向けの基本設計は `実行支援.md` を正本とし、ここではコードに落とすための具体ルールを扱います。

## 2. 優先順位

1. `実行支援.md` の基本設計との整合
2. 既存 DB 構造との互換性
3. 通知・履歴・同期の正しさ
4. Vercel 本番とローカル確認の一貫性
5. UI の見た目や補助機能

## 3. 実装構成

### 3.1 フロントエンド

- `index.html` + `app.js` + `styles.css` のシングルページ構成
- 画面遷移は hash routing を使う
- 主要画面は `home / tasks / create / edit / settings`

### 3.2 サーバー API

- `api/` 配下に HTTP エンドポイントを置く
- ローカルでは `scripts/dev-server.mjs` で静的配信と API をまとめて起動する
- 本番では Vercel Functions として動かす

### 3.3 データ保存

- データの正本は Supabase
- クライアントのローカル状態は編集用キャッシュであり、保存時にサーバーと同期する

## 4. データモデル実装方針

### 4.1 `tasks`

主な責務:

- タスク自体の定義を持つ
- `schedule_type` は `once / daily / weekly`
- 無効化は `is_active = false` で表現する

主要項目:

- `title`
- `description`
- `schedule_type`
- `scheduled_date`
- `scheduled_time`
- `weekdays`
- `reminder_interval_minutes`
- `is_active`

### 4.2 `task_occurrences`

主な責務:

- 予定単位の進行状態を持つ
- 通知タイミングを持つ
- Google Calendar 連携結果を持つ

主要項目:

- `task_id`
- `scheduled_at`
- `status`
- `next_notification_at`
- `completed_at`
- `skipped_at`
- `google_event_id`
- `calendar_synced_at`
- `calendar_sync_error`

状態ルール:

- 開始状態は `pending`
- `pending` から `completed`、`skipped`、または `expired` に遷移する
- `expired` は日次・週次タスクの次回予定到来時点で、前回分が未完了なら自動遷移する
- `completed`、`skipped`、`expired` は履歴として保持し、再計算で消さない

### 4.3 `push_subscriptions`

- `endpoint` 単位で一意に扱う
- 重複登録は upsert で吸収する

### 4.4 `app_settings`

- Google Calendar 接続情報を保持する
- 現行実装に合わせ、単一設定レコード前提で扱う

## 5. 状態同期

### 5.1 基本方式

- 取得は `GET /api/state`
- 保存は `POST /api/state`
- 同期対象は `tasks`、`task_occurrences`、`app_settings` の一部

### 5.2 同期の考え方

- 画面単位 API より、アプリ全体状態の同期を優先する
- クライアント側で編集した結果を保存時に upsert する
- 読み込み時に occurrence 補完が発生した場合は、必要に応じて自動保存する

## 6. occurrence 生成ルール

### 6.1 生成範囲

- `task_occurrences` は無制限に作らない
- 現在日から 7 日先までを生成対象とする
- 実装定数は `OCCURRENCE_WINDOW_DAYS = 7`

### 6.2 スケジュール別ルール

- `once`: 指定日・指定時刻の 1 件を生成する
- `daily`: 対象期間内の毎日分を生成する
- `weekly`: 指定曜日かつ対象期間内の日付分を生成する

### 6.3 初期値

- 新規 `occurrence` の `status` は `pending`
- `next_notification_at` は初回は `scheduled_at`

### 6.4 再計算

- タスク登録時に対象 occurrence を生成する
- タスク更新時に future/pending occurrence を再計算する
- タスク無効化時は future/pending occurrence を削除または非対象化する
- `completed` と `skipped` の履歴は削除しない

## 7. 画面別の実装仕様

### 7.1 ホーム

表示条件:

- `pending` のみ対象
- 対象タスクが `is_active = true`

表示グループ:

- 超過中: `scheduled_at <= now`
- 今日これから: `scheduled_at > now` かつ当日分のみ

並び順:

- どちらも `scheduled_at ASC`

操作:

- 完了
- スキップ
- 再読み込み

### 7.2 タスク一覧

- 有効タスクを先頭に表示する
- 同一グループ内では作成日時降順
- 有効・無効の両方を表示する
- 1 ページ 10 件を基本とする

### 7.3 タスク登録・編集

入力ルール:

- `once`: 日付と時刻が必須
- `daily`: 時刻が必須
- `weekly`: 曜日と時刻が必須
- 通知間隔は分単位で扱う

更新ルール:

- 実行条件変更時は pending occurrence を再計算する
- 無効化しても履歴は残す

### 7.4 設定

- Google Calendar 接続状態を表示する
- Push 購読状態を表示する
- テスト通知を送れる
- Google Calendar 接続確認やテスト登録を行える

## 8. 操作時の更新仕様

### 8.1 タスク完了

- 対象 occurrence を `completed` に更新する
- `completed_at` を記録する
- 再通知を停止する
- Google Calendar 接続済みなら同期対象にする

### 8.2 タスクスキップ

- 対象 occurrence を `skipped` に更新する
- `skipped_at` を記録する
- 再通知を停止する
- Google Calendar には登録しない

## 9. Push 実装仕様

### 9.1 基本

- Web Push + Service Worker (`sw.js`) を利用する
- 通知クリック時は `/#/home` を開く

### 9.2 API

- `GET /api/state?view=public-config`
  - VAPID 公開鍵
  - Push 利用可否
- `POST /api/push-subscriptions`
  - 購読情報を登録する
- `POST /api/push-test`
  - テスト通知を送る

### 9.3 配信エラー

- Push 送信先が `404` または `410` を返した場合は購読を削除する

## 10. 定刻通知・再通知

### 10.1 実行入口

- `GET /api/jobs-dispatch` を外部 Cron から呼び出す

### 10.2 通知対象

以下を満たす occurrence を対象にする。

```text
status = pending
AND next_notification_at <= 現在日時
AND tasks.is_active = true
```

### 10.3 送信後更新

- 通知送信後、`next_notification_at` を通知間隔ぶん進める
- `completed`、`skipped`、または `expired` に変わったものは以降送信しない

## 11. Google Calendar 実装仕様

### 11.1 同期対象

- `completed` のみ
- `skipped` は同期しない

### 11.2 登録内容

- タイトル: タスク名
- 開始日時: `completed_at`
- 説明: 予定日時、完了日時、補足説明

### 11.3 同期結果の保持

- 成功時は `google_event_id` と `calendar_synced_at` を更新する
- 失敗時は `calendar_sync_error` に理由を保持する

## 12. API・環境変数

### 12.1 必須環境変数

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### 12.2 Push 有効化に必要

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

### 12.3 Cron 保護

- `CRON_SECRET`
- `CRON_SECRET` がある場合、`/api/jobs-dispatch` は `Authorization: Bearer <CRON_SECRET>` か `x-vercel-cron` で認証する

### 12.4 Google OAuth

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`

## 13. オフライン・PWA

- `manifest.webmanifest` と `sw.js` を持つ
- app shell はキャッシュできる
- 更新系 API はオンライン前提
- 完全なオフライン編集同期は対象外

## 14. 変更ルール

- 基本設計を変える場合は、先に `実行支援.md` を更新する
- 実装ルールを変える場合は `AGENT.md` を更新する
- DB 変更時は `実行支援_DDL.sql` とコードを同時に見直す
- API 変更時は `README.md` の確認手順も更新する
- ユーザーからコミットを依頼された場合は、コミット対象の変更内容が `AGENT.md` または `実行支援.md` に反映すべきものかを確認し、必要なら先に文書へ反映してからコミットする
- コミットメッセージは日本語で記述する

## 15. 会話運用ルール

### 15.1 相談と実装依頼の区別

- ユーザーが「できる？」「可能？」「どうする？」「方針は？」のように相談や可否確認をしている段階では、原則として実装に着手しない
- 「前回修正したにもかかわらず同じエラーが発生している」のような障害報告は、原因調査・状況説明の依頼として扱い、修正依頼とはみなさない
- この段階では、実現可否、想定方針、影響範囲、選択肢の整理までを行う

### 15.2 実装を開始する条件

- ユーザーが「やって」「作成して」「修正して」「追加して」など、実作業を明示的に依頼したときに実装へ進む
- 相談の流れであっても、実装意思が明確でない場合はコード変更を始めない
- 明示的な実装依頼がない場合、調査の結果として修正が必要と判断しても、変更前に修正してよいかユーザーへ確認する

### 15.3 相談段階で許容する作業

- 既存コードや既存文書の調査
- 実装案の提示
- 影響箇所の洗い出し
- 必要に応じた軽微な文書整理

### 15.4 避けること

- 可否確認の問いに対して、そのままコード変更まで進めること
- ユーザーの合意がないまま仕様変更を前提に実装すること
