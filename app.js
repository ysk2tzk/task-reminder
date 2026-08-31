const APP_VERSION = "0.3.1";
const OCCURRENCE_WINDOW_DAYS = 7;
const REQUEST_TIMEOUT_MS = 8000;
const LOCAL_NOTIFICATION_POLL_MS = 5000;
const TASKS_PAGE_SIZE = 10;
const DAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"];
const DEFAULT_STATE = {
  tasks: [],
  occurrences: [],
  settings: {
    googleCalendarConnected: false,
    googleCalendarId: "",
    googleCalendarOptions: [],
    googleRefreshTokenMasked: "",
    lastCalendarTestAt: null,
    pushEnabled: false,
    pushSubscriptionConfigured: false,
    remoteSyncEnabled: true,
    remoteSyncHealthy: false,
    lastRemoteSyncAt: null,
    lastRemoteSyncError: "",
  },
};

const runtime = {
  remoteConfig: null,
  state: structuredClone(DEFAULT_STATE),
  loaded: false,
  loadError: "",
  busy: false,
  reloadBusy: false,
  reloadMessage: "",
  pendingOccurrenceAction: null,
  localNotificationTimer: null,
  lastRouteNotice: "",
};

bootstrap().catch((error) => {
  runtime.loadError = error instanceof Error ? error.message : "初期化に失敗しました。";
  renderApp();
});

async function bootstrap() {
  renderApp();
  runtime.remoteConfig = await loadRemoteConfig();
  registerServiceWorker();
  window.addEventListener("hashchange", () => {
    loadRouteData().catch((error) => {
      runtime.loadError = error instanceof Error ? error.message : "タスク一覧の取得に失敗しました。";
    }).finally(() => {
      renderApp();
      announceRouteNotice();
    });
  });
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("click", handleClick);
  document.addEventListener("change", handleChange);
  await loadStateFromServer();
  await loadRouteData();
  await refreshPushStatus();
  await suppressLocalNotificationBacklog();
  startLocalNotificationLoop();
  await refreshGoogleCalendarOptions();
  renderApp();
  announceRouteNotice();
}

function renderApp() {
  const app = document.getElementById("app");
  if (!app) {
    return;
  }

  if (!runtime.loaded) {
    app.innerHTML = renderLoadingPage(runtime.loadError);
    return;
  }

  const route = parseRoute(location.hash || "#/home");
  app.innerHTML = `${renderPage(route)}${renderGlobalReloadButton()}`;
  markActiveTab(route.name);
}

