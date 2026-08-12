import { fromError, methodNotAllowed, ok, readJson, send } from "../lib/server/http.js";
import { readState, syncState } from "../lib/server/state-sync.js";

export default async function handler(request, response) {
  try {
    if (request.method === "GET") {
      return send(response, ok(await readState()));
    }
    if (request.method === "POST") {
      return send(response, ok(await syncState(await readJson(request))));
    }
    return send(response, methodNotAllowed());
  } catch (error) {
    return send(response, fromError(error));
  }
}
