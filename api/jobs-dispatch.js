import { fromError, methodNotAllowed, ok, createHttpError, getHeader, send } from "../lib/server/http.js";
import { getSupabaseAdmin } from "../lib/server/supabase.js";
import { sendPush } from "../lib/server/push.js";
import { ensurePendingOccurrences } from "../lib/server/state-sync.js";

const JST_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export default async function handler(request, response) {
  try {
    if (request.method !== "GET") {
      return send(response, methodNotAllowed());
    }

    const cronSecret = process.env.CRON_SECRET;
    const authHeader = getHeader(request, "authorization");
    const vercelCron = getHeader(request, "x-vercel-cron");
    if (cronSecret && authHeader !== "Bearer " + cronSecret && !vercelCron) {
      console.warn("jobs-dispatch authorization rejected", {
        cronSecretConfigured: true,
        authorizationHeaderPresent: Boolean(authHeader),
        authorizationHeaderUsesBearer: authHeader?.startsWith("Bearer ") ?? false,
        authorizationHeaderLength: authHeader?.length ?? 0,
        expectedAuthorizationHeaderLength: 7 + cronSecret.length,
        vercelCronHeaderPresent: Boolean(vercelCron),
      });
      throw createHttpError(401, "Unauthorized");
    }

    const supabase = getSupabaseAdmin();
    await ensurePendingOccurrences(supabase);
    const nowIso = new Date().toISOString();
    await expireSupersededOccurrences(supabase, nowIso);

    const { data: occurrences, error: occurrenceError } = await supabase
      .from("task_occurrences")
      .select("id, task_id, scheduled_at, next_notification_at, tasks!inner(title, reminder_interval_minutes, is_active)")
      .eq("status", "pending")
      .lte("next_notification_at", nowIso)
      .eq("tasks.is_active", true);

    if (occurrenceError) {
      throw createHttpError(500, occurrenceError.message);
    }

    const { data: subscriptions, error: subscriptionError } = await supabase
      .from("push_subscriptions")
      .select("*");

    if (subscriptionError) {
      throw createHttpError(500, subscriptionError.message);
    }

    let sentCount = 0;
    let dispatchedOccurrences = 0;
    for (const occurrence of occurrences || []) {
      const task = Array.isArray(occurrence.tasks) ? occurrence.tasks[0] : occurrence.tasks;
      const nextNotificationAt = getNextNotificationAt(nowIso, task.reminder_interval_minutes);
      const { data: claimedRows, error: claimError } = await supabase
        .from("task_occurrences")
        .update({
          next_notification_at: nextNotificationAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", occurrence.id)
        .eq("status", "pending")
        .lte("next_notification_at", nowIso)
        .select("id");

      if (claimError) {
        throw createHttpError(500, claimError.message);
      }
      if (!claimedRows?.length) {
        continue;
      }

      dispatchedOccurrences += 1;
      const payload = {
        title: `実行支援: ${task.title}`,
        body: `予定時刻 ${formatJstDateTime(occurrence.scheduled_at)} のタスクが未完了です。`,
        url: "/#/home",
        tag: occurrence.id,
      };

      for (const subscription of subscriptions || []) {
        try {
          await sendPush({
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          }, payload);
          sentCount += 1;
        } catch (error) {
          const statusCode = error?.statusCode || error?.status;
          if (statusCode === 404 || statusCode === 410) {
            await supabase.from("push_subscriptions").delete().eq("id", subscription.id);
          }
        }
      }

    }

    return send(response, ok({
      dispatchedOccurrences,
      sentCount,
      checkedAt: nowIso,
    }));
  } catch (error) {
    console.error("jobs-dispatch failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return send(response, fromError(error));
  }
}

function formatJstDateTime(value) {
  return JST_DATE_TIME_FORMATTER.format(new Date(value));
}

function getNextNotificationAt(baseTime, intervalMinutes) {
  return new Date(
    new Date(baseTime).getTime() + Math.max(1, Number(intervalMinutes) || 1) * 60 * 1000
  ).toISOString();
}

async function expireSupersededOccurrences(supabase, nowIso) {
  const { data: pendingOccurrences, error } = await supabase
    .from("task_occurrences")
    .select("id, scheduled_at, tasks!inner(schedule_type, monthly_day, is_active)")
    .eq("status", "pending")
    .eq("tasks.is_active", true);

  if (error) {
    throw createHttpError(500, error.message);
  }

  const nowMs = new Date(nowIso).getTime();
  for (const occurrence of pendingOccurrences || []) {
    const task = Array.isArray(occurrence.tasks) ? occurrence.tasks[0] : occurrence.tasks;
    const nextOccurrenceAt = getNextOccurrenceAt(occurrence.scheduled_at, task);
    if (!nextOccurrenceAt || nextOccurrenceAt > nowMs) {
      continue;
    }

    const { error: updateError } = await supabase
      .from("task_occurrences")
      .update({
        status: "expired",
        next_notification_at: null,
        expired_at: nowIso,
        updated_at: nowIso,
      })
      .eq("id", occurrence.id)
      .eq("status", "pending");

    if (updateError) {
      throw createHttpError(500, updateError.message);
    }
  }
}

function getNextOccurrenceAt(scheduledAt, task) {
  if (task?.schedule_type === "daily") {
    return new Date(scheduledAt).getTime() + 24 * 60 * 60 * 1000;
  }
  if (task?.schedule_type === "weekly") {
    return new Date(scheduledAt).getTime() + 7 * 24 * 60 * 60 * 1000;
  }
  if (task?.schedule_type !== "monthly") {
    return null;
  }

  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const jstDate = new Date(new Date(scheduledAt).getTime() + JST_OFFSET_MS);
  const year = jstDate.getUTCFullYear();
  const month = jstDate.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const day = Math.min(Number(task.monthly_day), lastDay);
  return Date.UTC(
    year,
    month + 1,
    day,
    jstDate.getUTCHours(),
    jstDate.getUTCMinutes(),
    jstDate.getUTCSeconds(),
    jstDate.getUTCMilliseconds()
  ) - JST_OFFSET_MS;
}
