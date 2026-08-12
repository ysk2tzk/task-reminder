import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

loadEnvFile(path.join(ROOT_DIR, ".env.local"));

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
  realtime: {
    transport: ws,
  },
});

const { data, error } = await supabase
  .from("task_occurrences")
  .select("id, task_id, scheduled_at, status, completed_at, skipped_at, next_notification_at, updated_at, created_at");

if (error) {
  throw error;
}

const groups = new Map();
for (const row of data || []) {
  const key = `${row.task_id}:${row.scheduled_at}`;
  const items = groups.get(key) || [];
  items.push(row);
  groups.set(key, items);
}

const duplicateIds = [];
const duplicateGroups = [];

for (const [key, rows] of groups.entries()) {
  if (rows.length < 2) {
    continue;
  }
  const sorted = [...rows].sort(compareOccurrenceRowsForDedup);
  duplicateIds.push(...sorted.slice(1).map((row) => row.id));
  duplicateGroups.push({
    key,
    keep: sorted[0].id,
    remove: sorted.slice(1).map((row) => row.id),
    statuses: rows.map((row) => row.status),
  });
}

if (!duplicateIds.length) {
  console.log(JSON.stringify({ duplicateGroups: 0, deletedRows: 0 }, null, 2));
  process.exit(0);
}

const { error: deleteError } = await supabase
  .from("task_occurrences")
  .delete()
  .in("id", duplicateIds);

if (deleteError) {
  throw deleteError;
}

console.log(JSON.stringify({
  duplicateGroups: duplicateGroups.length,
  deletedRows: duplicateIds.length,
  details: duplicateGroups,
}, null, 2));

function compareOccurrenceRowsForDedup(left, right) {
  const priority = (row) => {
    if (row.status === "completed") {
      return 3;
    }
    if (row.status === "skipped") {
      return 2;
    }
    return 1;
  };

  const priorityDiff = priority(right) - priority(left);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  const sortValue = (row) => row.completed_at || row.skipped_at || row.next_notification_at || row.updated_at || row.created_at || "";
  return sortValue(right).localeCompare(sortValue(left));
}

function loadEnvFile(filePath) {
  try {
    const source = readFileSync(filePath, "utf8");
    for (const line of source.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/gu, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env.local がなくても、親プロセスから渡された環境変数で動けるようにする
  }
}
