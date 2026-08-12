import { fromError, methodNotAllowed, ok, readJson, createHttpError, send } from "../lib/server/http.js";
import { getSupabaseAdmin } from "../lib/server/supabase.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      return send(response, methodNotAllowed());
    }

    const body = await readJson(request);
    if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
      throw createHttpError(400, "Push subscription が不正です。");
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("push_subscriptions")
      .upsert({
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      }, { onConflict: "endpoint" });

    if (error) {
      throw createHttpError(500, error.message);
    }

    return send(response, ok({ subscribed: true }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
