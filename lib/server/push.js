import webpush from "web-push";
import { getRequiredEnv } from "./env.js";

let configured = false;

export function configureWebPush() {
  if (configured) {
    return;
  }
  webpush.setVapidDetails(
    getRequiredEnv("VAPID_SUBJECT"),
    getRequiredEnv("VAPID_PUBLIC_KEY"),
    getRequiredEnv("VAPID_PRIVATE_KEY")
  );
  configured = true;
}

export function getPublicVapidKey() {
  return getRequiredEnv("VAPID_PUBLIC_KEY");
}

export async function sendPush(subscription, payload) {
  configureWebPush();
  return webpush.sendNotification(subscription, JSON.stringify(payload));
}
