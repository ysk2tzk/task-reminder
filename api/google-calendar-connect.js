import { createGoogleAuthUrl, isGoogleCalendarConfigured, getMissingGoogleCalendarEnv } from "../lib/server/google-calendar.js";
import { createHttpError, fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "GET") {
      return send(response, methodNotAllowed());
    }
    if (!isGoogleCalendarConfigured()) {
      throw createHttpError(500, `Google Calendar 連携に必要な環境変数が不足しています: ${getMissingGoogleCalendarEnv().join(", ")}`);
    }
    return send(response, ok({ authUrl: createGoogleAuthUrl() }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
