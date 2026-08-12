import crypto from "node:crypto";
import { createHttpError } from "./http.js";
import { getSupabaseAdmin } from "./supabase.js";
import { getRequiredEnv } from "./env.js";

const GOOGLE_AUTH_BASE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const GOOGLE_TEST_EVENT_DURATION_MINUTES = 15;

export function isGoogleCalendarConfigured() {
  return getMissingGoogleCalendarEnv().length === 0;
}

export function getMissingGoogleCalendarEnv() {
  return [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
  ].filter((name) => !process.env[name]);
}

export function createGoogleAuthUrl() {
  ensureGoogleCalendarConfigured();
  const state = createOAuthState();
  const params = new URLSearchParams({
    client_id: getRequiredEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: getRequiredEnv("GOOGLE_OAUTH_REDIRECT_URI"),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: GOOGLE_SCOPE,
    state,
  });
  return `${GOOGLE_AUTH_BASE_URL}?${params.toString()}`;
}

export async function exchangeCodeForStoredCalendar(code, state) {
  ensureGoogleCalendarConfigured();
  if (!code) {
    throw createHttpError(400, "Google OAuth の認可コードがありません。");
  }
  verifyOAuthState(state);

  const tokenData = await exchangeCodeForTokens(code);
  const settings = await getAppSettings();
  const refreshToken = tokenData.refresh_token || settings?.google_refresh_token;
  if (!refreshToken) {
    throw createHttpError(400, "refresh token を取得できませんでした。Google 側の同意画面をやり直してください。");
  }

  const accessToken = tokenData.access_token || await refreshGoogleAccessToken(refreshToken);
  const calendarId = settings?.google_calendar_id || await resolveDefaultCalendarId(accessToken);

  await saveGoogleCalendarSettings({
    googleCalendarId: calendarId,
    googleRefreshToken: refreshToken,
  });

  return { calendarId };
}

export async function disconnectGoogleCalendar() {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("app_settings")
    .upsert({
      singleton_key: true,
      google_calendar_id: null,
      google_refresh_token: null,
    }, { onConflict: "singleton_key" });
  if (error) {
    throw createHttpError(500, error.message);
  }
}

export async function createGoogleCalendarTestEvent() {
  const settings = await getStoredGoogleCalendarSettings();
  const startedAt = new Date();
  const event = buildCalendarEvent({
    summary: "実行支援 接続テスト",
    description: `Google Calendar 接続確認\n実行日時: ${startedAt.toLocaleString("ja-JP")}`,
    startedAt,
  });
  return insertCalendarEvent(settings, event);
}

export async function listWritableGoogleCalendars() {
  const settings = await getStoredGoogleCalendarSettings();
  const accessToken = await refreshGoogleAccessToken(settings.googleRefreshToken);
  const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList?minAccessRole=writer`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, payload.error?.message || "Google Calendar 一覧の取得に失敗しました。");
  }

  return (payload.items || [])
    .filter((item) => item?.id)
    .map((item) => ({
      id: item.id,
      summary: item.summary || item.id,
      description: item.description || "",
      primary: Boolean(item.primary),
      accessRole: item.accessRole || "",
    }));
}

export async function syncCompletedOccurrences(occurrences, tasksById) {
  const settings = await getStoredGoogleCalendarSettings({ allowDisconnected: true });
  const completed = (occurrences || []).filter((item) => (
    item.status === "completed"
      && item.completed_at
      && !item.google_event_id
  ));

  if (!completed.length) {
    return;
  }

  const supabase = getSupabaseAdmin();

  if (!settings) {
    for (const occurrence of completed) {
      await updateOccurrenceSyncStatus(supabase, occurrence.id, {
        calendar_sync_error: "Google Calendar 未接続のため未同期",
        calendar_synced_at: null,
        google_event_id: null,
      });
    }
    return;
  }

  for (const occurrence of completed) {
    const task = tasksById.get(occurrence.task_id);
    if (!task) {
      await updateOccurrenceSyncStatus(supabase, occurrence.id, {
        calendar_sync_error: "元タスクが見つからないため同期できませんでした。",
        calendar_synced_at: null,
        google_event_id: null,
      });
      continue;
    }

    try {
      const event = buildCalendarEvent({
        summary: `☑️ ${task.title}`,
        description: [
          task.description || "",
          `予定日時: ${formatGoogleEventDate(new Date(occurrence.scheduled_at))}`,
          `完了日時: ${formatGoogleEventDate(new Date(occurrence.completed_at))}`,
        ].filter(Boolean).join("\n"),
        startedAt: new Date(occurrence.completed_at),
      });

      const created = await insertCalendarEvent(settings, event, occurrence.id);
      await updateOccurrenceSyncStatus(supabase, occurrence.id, {
        google_event_id: created.id,
        calendar_synced_at: new Date().toISOString(),
        calendar_sync_error: null,
      });
    } catch (error) {
      await updateOccurrenceSyncStatus(supabase, occurrence.id, {
        google_event_id: null,
        calendar_synced_at: null,
        calendar_sync_error: error instanceof Error ? error.message : "Google Calendar への同期に失敗しました。",
      });
    }
  }
}

async function insertCalendarEvent(settings, event, occurrenceId = "") {
  const accessToken = await refreshGoogleAccessToken(settings.googleRefreshToken);
  const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(settings.googleCalendarId)}/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      ...event,
      extendedProperties: occurrenceId ? {
        private: {
          taskReminderOccurrenceId: occurrenceId,
        },
      } : undefined,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, payload.error?.message || "Google Calendar へのイベント登録に失敗しました。");
  }
  return payload;
}

async function resolveDefaultCalendarId(accessToken) {
  const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList?minAccessRole=owner`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, payload.error?.message || "Google Calendar 一覧の取得に失敗しました。");
  }
  const primary = payload.items?.find((item) => item.primary) || payload.items?.[0];
  if (!primary?.id) {
    throw createHttpError(400, "登録先の Google Calendar が見つかりません。");
  }
  return primary.id;
}

