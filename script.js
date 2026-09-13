import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getDatabase,
  ref,
  get,
  update,
  push,
  onValue,
  connectDatabaseEmulator
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

const USE_FIREBASE_EMULATOR = false;
const EMULATOR_HOST = "127.0.0.1";
const EMULATOR_DATABASE_PORT = 9000;
const ANCHOR_TICK = 14400;
const LANES = ["u", "s", "d"];
const STUL_SETTING_PATH = "./StUL_setting.json";
const LANE_LABELS = {
  u: "不明・遅延",
  s: "発車予定",
  d: "発車済"
};

const modelClock = document.querySelector("#modelClock");
const tickValue = document.querySelector("#tickValue");
const anchorDisplay = document.querySelector("#anchorDisplay");
const speedDisplay = document.querySelector("#speedDisplay");
const trainCount = document.querySelector("#trainCount");
const loadMessage = document.querySelector("#loadMessage");
const firebaseStatus = document.querySelector("#firebaseStatus");
const template = document.querySelector("#trainCardTemplate");
const stationAttribute = document.querySelector("#stationAttribute");
const lanes = Object.fromEntries(
  LANES.map((code) => [code, document.querySelector(`#lane-${code} .lane-cards`)])
);

let timetableData = null;
let stulSetting = null;
let database = null;
let firebaseReady = false;
let clockSettings = {
  anchor: "06:00:00",
  speed: 20,
  automaticOperationStatus: true
};
let trainStates = new Map();
let selectedTrainId = null;
let selectedLane = "s";
let automaticUpdatePromise = null;
let stationSelectionInitialized = false;

const ALLOWED_SPEEDS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

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
  return {
    anchor,
    speed,
    automaticOperationStatus: value?.automaticOperationStatus !== false
  };
}

