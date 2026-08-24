import { getSupabaseAdmin } from "./supabase.js";
import { createHttpError } from "./http.js";
import { syncCompletedOccurrences } from "./google-calendar.js";

const OCCURRENCE_WINDOW_DAYS = 30;
const JST_OFFSET_MINUTES = 9 * 60;

export function normalizeTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description || "",
    schedule_type: task.scheduleType,
    scheduled_date: task.scheduledDate || null,
    scheduled_time: task.scheduledTime,
    weekdays: task.scheduleType === "weekly" ? task.weekdays : null,
    reminder_interval_minutes: task.reminderIntervalMinutes,
    is_active: Boolean(task.isActive),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

export function normalizeOccurrence(item) {
  return {
    id: item.id,
    task_id: item.taskId,
    scheduled_at: item.scheduledAt,
    status: item.status,
    next_notification_at: item.nextNotificationAt || null,
    completed_at: item.completedAt || null,
    skipped_at: item.skippedAt || null,
    google_event_id: item.googleEventId || null,
    calendar_synced_at: item.calendarSyncedAt || null,
    calendar_sync_error: item.calendarSyncError || null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  };
}

export function deserializeTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    scheduleType: row.schedule_type,
    scheduledDate: row.scheduled_date || "",
    scheduledTime: normalizeTimeValue(row.scheduled_time),
    weekdays: row.weekdays || [],
    reminderIntervalMinutes: row.reminder_interval_minutes,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deserializeOccurrence(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    scheduledAt: row.scheduled_at,
    status: row.status,
    nextNotificationAt: row.next_notification_at,
    completedAt: row.completed_at,
    skippedAt: row.skipped_at,
    googleEventId: row.google_event_id || "",
    calendarSyncedAt: row.calendar_synced_at,
    calendarSyncError: row.calendar_sync_error || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function readState() {
  const supabase = getSupabaseAdmin();
  await ensurePendingOccurrences(supabase);
  const [{ data: tasks, error: taskError }, { data: occurrences, error: occurrenceError }, { data: settings, error: settingsError }] = await Promise.all([
    supabase.from("tasks").select("*").order("created_at", { ascending: false }),
    supabase.from("task_occurrences").select("*"),
    supabase.from("app_settings").select("*").limit(1).maybeSingle(),
  ]);

  if (taskError || occurrenceError || settingsError) {
    throw createHttpError(500, taskError?.message || occurrenceError?.message || settingsError?.message || "Supabase の読み込みに失敗しました。");
  }

  return {
    tasks: (tasks || []).map(deserializeTask),
    occurrences: (occurrences || []).map(deserializeOccurrence),
    settings: {
      googleCalendarConnected: Boolean(settings?.google_calendar_id && settings?.google_refresh_token),
      googleCalendarId: settings?.google_calendar_id || "",
      googleRefreshTokenMasked: settings?.google_refresh_token ? "configured" : "",
    },
  };
}

export async function syncState(payload) {
  if (!Array.isArray(payload?.tasks) || !Array.isArray(payload?.occurrences)) {
    throw createHttpError(400, "tasks と occurrences は配列で送ってください。");
  }

  const supabase = getSupabaseAdmin();
  const taskRows = payload.tasks.map(normalizeTask);
  const occurrenceRows = payload.occurrences.map(normalizeOccurrence);

  const { error: taskError } = await supabase
    .from("tasks")
    .upsert(taskRows, { onConflict: "id" });
  if (taskError) {
    throw createHttpError(500, taskError.message);
  }

  const { error: occurrenceError } = await supabase
    .from("task_occurrences")
    .upsert(occurrenceRows, { onConflict: "id" });
  if (occurrenceError) {
    throw createHttpError(500, occurrenceError.message);
  }

  const incomingPendingIds = occurrenceRows
    .filter((row) => row.status === "pending")
    .map((row) => row.id);

  if (incomingPendingIds.length) {
    const { error: cleanupError } = await supabase
      .from("task_occurrences")
      .delete()
      .eq("status", "pending")
      .not("id", "in", `(${incomingPendingIds.map((id) => `"${id}"`).join(",")})`);
    if (cleanupError) {
      throw createHttpError(500, cleanupError.message);
    }
  }

  const settingsPayload = payload.settings || {};
  const { error: settingsError } = await supabase
    .from("app_settings")
    .upsert({
      singleton_key: true,
      google_calendar_id: settingsPayload.googleCalendarId || null,
    }, { onConflict: "singleton_key" });
  if (settingsError) {
    throw createHttpError(500, settingsError.message);
  }

  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  await syncCompletedOccurrences(occurrenceRows, tasksById);

  return readState();
}

export async function ensurePendingOccurrences(supabase = getSupabaseAdmin()) {
  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, schedule_type, scheduled_date, scheduled_time, weekdays, is_active")
    .eq("is_active", true);

  if (error) {
    throw createHttpError(500, error.message);
  }

  const startDateKey = getJstDateKey(new Date());
  const endDateKey = getShiftedJstDateKey(startDateKey, OCCURRENCE_WINDOW_DAYS);
  const rangeStartIso = `${startDateKey}T00:00:00+09:00`;
  const rangeEndIso = `${endDateKey}T23:59:59+09:00`;
  const taskIds = (tasks || []).map((task) => task.id);
  const existingKeys = new Set();

  if (taskIds.length) {
    const { data: existingRows, error: existingError } = await supabase
      .from("task_occurrences")
      .select("task_id, scheduled_at")
      .in("task_id", taskIds)
      .gte("scheduled_at", rangeStartIso)
      .lte("scheduled_at", rangeEndIso);

    if (existingError) {
      throw createHttpError(500, existingError.message);
    }

    for (const row of existingRows || []) {
      existingKeys.add(`${row.task_id}:${normalizeOccurrenceTimestamp(row.scheduled_at)}`);
    }
  }

  const occurrenceRows = [];
  const createdAt = new Date().toISOString();

  for (const task of tasks || []) {
    for (const scheduledAt of generateScheduledAtValues(task, startDateKey, endDateKey)) {
      const occurrenceKey = `${task.id}:${normalizeOccurrenceTimestamp(scheduledAt)}`;
      if (existingKeys.has(occurrenceKey)) {
        continue;
      }
      occurrenceRows.push({
        task_id: task.id,
        scheduled_at: scheduledAt,
        status: "pending",
        next_notification_at: scheduledAt,
        completed_at: null,
        skipped_at: null,
        google_event_id: null,
        calendar_synced_at: null,
        calendar_sync_error: null,
        created_at: createdAt,
        updated_at: createdAt,
      });
    }
  }

  if (!occurrenceRows.length) {
    return;
  }

  const { error: insertError } = await supabase
    .from("task_occurrences")
    .upsert(occurrenceRows, {
      onConflict: "task_id,scheduled_at",
      ignoreDuplicates: true,
    });

  if (insertError) {
    throw createHttpError(500, insertError.message);
  }
}

function normalizeTimeValue(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const [hours = "", minutes = ""] = raw.split(":");
  if (!hours || !minutes) {
    return raw;
  }
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

function generateScheduledAtValues(task, startDateKey, endDateKey) {
  const values = [];
  const normalizedTime = normalizeScheduledTime(task.scheduled_time);

  if (!normalizedTime) {
    return values;
  }

  for (const dateKey of iterateDateKeys(startDateKey, endDateKey)) {
    let shouldInclude = false;

    if (task.schedule_type === "once") {
      shouldInclude = task.scheduled_date === dateKey;
    }
    if (task.schedule_type === "daily") {
      shouldInclude = true;
    }
    if (task.schedule_type === "weekly") {
      shouldInclude = Array.isArray(task.weekdays) && task.weekdays.includes(getWeekdayFromDateKey(dateKey));
    }

    if (shouldInclude) {
      values.push(toOccurrenceTimestamp(dateKey, normalizedTime));
    }
  }

  return values;
}

function* iterateDateKeys(startDateKey, endDateKey) {
  let current = startDateKey;
  while (current <= endDateKey) {
    yield current;
    current = getShiftedJstDateKey(current, 1);
  }
}

function normalizeScheduledTime(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const [hours = "", minutes = "", seconds = "00"] = raw.split(":");
  if (!hours || !minutes) {
    return "";
  }

  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds.padStart(2, "0")}`;
}

function getJstDateKey(date) {
  const shifted = new Date(date.getTime() + JST_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function getShiftedJstDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day + days));
  return utcDate.toISOString().slice(0, 10);
}

function getWeekdayFromDateKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function toOccurrenceTimestamp(dateKey, normalizedTime) {
  return new Date(`${dateKey}T${normalizedTime}+09:00`).toISOString();
}

function normalizeOccurrenceTimestamp(value) {
  return new Date(value).toISOString();
}

export async function cleanupDuplicateOccurrences(supabase = getSupabaseAdmin()) {
  const { data, error } = await supabase
    .from("task_occurrences")
    .select("id, task_id, scheduled_at, status, completed_at, skipped_at, next_notification_at, updated_at, created_at");

  if (error) {
    throw createHttpError(500, error.message);
  }

  const groups = new Map();
  for (const row of data || []) {
    const key = `${row.task_id}:${row.scheduled_at}`;
    const items = groups.get(key) || [];
    items.push(row);
    groups.set(key, items);
  }

  const duplicateIds = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) {
      continue;
    }

    const sorted = [...rows].sort(compareOccurrenceRowsForDedup);
    duplicateIds.push(...sorted.slice(1).map((row) => row.id));
  }

  if (!duplicateIds.length) {
    return;
  }

  const { error: deleteError } = await supabase
    .from("task_occurrences")
    .delete()
    .in("id", duplicateIds);

  if (deleteError) {
    throw createHttpError(500, deleteError.message);
  }
}

function compareOccurrenceRowsForDedup(left, right) {
  const priority = (row) => {
    if (row.status === "completed") {
      return 3;
    }
    if (row.status === "skipped") {
      return 2;
    }
    return 1;
  };

  const priorityDiff = priority(right) - priority(left);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const terminalTime = (row) => row.completed_at || row.skipped_at || row.next_notification_at || row.updated_at || row.created_at || "";
  return terminalTime(right).localeCompare(terminalTime(left));
}
