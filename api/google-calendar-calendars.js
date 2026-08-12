import { listWritableGoogleCalendars } from "../lib/server/google-calendar.js";
import { fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "GET") {
      return send(response, methodNotAllowed());
    }
    return send(response, ok({
      calendars: await listWritableGoogleCalendars(),
    }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
