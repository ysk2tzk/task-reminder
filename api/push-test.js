import { fromError, methodNotAllowed, ok, readJson, createHttpError, send } from "../lib/server/http.js";
import { getSupabaseAdmin } from "../lib/server/supabase.js";
import { sendPush } from "../lib/server/push.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      return send(response, methodNotAllowed());
    }

    const { title = "実行支援", body = "テスト通知です。" } = await readJson(request);
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("push_subscriptions")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw createHttpError(500, error.message);
    }
    if (!data) {
      throw createHttpError(400, "Push subscription が登録されていません。");
    }

    await sendPush({
      endpoint: data.endpoint,
      keys: {
        p256dh: data.p256dh,
        auth: data.auth,
      },
    }, {
      title,
      body,
      url: "/#/home",
      tag: "task-reminder-test",
    });

    return send(response, ok({ sent: true }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
