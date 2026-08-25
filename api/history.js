import { fromError, methodNotAllowed, ok, send } from "../lib/server/http.js";
import { readHistory } from "../lib/server/state-sync.js";

export default async function handler(request, response) {
  try {
    if (request.method !== "GET") return send(response, methodNotAllowed());
    const url = new URL(request.url || "/", "http://localhost");
    return send(response, ok(await readHistory({
      page: url.searchParams.get("page"),
      query: url.searchParams.get("q") || "",
    })));
  } catch (error) {
    return send(response, fromError(error));
  }
}