function updateClockSettingsDisplay() {
  anchorDisplay.textContent = clockSettings.anchor;
  speedDisplay.textContent = `${clockSettings.speed}倍`;
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

function getStationMode(stationId) {
  const compactId = normalizeStationId(stationId);
  const legacyId = `st_${compactId.padStart(3, "0")}`;
  return stulSetting?.stations?.[compactId]
    || stulSetting?.stations?.[legacyId]
    || "";
}

function getStationName(stationId = null) {
  const selectedStationId = stationId === null
    ? parseStationSelection(stationAttribute?.value || "").stationId
    : stationId;
  const compactId = normalizeStationId(selectedStationId);
  return timetableData?.stations?.find(
    (station) => normalizeStationId(station.id) === compactId
  )?.name || "";
}

function getDirectionLabel(direction) {
  return normalizeDirection(direction) === "N" ? "上り" : "下り";
}

function getCurrentStationSelection() {
  const selection = parseStationSelection(stationAttribute?.value || "");
  if (!selection.stationId) throw new Error("担当駅が選択されていません。");
  return selection;
}

function initializeStationAttribute() {
  if (!stationAttribute) return;
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

  if (!stationSelectionInitialized) {
    stationAttribute.addEventListener("change", () => {
      applyCurrentStateSnapshot(currentStateSnapshot);
      renderLanes(true);
    });
    stationSelectionInitialized = true;
  }
}

function getDepartureInfo(trainId, train) {
  const { stationId, direction } = parseStationSelection(stationAttribute?.value || "");
  const timetable = train?.timetable ?? [];
  let stop = null;

  if (stationId) {
    if (direction && normalizeDirection(train?.direction) !== direction) return null;
    stop = timetable.find((item) => item.stationId === stationId && !item.isPass);
    if (!stop) return null;
    if (normalizeStationId(train.destination) === normalizeStationId(stationId)) return null;
  } else {
    stop = timetable.find((item) => !item.isPass);
  }

  const depTick = Number(stop?.depTick);
  if (!Number.isFinite(depTick)) return null;
  return {
    trainId,
    depTick,
    destination: train.destination
  };
}

function getVisibleTrains() {
  return Object.entries(timetableData?.trains ?? {})
    .map(([trainId, train]) => ({ trainId, train, departure: getDepartureInfo(trainId, train) }))
    .filter((item) => item.departure);
}

function normalizeTimetableData(data) {
  const stations = (data?.stations ?? []).map((station, index) => ({
    ...station,
    id: String(index)
  }));
  const stationIdByName = new Map(
    stations.map((station) => [station.name, station.id])
  );

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

  return {
    ...data,
    stations,
    trains
  };
}

function normalizeAction(value) {
  return LANES.includes(value) ? value : "s";
}

function getCurrentLane(trainId) {
  return normalizeAction(trainStates.get(trainId)?.ac);
}

function getSortedTrainEntries() {
  return getVisibleTrains().sort((a, b) =>
    a.departure.depTick - b.departure.depTick ||
    a.trainId.localeCompare(b.trainId)
  );
}

function selectCard(trainId, focus = true) {
  selectedTrainId = trainId;
  selectedLane = getCurrentLane(trainId);
  document.querySelectorAll(".train-card.is-selected").forEach((card) => card.classList.remove("is-selected"));
  const card = document.querySelector(`.train-card[data-train-id="${CSS.escape(trainId)}"]`);
  if (card) {
    card.classList.add("is-selected");
    if (focus) card.focus({ preventScroll: true });
  }
}

function updateSelectionVisual() {
  document.querySelectorAll(".train-card.is-selected").forEach((card) => card.classList.remove("is-selected"));
  if (!selectedTrainId) return;
  const card = document.querySelector(`.train-card[data-train-id="${CSS.escape(selectedTrainId)}"]`);
  if (card) card.classList.add("is-selected");
}

function getCurrentStatePath(trainId) {
  const train = timetableData?.trains?.[trainId];
  if (!train) return null;
  const { stationId, direction } = getCurrentStationSelection();
  const mode = getStationMode(stationId);
  if (mode === "shared") {
    return `currentState/${stationId}/${train.trainNumber}`;
  }
  if (mode === "up_only" || mode === "down_only" || mode === "down_up_separate") {
    if (mode !== "down_up_separate" && normalizeDirection(train.direction) !== direction) return null;
    return `currentState/${stationId}/${direction}/${train.trainNumber}`;
  }
  return null;
}

async function pushLog(trainId, action, tick = calculateTick()) {
  if (!firebaseReady) {
    loadMessage.textContent = "Firebase未接続のためログを保存できません。";
    return false;
  }

  const train = timetableData?.trains?.[trainId];
  if (!train) return false;

  const currentStatePath = getCurrentStatePath(trainId);
  if (!currentStatePath) return false;

  const tst = String(Math.floor(tick));

  await update(ref(database), {
    [currentStatePath]: { ac: action, tst }
  });
  return true;
}

async function moveTrain(trainId, action, { log = true, tick = calculateTick() } = {}) {
  const nextAction = normalizeAction(action);
  const currentAction = getCurrentLane(trainId);
  if (currentAction === nextAction) {
    selectCard(trainId);
    return false;
  }

  trainStates.set(trainId, {
    ...(trainStates.get(trainId) || {}),
    ac: nextAction,
    tst: String(Math.floor(tick))
  });
  selectedTrainId = trainId;
  selectedLane = nextAction;
  renderLanes(false);

  if (log) {
    try {
      await pushLog(trainId, nextAction, tick);
    } catch (error) {
      console.error("logs push error:", error);
      loadMessage.textContent = "ログ保存失敗";
    }
  }
  return true;
}

async function updateAutomaticDepartures(tick) {
  if (!clockSettings.automaticOperationStatus || !firebaseReady || automaticUpdatePromise) return;

  automaticUpdatePromise = (async () => {
    for (const { trainId, departure } of getSortedTrainEntries()) {
      if (departure.depTick > tick || getCurrentLane(trainId) !== "s") continue;
      await moveTrain(trainId, "d", { log: true, tick });
    }
  })().catch((error) => {
    console.error("自動発車更新エラー:", error);
  }).finally(() => {
    automaticUpdatePromise = null;
  });
}

function renderLanes(shouldCenter = false) {
  if (!timetableData) return;
  const entries = getSortedTrainEntries();
  const cardsByLane = { u: [], s: [], d: [] };

  for (const entry of entries) {
    cardsByLane[getCurrentLane(entry.trainId)].push(entry);
  }

  for (const code of LANES) {
    lanes[code].replaceChildren();
    const laneEntries = code === "u" || code === "d"
      ? [...cardsByLane[code]].reverse()
      : cardsByLane[code];

    for (const entry of laneEntries) {
      lanes[code].appendChild(createTrainCard(entry.trainId, entry.train, entry.departure));
    }
  }

  updateSelectionVisual();

  if (shouldCenter && selectedTrainId) {
    const card = document.querySelector(`.train-card[data-train-id="${CSS.escape(selectedTrainId)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }
}

function createTrainCard(trainId, train, departure) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.trainId = trainId;
  card.dataset.lane = getCurrentLane(trainId);
  card.tabIndex = 0;
  card.draggable = true;

  card.querySelector(".train-number").textContent = train.trainNumber;
  card.querySelector(".train-meta").textContent =
    `運用 ${train.operationNumber} / ${train.trainType} / ${getDirectionLabel(train.direction)}`;
  card.querySelector(".destination").textContent = `→ ${getStationName(train.destination) || train.destination}`;
  card.querySelector(".departure-time").textContent = `発車 ${formatTick(departure.depTick)}`;
  card.querySelector(".lane-action").textContent = `状態: ${LANE_LABELS[getCurrentLane(trainId)]}`;

  card.addEventListener("click", () => selectCard(trainId));
  card.addEventListener("focus", () => selectCard(trainId, false));

  card.addEventListener("dragstart", (event) => {
    selectCard(trainId, false);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", trainId);
    card.classList.add("is-dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("is-dragging"));

  return card;
}

function getLaneIndex(lane) {
  return LANES.indexOf(lane);
}

async function moveSelectedByDelta(delta) {
  if (!selectedTrainId) return;
  const current = getCurrentLane(selectedTrainId);
  const nextIndex = Math.max(0, Math.min(LANES.length - 1, getLaneIndex(current) + delta));
  if (nextIndex === getLaneIndex(current)) return;
  await moveTrain(selectedTrainId, LANES[nextIndex]);
}

function selectAdjacent(delta) {
  const cards = [...document.querySelectorAll(`.train-card[data-lane="${CSS.escape(selectedLane)}"]`)]
    .filter((card) => !card.hidden);
  if (!cards.length) return;
  const currentIndex = cards.findIndex((card) => card.dataset.trainId === selectedTrainId);
  const nextIndex = currentIndex < 0
    ? 0
    : Math.max(0, Math.min(cards.length - 1, currentIndex + delta));
  selectCard(cards[nextIndex].dataset.trainId);
}

function selectFirstScheduled() {
  const first = lanes.s?.querySelector(".train-card");
  if (first) selectCard(first.dataset.trainId);
}

function handleKeyboard(event) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Backspace"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();

  if (!selectedTrainId) {
    selectFirstScheduled();
    return;
  }

  if (event.key === "ArrowLeft") return selectAdjacent(-1);
  if (event.key === "ArrowRight") return selectAdjacent(1);
  if (event.key === "ArrowUp" || event.key === "Backspace") return void moveSelectedByDelta(-1);
  if (event.key === "ArrowDown" || event.key === "Enter") return void moveSelectedByDelta(1);
}

function setupLaneDropTargets() {
  for (const code of LANES) {
    const lane = document.querySelector(`#lane-${code}`);
    lane.addEventListener("dragover", (event) => {
      event.preventDefault();
      lane.classList.add("is-drop-target");
      event.dataTransfer.dropEffect = "move";
    });
    lane.addEventListener("dragleave", () => lane.classList.remove("is-drop-target"));
    lane.addEventListener("drop", async (event) => {
      event.preventDefault();
      lane.classList.remove("is-drop-target");
      const trainId = event.dataTransfer.getData("text/plain");
      if (trainId) await moveTrain(trainId, code);
    });
  }
}

function applyClockSettings(value) {
  clockSettings = normalizeClockSettings(value);
  updateClockSettingsDisplay();
}

async function initializeClockSettings() {
  const systemRef = ref(database, "system");
  const snapshot = await get(systemRef);
  const current = snapshot.val();
  const normalized = normalizeClockSettings(current);
  const patch = {};

  if (!current || current.anchor !== normalized.anchor) patch.anchor = normalized.anchor;
  if (!current || Number(current.speed) !== normalized.speed) patch.speed = normalized.speed;
  if (!current || current.automaticOperationStatus !== normalized.automaticOperationStatus) {
    patch.automaticOperationStatus = normalized.automaticOperationStatus;
  }
  if (Object.keys(patch).length) await update(systemRef, patch);
  applyClockSettings(normalized);

  onValue(systemRef, (systemSnapshot) => {
    applyClockSettings(systemSnapshot.val());
    renderLanes(false);
  });
}

let currentStateSnapshot = null;

function applyCurrentStateSnapshot(snapshot) {
  currentStateSnapshot = snapshot?.val?.() ?? snapshot ?? {};
  const { stationId, direction } = parseStationSelection(stationAttribute?.value || "");
  if (!stationId) return;

  const mode = getStationMode(stationId);
  const stationState = currentStateSnapshot?.[stationId] || {};
  const directionState = mode === "shared" ? stationState : (stationState?.[direction] || {});

  trainStates = new Map();
  for (const [trainId, train] of Object.entries(timetableData?.trains ?? {})) {
    const state = directionState?.[train.trainNumber];
    trainStates.set(trainId, state
      ? { ac: normalizeAction(state.ac), tst: String(state.tst ?? "") }
      : { ac: "s", tst: "" });
  }
  renderLanes(false);
}

async function initializeCurrentState() {
  const currentStateRef = ref(database, "currentState");
  const snapshot = await get(currentStateRef);
  applyCurrentStateSnapshot(snapshot);
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
    await initializeClockSettings();
    await initializeCurrentState();
  } catch (error) {
    console.error("Firebase初期化エラー:", error);
    firebaseReady = false;
    firebaseStatus.textContent = USE_FIREBASE_EMULATOR ? "Firebase Emulator: 未接続" : "Firebase: 未接続";
    firebaseStatus.className = "connection disconnected";
    loadMessage.textContent = "Firebase設定を読み込めませんでした";
  }
}

function updateClock() {
  const tick = calculateTick();
  modelClock.textContent = formatTick(tick);
  tickValue.textContent = `${tick} tick`;
  void updateAutomaticDepartures(tick);
}

function startClock() {
  updateClock();
  setInterval(updateClock, 1000);
}

async function loadTimetable() {
  const [timetableResponse, stulResponse] = await Promise.all([
    fetch("./timetable.json", { cache: "no-store" }),
    fetch(STUL_SETTING_PATH, { cache: "no-store" })
  ]);
  if (!timetableResponse.ok) throw new Error(`timetable.json の読み込みに失敗しました: ${timetableResponse.status}`);
  if (!stulResponse.ok) throw new Error(`StUL_setting.json の読み込みに失敗しました: ${stulResponse.status}`);
  timetableData = normalizeTimetableData(await timetableResponse.json());
  stulSetting = await stulResponse.json();
}

function renderInitialState() {
  const entries = getSortedTrainEntries();
  trainCount.textContent = `${entries.length}列車`;
  renderLanes(false);
  loadMessage.textContent = firebaseReady
    ? "列車カードを表示しました。"
    : "列車カードを表示しました（Firebase未接続）。";
}

async function main() {
  setupLaneDropTargets();
  document.addEventListener("keydown", handleKeyboard);
  startClock();

  try {
    await loadTimetable();
    initializeStationAttribute();
    for (const [trainId] of Object.entries(timetableData?.trains ?? {})) {
      trainStates.set(trainId, { ac: "s", tst: "" });
    }
    renderInitialState();
    await initializeFirebase();
    renderInitialState();
  } catch (error) {
    console.error(error);
    loadMessage.textContent = error.message;
  }
}

main();