function parseRoute(hash) {
  const pathOnly = hash.split("?")[0];
  const cleaned = pathOnly.replace(/^#\/?/, "");
  const [name = "home", id] = cleaned.split("/");
  return { name, id: id || null };
}

function renderPage(route) {
  switch (route.name) {
    case "home":
      return renderHomePage();
    case "tasks":
      return renderTasksPage();
    case "task-new":
      return renderTaskFormPage("create");
    case "task-edit":
      return renderTaskFormPage("edit", route.id);
    case "settings":
      return renderSettingsPage();
    default:
      return renderNotFoundPage();
  }
}

function renderLoadingPage(message = "") {
  return `
    <section class="page">
      <section class="card">
        <h2>${message ? "読み込みエラー" : "読み込み中"}</h2>
        <p class="muted">${escapeHtml(message || "Supabase からデータを取得しています。")}</p>
        ${message ? `
          <div class="actions">
            ${renderReloadStatus()}
            <button class="primary-button" data-action="reload-state" type="button" ${runtime.reloadBusy ? "disabled" : ""}>${runtime.reloadBusy ? "再読み込み中..." : "再読み込み"}</button>
          </div>
        ` : ""}
      </section>
    </section>
  `;
}

function renderHomePage() {
  const state = getState();
  const overdue = getOverdueOccurrences(state);
  const todayUpcoming = getTodayUpcomingOccurrences(state);

  return `
    <section class="page">
      <section class="card">
        <div class="section-title">
          <h3>未完了かつ予定時刻超過</h3>
        </div>
        <div class="stack">
          ${overdue.length ? overdue.map((occurrence) => renderHomeTaskCard(occurrence, true)).join("") : `<p class="list-empty">超過中のタスクはありません。</p>`}
        </div>
      </section>

      <section class="card">
        <div class="section-title">
          <h3>今日これから実行するタスク</h3>
        </div>
        <div class="stack">
          ${todayUpcoming.length ? todayUpcoming.map((occurrence) => renderHomeTaskCard(occurrence, false)).join("") : `<p class="list-empty">今日この後の予定はありません。</p>`}
        </div>
      </section>
    </section>
  `;
}

function renderHomeTaskCard(occurrence, isOverdue) {
  const task = getTaskById(occurrence.taskId);
  const delta = isOverdue ? formatRelativeMinutes(occurrence.scheduledAt) : `通知間隔 ${task.reminderIntervalMinutes}分`;
  const pendingAction = runtime.pendingOccurrenceAction;
  const isPending = pendingAction?.id === occurrence.id;
  const pendingLabel = pendingAction?.type === "complete" ? "完了処理中..." : "スキップ処理中...";
  const disabled = isPending ? "disabled" : "";
  return `
    <article class="task-item home-task-item ${isOverdue ? "overdue" : ""} ${isPending ? "is-pending" : ""}" ${isPending ? `aria-busy="true"` : ""}>
      <div class="task-topline">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="task-meta">${escapeHtml(task.description || "説明なし")}</div>
        </div>
        ${isOverdue ? "" : `<div class="badge-row"><span class="badge warning">予定</span></div>`}
      </div>
      <div class="task-meta home-task-schedule">
        <span>予定: ${formatDateTime(occurrence.scheduledAt)}</span>
        <span>${delta}</span>
      </div>
      ${isPending ? `<div class="pending-note"><span class="pending-dot" aria-hidden="true"></span><span>${pendingLabel}</span></div>` : ""}
      <div class="actions">
        <button class="primary-button" data-action="complete-occurrence" data-id="${occurrence.id}" type="button" ${disabled}>${isPending && pendingAction.type === "complete" ? "処理中..." : "完了"}</button>
        <button class="secondary-button" data-action="skip-occurrence" data-id="${occurrence.id}" type="button" ${disabled}>${isPending && pendingAction.type === "skip" ? "処理中..." : "スキップ"}</button>
        <button class="ghost-button" data-action="edit-task" data-id="${task.id}" type="button" ${disabled}>タスク編集</button>
      </div>
    </article>
  `;
}

function renderTasksPage() {
  const tasks = getTasksSorted();
  const query = parseRouteQuery(location.hash || "");
  const totalPages = Math.max(1, Math.ceil(tasks.length / TASKS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, Number(query.page) || 1), totalPages);
  const startIndex = (currentPage - 1) * TASKS_PAGE_SIZE;
  const visibleTasks = tasks.slice(startIndex, startIndex + TASKS_PAGE_SIZE);
  return `
    <section class="page">
      <section class="page-header">
        <div>
          <h2>タスク一覧</h2>
          <p>有効なタスクを先頭に表示し、その中で作成日時の新しい順に並べています。</p>
        </div>
      </section>

      <section class="card stack">
        ${tasks.length ? visibleTasks.map(renderTaskListItem).join("") : `<p class="list-empty">まだタスクがありません。右下の＋から作成できます。</p>`}
        ${tasks.length ? renderTasksPagination(currentPage, totalPages, tasks.length) : ""}
      </section>

      <button class="fab" data-action="go" data-target="#/task-new" type="button" aria-label="タスクを追加">+</button>
    </section>
  `;
}

function renderTaskListItem(task) {
  return `
    <article class="task-item task-list-item ${task.isActive ? "is-active" : "is-inactive"}" aria-label="${task.isActive ? "有効" : "無効"}なタスク: ${escapeHtml(task.title)}">
      <div class="task-topline">
        <div>
          <div class="task-title">${escapeHtml(task.title)}</div>
          <div class="task-meta">${escapeHtml(task.description || "説明なし")}</div>
        </div>
      </div>
      <div class="task-meta task-list-meta-row">
        <span>${formatTaskRule(task)} / 通知間隔: ${task.reminderIntervalMinutes}分</span>
      </div>
      <div class="actions">
        <button class="ghost-button" data-action="edit-task" data-id="${task.id}" type="button">編集</button>
        <button class="${task.isActive ? "danger-button" : "secondary-button"}" data-action="toggle-task" data-id="${task.id}" type="button">${task.isActive ? "無効にする" : "有効にする"}</button>
      </div>
    </article>
  `;
}

function renderTasksPagination(currentPage, totalPages, totalCount) {
  if (totalPages <= 1) {
    return `<div class="pagination-summary">${totalCount}件</div>`;
  }
  return `
    <div class="pagination">
      <div class="pagination-summary">${totalCount}件中 ${((currentPage - 1) * TASKS_PAGE_SIZE) + 1}-${Math.min(currentPage * TASKS_PAGE_SIZE, totalCount)}件を表示</div>
      <div class="actions pagination-actions">
        <button class="ghost-button" data-action="tasks-page" data-page="${currentPage - 1}" type="button" ${currentPage <= 1 ? "disabled" : ""}>前へ</button>
        <span class="pagination-current">${currentPage} / ${totalPages}</span>
        <button class="ghost-button" data-action="tasks-page" data-page="${currentPage + 1}" type="button" ${currentPage >= totalPages ? "disabled" : ""}>次へ</button>
      </div>
    </div>
  `;
}

function renderGlobalReloadButton() {
  return `
    <div class="reload-control">
      ${renderReloadStatus()}
      <button class="reload-fab" data-action="reload-state" type="button" aria-label="再読み込み" ${runtime.reloadBusy ? "disabled" : ""}>${runtime.reloadBusy ? "..." : "↻"}</button>
    </div>
  `;
}

function renderReloadStatus() {
  if (!runtime.reloadBusy) {
    return "";
  }
  return `<div class="reload-status" aria-live="polite"> ${escapeHtml(runtime.reloadMessage || "タスク読み込み中です。")} </div>`;
}

function renderTaskFormPage(mode, taskId = null) {
  const task = taskId ? getTaskById(taskId) : null;
  const values = task || {
    title: "",
    description: "",
    scheduleType: "daily",
    scheduledDate: "",
    monthlyDay: 1,
    scheduledTime: "09:00",
    weekdays: [1, 2, 3, 4, 5],
    reminderIntervalMinutes: 15,
    isActive: true,
  };

  const title = mode === "create" ? "タスク登録" : "タスク編集";
  const description = mode === "create" ? "1回だけ・毎日・毎月・曜日指定に対応しています。" : "実行済みの記録を保持したまま設定を更新できます。";

  return `
    <section class="page">
      <section class="page-header">
        <div>
          <h2>${title}</h2>
          <p>${description}</p>
        </div>
        <button class="ghost-button" data-action="go" data-target="#/tasks" type="button">戻る</button>
      </section>

      <form class="card form" data-form="task" data-mode="${mode}" ${taskId ? `data-id="${taskId}"` : ""}>
        <div class="field">
          <label for="title">タスク名</label>
          <input id="title" name="title" required maxlength="120" value="${escapeAttr(values.title)}" />
        </div>

        <div class="field">
          <label for="description">説明</label>
          <textarea id="description" name="description" placeholder="完了したい内容の補足">${escapeHtml(values.description || "")}</textarea>
        </div>

        <fieldset class="field fieldset">
          <legend>実行条件</legend>
          <div class="inline-options">
            ${renderScheduleTypeOption("once", "1回だけ", values.scheduleType)}
            ${renderScheduleTypeOption("daily", "毎日", values.scheduleType)}
            ${renderScheduleTypeOption("monthly", "毎月", values.scheduleType)}
            ${renderScheduleTypeOption("weekly", "曜日指定", values.scheduleType)}
          </div>
        </fieldset>

        <div class="split">
          <div class="field schedule-once ${values.scheduleType === "once" ? "" : "hidden"}">
            <label for="scheduledDate">予定日</label>
            <input id="scheduledDate" name="scheduledDate" type="date" value="${escapeAttr(values.scheduledDate || "")}" />
          </div>

          <div class="field">
            <label for="scheduledTime">実行時刻</label>
            <input id="scheduledTime" name="scheduledTime" type="time" required value="${escapeAttr(values.scheduledTime)}" />
          </div>
        </div>

        <div class="field schedule-monthly ${values.scheduleType === "monthly" ? "" : "hidden"}">
          <label for="monthlyDay">毎月の実行日</label>
          <input id="monthlyDay" name="monthlyDay" type="number" min="1" max="31" value="${escapeAttr(String(values.monthlyDay || 1))}" />
          <small>存在しない日は、その月の最終日に実行します。</small>
        </div>

        <fieldset class="field fieldset schedule-weekly ${values.scheduleType === "weekly" ? "" : "hidden"}">
          <legend>曜日指定</legend>
          <div class="weekday-grid">
            ${DAY_NAMES.map((name, index) => renderWeekdayOption(index, name, values.weekdays || [])).join("")}
          </div>
        </fieldset>

        <div class="field">
          <label for="reminderIntervalMinutes">通知間隔（分）</label>
          <input id="reminderIntervalMinutes" name="reminderIntervalMinutes" type="number" min="1" max="1440" required value="${escapeAttr(String(values.reminderIntervalMinutes))}" />
        </div>

        <div class="actions">
          <button class="primary-button" type="submit">${mode === "create" ? "登録" : "保存"}</button>
          <button class="ghost-button" data-action="go" data-target="#/tasks" type="button">キャンセル</button>
        </div>
      </form>
    </section>
  `;
}

function renderScheduleTypeOption(value, label, current) {
  return `
    <label class="chip-option">
      <input name="scheduleType" type="radio" value="${value}" ${current === value ? "checked" : ""} />
      <span>${label}</span>
    </label>
  `;
}

function renderWeekdayOption(value, label, selected) {
  return `
    <label class="chip-option">
      <input name="weekdays" type="checkbox" value="${value}" ${selected.includes(value) ? "checked" : ""} />
      <span>${label}</span>
    </label>
  `;
}

function renderSettingsPage() {
  const state = getState();
  const permission = typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  const remoteReady = Boolean(runtime.remoteConfig?.pushSupported);
  const pushStatus = state.settings.pushSubscriptionConfigured ? "購読済み" : state.settings.pushEnabled ? "権限のみ許可" : "未設定";
  const missingEnv = Array.isArray(runtime.remoteConfig?.missingEnv) ? runtime.remoteConfig.missingEnv : [];
  const googleReady = Boolean(runtime.remoteConfig?.googleCalendarSupported);
  const missingGoogleEnv = Array.isArray(runtime.remoteConfig?.missingGoogleEnv) ? runtime.remoteConfig.missingGoogleEnv : [];
  const calendarOptions = Array.isArray(state.settings.googleCalendarOptions) ? state.settings.googleCalendarOptions : [];
  return `
    <section class="page">
      <section class="page-header">
        <div>
          <h2>設定</h2>
          <p>Google Calendar と通知周りの状態を確認します。</p>
        </div>
      </section>

      <section class="card stack">
        <div class="setting-row">
          <div class="task-title">Google Calendar 接続状態</div>
          <div class="task-meta">${state.settings.googleCalendarConnected ? "接続済み" : "未接続"}</div>
          <div class="task-meta">サーバー設定: ${googleReady ? "利用可能" : "未設定"} / 登録先: ${state.settings.googleCalendarId || "-"}</div>
          ${missingGoogleEnv.length ? `<div class="task-meta">不足している環境変数: ${escapeHtml(missingGoogleEnv.join(", "))}</div>` : `<div class="task-meta">Google OAuth 用の環境変数は揃っています。</div>`}
          ${state.settings.googleCalendarConnected ? `
            <div class="field">
              <label for="googleCalendarId">登録先カレンダー</label>
              <select id="googleCalendarId" name="googleCalendarId">
                ${calendarOptions.length
                  ? calendarOptions.map((calendar) => `<option value="${escapeAttr(calendar.id)}" ${calendar.id === state.settings.googleCalendarId ? "selected" : ""}>${escapeHtml(formatCalendarOptionLabel(calendar))}</option>`).join("")
                  : `<option value="${escapeAttr(state.settings.googleCalendarId || "")}">${escapeHtml(state.settings.googleCalendarId || "読み込み中")}</option>`}
              </select>
            </div>
          ` : ""}
          <div class="actions">
            <button class="secondary-button" data-action="${state.settings.googleCalendarConnected ? "disconnect-calendar" : "connect-calendar"}" type="button">${state.settings.googleCalendarConnected ? "接続を解除" : "Google で接続する"}</button>
            ${state.settings.googleCalendarConnected ? `<button class="ghost-button" data-action="save-calendar-target" type="button">登録先を保存</button>` : ""}
            <button class="ghost-button" data-action="calendar-test" type="button">テスト登録</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="task-title">Push 通知状態</div>
          <div class="task-meta">ブラウザ権限: ${permissionLabel(permission)} / Push: ${pushStatus}</div>
          <div class="task-meta">サーバー連携: ${remoteReady ? "有効" : "未設定"} / モード: ${remoteReady ? "本番 Push" : "ローカル通知"} / 最終保存: ${state.settings.lastRemoteSyncAt ? formatDateTime(state.settings.lastRemoteSyncAt) : "-"}</div>
          ${missingEnv.length ? `<div class="task-meta">不足している環境変数: ${escapeHtml(missingEnv.join(", "))}</div>` : `<div class="task-meta">本番 Push に必要な環境変数は揃っています。</div>`}
          ${state.settings.lastRemoteSyncError ? `<div class="task-meta">保存エラー: ${escapeHtml(state.settings.lastRemoteSyncError)}</div>` : ""}
          <div class="actions">
            <button class="secondary-button" data-action="enable-push" type="button">${remoteReady ? "通知を購読する" : "通知権限を許可"}</button>
            <button class="ghost-button" data-action="test-notification" type="button">テスト通知</button>
            ${renderReloadStatus()}
            <button class="ghost-button" data-action="reload-state" type="button" ${runtime.reloadBusy ? "disabled" : ""}>${runtime.reloadBusy ? "再読み込み中..." : "再読み込み"}</button>
          </div>
        </div>

        <div class="setting-row">
          <div class="task-title">アプリ情報</div>
          <div class="task-meta">PWA名: task-reminder</div>
          <div class="task-meta">バージョン: ${APP_VERSION}</div>
          <div class="task-meta">保存先: Supabase</div>
        </div>
      </section>
    </section>
  `;
}

function renderNotFoundPage(message = "ページが見つかりませんでした。") {
  return `
    <section class="page">
      <section class="card">
        <h2>Not Found</h2>
        <p class="muted">${escapeHtml(message)}</p>
        <div class="actions">
          <button class="primary-button" data-action="go" data-target="#/home" type="button">ホームへ戻る</button>
        </div>
      </section>
    </section>
  `;
}

async function handleSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  try {
    if (form.dataset.form === "task") {
      event.preventDefault();
      await upsertTaskFromForm(form);
      return;
    }

  } catch (error) {
    toast(error instanceof Error ? error.message : "入力内容を確認してください。");
  }
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  const id = target.dataset.id;

  try {
    if (action === "go") {
      location.hash = target.dataset.target;
      return;
    }
    if (action === "edit-task" && id) {
      location.hash = `#/task-edit/${id}`;
      return;
    }
    if (action === "reload-state") {
      if (runtime.reloadBusy) {
        return;
      }
      runtime.reloadBusy = true;
      runtime.reloadMessage = "タスク読み込み中です。";
      renderApp();
      try {
        await loadStateFromServer();
        await loadRouteData();
        await refreshPushStatus();
        toast("Supabase から再読み込みしました。");
      } finally {
        runtime.reloadBusy = false;
        runtime.reloadMessage = "";
        renderApp();
      }
      return;
    }
    if (action === "tasks-page") {
      updateTasksPage(Number(target.dataset.page) || 1);
      return;
    }
    if (action === "toggle-task" && id) {
      await toggleTaskActive(id);
      return;
    }
    if (action === "complete-occurrence" && id) {
      await completeOccurrence(id);
      return;
    }
    if (action === "skip-occurrence" && id) {
      await skipOccurrence(id);
      return;
    }
    if (action === "enable-push") {
      await requestPushSetup();
      return;
    }
    if (action === "test-notification") {
      await testNotification();
      return;
    }
    if (action === "connect-calendar") {
      await connectGoogleCalendar();
      return;
    }
    if (action === "disconnect-calendar") {
      await disconnectGoogleCalendar();
      return;
    }
    if (action === "save-calendar-target") {
      await saveGoogleCalendarTarget();
      return;
    }
    if (action === "calendar-test") {
      await createCalendarTestEvent();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "処理に失敗しました。");
  }
}

function handleChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.name === "scheduleType") {
    document.querySelector(".schedule-once")?.classList.toggle("hidden", target.value !== "once");
    document.querySelector(".schedule-monthly")?.classList.toggle("hidden", target.value !== "monthly");
    document.querySelector(".schedule-weekly")?.classList.toggle("hidden", target.value !== "weekly");
    return;
  }

  if (target.name === "googleCalendarId") {
    runtime.state.settings.googleCalendarId = target.value;
  }
}

async function upsertTaskFromForm(form) {
  const formData = new FormData(form);
  const scheduleType = formData.get("scheduleType")?.toString() || "daily";
  const weekdays = formData
    .getAll("weekdays")
    .map((value) => Number(value))
    .sort((a, b) => a - b);

  const taskPayload = {
    title: formData.get("title")?.toString().trim() || "",
    description: formData.get("description")?.toString().trim() || "",
    scheduleType,
    scheduledDate: scheduleType === "once" ? formData.get("scheduledDate")?.toString() || "" : "",
    monthlyDay: scheduleType === "monthly" ? Number(formData.get("monthlyDay")) : null,
    scheduledTime: formData.get("scheduledTime")?.toString() || "",
    weekdays: scheduleType === "weekly" ? weekdays : [],
    reminderIntervalMinutes: Number(formData.get("reminderIntervalMinutes")),
    isActive: true,
  };

  validateTask(taskPayload);

  const state = getState();
  if (form.dataset.mode === "edit" && form.dataset.id) {
    const index = state.tasks.findIndex((task) => task.id === form.dataset.id);
    taskPayload.isActive = state.tasks[index]?.isActive ?? true;
    state.tasks[index] = {
      ...state.tasks[index],
      ...taskPayload,
      updatedAt: new Date().toISOString(),
    };
    await persistState("タスクを更新しました。");
  } else {
    const now = new Date().toISOString();
    state.tasks.push({
      id: crypto.randomUUID(),
      ...taskPayload,
      createdAt: now,
      updatedAt: now,
    });
    await persistState("タスクを登録しました。");
  }

  location.hash = "#/tasks";
  renderApp();
}

