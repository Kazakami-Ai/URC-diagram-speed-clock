import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  onValue
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdDtvjwqZWU8Ou-0m-_UEZe6NF2WBxaq0",
  authDomain: "ptd-system.firebaseapp.com",
  databaseURL: "https://ptd-system-default-rtdb.firebaseio.com",
  projectId: "ptd-system",
  storageBucket: "ptd-system.firebasestorage.app",
  messagingSenderId: "823235993839",
  appId: "1:823235993839:web:470c9261ee9f8e90dd7b1a"
};

const ANCHOR_TICK = 14400;
const STUL_SETTING_PATH = "./StUL_setting.json";
const TRAVEL_TIMES_PATH = "./travel-times.json";
const ALLOWED_SPEEDS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
const DEBUG = false;

const modelClock = document.querySelector("#modelClock");
const tickValue = document.querySelector("#tickValue");
const anchorDisplay = document.querySelector("#anchorDisplay");
const speedDisplay = document.querySelector("#speedDisplay");
const firebaseStatus = document.querySelector("#firebaseStatus");
const loadMessage = document.querySelector("#loadMessage");
const stationAttribute = document.querySelector("#stationAttribute");
const tableBody = document.querySelector("#departureBody");

let database = null;
let firebaseReady = false;
let timetableData = null;
let stulSetting = null;
let travelTimes = null;
let currentStateSnapshot = {};
let clockSettings = { anchor: "06:00:00", speed: 20 };
let currentTick = 0;
let debugEntries = [];

function normalizeStationId(stationId) {
  if (stationId === null || stationId === undefined || stationId === "") return "";
  const text = String(stationId);
  return /^\d$/.test(text) ? text : text.replace(/^st_0*/, "");
}

function normalizeDirection(direction) {
  if (direction === "Nobori") return "N";
  if (direction === "Kudari") return "K";
  return direction === "N" || direction === "K" ? direction : "";
}

function parseTimeToSeconds(timeText) {
  const [h, m, s] = timeText.split(":").map(Number);
  return (h * 3600) + (m * 60) + (s || 0);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTick(tick) {
  const safeTick = Math.max(0, Math.floor(Number(tick) || 0));
  const hours = Math.floor(safeTick / 3600);
  const minutes = Math.floor((safeTick % 3600) / 60);
  const seconds = safeTick % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function calculateTick(now = new Date()) {
  const anchorSeconds = parseTimeToSeconds(clockSettings.anchor);
  const realSecondsSinceMidnight =
    now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const speed = Number(clockSettings.speed) || 1;
  const rawTick =
    (realSecondsSinceMidnight - anchorSeconds) * speed + ANCHOR_TICK;
  return Math.floor(rawTick / speed) * speed;
}

function normalizeClockSettings(value) {
  const anchor =
    typeof value?.anchor === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value.anchor)
      ? (value.anchor.length === 5 ? `${value.anchor}:00` : value.anchor)
      : "06:00:00";
  const numericSpeed = Number(value?.speed);
  const speed = ALLOWED_SPEEDS.includes(numericSpeed) ? numericSpeed : 20;
  return { anchor, speed };
}

function normalizeTimetableData(data) {
  const stations = (data?.stations ?? []).map((station, index) => ({
    ...station,
    id: String(index)
  }));
  const stationIdByName = new Map(stations.map((station) => [station.name, station.id]));
  const trains = Object.fromEntries(
    Object.entries(data?.trains ?? {}).map(([trainId, train]) => [
      trainId,
      {
        ...train,
        direction: normalizeDirection(train.direction),
        destination: stationIdByName.get(train.destination) ?? train.destination,
        timetable: (train.timetable ?? []).map((stop) => ({
          ...stop,
          stationId: normalizeStationId(stop.stationId)
        }))
      }
    ])
  );
  return { ...data, stations, trains };
}

function getStationMode(stationId) {
  const compactId = normalizeStationId(stationId);
  const legacyId = `st_${compactId.padStart(3, "0")}`;
  return stulSetting?.stations?.[compactId]
    || stulSetting?.stations?.[legacyId]
    || "";
}

function getStationName(stationId) {
  const compactId = normalizeStationId(stationId);
  return timetableData?.stations?.find(
    (station) => normalizeStationId(station.id) === compactId
  )?.name || "";
}

function getStationOptionKey(stationId, direction = "") {
  return direction ? `${direction}:${stationId}` : `shared:${stationId}`;
}

function parseStationSelection(value) {
  if (!value) return { stationId: "", direction: "" };
  const separatorIndex = value.indexOf(":");
  if (separatorIndex < 0) return { stationId: normalizeStationId(value), direction: "" };
  const prefix = value.slice(0, separatorIndex);
  const stationId = value.slice(separatorIndex + 1);
  return prefix === "shared"
    ? { stationId: normalizeStationId(stationId), direction: "" }
    : { stationId: normalizeStationId(stationId), direction: normalizeDirection(prefix) };
}

function initializeStationAttribute() {
  const currentValue = stationAttribute.value;
  stationAttribute.replaceChildren();
  const groups = [
    { mode: "up_only", direction: "N", label: "上り" },
    { mode: "down_only", direction: "K", label: "下り" },
    { mode: "down_up_separate", direction: "N", label: "上り" },
    { mode: "down_up_separate", direction: "K", label: "下り" },
    { mode: "shared", direction: "", label: "上下共通" }
  ];

  for (const group of groups) {
    const stations = (timetableData?.stations ?? []).filter(
      (station) => getStationMode(station.id) === group.mode
    );
    if (!stations.length) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const station of stations) {
      const option = document.createElement("option");
      option.value = getStationOptionKey(station.id, group.direction);
      option.textContent = station.name;
      optgroup.appendChild(option);
    }
    stationAttribute.appendChild(optgroup);
  }

  if ([...stationAttribute.options].some((option) => option.value === currentValue)) {
    stationAttribute.value = currentValue;
  } else if (stationAttribute.options.length) {
    stationAttribute.selectedIndex = 0;
  }
  stationAttribute.addEventListener("change", renderBoard);
}

