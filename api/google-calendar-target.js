import { updateGoogleCalendarTarget } from "../lib/server/google-calendar.js";
import { fromError, methodNotAllowed, ok, readJson, send } from "../lib/server/http.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      return send(response, methodNotAllowed());
    }

    const body = await readJson(request);
    return send(response, ok(await updateGoogleCalendarTarget(body?.googleCalendarId)));
  } catch (error) {
    return send(response, fromError(error));
  }
}
