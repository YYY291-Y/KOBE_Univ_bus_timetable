const $ = id => document.getElementById(id);

const DATA_URLS = {
  timetable: "./timetable.json",
  calendar: "./calendar.json"
};
const CSV_PASSWORD_HASH = "93659296c53c498ea585f5fdb98d39789de6029a0b7c26ce769e807b3e38225c";

const destinations = [
  { name: "文理農学部前", target: "神大文理農学部前", routes: ["36"] },
  { name: "本部工学部前", target: "神大本部工学部前", routes: ["36"] },
  { name: "正門前", target: "神大正門前", routes: ["36"] },
  { name: "人間発達環境学研究科前", target: "神大人間発達環境学研究科前", routes: ["36"] },
  { name: "国際文化学研究科前・東門", target: ["神大国際文化学研究科前", "神大国際文化学研究科東門"], routes: ["16", "106", "直行16"] },
  { name: "国際文化学研究科前・本部工学部前", target: ["神大国際文化学研究科前", "神大本部工学部前"], routes: ["16", "106", "36"] }
];

const state = {
  timetable: [],
  calendar: null,
  destination: destinations[0].name,
  mode: "next",
  origin: "JR六甲道",
  csvActive: false,
  serviceWorkerRegistration: null
};

const ORIGINS = ["JR六甲道", "六甲口", "阪急六甲"];

function hhmm(value) {
  return /^\d{4}$/.test(String(value)) ? `${value.slice(0, 2)}:${value.slice(2)}` : value;
}

// 0時からの経過分数を HH:MM 形式に変換
function formatMinutes(value) {
  const total = Number(value);
  if (!Number.isFinite(total)) return "--:--";

  const hours = Math.floor(total / 60);
  const minutes = total % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function toMinutes(value) {
  return /^\d{4}$/.test(String(value).trim())
    ? Number(String(value).trim().slice(0, 2)) * 60 + Number(String(value).trim().slice(2))
    : null;
}

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function routeName(value) {
  return String(value || "").split("（")[0];
}

function displayRouteName(value) {
  const name = routeName(value);
  return name === "直行16" ? "直16" : name;
}

function targetFor(row, destination) {
  const route = routeName(row["系統番号・運行区分"]);
  if (destination.name === "国際文化学研究科前・本部工学部前") {
    if (route === "16" || route === "106") return "神大国際文化学研究科前";
    if (route === "36") return "神大本部工学部前";
  }
  if (destination.name === "国際文化学研究科前・東門") {
    if (route === "直行16") return "神大国際文化学研究科東門";
    if (route === "16" || route === "106") return "神大国際文化学研究科前";
  }
  return Array.isArray(destination.target)
    ? destination.target.find(stop => toMinutes(row[stop]) !== null)
    : destination.target;
}

function isEligible(row, destination, origin) {
  const route = routeName(row["系統番号・運行区分"]);
  const target = targetFor(row, destination);
  if (!destination.routes.includes(route) || !target) return false;
  if (["BBBB", "AAAA"].includes(String(row[origin] || "").trim())) return false;
  if (toMinutes(row[origin]) === null || toMinutes(row[target]) === null) return false;
  if (destination.name === "国際文化学研究科前・本部工学部前") {
    return ["16", "106", "36"].includes(route);
  }
  if (destination.name === "国際文化学研究科前・東門") {
    return ["16", "106", "直行16"].includes(route);
  }
  return route === "36" && target === destination.target;
}

function getAutoDayInfo(date = new Date()) {
  const key = dateKey(date);
  const weekday = date.getDay();
  const calendar = state.calendar;

  if (!calendar) throw new Error("カレンダーデータが読み込まれていません。");

  if (weekday === 0 || weekday === 6 || calendar.holidays.includes(key)) {
    return { code: "HT", label: "土日祝ダイヤ", override: null };
  }

  const override = calendar.calendarOverrides?.[key] || null;
  const isClassDay = calendar.classDays.includes(key);

  if (isClassDay) {
    const effectiveDay = override?.classDay || ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][weekday];
    const isFridayClass = effectiveDay === "FRI";
    return {
      code: isFridayClass ? "FRI_CLASS" : "WD_CLASS",
      label: isFridayClass ? "金（授業日）ダイヤ" : "月～木（授業日）ダイヤ",
      override
    };
  }

  return weekday === 5
    ? { code: "FRI_OFF", label: "金（休校日）ダイヤ", override: null }
    : { code: "WD_OFF", label: "月～木（休校日）ダイヤ", override: null };
}

function activeDayType() {
  const selected = $("dayTypeSub")?.value || "AUTO";
  return selected === "AUTO" ? getAutoDayInfo().code : selected;
}

