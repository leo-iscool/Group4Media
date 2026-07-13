/* Macro Tracker — photo → macros via Claude vision, daily goal tracking.
   All data stays on-device: settings in localStorage, entries in IndexedDB. */

(() => {
"use strict";

/* ================= settings ================= */

const DEFAULT_GOALS = { calories: 2000, protein: 150, carbs: 200, fat: 65 };
const SETTINGS_KEY = "macrotracker.settings";

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return {
      apiKey: raw.apiKey || "",
      goalMode: raw.goalMode === "target" ? "target" : "under",
      goals: { ...DEFAULT_GOALS, ...(raw.goals || {}) },
    };
  } catch {
    return { apiKey: "", goalMode: "under", goals: { ...DEFAULT_GOALS } };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let settings = loadSettings();

/* ================= IndexedDB ================= */

const DB_NAME = "macro-tracker";
const STORE = "entries";
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("dateKey", "dateKey");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function dbAdd(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ================= date helpers ================= */

function dateKeyOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const todayKey = () => dateKeyOf(new Date());

function keyMinusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKeyOf(d);
}

function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  if (key === todayKey()) return "Today";
  if (key === keyMinusDays(1)) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function weekdayLetter(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "narrow" });
}

/* ================= goal logic ================= */

function dayTotals(entries) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) {
    t.calories += e.calories || 0;
    t.protein += e.protein || 0;
    t.carbs += e.carbs || 0;
    t.fat += e.fat || 0;
  }
  return t;
}

function calorieGoalHit(totalCal, goals, mode) {
  if (mode === "target") {
    // round the band edges so e.g. 2000 * 0.9 (1800.0000000000002 in JS) doesn't exclude exactly 1800
    return totalCal >= Math.round(goals.calories * 0.9) && totalCal <= Math.round(goals.calories * 1.1);
  }
  return totalCal <= goals.calories; // "stay under"
}

const proteinGoalHit = (totalPro, goals) => totalPro >= goals.protein;

/* Consecutive days hitting the calorie goal, counting back from yesterday;
   today is included only once it already qualifies and has entries. */
function computeStreak(byDay) {
  let streak = 0;
  const today = byDay.get(todayKey());
  if (today && today.length && calorieGoalHit(dayTotals(today).calories, settings.goals, settings.goalMode)) {
    streak++;
  }
  for (let i = 1; i < 3650; i++) {
    const entries = byDay.get(keyMinusDays(i));
    if (!entries || !entries.length) break;
    if (!calorieGoalHit(dayTotals(entries).calories, settings.goals, settings.goalMode)) break;
    streak++;
  }
  return streak;
}

/* ================= Claude vision ================= */

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";

const FOOD_SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean", description: "Whether the image shows edible food or drink" },
    food_name: { type: "string", description: "Short name of the dish or food, e.g. 'Chicken burrito'" },
    portion_estimate: { type: "string", description: "Estimated portion size visible in the photo, e.g. '1 large bowl (~450g)'" },
    calories: { type: "number", description: "Estimated total calories (kcal) for the visible portion" },
    protein_g: { type: "number", description: "Estimated grams of protein" },
    carbs_g: { type: "number", description: "Estimated grams of carbohydrates" },
    fat_g: { type: "number", description: "Estimated grams of fat" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    notes: { type: "string", description: "One short sentence of caveats or assumptions" }
  },
  required: ["is_food", "food_name", "portion_estimate", "calories", "protein_g", "carbs_g", "fat_g", "confidence", "notes"],
  additionalProperties: false
};

async function analyzeFoodPhoto(base64Jpeg) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      output_config: { format: { type: "json_schema", schema: FOOD_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text:
            "Identify the food in this photo and estimate its nutrition for the portion shown. " +
            "Be realistic about portion size using visual cues (plate size, utensils, packaging). " +
            "If multiple items are visible, estimate the combined total. " +
            "If the image does not show food or drink, set is_food to false." }
        ]
      }]
    })
  });

  if (!res.ok) {
    let msg = `API error (${res.status})`;
    try { msg = (await res.json()).error?.message || msg; } catch { /* keep default */ }
    if (res.status === 401) msg = "Invalid API key — check it in Settings.";
    if (res.status === 429) msg = "Rate limited — wait a moment and try again.";
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("Claude declined to analyze this image. Try a different photo.");
  }
  const text = (data.content || []).find(b => b.type === "text")?.text;
  if (!text) throw new Error("Empty response from the API.");
  return JSON.parse(text);
}

