export async function readJson(request) {
  if (request && typeof request.json === "function") {
    try {
      return await request.json();
    } catch {
      throw createHttpError(400, "JSON ボディを解釈できません。");
    }
  }

  if (request?.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];
  try {
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw createHttpError(400, "JSON ボディを解釈できません。");
  }
}

export function json(status, body) {
  return { status, body };
}

export function ok(body) {
  return json(200, body);
}

export function created(body) {
  return json(201, body);
}

export function noContent() {
  return { status: 204, body: null };
}

export function methodNotAllowed() {
  return json(405, { error: "Method not allowed" });
}

export function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function fromError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = error instanceof Error ? error.message : "Internal Server Error";
  return json(status, { error: message });
}

export function getHeader(request, name) {
  if (request?.headers?.get) {
    return request.headers.get(name);
  }
  const value = request?.headers?.[name] ?? request?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export function send(response, payload) {
  if (response && typeof response.status === "function") {
    response.status(payload.status);
    response.setHeader("Cache-Control", "no-store");
    if (payload.body === null) {
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.send(JSON.stringify(payload.body));
    return;
  }

  if (response && typeof response.setHeader === "function" && typeof response.end === "function") {
    response.statusCode = payload.status;
    response.setHeader("Cache-Control", "no-store");
    if (payload.body === null) {
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload.body));
    return;
  }

  return new Response(payload.body === null ? null : JSON.stringify(payload.body), {
    status: payload.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