function isOperating(row) {
  const mark = String(row["運転日識別記号"] || "").trim();
  const selected = activeDayType();

  if (selected === "WD_CLASS") {
    return ["WD", "WD_NOT_FRI", "WD_HOL", "WD_DIRECT"].includes(mark);
  }
  if (selected === "WD_OFF" || selected === "FRI_OFF") return mark === "WD";
  if (selected === "FRI_CLASS") {
    return ["WD", "WD_FRI", "WD_HOL"].includes(mark);
  }
  if (selected === "HT") return ["HT", "SAT", "SUN", "HOL"].includes(mark);
  return false;
}

function renderDestinations() {
  $("destinations").innerHTML = destinations.map((destination, index) => `
    <button class="choice ${destination.name === state.destination ? "active" : ""}" data-destination="${index}" type="button">
      ${destination.name}<small>${destination.routes.join("・")}系統</small>
    </button>
  `).join("");

  document.querySelectorAll("[data-destination]").forEach(button => {
    button.addEventListener("click", () => {
      state.destination = destinations[Number(button.dataset.destination)].name;
      renderDestinations();
      renderOrigins();
      render();
    });
  });
}

function renderOrigins() {
  const destination = destinations.find(item => item.name === state.destination);
  if (!ORIGINS.includes(state.origin)) state.origin = ORIGINS[0];
  $("origin").innerHTML = ORIGINS.map(origin =>
    `<option value="${origin}" ${origin === state.origin ? "selected" : ""}>${origin}</option>`
  ).join("");
  $("origin").onchange = () => {
    state.origin = $("origin").value;
    render();
  };
}

function renderCalendarInfo() {
  const dia = $("todayDiaText");
  const notice = $("calendarNotice");
  if (state.mode !== "next") {
    dia.hidden = true;
    notice.hidden = true;
    return;
  }

  const info = getAutoDayInfo();
  dia.hidden = false;
  dia.textContent = `今日は ${info.label}`;

  if (info.override) {
    const weekdayNames = { MON: "月曜日", TUE: "火曜日", WED: "水曜日", THU: "木曜日", FRI: "金曜日" };
    const effectiveName = weekdayNames[info.override.classDay] || "指定曜日";
    notice.textContent = `振替授業日です。本日は${effectiveName}の授業を実施するため、${info.label}で運行します。`;
    notice.hidden = false;
  } else {
    notice.hidden = true;
    notice.textContent = "";
  }
}

