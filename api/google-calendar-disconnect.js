import { disconnectGoogleCalendar } from "../lib/server/google-calendar.js";
import { fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";
import { readState } from "../lib/server/state-sync.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      return send(response, methodNotAllowed());
    }
    await disconnectGoogleCalendar();
    return send(response, ok(await readState()));
  } catch (error) {
    return send(response, fromError(error));
  }
}
