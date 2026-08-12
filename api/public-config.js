import { getPublicVapidKey } from "../lib/server/push.js";
import { getMissingGoogleEnv, getMissingPushEnv, isGoogleConfigured, isPushConfigured } from "../lib/server/env.js";
import { fromError, ok, send } from "../lib/server/http.js";

export default async function handler(request, response) {
  try {
    const missingEnv = getMissingPushEnv();
    const missingGoogleEnv = getMissingGoogleEnv();
    if (!isPushConfigured()) {
      return send(response, ok({
        pushSupported: false,
        pushMode: "local",
        missingEnv,
        googleCalendarSupported: isGoogleConfigured(),
        missingGoogleEnv,
      }));
    }
    return send(response, ok({
      pushSupported: true,
      pushMode: "remote",
      missingEnv: [],
      vapidPublicKey: getPublicVapidKey(),
      googleCalendarSupported: isGoogleConfigured(),
      missingGoogleEnv,
    }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
