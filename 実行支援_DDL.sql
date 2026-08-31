-- 実行支援 / task-reminder
-- Supabase (PostgreSQL) DDL
-- MVP / 単一ユーザー前提

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- 1. tasks
-- =========================================================

CREATE TABLE IF NOT EXISTS public.tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    title text NOT NULL,
    description text,

    schedule_type text NOT NULL
        CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly')),

    scheduled_date date,
    monthly_day smallint
        CHECK (monthly_day BETWEEN 1 AND 31),
    scheduled_time time NOT NULL,

    weekdays smallint[],

    reminder_interval_minutes integer NOT NULL
        CHECK (reminder_interval_minutes > 0),

    is_active boolean NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tasks_schedule_consistency_check
    CHECK (
        (
            schedule_type = 'once'
            AND scheduled_date IS NOT NULL
            AND monthly_day IS NULL
            AND weekdays IS NULL
        )
        OR
        (
            schedule_type = 'daily'
            AND scheduled_date IS NULL
            AND monthly_day IS NULL
            AND weekdays IS NULL
        )
        OR
        (
            schedule_type = 'weekly'
            AND scheduled_date IS NULL
            AND monthly_day IS NULL
            AND weekdays IS NOT NULL
            AND cardinality(weekdays) > 0
        )
        OR
        (
            schedule_type = 'monthly'
            AND scheduled_date IS NULL
            AND monthly_day BETWEEN 1 AND 31
            AND weekdays IS NULL
        )
    ),

    CONSTRAINT tasks_weekdays_range_check
    CHECK (
        weekdays IS NULL
        OR weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
    )
);

COMMENT ON TABLE public.tasks IS 'タスク定義';
COMMENT ON COLUMN public.tasks.schedule_type IS 'once / daily / weekly / monthly';
COMMENT ON COLUMN public.tasks.weekdays IS '曜日指定。0=日, 1=月, 2=火, 3=水, 4=木, 5=金, 6=土';
COMMENT ON COLUMN public.tasks.reminder_interval_minutes IS '未完了時の再通知間隔（分）';
COMMENT ON COLUMN public.tasks.is_active IS 'タスクの有効/無効。削除は行わない';

-- 既存環境にも月次タスクの設定を追加する
ALTER TABLE public.tasks
    ADD COLUMN IF NOT EXISTS monthly_day smallint;

COMMENT ON COLUMN public.tasks.monthly_day IS '月次タスクの実行日。月末を超える場合はその月の最終日';

ALTER TABLE public.tasks
    DROP CONSTRAINT IF EXISTS tasks_schedule_type_check;

ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_schedule_type_check
    CHECK (schedule_type IN ('once', 'daily', 'weekly', 'monthly'));

ALTER TABLE public.tasks
    DROP CONSTRAINT IF EXISTS tasks_monthly_day_check;

ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_monthly_day_check
    CHECK (monthly_day IS NULL OR monthly_day BETWEEN 1 AND 31);

ALTER TABLE public.tasks
    DROP CONSTRAINT IF EXISTS tasks_schedule_consistency_check;

ALTER TABLE public.tasks
    ADD CONSTRAINT tasks_schedule_consistency_check
    CHECK (
        (
            schedule_type = 'once'
            AND scheduled_date IS NOT NULL
            AND monthly_day IS NULL
            AND weekdays IS NULL
        )
        OR
        (
            schedule_type = 'daily'
            AND scheduled_date IS NULL
            AND monthly_day IS NULL
            AND weekdays IS NULL
        )
        OR
        (
            schedule_type = 'weekly'
            AND scheduled_date IS NULL
            AND monthly_day IS NULL
            AND weekdays IS NOT NULL
            AND cardinality(weekdays) > 0
        )
        OR
        (
            schedule_type = 'monthly'
            AND scheduled_date IS NULL
            AND monthly_day BETWEEN 1 AND 31
            AND weekdays IS NULL
        )
    );


-- =========================================================
-- 2. task_occurrences
-- =========================================================

CREATE TABLE IF NOT EXISTS public.task_occurrences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id uuid NOT NULL
        REFERENCES public.tasks(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    scheduled_at timestamptz NOT NULL,

    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'skipped', 'expired')),

    next_notification_at timestamptz,

    completed_at timestamptz,
    skipped_at timestamptz,
    expired_at timestamptz,

    google_event_id text,
    calendar_synced_at timestamptz,
    calendar_sync_error text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT task_occurrences_status_consistency_check
    CHECK (
        (
            status = 'pending'
            AND completed_at IS NULL
            AND skipped_at IS NULL
        )
        OR
        (
            status = 'completed'
            AND completed_at IS NOT NULL
            AND skipped_at IS NULL
            AND next_notification_at IS NULL
        )
        OR
        (
            status = 'skipped'
            AND completed_at IS NULL
            AND skipped_at IS NOT NULL
            AND next_notification_at IS NULL
        )
        OR
        (
            status = 'expired'
            AND completed_at IS NULL
            AND skipped_at IS NULL
            AND expired_at IS NOT NULL
            AND next_notification_at IS NULL
        )
    ),

    CONSTRAINT task_occurrences_google_calendar_check
    CHECK (
        status = 'completed'
        OR (
            google_event_id IS NULL
            AND calendar_synced_at IS NULL
            AND calendar_sync_error IS NULL
        )
    )
);

