import { createGoogleCalendarTestEvent } from "../lib/server/google-calendar.js";
import { fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      return send(response, methodNotAllowed());
    }
    const event = await createGoogleCalendarTestEvent();
    return send(response, ok({
      created: true,
      eventId: event.id,
      htmlLink: event.htmlLink || "",
    }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
