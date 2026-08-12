import { exchangeCodeForStoredCalendar } from "../lib/server/google-calendar.js";

export default async function handler(request, response) {
  const url = new URL(request.url || "/", "http://localhost");

  try {
    const errorCode = url.searchParams.get("error");
    if (errorCode) {
      return redirect(response, `/#/settings?calendar=error&reason=${encodeURIComponent(errorCode)}`);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    await exchangeCodeForStoredCalendar(code, state);
    return redirect(response, "/#/settings?calendar=connected");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Calendar の接続処理に失敗しました。";
    return redirect(response, `/#/settings?calendar=error&reason=${encodeURIComponent(message)}`);
  }
}

function redirect(response, location) {
  if (response && typeof response.writeHead === "function") {
    response.writeHead(302, {
      Location: location,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  response.statusCode = 302;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}