function getState(stationId, train) {
  const compactStationId = normalizeStationId(stationId);
  const mode = getStationMode(compactStationId);
  const direction = normalizeDirection(train?.direction);
  const stationState = currentStateSnapshot?.[compactStationId] || {};
  if (mode === "shared") return stationState?.[train.trainNumber] || null;
  return stationState?.[direction]?.[train.trainNumber] || null;
}

function getCurrentStateValue(stationId, train, key) {
  return getState(stationId, train)?.[key];
}

function findCurrentStop(train) {
  const { stationId } = parseStationSelection(stationAttribute.value);
  return train?.timetable?.find((stop) => normalizeStationId(stop.stationId) === stationId) || null;
}

function findPreviousOperationalStop(train, currentIndex) {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const stop = train.timetable[index];
    if (!stop.isPass) return { stop, index };
  }
  return null;
}

function findTravelTime(fromId, toId, train) {
  const segments = travelTimes?.segments ?? [];
  const compactFrom = normalizeStationId(fromId);
  const compactTo = normalizeStationId(toId);
  return segments.find((segment) => {
    if (normalizeStationId(segment.from) !== compactFrom) return false;
    if (normalizeStationId(segment.to) !== compactTo) return false;
    const directionMatches = !Array.isArray(segment.sourceDirections) ||
      !segment.sourceDirections.length ||
      segment.sourceDirections.map(normalizeDirection).includes(normalizeDirection(train.direction));
    const trainMatches = !Array.isArray(segment.sourceTrainNumbers) ||
      !segment.sourceTrainNumbers.length ||
      segment.sourceTrainNumbers.includes(train.trainNumber);
    return directionMatches && trainMatches;
  }) || null;
}

function getVirtualScheduledTick(train, currentIndex) {
  const previous = findPreviousOperationalStop(train, currentIndex);
  if (!previous) return null;
  const previousDeptick = Number(previous.stop.depTick);
  if (!Number.isFinite(previousDeptick)) return null;
  const travel = findTravelTime(previous.stop.stationId, train.timetable[currentIndex].stationId, train);
  const minTick = Number(travel?.minTick);
  if (!Number.isFinite(minTick)) return null;
  return previousDeptick + minTick;
}

function getScheduledDepartureTick(train, stop, currentIndex) {
  const depTick = Number(stop?.depTick);
  if (Number.isFinite(depTick)) return depTick;
  if (stop?.isPass) return getVirtualScheduledTick(train, currentIndex);
  return null;
}

function getPreviousContext(train, currentIndex) {
  const previous = findPreviousOperationalStop(train, currentIndex);
  if (!previous) return null;
  const previousStop = previous.stop;
  const state = getState(previousStop.stationId, train);
  const depTick = Number(previousStop.depTick);
  return {
    ...previous,
    state,
    depTick: Number.isFinite(depTick) ? depTick : null
  };
}

function delayMinutesFromDelta(deltaTick) {
  const speed = Number(clockSettings.speed) || 1;
  const minutes = deltaTick / speed;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.floor(minutes);
}

