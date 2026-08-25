import { fromError, methodNotAllowed, ok, readJson, send } from "../lib/server/http.js";
import { getMissingGoogleEnv, getMissingPushEnv, isGoogleConfigured, isPushConfigured } from "../lib/server/env.js";
import { getPublicVapidKey } from "../lib/server/push.js";
import { readState, syncState } from "../lib/server/state-sync.js";

export default async function handler(request, response) {
  try {
    if (request.method === "GET") {
      if (isPublicConfigRequest(request)) {
        return send(response, ok(getPublicConfig()));
      }
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

function isPublicConfigRequest(request) {
  const url = new URL(request?.url || "/api/state", "http://localhost");
  return url.searchParams.get("view") === "public-config";
}

function getPublicConfig() {
  const missingEnv = getMissingPushEnv();
  const missingGoogleEnv = getMissingGoogleEnv();
  if (!isPushConfigured()) {
    return {
      pushSupported: false,
      pushMode: "local",
      missingEnv,
      googleCalendarSupported: isGoogleConfigured(),
      missingGoogleEnv,
    };
  }
  return {
    pushSupported: true,
    pushMode: "remote",
    missingEnv: [],
    vapidPublicKey: getPublicVapidKey(),
    googleCalendarSupported: isGoogleConfigured(),
    missingGoogleEnv,
  };
}