async function exchangeCodeForTokens(code) {
  const body = new URLSearchParams({
    code,
    client_id: getRequiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: getRequiredEnv("GOOGLE_OAUTH_REDIRECT_URI"),
    grant_type: "authorization_code",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw createHttpError(response.status, payload.error_description || payload.error || "Google OAuth のトークン交換に失敗しました。");
  }
  return payload;
}

async function refreshGoogleAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: getRequiredEnv("GOOGLE_CLIENT_ID"),
    client_secret: getRequiredEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw createHttpError(response.status || 500, payload.error_description || payload.error || "Google のアクセストークン更新に失敗しました。");
  }
  return payload.access_token;
}

async function getAppSettings() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("google_calendar_id, google_refresh_token")
    .limit(1)
    .maybeSingle();
  if (error) {
    throw createHttpError(500, error.message);
  }
  return data;
}

async function getStoredGoogleCalendarSettings(options = {}) {
  const settings = await getAppSettings();
  if (!settings?.google_calendar_id || !settings?.google_refresh_token) {
    if (options.allowDisconnected) {
      return null;
    }
    throw createHttpError(400, "Google Calendar が未接続です。");
  }
  return {
    googleCalendarId: settings.google_calendar_id,
    googleRefreshToken: settings.google_refresh_token,
  };
}

async function saveGoogleCalendarSettings({ googleCalendarId, googleRefreshToken }) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("app_settings")
    .upsert({
      singleton_key: true,
      google_calendar_id: googleCalendarId,
      google_refresh_token: googleRefreshToken,
    }, { onConflict: "singleton_key" });
  if (error) {
    throw createHttpError(500, error.message);
  }
}

function buildCalendarEvent({ summary, description, startedAt }) {
  const endedAt = new Date(startedAt.getTime() + GOOGLE_TEST_EVENT_DURATION_MINUTES * 60 * 1000);
  return {
    summary,
    description,
    start: {
      dateTime: startedAt.toISOString(),
    },
    end: {
      dateTime: endedAt.toISOString(),
    },
  };
}

async function updateOccurrenceSyncStatus(supabase, occurrenceId, fields) {
  const { error } = await supabase
    .from("task_occurrences")
    .update(fields)
    .eq("id", occurrenceId);
  if (error) {
    throw createHttpError(500, error.message);
  }
}

function createOAuthState() {
  const payload = JSON.stringify({
    ts: Date.now(),
    nonce: crypto.randomBytes(12).toString("hex"),
  });
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = signState(encoded);
  return `${encoded}.${signature}`;
}

function verifyOAuthState(state) {
  const [encoded, providedSignature] = String(state || "").split(".");
  if (!encoded || !providedSignature) {
    throw createHttpError(400, "Google OAuth の state が不正です。");
  }

  const expectedSignature = signState(encoded);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw createHttpError(400, "Google OAuth の state 検証に失敗しました。");
  }

  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!payload?.ts || Date.now() - payload.ts > 10 * 60 * 1000) {
    throw createHttpError(400, "Google OAuth の state が期限切れです。");
  }
}

function signState(encodedPayload) {
  return crypto
    .createHmac("sha256", getRequiredEnv("GOOGLE_CLIENT_SECRET"))
    .update(encodedPayload)
    .digest("base64url");
}

function ensureGoogleCalendarConfigured() {
  const missing = getMissingGoogleCalendarEnv();
  if (missing.length) {
    throw createHttpError(500, `Google Calendar 連携に必要な環境変数が不足しています: ${missing.join(", ")}`);
  }
}

function formatGoogleEventDate(value) {
  return value.toLocaleString("ja-JP");
}
