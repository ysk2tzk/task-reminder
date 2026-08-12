import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { getRequiredEnv } from "./env.js";

let client;

export function getSupabaseAdmin() {
  if (!client) {
    client = createClient(
      getRequiredEnv("SUPABASE_URL"),
      getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
        realtime: {
          transport: ws,
        },
      }
    );
  }
  return client;
}