function validateTask(task) {
  if (!task.title) {
    throw new Error("タスク名を入力してください。");
  }
  if (!task.scheduledTime) {
    throw new Error("実行時刻を入力してください。");
  }
  if (!Number.isFinite(task.reminderIntervalMinutes) || task.reminderIntervalMinutes <= 0) {
    throw new Error("通知間隔は1分以上で入力してください。");
  }
  if (task.scheduleType === "once" && !task.scheduledDate) {
    throw new Error("1回だけの場合は予定日が必要です。");
  }
  if (task.scheduleType === "weekly" && !task.weekdays.length) {
    throw new Error("曜日指定の場合は1つ以上選択してください。");
  }
  if (task.scheduleType === "monthly" && (!Number.isInteger(task.monthlyDay) || task.monthlyDay < 1 || task.monthlyDay > 31)) {
    throw new Error("毎月の実行日は1日から31日で入力してください。");
  }
}

async function toggleTaskActive(taskId) {
  const state = getState();
  const task = state.tasks.find((item) => item.id === taskId);
  task.isActive = !task.isActive;
  task.updatedAt = new Date().toISOString();
  await persistState(task.isActive ? "タスクを有効にしました。" : "タスクを無効にしました。");
  await loadTasksForList();
  renderApp();
}

async function completeOccurrence(id) {
  const state = getState();
  const occurrence = state.occurrences.find((item) => item.id === id);
  if (!occurrence || occurrence.status !== "pending") {
    return;
  }
  runtime.pendingOccurrenceAction = { id, type: "complete" };
  renderApp();
  try {
    const now = new Date().toISOString();
    occurrence.status = "completed";
    occurrence.completedAt = now;
    occurrence.nextNotificationAt = null;
    occurrence.updatedAt = now;
    occurrence.googleEventId = "";
    occurrence.calendarSyncedAt = null;
    occurrence.calendarSyncError = "";
    deactivateOneTimeTaskAfterOccurrence(occurrence.taskId, now);
    await persistState("タスクを完了にしました。");
  } finally {
    runtime.pendingOccurrenceAction = null;
    renderApp();
  }
}

