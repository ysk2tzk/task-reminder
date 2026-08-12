import { createHttpError } from "./http.js";

const PUSH_ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "VAPID_SUBJECT",
];

const GOOGLE_ENV_NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
];

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw createHttpError(500, `${name} が設定されていません。`);
  }
  return value;
}

export function isPushConfigured() {
  return getMissingPushEnv().length === 0;
}

export function getMissingPushEnv() {
  return PUSH_ENV_NAMES.filter((name) => !process.env[name]);
}

export function getMissingGoogleEnv() {
  return GOOGLE_ENV_NAMES.filter((name) => !process.env[name]);
}

export function isGoogleConfigured() {
  return getMissingGoogleEnv().length === 0;
}