function getPreviousDepartureTick(train, previous, tick) {
  if (!previous) return null;

  const actualDepartureTick = Number(previous.state?.tst);
  if (previous.state?.ac === "d" && Number.isFinite(actualDepartureTick)) {
    return actualDepartureTick;
  }

  // 未発車状態では、予定発車時刻を過ぎていれば「現在時刻まで遅れている」とみなす。
  if ((previous.state?.ac === "u" || previous.state?.ac === "s") &&
      previous.depTick !== null && tick >= previous.depTick) {
    return tick;
  }

  return null;
}

function getPreviousToCurrentMinTick(train, previous, stop) {
  if (!previous || !stop) return null;

  const travel = findTravelTime(previous.stop.stationId, stop.stationId, train);
  const travelMinTick = Number(travel?.minTick);
  if (Number.isFinite(travelMinTick)) return travelMinTick;

  // travel-times.json に当該方向の区間がない場合は、
  // 当駅の予定発車時刻と前駅の予定発車時刻の差を最低所要時間として使う。
  const previousDepTick = Number(previous.stop.depTick);
  const currentDepTick = Number(stop.depTick);
  if (Number.isFinite(previousDepTick) && Number.isFinite(currentDepTick) &&
      currentDepTick > previousDepTick) {
    return currentDepTick - previousDepTick;
  }

  return null;
}

function makeDelayText(minutes) {
  return minutes > 0 ? `遅れ ${minutes}分` : "";
}

function getTrainDestination(train, stop) {
  return stop?.isPass ? "通過" : (getStationName(train.destination) || train.destination || "");
}

function getFutureDisplayInfo(train, currentIndex, tick) {
  const stop = train.timetable[currentIndex];
  const currentState = getState(stop.stationId, train);
  if (currentState?.ac === "d") return null;

  const scheduledDepTick = getScheduledDepartureTick(train, stop, currentIndex);
  if (!Number.isFinite(scheduledDepTick)) return null;

  const previous = getPreviousContext(train, currentIndex);
  let delayMinutes = 0;
  let delayedByPrevious = false;
  let simArrTick = null;
  let hasPreviousDeparture = false;

  const previousDepartureTick = getPreviousDepartureTick(train, previous, tick);
  if (Number.isFinite(previousDepartureTick)) {
    const minTick = getPreviousToCurrentMinTick(train, previous, stop);
    if (Number.isFinite(minTick)) {
      hasPreviousDeparture = true;
      simArrTick = previousDepartureTick + minTick;

      const scheduledArrTick = Number(stop.arrTick);
      if (Number.isFinite(scheduledArrTick)) {
        delayMinutes = delayMinutesFromDelta(simArrTick - scheduledArrTick);
        delayedByPrevious = delayMinutes > 0;
      } else if (previous?.depTick !== null) {
        delayMinutes = delayMinutesFromDelta(previousDepartureTick - previous.depTick);
        delayedByPrevious = delayMinutes > 0;
      }

      // 既に当駅の発車予定時刻を過ぎても、実到着見込みが現在時刻より
      // 後なら「先発候補」として残し、実到着時刻で割り込み順を決める。
      if (simArrTick < tick) return null;
    }
  }

  // 前駅の状態から実際の発車時刻を取得できない列車は、
  // 通常どおり予定発車時刻が過ぎた時点で先発候補から外す。
  if (scheduledDepTick < tick && !hasPreviousDeparture) return null;

  // 現在時刻より先なら通常の予定順、現在時刻を過ぎていれば
  // 前駅発車時刻 + 最低所要時間で到着見込みを作って割り込ませる。
  const sortTick = scheduledDepTick > tick
    ? scheduledDepTick
    : (simArrTick ?? scheduledDepTick);

  return {
    train,
    stop,
    currentIndex,
    scheduledDepTick,
    displayTimeTick: Number.isFinite(Number(stop.depTick)) ? Number(stop.depTick) : null,
    destination: getTrainDestination(train, stop),
    delayText: makeDelayText(delayMinutes),
    waitText: stop.isPassingWait ? "待避あり" : "",
    isPassing: Boolean(stop.isPass),
    delayedByPrevious,
    simArrTick,
    sortTick
  };
}

function getDepartedDisplayInfo(train, currentIndex, tick) {
  const stop = train.timetable[currentIndex];
  const state = getState(stop.stationId, train);
  if (state?.ac !== "d") return null;
  const tst = Number(state.tst);
  if (!Number.isFinite(tst)) return null;

  const scheduledDepTick = Number(stop.depTick);
  const delayMinutes = Number.isFinite(scheduledDepTick)
    ? delayMinutesFromDelta(tst - scheduledDepTick)
    : 0;

  return {
    train,
    stop,
    currentIndex,
    scheduledDepTick: Number.isFinite(scheduledDepTick) ? scheduledDepTick : null,
    displayTimeTick: Number.isFinite(scheduledDepTick) ? scheduledDepTick : null,
    actualTick: tst,
    destination: getTrainDestination(train, stop),
    delayText: makeDelayText(delayMinutes),
    waitText: stop.isPassingWait ? "待避あり" : "",
    isPassing: Boolean(stop.isPass)
  };
}