COMMENT ON TABLE public.task_occurrences IS 'タスクの1回ごとの実行予定・実績';
COMMENT ON COLUMN public.task_occurrences.scheduled_at IS '本来の実行日時';
COMMENT ON COLUMN public.task_occurrences.status IS 'pending / completed / skipped / expired';
COMMENT ON COLUMN public.task_occurrences.next_notification_at IS '次にWeb Push通知を送る日時';
COMMENT ON COLUMN public.task_occurrences.completed_at IS '完了日時';
COMMENT ON COLUMN public.task_occurrences.skipped_at IS 'スキップ日時';
COMMENT ON COLUMN public.task_occurrences.google_event_id IS '完了実績として作成したGoogle CalendarイベントID';

-- 既存環境にも expired 状態を追加する
ALTER TABLE public.task_occurrences
    ADD COLUMN IF NOT EXISTS expired_at timestamptz;

COMMENT ON COLUMN public.task_occurrences.expired_at IS '次回予定到来により未完了扱いを終了した日時';

ALTER TABLE public.task_occurrences
    DROP CONSTRAINT IF EXISTS task_occurrences_status_check;

ALTER TABLE public.task_occurrences
    ADD CONSTRAINT task_occurrences_status_check
    CHECK (status IN ('pending', 'completed', 'skipped', 'expired'));

ALTER TABLE public.task_occurrences
    DROP CONSTRAINT IF EXISTS task_occurrences_status_consistency_check;

ALTER TABLE public.task_occurrences
    ADD CONSTRAINT task_occurrences_status_consistency_check
    CHECK (
        (
            status = 'pending'
            AND completed_at IS NULL
            AND skipped_at IS NULL
        )
        OR
        (
            status = 'completed'
            AND completed_at IS NOT NULL
            AND skipped_at IS NULL
            AND next_notification_at IS NULL
        )
        OR
        (
            status = 'skipped'
            AND completed_at IS NULL
            AND skipped_at IS NOT NULL
            AND next_notification_at IS NULL
        )
        OR
        (
            status = 'expired'
            AND completed_at IS NULL
            AND skipped_at IS NULL
            AND expired_at IS NOT NULL
            AND next_notification_at IS NULL
        )
    );


-- =========================================================
-- 3. push_subscriptions
-- =========================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    endpoint text NOT NULL UNIQUE,
    p256dh text NOT NULL,
    auth text NOT NULL,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_subscriptions IS 'Web Push通知先';
COMMENT ON COLUMN public.push_subscriptions.endpoint IS 'PushSubscription.endpoint';
COMMENT ON COLUMN public.push_subscriptions.p256dh IS 'PushSubscription公開鍵';
COMMENT ON COLUMN public.push_subscriptions.auth IS 'PushSubscription認証情報';


-- =========================================================
-- 4. app_settings
-- =========================================================

CREATE TABLE IF NOT EXISTS public.app_settings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    singleton_key boolean NOT NULL DEFAULT true
        UNIQUE
        CHECK (singleton_key = true),

    google_calendar_id text,
    google_refresh_token text,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.app_settings IS 'アプリ全体設定。単一ユーザーのため1レコードのみ';
COMMENT ON COLUMN public.app_settings.singleton_key IS '1レコード制約用。常にtrue';
COMMENT ON COLUMN public.app_settings.google_calendar_id IS '完了実績の登録先Google Calendar ID';
COMMENT ON COLUMN public.app_settings.google_refresh_token IS 'Google OAuth refresh token。クライアントから直接参照させない';


-- =========================================================
-- 5. Indexes
-- =========================================================

-- タスク一覧: 作成日時の降順
CREATE INDEX IF NOT EXISTS idx_tasks_created_at
    ON public.tasks (created_at DESC);

-- ホーム画面・通知処理: pendingの予定日時
CREATE INDEX IF NOT EXISTS idx_task_occurrences_pending_scheduled_at
    ON public.task_occurrences (scheduled_at)
    WHERE status = 'pending';

-- 再通知対象検索
CREATE INDEX IF NOT EXISTS idx_task_occurrences_pending_next_notification_at
    ON public.task_occurrences (next_notification_at)
    WHERE status = 'pending'
      AND next_notification_at IS NOT NULL;

-- 履歴画面: 完了日時の新しい順
CREATE INDEX IF NOT EXISTS idx_task_occurrences_completed_at
    ON public.task_occurrences (completed_at DESC)
    WHERE status = 'completed';

-- 履歴画面: スキップ日時の新しい順
CREATE INDEX IF NOT EXISTS idx_task_occurrences_skipped_at
    ON public.task_occurrences (skipped_at DESC)
    WHERE status = 'skipped';

-- タスクごとの実行履歴参照
CREATE INDEX IF NOT EXISTS idx_task_occurrences_task_id_scheduled_at
    ON public.task_occurrences (task_id, scheduled_at DESC);

-- 同一タスク・同一予定時刻の occurrence 重複を防止
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_occurrences_task_id_scheduled_at
    ON public.task_occurrences (task_id, scheduled_at);


-- =========================================================
-- 6. updated_at 自動更新
-- =========================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tasks_set_updated_at
    ON public.tasks;

CREATE TRIGGER trg_tasks_set_updated_at
BEFORE UPDATE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_task_occurrences_set_updated_at
    ON public.task_occurrences;

CREATE TRIGGER trg_task_occurrences_set_updated_at
BEFORE UPDATE ON public.task_occurrences
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_push_subscriptions_set_updated_at
    ON public.push_subscriptions;

CREATE TRIGGER trg_push_subscriptions_set_updated_at
BEFORE UPDATE ON public.push_subscriptions
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_app_settings_set_updated_at
    ON public.app_settings;

CREATE TRIGGER trg_app_settings_set_updated_at
BEFORE UPDATE ON public.app_settings
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();


-- =========================================================
-- 7. app_settings 初期レコード
-- =========================================================

INSERT INTO public.app_settings (singleton_key)
VALUES (true)
ON CONFLICT (singleton_key) DO NOTHING;

COMMIT;
