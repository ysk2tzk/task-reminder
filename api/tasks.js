import { fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";
import { readTasks } from "../lib/server/state-sync.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "GET") {
      return send(response, methodNotAllowed());
    }
    return send(response, ok({ tasks: await readTasks() }));
  } catch (error) {
    return send(response, fromError(error));
  }
}