function getBoardEntries(tick) {
  const { stationId, direction } = parseStationSelection(stationAttribute.value);
  debugEntries = [];
  if (!stationId) return { departed: null, future: [] };

  const candidates = [];
  const departedCandidates = [];

  for (const train of Object.values(timetableData?.trains ?? {})) {
    if (direction && normalizeDirection(train.direction) !== direction) continue;
    const index = train.timetable.findIndex(
      (stop) => normalizeStationId(stop.stationId) === stationId
    );
    if (index < 0) continue;

    const departed = getDepartedDisplayInfo(train, index, tick);
    if (departed) departedCandidates.push(departed);

    const future = getFutureDisplayInfo(train, index, tick);
    if (future) candidates.push(future);

    if (DEBUG) {
      const stop = train.timetable[index];
      const scheduledDepTick = getScheduledDepartureTick(train, stop, index);
      const previous = getPreviousContext(train, index);
      const state = getState(stop.stationId, train);
      debugEntries.push({
        trainNumber: train.trainNumber,
        station: stationId,
        direction: normalizeDirection(train.direction),
        currentTick: tick,
        scheduledDepTick: Number.isFinite(scheduledDepTick) ? scheduledDepTick : null,
        scheduledDepStatus: Number.isFinite(scheduledDepTick)
          ? (scheduledDepTick > tick ? "予定>現在" : "予定<=現在")
          : "なし",
        currentAc: state?.ac ?? "",
        currentTst: state?.tst ?? "",
        previousStation: previous ? normalizeStationId(previous.stop.stationId) : "",
        previousAc: previous?.state?.ac ?? "",
        previousTst: previous?.state?.tst ?? "",
        previousDepTick: previous?.depTick ?? null,
        simArrTick: future?.simArrTick ?? null,
        sortTick: future?.sortTick ?? null,
        delayText: future?.delayText ?? departed?.delayText ?? "",
        result: departed
          ? "発車済"
          : future
            ? (future.sortTick === future.scheduledDepTick ? "未来候補" : "sim_arrtick割込")
            : "非表示"
      });
    }
  }

  departedCandidates.sort((a, b) =>
    Math.abs(a.actualTick - tick) - Math.abs(b.actualTick - tick) ||
    a.actualTick - b.actualTick ||
    a.train.trainNumber.localeCompare(b.train.trainNumber)
  );

  candidates.sort((a, b) =>
    a.sortTick - b.sortTick ||
    a.scheduledDepTick - b.scheduledDepTick ||
    a.train.trainNumber.localeCompare(b.train.trainNumber)
  );

  return {
    departed: departedCandidates[0] || null,
    future: candidates.slice(0, 3)
  };
}