async function skipOccurrence(id) {
  const state = getState();
  const occurrence = state.occurrences.find((item) => item.id === id);
  if (!occurrence || occurrence.status !== "pending") {
    return;
  }
  runtime.pendingOccurrenceAction = { id, type: "skip" };
  renderApp();
  try {
    const now = new Date().toISOString();
    occurrence.status = "skipped";
    occurrence.skippedAt = now;
    occurrence.nextNotificationAt = null;
    occurrence.updatedAt = now;
    occurrence.googleEventId = "";
    occurrence.calendarSyncedAt = null;
    occurrence.calendarSyncError = "";
    deactivateOneTimeTaskAfterOccurrence(occurrence.taskId, now);
    await persistState("タスクをスキップしました。");
  } finally {
    runtime.pendingOccurrenceAction = null;
    renderApp();
  }
}

function getOverdueOccurrences(state) {
  const now = new Date();
  return state.occurrences
    .filter((item) => item.status === "pending" && new Date(item.scheduledAt) <= now)
    .filter((item) => {
      const task = state.tasks.find((taskItem) => taskItem.id === item.taskId);
      return task?.isActive;
    })
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

function getTodayUpcomingOccurrences(state) {
  const now = new Date();
  const today = toDateKey(now);
  return state.occurrences
    .filter((item) => item.status === "pending" && new Date(item.scheduledAt) > now)
    .filter((item) => toDateKey(new Date(item.scheduledAt)) === today)
    .filter((item) => {
      const task = state.tasks.find((taskItem) => taskItem.id === item.taskId);
      return task?.isActive;
    })
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
}

function getTasksSorted() {
  return [...getState().tasks].sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

function getTaskById(id) {
  return getState().tasks.find((task) => task.id === id);
}

function deactivateOneTimeTaskAfterOccurrence(taskId, updatedAt) {
  const task = getTaskById(taskId);
  if (!task || task.scheduleType !== "once" || !task.isActive) {
    return;
  }
  task.isActive = false;
  task.updatedAt = updatedAt;
}

function ensureUpcomingOccurrences(taskId = null) {
  const state = getState();
  const now = startOfDay(new Date());
  const horizon = addDays(now, OCCURRENCE_WINDOW_DAYS);
  const tasks = taskId ? state.tasks.filter((task) => task.id === taskId) : state.tasks;
  const affectedTaskIds = new Set(tasks.map((task) => task.id));
  const scheduledDatesByTaskId = new Map();

  for (const task of tasks) {
    const existingScheduledKeys = new Set(
      state.occurrences
        .filter((item) => item.taskId === task.id)
        .map((item) => normalizeOccurrenceTimestamp(item.scheduledAt))
    );

    if (!task.isActive) {
      continue;
    }

    const scheduledDates = generateScheduleDates(task, now, horizon);
    scheduledDatesByTaskId.set(task.id, scheduledDates);
    for (const scheduledAt of scheduledDates) {
      if (existingScheduledKeys.has(scheduledAt)) {
        continue;
      }
      const createdAt = new Date().toISOString();
      state.occurrences.push({
        id: crypto.randomUUID(),
        taskId: task.id,
        scheduledAt,
        status: "pending",
        nextNotificationAt: scheduledAt,
        completedAt: null,
        skippedAt: null,
        expiredAt: null,
        googleEventId: "",
        calendarSyncedAt: null,
        calendarSyncError: "",
        createdAt,
        updatedAt: createdAt,
      });
      existingScheduledKeys.add(scheduledAt);
    }
  }

  state.occurrences = state.occurrences.filter((occurrence) => {
    if (occurrence.status !== "pending") {
      return true;
    }
    if (taskId && !affectedTaskIds.has(occurrence.taskId)) {
      return true;
    }
    const task = state.tasks.find((item) => item.id === occurrence.taskId);
    if (!task || !task.isActive) {
      return false;
    }
    const scheduledDates = scheduledDatesByTaskId.get(task.id) || generateScheduleDates(task, now, horizon);
    const scheduledKeys = new Set(scheduledDates.map(normalizeOccurrenceTimestamp));
    return scheduledKeys.has(normalizeOccurrenceTimestamp(occurrence.scheduledAt));
  });
}

function generateScheduleDates(task, start, end) {
  const dates = [];
  const cursor = new Date(start);

  while (cursor <= end) {
    const dateKey = toDateKey(cursor);
    let shouldInclude = false;

    if (task.scheduleType === "once") {
      shouldInclude = task.scheduledDate === dateKey;
    }
    if (task.scheduleType === "daily") {
      shouldInclude = true;
    }
    if (task.scheduleType === "weekly") {
      shouldInclude = task.weekdays.includes(cursor.getDay());
    }
    if (task.scheduleType === "monthly") {
      shouldInclude = cursor.getDate() === getMonthlyScheduledDay(cursor, task.monthlyDay);
    }

    if (shouldInclude) {
      const scheduledAt = combineDateAndTime(dateKey, task.scheduledTime);
      if (scheduledAt) {
        dates.push(scheduledAt);
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function getMonthlyScheduledDay(date, monthlyDay) {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return Math.min(monthlyDay, lastDay);
}

function combineDateAndTime(dateKey, timeKey) {
  const normalizedTime = normalizeTimeKey(timeKey);
  if (!normalizedTime) {
    return null;
  }

  const value = new Date(`${dateKey}T${normalizedTime}:00`);
  if (Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

function getNextNotificationSlot(baseTime, intervalMinutes, nowMs = Date.now()) {
  const baseDate = toValidDate(baseTime);
  if (!baseDate) {
    return null;
  }

  const intervalMs = Math.max(1, Number(intervalMinutes) || 1) * 60 * 1000;
  let nextMs = baseDate.getTime();
  while (nextMs <= nowMs) {
    nextMs += intervalMs;
  }
  return new Date(nextMs).toISOString();
}

function getNextNotificationAt(baseTime, intervalMinutes) {
  const baseDate = toValidDate(baseTime);
  if (!baseDate) {
    return null;
  }

  return new Date(
    baseDate.getTime() + Math.max(1, Number(intervalMinutes) || 1) * 60 * 1000
  ).toISOString();
}

function normalizeOccurrenceTimestamp(value) {
  const date = toValidDate(value);
  return date ? date.toISOString() : String(value || "");
}

async function refreshPushStatus() {
  const state = getState();
  state.settings.pushEnabled = typeof Notification !== "undefined" && Notification.permission === "granted";

  if (runtime.remoteConfig?.pushSupported && "serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      state.settings.pushSubscriptionConfigured = Boolean(subscription);
    } catch {
      state.settings.pushSubscriptionConfigured = false;
    }
  } else {
    state.settings.pushSubscriptionConfigured = false;
  }
}

function startLocalNotificationLoop() {
  if (runtime.localNotificationTimer) {
    return;
  }

  runtime.localNotificationTimer = window.setInterval(() => {
    processLocalDueNotifications().catch((error) => {
      console.error(error);
    });
  }, LOCAL_NOTIFICATION_POLL_MS);
}

async function processLocalDueNotifications() {
  if (!runtime.loaded || runtime.busy || runtime.remoteConfig?.pushSupported) {
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") {
    return;
  }

  const state = getState();
  const now = Date.now();
  const dueOccurrences = state.occurrences
    .filter((occurrence) => occurrence.status === "pending" && occurrence.nextNotificationAt)
    .filter((occurrence) => new Date(occurrence.nextNotificationAt).getTime() <= now)
    .filter((occurrence) => {
      const task = state.tasks.find((item) => item.id === occurrence.taskId);
      return task?.isActive;
    });

  if (!dueOccurrences.length) {
    return;
  }

  for (const occurrence of dueOccurrences) {
    const task = getTaskById(occurrence.taskId);
    if (!task) {
      continue;
    }
    const notifiedAt = new Date().toISOString();
    sendLocalNotification(`実行支援: ${task.title}`, `予定時刻 ${formatDateTime(occurrence.scheduledAt)} のタスクが未完了です。`);
    occurrence.nextNotificationAt = getNextNotificationAt(notifiedAt, task.reminderIntervalMinutes);
    occurrence.updatedAt = notifiedAt;
  }

  await persistState();
}

async function suppressLocalNotificationBacklog() {
  if (!runtime.loaded || runtime.remoteConfig?.pushSupported) {
    return;
  }

  const state = getState();
  const now = Date.now();
  let updated = false;

  for (const occurrence of state.occurrences) {
    if (occurrence.status !== "pending" || !occurrence.nextNotificationAt) {
      continue;
    }

    const task = getTaskById(occurrence.taskId);
    if (!task?.isActive) {
      continue;
    }

    const nextDate = toValidDate(occurrence.nextNotificationAt);
    if (!nextDate || nextDate.getTime() > now) {
      continue;
    }

    const nextSlot = getNextNotificationSlot(
      occurrence.nextNotificationAt,
      task.reminderIntervalMinutes,
      now
    );

    if (nextSlot && nextSlot !== occurrence.nextNotificationAt) {
      occurrence.nextNotificationAt = nextSlot;
      occurrence.updatedAt = new Date().toISOString();
      updated = true;
    }
  }

  if (updated) {
    await persistState();
  }
}

async function requestPushSetup() {
  if (typeof Notification === "undefined") {
    toast("このブラウザでは通知を利用できません。");
    return;
  }

  const permission = await Notification.requestPermission();
  runtime.state.settings.pushEnabled = permission === "granted";

  if (permission !== "granted") {
    toast("通知権限が許可されていません。");
    renderApp();
    return;
  }

  if (!runtime.remoteConfig?.pushSupported) {
    toast("通知権限を許可しました。サーバー側の Push 設定を確認してください。");
    renderApp();
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing || await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(runtime.remoteConfig.vapidPublicKey),
  });

  await postJson("/api/push-subscriptions", subscription.toJSON());
  runtime.state.settings.pushSubscriptionConfigured = true;
  toast("Push 通知を購読しました。");
  renderApp();
}

async function testNotification() {
  if (runtime.remoteConfig?.pushSupported) {
    await postJson("/api/push-test", {
      title: "実行支援のテスト通知",
      body: "サーバー経由の Push 通知テストです。",
    });
    toast("テスト通知を送信しました。");
    return;
  }

  sendLocalNotification("テスト通知", "通知の表示を確認できました。");
}

async function sendLocalNotification(title, body) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    const options = {
      body,
      icon: "./icons/icon.svg",
      badge: "./icons/icon.svg",
      data: { url: "./index.html#/home" },
    };

    try {
      const registration = await Promise.race([
        navigator.serviceWorker?.getRegistration?.(),
        new Promise((resolve) => window.setTimeout(() => resolve(null), 1200)),
      ]);

      if (registration) {
        await registration.showNotification(title, options);
      } else {
        new Notification(title, options);
      }
    } catch {
      try {
        new Notification(title, options);
      } catch {
        // ブラウザ側の通知表示失敗時は toast のみ残す
      }
    }
  }
  toast(`${title}: ${body}`);
}

async function connectGoogleCalendar() {
  const { authUrl } = await fetchJson("/api/google-calendar-connect");
  if (!authUrl) {
    throw new Error("Google Calendar の接続 URL を取得できませんでした。");
  }
  window.location.href = authUrl;
}

async function disconnectGoogleCalendar() {
  const remote = await postJson("/api/google-calendar-disconnect", {});
  applyRemoteState(remote);
  runtime.state.settings.googleCalendarOptions = [];
  toast("Google Calendar 接続を解除しました。");
  renderApp();
}

async function createCalendarTestEvent() {
  const state = getState();
  if (!state.settings.googleCalendarConnected) {
    throw new Error("Google Calendar が未接続です。");
  }
  const result = await postJson("/api/google-calendar-test", {});
  state.settings.lastCalendarTestAt = new Date().toISOString();
  toast(result.htmlLink ? "Google Calendar にテストイベントを登録しました。" : "テストイベントを登録しました。");
  renderApp();
}

async function saveGoogleCalendarTarget() {
  const state = getState();
  if (!state.settings.googleCalendarConnected) {
    throw new Error("Google Calendar が未接続です。");
  }
  if (!state.settings.googleCalendarId) {
    throw new Error("登録先カレンダーを選択してください。");
  }
  const result = await postJson("/api/google-calendar-target", {
    googleCalendarId: state.settings.googleCalendarId,
  });
  state.settings.googleCalendarId = result.calendarId;
  toast("Google Calendar の登録先を保存しました。");
  await refreshGoogleCalendarOptions();
  renderApp();
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      toast("Service Worker の登録に失敗しました。");
    });
  }
}

function markActiveTab(name) {
  document.querySelectorAll(".tabbar a").forEach((link) => {
    link.classList.toggle("active", link.dataset.tab === name);
  });
}

function getState() {
  return runtime.state;
}

async function loadRemoteConfig() {
  try {
    const response = await fetch("/api/state?view=public-config", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function loadStateFromServer() {
  const remote = await fetchJson("/api/state");
  applyRemoteState(remote);
  const countBeforeEnsure = runtime.state.occurrences.length;
  ensureUpcomingOccurrences();
  runtime.loaded = true;
  runtime.loadError = "";
  await refreshGoogleCalendarOptions();
  if (runtime.state.occurrences.length !== countBeforeEnsure) {
    await persistState();
  }
}

async function loadTasksForList() {
  if (parseRoute(location.hash || "#/home").name !== "tasks") {
    return;
  }

  const remote = await fetchJson("/api/tasks");
  runtime.state.tasks = Array.isArray(remote.tasks) ? remote.tasks : [];
}

async function loadRouteData() {
  await loadTasksForList();
}

function mergeState(candidate) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...candidate,
    settings: {
      ...structuredClone(DEFAULT_STATE).settings,
      ...(candidate.settings || {}),
    },
  };
}

async function persistState(successMessage = "") {
  if (runtime.busy) {
    throw new Error("別の保存処理が進行中です。");
  }

  runtime.busy = true;
  try {
    const state = getState();
    const remote = await postJson("/api/state", {
      tasks: state.tasks,
      occurrences: state.occurrences,
    });
    applyRemoteState(remote);
    runtime.state.settings.remoteSyncHealthy = true;
    runtime.state.settings.lastRemoteSyncAt = new Date().toISOString();
    runtime.state.settings.lastRemoteSyncError = "";
    if (successMessage) {
      toast(successMessage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Supabase への保存に失敗しました。";
    runtime.state.settings.remoteSyncHealthy = false;
    runtime.state.settings.lastRemoteSyncError = message;
    throw new Error(message);
  } finally {
    runtime.busy = false;
  }
}

function applyRemoteState(remote) {
  runtime.state = mergeState({
    ...structuredClone(DEFAULT_STATE),
    ...runtime.state,
    ...remote,
    settings: {
      ...structuredClone(DEFAULT_STATE).settings,
      ...runtime.state.settings,
      ...(remote.settings || {}),
      remoteSyncEnabled: true,
      remoteSyncHealthy: true,
      lastRemoteSyncError: "",
      googleCalendarOptions: runtime.state.settings.googleCalendarOptions || [],
    },
  });
}

async function refreshGoogleCalendarOptions() {
  if (!runtime.state.settings.googleCalendarConnected) {
    runtime.state.settings.googleCalendarOptions = [];
    return;
  }

  try {
    const remote = await fetchJson("/api/google-calendar-calendars");
    runtime.state.settings.googleCalendarOptions = Array.isArray(remote.calendars) ? remote.calendars : [];
  } catch (error) {
    runtime.state.settings.googleCalendarOptions = [];
    runtime.state.settings.lastRemoteSyncError = error instanceof Error ? error.message : "Google Calendar 一覧の取得に失敗しました。";
  }
}

function announceRouteNotice() {
  const route = parseRoute(location.hash || "#/home");
  const query = parseRouteQuery(location.hash || "");
  if (route.name !== "settings" || !query.calendar) {
    return;
  }

  const key = `${query.calendar}:${query.reason || ""}`;
  if (runtime.lastRouteNotice === key) {
    return;
  }
  runtime.lastRouteNotice = key;

  if (query.calendar === "connected") {
    toast("Google Calendar を接続しました。");
  } else if (query.calendar === "error") {
    toast(query.reason || "Google Calendar の接続に失敗しました。");
  }

  const baseHash = `#/settings`;
  history.replaceState(null, "", `${location.pathname}${location.search}${baseHash}`);
}

function parseRouteQuery(hash) {
  const [, query = ""] = hash.split("?");
  return Object.fromEntries(new URLSearchParams(query).entries());
}

function updateTasksPage(page) {
  const safePage = Math.max(1, page);
  location.hash = `#/tasks?page=${safePage}`;
}

function formatCalendarOptionLabel(calendar) {
  const badges = [];
  if (calendar.primary) {
    badges.push("メイン");
  }
  if (calendar.accessRole) {
    badges.push(calendar.accessRole);
  }
  return badges.length ? `${calendar.summary} (${badges.join(" / ")})` : calendar.summary;
}

function formatTaskRule(task) {
  if (task.scheduleType === "once") {
    return `1回だけ / ${task.scheduledDate} ${task.scheduledTime}`;
  }
  if (task.scheduleType === "daily") {
    return `毎日 / ${task.scheduledTime}`;
  }
  if (task.scheduleType === "monthly") {
    return `毎月${task.monthlyDay}日 / ${task.scheduledTime}`;
  }
  return `曜日指定 / ${task.weekdays.map((weekday) => DAY_NAMES[weekday]).join("・")} / ${task.scheduledTime}`;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = toValidDate(value);
  if (!date) {
    return "日時不正";
  }
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRelativeMinutes(isoString) {
  const date = toValidDate(isoString);
  if (!date) {
    return "日時不正";
  }
  const diff = Math.max(0, Date.now() - date.getTime());
  const minutes = Math.floor(diff / (60 * 1000));
  if (minutes < 60) {
    return `${minutes}分超過`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分超過`;
}

function permissionLabel(permission) {
  if (permission === "granted") {
    return "許可済み";
  }
  if (permission === "denied") {
    return "拒否";
  }
  if (permission === "default") {
    return "未確認";
  }
  return "非対応";
}

function toast(message) {
  const root = document.getElementById("toast-root");
  if (!root) {
    return;
  }
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  root.appendChild(element);
  window.setTimeout(() => element.remove(), 3200);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function toDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function normalizeTimeKey(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const [hours = "", minutes = ""] = raw.split(":");
  if (!hours || !minutes) {
    return "";
  }
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

function toValidDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`${url} の応答が ${REQUEST_TIMEOUT_MS / 1000} 秒以内に返りませんでした。Vercel dev のログと Supabase 接続設定を確認してください。`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

window.addEventListener("error", (event) => {
  toast(event.error?.message || "エラーが発生しました。");
});