function render() {
  if (!state.timetable.length || !state.calendar) return;

  const destination = destinations.find(item => item.name === state.destination);
  const now = new Date();
  const base = state.mode === "time"
    ? toMinutes(($("searchTime").value || "00:00").replace(":", ""))
    : now.getHours() * 60 + now.getMinutes();

  const list = state.timetable
    .filter(row => isEligible(row, destination, state.origin) && isOperating(row))
    .map(row => {
      const target = targetFor(row, destination);
      return { row, target, depart: toMinutes(row[state.origin]), arrive: toMinutes(row[target]) };
    })
    .filter(item => item.depart !== null && item.arrive !== null && item.depart >= base)
    .sort((a, b) => a.depart - b.depart)
    .slice(0, 5);

  renderCalendarInfo();
  $("status").textContent = (state.mode === "next"
    ? `現在時刻 ${now.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : `${hhmm(String(Math.floor(base / 60)).padStart(2, "0") + String(base % 60).padStart(2, "0"))} 以降`)
    + ` · ${state.origin} 発`;

  $("results").innerHTML = list.length ? list.map(item => {
    const route = routeName(item.row["系統番号・運行区分"]);
    const displayRoute = displayRouteName(item.row["系統番号・運行区分"]);
    const isJR = String(item.row["系統番号・運行区分"]).includes("JR六甲道発");
    const isHankyu = String(item.row["系統番号・運行区分"]).includes("阪急六甲発");
    const startBadge = isJR
      ? '<span class="start-badge start-jr">JR始発</span>'
      : isHankyu
        ? '<span class="start-badge start-hankyu">阪急始発</span>'
        : '<span class="start-badge hidden">始発</span>';
    const badgeClass = route === "16" ? "r16" : route === "直行16" ? "r16d" : route === "106" ? "r106" : "r36";

    return `
      <article class="bus">
        <div class="times">
          <div><div class="time-label">発車</div><div class="time">${formatMinutes(item.depart)}</div></div>
          <div class="arrow">→</div>
          <div><div class="time-label">${item.target}到着</div><div class="time">${formatMinutes(item.arrive)}</div></div>
        </div>
        <div class="busmeta">
          <div class="busmeta-header">
            <span class="badge ${badgeClass}">${displayRoute}</span>
            <span class="bus-destination">${item.row["行先"]}行き</span>
          </div>
          <div class="start-badge-container">${startBadge}</div>
        </div>
      </article>`;
  }).join("") : '<div class="empty">該当する便がありません。時刻や出発停留所を変更してください。</div>';
}

function setMode(mode) {
  state.mode = mode;
  $("nextMode").classList.toggle("active", mode === "next");
  $("timeMode").classList.toggle("active", mode === "time");
  $("timeBox").hidden = mode !== "time";
  render();
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSVにデータ行がありません。");
  const headers = parseCsvLine(lines[0]).map(value => value.trim());
  const required = ["運転日識別記号", "系統番号・運行区分", "便識別番号", "行先", ...ORIGINS];
  const missing = required.filter(key => !headers.includes(key));
  if (missing.length) throw new Error(`必要な列がありません：${missing.join("、")}`);
  return lines.slice(1).filter(line => line.trim()).map(line => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((header, index) => row[header] = (values[index] || "").trim());
    return row;
  });
}

async function unlockCsvTools() {
  const password = $("developerPassword").value;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== CSV_PASSWORD_HASH) {
    $("csvAuthStatus").textContent = "パスワードが違います。";
    $("csvTools").hidden = true;
    return;
  }
  $("csvAuthStatus").textContent = "ロックを解除しました。";
  $("csvTools").hidden = false;
  $("developerPassword").value = "";
}

async function loadExternalData() {
  $("status").textContent = "時刻表・運行日データを読み込んでいます…";
  const [timetableResponse, calendarResponse] = await Promise.all([
    fetch(DATA_URLS.timetable, { cache: "no-cache" }),
    fetch(DATA_URLS.calendar, { cache: "no-cache" })
  ]);
  if (!timetableResponse.ok) throw new Error(`timetable.json の読み込みに失敗しました（${timetableResponse.status}）。`);
  if (!calendarResponse.ok) throw new Error(`calendar.json の読み込みに失敗しました（${calendarResponse.status}）。`);

  const timetableJson = await timetableResponse.json();
  const calendarJson = await calendarResponse.json();
  if (!Array.isArray(timetableJson["時刻表データ"])) throw new Error("timetable.json の形式が正しくありません。");
  if (!Array.isArray(calendarJson.classDays) || !Array.isArray(calendarJson.holidays) || !calendarJson.calendarOverrides) {
    throw new Error("calendar.json の形式が正しくありません。");
  }

  state.timetable = timetableJson["時刻表データ"];
  state.calendar = calendarJson;
}

function setupEvents() {
  $("nextMode").addEventListener("click", () => setMode("next"));
  $("timeMode").addEventListener("click", () => setMode("time"));
  $("refresh").addEventListener("click", render);
  $("searchTime").addEventListener("change", render);
  $("dayTypeSub").addEventListener("change", render);
  $("unlockCsv").addEventListener("click", unlockCsvTools);
  $("developerPassword").addEventListener("keydown", event => {
    if (event.key === "Enter") unlockCsvTools();
  });

  $("csvFile").addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.length) throw new Error("CSVに有効な便データがありません。");
      state.timetable = parsed;
      state.csvActive = true;
      $("csvStatus").textContent = `${parsed.length}便を読み込みました（この画面内のみ）。`;
      render();
    } catch (error) {
      $("csvStatus").textContent = error.message || "CSVを読み込めませんでした。";
    }
  });

  $("restoreJson").addEventListener("click", async () => {
    try {
      const response = await fetch(DATA_URLS.timetable, { cache: "no-cache" });
      if (!response.ok) throw new Error("外部JSONを読み込めませんでした。");
      const json = await response.json();
      state.timetable = json["時刻表データ"];
      state.csvActive = false;
      $("csvStatus").textContent = "外部JSONの時刻表に戻しました。";
      $("csvFile").value = "";
      render();
    } catch (error) {
      $("csvStatus").textContent = error.message;
    }
  });
}

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  let refreshing = false;
  let registration = null;
  const checkKey = "tsurunaviLastUpdateCheck";

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      state.serviceWorkerRegistration = registration;
      if (registration.waiting && navigator.serviceWorker.controller) {
        $("appUpdateNotice").style.display = "flex";
      }
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            $("appUpdateNotice").style.display = "flex";
          }
        });
      });

      const lastCheck = Number(localStorage.getItem(checkKey) || 0);
      if (!lastCheck || Date.now() - lastCheck >= 24 * 60 * 60 * 1000) {
        await registration.update();
        localStorage.setItem(checkKey, String(Date.now()));
      }
    } catch (error) {
      console.info("Service Workerを利用できません。", error);
    }
  });

  $("appUpdateButton").addEventListener("click", () => {
    if (!registration?.waiting) return;
    $("appUpdateButton").disabled = true;
    $("appUpdateButton").textContent = "更新中…";
    registration.waiting.postMessage({ type: "SKIP_WAITING" });
  });
}

async function init() {
  setupEvents();
  setupServiceWorker();
  try {
    await loadExternalData();
    renderDestinations();
    renderOrigins();
    render();
    window.setInterval(() => {
      if (state.mode === "next") render();
    }, 30 * 1000);
  } catch (error) {
    $("status").textContent = error.message || "データの読み込みに失敗しました。";
    $("results").innerHTML = '<div class="empty">時刻表データを読み込めません。通信状態とJSONファイルの配置を確認してください。</div>';
  }
}

init();