function createCell(text = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

function renderRow(rowLabel, info, indexText) {
  const row = document.createElement("tr");
  row.appendChild(createCell(indexText));
  row.appendChild(createCell(info?.train?.trainNumber || ""));
  row.appendChild(createCell(info?.stop?.trackNum || ""));
  row.appendChild(createCell(info?.displayTimeTick === null || info?.displayTimeTick === undefined
    ? ""
    : formatTick(info.displayTimeTick)));
  row.appendChild(createCell(info?.train?.trainType || ""));
  row.appendChild(createCell(info?.destination || ""));
  row.appendChild(createCell(info?.delayText || ""));
  row.appendChild(createCell(info?.waitText || ""));
  row.dataset.rowLabel = rowLabel;
  return row;
}

function renderDebugPanel() {
  const panel = document.querySelector("#debugPanel");
  const body = document.querySelector("#debugBody");
  if (!DEBUG || !panel || !body) return;

  const { stationId, direction } = parseStationSelection(stationAttribute.value);
  panel.hidden = false;
  body.replaceChildren();

  const summary = document.createElement("div");
  summary.className = "debug-summary";
  summary.textContent = `DEBUG ON / station=${stationId || "-"} / direction=${direction || "shared"} / currentTick=${currentTick}`;
  body.appendChild(summary);

  if (!debugEntries.length) {
    const empty = document.createElement("div");
    empty.textContent = "候補列車なし";
    body.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  const headers = [
    "列車", "予定dep", "予定と現在", "current ac", "prev駅", "prev ac",
    "prev tst", "prev dep", "sim_arrtick", "sortTick", "遅れ", "結果"
  ];
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  headers.forEach((header) => headerRow.appendChild(createCell(header).cloneNode(true)));
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const entry of debugEntries) {
    const row = document.createElement("tr");
    [
      entry.trainNumber,
      entry.scheduledDepTick ?? "",
      entry.scheduledDepStatus,
      `${entry.currentAc}${entry.currentTst !== "" ? ` / ${entry.currentTst}` : ""}`,
      entry.previousStation,
      entry.previousAc,
      entry.previousTst ?? "",
      entry.previousDepTick ?? "",
      entry.simArrTick ?? "",
      entry.sortTick ?? "",
      entry.delayText,
      entry.result
    ].forEach((value) => row.appendChild(createCell(value)));
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  body.appendChild(table);

  console.table(debugEntries);
}

function renderBoard() {
  if (!timetableData) return;
  const { departed, future } = getBoardEntries(currentTick);
  tableBody.replaceChildren();
  tableBody.appendChild(renderRow("発車済", departed, "発車済"));
  tableBody.appendChild(renderRow("先発", future[0], "先発"));
  tableBody.appendChild(renderRow("次発", future[1], "次発"));
  tableBody.appendChild(renderRow("次々発", future[2], "次々発"));
  loadMessage.textContent = firebaseReady ? "currentStateを監視中" : "Firebase未接続";
  renderDebugPanel();
}

function updateClock() {
  currentTick = calculateTick();
  modelClock.textContent = formatTick(currentTick);
  tickValue.textContent = `${currentTick} tick`;
  renderBoard();
}

async function initializeFirebase() {
  firebaseStatus.textContent = USE_FIREBASE_EMULATOR ? "Firebase Emulator: 接続中…" : "Firebase: 接続中…";
  try {
    const app = initializeApp(firebaseConfig);
    database = getDatabase(app);
    if (USE_FIREBASE_EMULATOR) connectDatabaseEmulator(database, EMULATOR_HOST, EMULATOR_DATABASE_PORT);
    firebaseReady = true;
    firebaseStatus.textContent = USE_FIREBASE_EMULATOR ? "Firebase Emulator: 接続済み" : "Firebase: 接続済み";
    firebaseStatus.className = "connection connected";

    const systemRef = ref(database, "system");
    const systemSnapshot = await get(systemRef);
    clockSettings = normalizeClockSettings(systemSnapshot.val());
    anchorDisplay.textContent = clockSettings.anchor;
    speedDisplay.textContent = `${clockSettings.speed}倍`;
    onValue(systemRef, (snapshot) => {
      clockSettings = normalizeClockSettings(snapshot.val());
      anchorDisplay.textContent = clockSettings.anchor;
      speedDisplay.textContent = `${clockSettings.speed}倍`;
      updateClock();
    });

    const currentStateRef = ref(database, "currentState");
    onValue(currentStateRef, (snapshot) => {
      currentStateSnapshot = snapshot.val() || {};
      renderBoard();
    });
  } catch (error) {
    console.error("Firebase初期化エラー:", error);
    firebaseReady = false;
    firebaseStatus.textContent = "Firebase: 未接続";
    firebaseStatus.className = "connection disconnected";
    loadMessage.textContent = "Firebaseの読み込みに失敗しました";
  }
}

async function loadData() {
  const [timetableResponse, stulResponse, travelTimesResponse] = await Promise.all([
    fetch("./timetable.json", { cache: "no-store" }),
    fetch(STUL_SETTING_PATH, { cache: "no-store" }),
    fetch(TRAVEL_TIMES_PATH, { cache: "no-store" })
  ]);
  if (!timetableResponse.ok) throw new Error(`timetable.json の読み込みに失敗しました: ${timetableResponse.status}`);
  if (!stulResponse.ok) throw new Error(`StUL_setting.json の読み込みに失敗しました: ${stulResponse.status}`);
  if (!travelTimesResponse.ok) throw new Error(`travel-times.json の読み込みに失敗しました: ${travelTimesResponse.status}`);
  timetableData = normalizeTimetableData(await timetableResponse.json());
  stulSetting = await stulResponse.json();
  travelTimes = await travelTimesResponse.json();
}

async function main() {
  try {
    await loadData();
    initializeStationAttribute();
    updateClock();
    setInterval(updateClock, 1000);
    await initializeFirebase();
    updateClock();
  } catch (error) {
    console.error(error);
    loadMessage.textContent = error.message;
  }
}

main();