/* ================= image processing ================= */

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

function drawScaled(img, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

async function processPhoto(file) {
  const { img, url } = await readImage(file);
  try {
    const apiDataUrl = drawScaled(img, 1024, 0.8);     // sent to Claude
    const thumbDataUrl = drawScaled(img, 200, 0.7);    // stored with the entry
    return { apiBase64: apiDataUrl.split(",")[1], thumbDataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ================= DOM helpers ================= */

const $ = id => document.getElementById(id);

let toastTimer = null;
function toast(msg, isError) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("error", !!isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* ================= views ================= */

function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.classList.add("hidden");
  $(`view-${name}`).classList.remove("hidden");
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("active", t.dataset.view === name);
  }
  if (name === "today") renderToday();
  if (name === "history") renderHistory();
  if (name === "settings") renderSettings();
}

/* ---------- Today ---------- */

function setBar(barEl, numsEl, value, goal, unit) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  barEl.style.width = `${pct}%`;
  barEl.classList.toggle("over", goal > 0 && value > goal);
  numsEl.textContent = `${Math.round(value)} / ${goal}${unit}`;
}

async function renderToday() {
  const all = await dbAll();
  const byDay = groupByDay(all);
  const entries = (byDay.get(todayKey()) || []).sort((a, b) => b.timestamp - a.timestamp);
  const totals = dayTotals(entries);
  const g = settings.goals;

  $("today-date").textContent = new Date().toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric" });

  // remaining headline
  const remaining = g.calories - totals.calories;
  const head = $("remaining-headline");
  if (remaining >= 0) {
    head.textContent = `${Math.round(remaining)} kcal left`;
    head.className = "remaining-headline " + (remaining < g.calories * 0.15 ? "near" : "ok");
    $("remaining-sub").textContent = settings.goalMode === "target"
      ? `Goal: hit ${g.calories} kcal (±10%)` : `Goal: stay under ${g.calories} kcal`;
  } else {
    head.textContent = `${Math.round(-remaining)} kcal over`;
    head.className = "remaining-headline over";
    $("remaining-sub").textContent = `Goal was ${g.calories} kcal`;
  }

  setBar($("cal-bar"), $("cal-nums"), totals.calories, g.calories, "");
  setBar($("pro-bar"), $("pro-nums"), totals.protein, g.protein, " g");
  setBar($("carb-bar"), $("carb-nums"), totals.carbs, g.carbs, " g");
  setBar($("fat-bar"), $("fat-nums"), totals.fat, g.fat, " g");

  // streak
  const streak = computeStreak(byDay);
  $("streak-badge").classList.toggle("hidden", streak < 2);
  $("streak-count").textContent = `${streak}-day streak`;

  renderRecents(all);

  // entry list
  const list = $("today-entries");
  list.innerHTML = "";
  $("today-empty").classList.toggle("hidden", entries.length > 0);
  for (const e of entries) list.appendChild(entryRow(e, true));
}

function entryRow(e, deletable) {
  const li = document.createElement("li");
  li.className = "entry";

  if (e.thumb) {
    const img = document.createElement("img");
    img.className = "entry-thumb";
    img.src = e.thumb;
    img.alt = "";
    li.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "entry-thumb placeholder";
    ph.textContent = "🍽️";
    li.appendChild(ph);
  }

  const info = document.createElement("div");
  info.className = "entry-info";
  const name = document.createElement("div");
  name.className = "entry-name";
  name.textContent = e.name;
  const macros = document.createElement("div");
  macros.className = "entry-macros";
  const time = new Date(e.timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  macros.textContent = `${time} · P ${Math.round(e.protein)} · C ${Math.round(e.carbs)} · F ${Math.round(e.fat)}`;
  info.append(name, macros);
  li.appendChild(info);

  const cal = document.createElement("div");
  cal.className = "entry-cal";
  cal.innerHTML = `${Math.round(e.calories)}<small> kcal</small>`;
  li.appendChild(cal);

  if (deletable) {
    const del = document.createElement("button");
    del.className = "entry-delete";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Delete ${e.name}`);
    del.addEventListener("click", async () => {
      await dbDelete(e.id);
      toast(`Deleted ${e.name}`);
      renderToday();
    });
    li.appendChild(del);
  }
  return li;
}

/* Most frequent recent foods for one-tap re-logging. */
function renderRecents(all) {
  const seen = new Map(); // name -> {entry, count}
  for (const e of [...all].sort((a, b) => b.timestamp - a.timestamp)) {
    const key = e.name.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, { entry: e, count: 0 });
    seen.get(key).count++;
  }
  const recents = [...seen.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  $("recents-section").classList.toggle("hidden", recents.length === 0);
  const row = $("recents-row");
  row.innerHTML = "";
  for (const { entry } of recents) {
    const chip = document.createElement("button");
    chip.className = "recent-chip";
    chip.innerHTML = `${escapeHtml(entry.name)}<span class="chip-cal">${Math.round(entry.calories)} kcal</span>`;
    chip.addEventListener("click", async () => {
      await dbAdd(makeEntry({
        name: entry.name, portion: entry.portion,
        calories: entry.calories, protein: entry.protein,
        carbs: entry.carbs, fat: entry.fat, thumb: entry.thumb,
      }));
      toast(`Logged ${entry.name} again`);
      renderToday();
    });
    row.appendChild(chip);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ---------- History ---------- */

function groupByDay(all) {
  const byDay = new Map();
  for (const e of all) {
    if (!byDay.has(e.dateKey)) byDay.set(e.dateKey, []);
    byDay.get(e.dateKey).push(e);
  }
  return byDay;
}

async function renderHistory() {
  const all = await dbAll();
  const byDay = groupByDay(all);
  renderWeekChart(byDay);

  const pastKeys = [...byDay.keys()].filter(k => k !== todayKey()).sort().reverse();
  $("history-empty").classList.toggle("hidden", pastKeys.length > 0);

  const list = $("history-days");
  list.innerHTML = "";
  for (const key of pastKeys) {
    const entries = byDay.get(key).sort((a, b) => b.timestamp - a.timestamp);
    const totals = dayTotals(entries);
    const calHit = calorieGoalHit(totals.calories, settings.goals, settings.goalMode);
    const proHit = proteinGoalHit(totals.protein, settings.goals);

    const li = document.createElement("li");
    li.className = "history-day";

    const head = document.createElement("button");
    head.className = "history-day-head";
    head.innerHTML = `
      <div>
        <div class="history-day-date">${prettyDate(key)}</div>
        <div class="history-day-macros">${Math.round(totals.calories)} kcal · P ${Math.round(totals.protein)} · C ${Math.round(totals.carbs)} · F ${Math.round(totals.fat)}</div>
      </div>
      <div class="day-badges">
        <span class="badge ${calHit ? "hit" : "miss"}">${calHit ? "✓ cal" : "✗ cal"}</span>
        <span class="badge ${proHit ? "hit" : "miss"}">${proHit ? "✓ pro" : "✗ pro"}</span>
      </div>`;

    const body = document.createElement("div");
    body.className = "history-day-body hidden";
    const ul = document.createElement("ul");
    ul.className = "entry-list";
    for (const e of entries) ul.appendChild(entryRow(e, false));
    body.appendChild(ul);

    head.addEventListener("click", () => body.classList.toggle("hidden"));
    li.append(head, body);
    list.appendChild(li);
  }
}

function renderWeekChart(byDay) {
  const chart = $("week-chart");
  chart.innerHTML = "";
  const g = settings.goals;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = keyMinusDays(i);
    const entries = byDay.get(key) || [];
    days.push({ key, cal: dayTotals(entries).calories, has: entries.length > 0 });
  }

  const maxCal = Math.max(g.calories, ...days.map(d => d.cal), 1);

  // dashed goal line across the chart
  const goalLine = document.createElement("div");
  goalLine.className = "goal-line";
  goalLine.style.bottom = `${(g.calories / maxCal) * 82 + 18}px`;
  chart.appendChild(goalLine);

  let hits = 0, scored = 0, calSum = 0;
  for (const d of days) {
    const col = document.createElement("div");
    col.className = "chart-col";
    const bar = document.createElement("div");
    bar.className = "chart-bar";
    bar.style.height = `${(d.cal / maxCal) * 82}px`;
    if (d.has) {
      const hit = calorieGoalHit(d.cal, g, settings.goalMode);
      bar.classList.add(hit ? "hit" : "miss");
      if (d.key !== todayKey()) { scored++; if (hit) hits++; }
      calSum += d.cal;
    }
    const label = document.createElement("div");
    label.className = "chart-day-label";
    label.textContent = weekdayLetter(d.key);
    col.append(bar, label);
    chart.appendChild(col);
  }

  const activeDays = days.filter(d => d.has);
  $("avg-cal").textContent = activeDays.length ? Math.round(calSum / activeDays.length) : "–";
  const proSum = activeDays.reduce((s, d) => s + dayTotals(byDay.get(d.key) || []).protein, 0);
  $("avg-pro").textContent = activeDays.length ? `${Math.round(proSum / activeDays.length)} g` : "–";
  $("hit-rate").textContent = scored ? `${hits}/${scored}` : "–";
}

/* ---------- Settings ---------- */

function renderSettings() {
  $("api-key-input").value = settings.apiKey;
  $("goal-cal").value = settings.goals.calories;
  $("goal-pro").value = settings.goals.protein;
  $("goal-carb").value = settings.goals.carbs;
  $("goal-fat").value = settings.goals.fat;
  $("goal-mode").value = settings.goalMode;
}

function bindSettings() {
  $("save-settings").addEventListener("click", () => {
    settings = {
      apiKey: $("api-key-input").value.trim(),
      goalMode: $("goal-mode").value,
      goals: {
        calories: Math.max(0, Number($("goal-cal").value) || 0),
        protein: Math.max(0, Number($("goal-pro").value) || 0),
        carbs: Math.max(0, Number($("goal-carb").value) || 0),
        fat: Math.max(0, Number($("goal-fat").value) || 0),
      },
    };
    saveSettings(settings);
    const note = $("settings-saved");
    note.classList.remove("hidden");
    setTimeout(() => note.classList.add("hidden"), 2000);
  });

  $("export-csv").addEventListener("click", () => exportData("csv"));
  $("export-json").addEventListener("click", () => exportData("json"));
}

async function exportData(format) {
  const all = (await dbAll()).sort((a, b) => a.timestamp - b.timestamp);
  let blob, filename;
  if (format === "csv") {
    const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["date", "time", "name", "portion", "calories", "protein_g", "carbs_g", "fat_g"]];
    for (const e of all) {
      const d = new Date(e.timestamp);
      rows.push([e.dateKey, d.toTimeString().slice(0, 5), e.name, e.portion || "",
        e.calories, e.protein, e.carbs, e.fat]);
    }
    blob = new Blob([rows.map(r => r.map(esc).join(",")).join("\n")], { type: "text/csv" });
    filename = "macro-tracker.csv";
  } else {
    const clean = all.map(({ thumb, ...rest }) => rest);
    blob = new Blob([JSON.stringify(clean, null, 2)], { type: "application/json" });
    filename = "macro-tracker.json";
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Exported ${all.length} entries`);
}

/* ================= review sheet ================= */

let pendingThumb = null;

function openSheet({ analyzing = false, title = "Review entry" } = {}) {
  $("sheet-title").textContent = title;
  $("analyze-state").classList.toggle("hidden", !analyzing);
  $("review-form").classList.toggle("hidden", analyzing);
  $("sheet-backdrop").classList.remove("hidden");
  $("review-sheet").classList.remove("hidden");
}

function closeSheet() {
  $("sheet-backdrop").classList.add("hidden");
  $("review-sheet").classList.add("hidden");
  $("review-thumb").classList.add("hidden");
  $("review-meta").textContent = "";
  pendingThumb = null;
  for (const id of ["review-name", "review-portion", "review-cal", "review-pro", "review-carb", "review-fat"]) {
    $(id).value = "";
  }
}

function fillReview(result, thumbDataUrl) {
  if (thumbDataUrl) {
    $("review-thumb").src = thumbDataUrl;
    $("review-thumb").classList.remove("hidden");
    pendingThumb = thumbDataUrl;
  }
  $("review-name").value = result.food_name || "";
  $("review-portion").value = result.portion_estimate || "";
  $("review-cal").value = Math.round(result.calories || 0);
  $("review-pro").value = Math.round(result.protein_g || 0);
  $("review-carb").value = Math.round(result.carbs_g || 0);
  $("review-fat").value = Math.round(result.fat_g || 0);
  const bits = [];
  if (result.confidence) bits.push(`Confidence: ${result.confidence}`);
  if (result.notes) bits.push(result.notes);
  $("review-meta").textContent = bits.join(" · ");
}

function makeEntry(fields) {
  const now = new Date();
  return {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    dateKey: dateKeyOf(now),
    timestamp: now.getTime(),
    name: fields.name,
    portion: fields.portion || "",
    calories: Number(fields.calories) || 0,
    protein: Number(fields.protein) || 0,
    carbs: Number(fields.carbs) || 0,
    fat: Number(fields.fat) || 0,
    thumb: fields.thumb || null,
  };
}

function bindReviewSheet() {
  $("review-cancel").addEventListener("click", closeSheet);
  $("sheet-backdrop").addEventListener("click", closeSheet);

  $("review-save").addEventListener("click", async () => {
    const name = $("review-name").value.trim();
    if (!name) { toast("Give this entry a name.", true); return; }
    await dbAdd(makeEntry({
      name,
      portion: $("review-portion").value.trim(),
      calories: $("review-cal").value,
      protein: $("review-pro").value,
      carbs: $("review-carb").value,
      fat: $("review-fat").value,
      thumb: pendingThumb,
    }));
    closeSheet();
    toast(`Added ${name}`);
    showView("today");
  });
}

/* ================= photo flow ================= */

function bindCapture() {
  $("camera-fab").addEventListener("click", () => {
    if (!settings.apiKey) {
      toast("Add your Claude API key in Settings first.", true);
      showView("settings");
      return;
    }
    $("photo-input").click();
  });

  $("photo-input").addEventListener("change", async ev => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    openSheet({ analyzing: true, title: "Analyzing photo" });
    try {
      const { apiBase64, thumbDataUrl } = await processPhoto(file);
      const result = await analyzeFoodPhoto(apiBase64);
      if (!result.is_food) {
        closeSheet();
        toast("That doesn't look like food — you can still add it manually.", true);
        return;
      }
      $("sheet-title").textContent = "Review entry";
      $("analyze-state").classList.add("hidden");
      $("review-form").classList.remove("hidden");
      fillReview(result, thumbDataUrl);
    } catch (err) {
      closeSheet();
      toast(err.message || "Something went wrong.", true);
    }
  });

  $("manual-fab").addEventListener("click", () => {
    openSheet({ title: "Manual entry" });
  });
}

/* ================= boot ================= */

function bindTabs() {
  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => showView(t.dataset.view));
  }
}

function boot() {
  bindTabs();
  bindSettings();
  bindReviewSheet();
  bindCapture();
  renderSettings();
  showView("today");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is optional */ });
  }
}

document.addEventListener("DOMContentLoaded", boot);

/* exposed for testing */
window.__mt = { dbAdd, dbAll, dateKeyOf, makeEntry, get settings() { return settings; } };

})();
