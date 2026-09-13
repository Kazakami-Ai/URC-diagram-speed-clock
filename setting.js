import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

import {
  getDatabase,
  ref,
  get,
  update,
  remove,
  onValue,
  connectDatabaseEmulator
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js";


/*
 * Firebase Emulator用設定
 */
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

const DEFAULT_SETTINGS = {
  anchor: "06:00:00",
  speed: 20,
  automaticOperationStatus: true
};

const ALLOWED_SPEEDS = [
  1, 2, 3, 4, 5, 6,
  10, 12, 15, 20, 30, 60
];


const anchorTimeInput =
  document.querySelector("#anchorTime");

const speedInput =
  document.querySelector("#speed");

const saveButton =
  document.querySelector("#saveButton");

const resetButton =
  document.querySelector("#resetButton");

const autoOperationStatusInput =
  document.querySelector("#autoOperationStatus");

const saveMessage =
  document.querySelector("#saveMessage");

const currentAnchor =
  document.querySelector("#currentAnchor");

const currentSpeed =
  document.querySelector("#currentSpeed");

const currentAutoOperationStatus =
  document.querySelector("#currentAutoOperationStatus");

const firebaseStatus =
  document.querySelector("#firebaseStatus");


let database = null;
let firebaseReady = false;


function normalizeSettings(value) {
  const anchor =
    typeof value?.anchor === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value.anchor)
      ? (value.anchor.length === 5 ? `${value.anchor}:00` : value.anchor)
      : DEFAULT_SETTINGS.anchor;

  const numericSpeed =
    Number(value?.speed);

  const speed =
    ALLOWED_SPEEDS.includes(numericSpeed)
      ? numericSpeed
      : DEFAULT_SETTINGS.speed;

  return {
    anchor,
    speed,
    automaticOperationStatus: value?.automaticOperationStatus !== false
  };
}


function applySettings(value) {
  const settings =
    normalizeSettings(value);

  anchorTimeInput.value =
    settings.anchor;

  speedInput.value =
    String(settings.speed);

  currentAnchor.textContent =
    settings.anchor;

  currentSpeed.textContent =
    `${settings.speed}倍`;

  currentAutoOperationStatus.textContent =
    settings.automaticOperationStatus ? "有効" : "無効";

  autoOperationStatusInput.value =
    String(settings.automaticOperationStatus);
}


async function initializeSettings() {
  const settingsRef =
    ref(database, "system");

  const snapshot =
    await get(settingsRef);

  const current =
    snapshot.val();

  const settings =
    normalizeSettings(current);

  const patch = {};

  if (
    !current ||
    current.anchor !== settings.anchor
  ) {
    patch.anchor = settings.anchor;
  }

  if (
    !current ||
    Number(current.speed) !== settings.speed
  ) {
    patch.speed = settings.speed;
  }

  if (
    !current ||
    current.automaticOperationStatus !== settings.automaticOperationStatus
  ) {
    patch.automaticOperationStatus = settings.automaticOperationStatus;
  }

  if (Object.keys(patch).length > 0) {
    await update(settingsRef, patch);
  }

  applySettings(settings);

  onValue(
    settingsRef,
    (settingsSnapshot) => {
      applySettings(
        settingsSnapshot.val()
      );
    }
  );
}


async function saveSettings() {
  if (!firebaseReady) {
    saveMessage.textContent =
      "Firebase未接続";

    return;
  }

  const anchor =
    anchorTimeInput.value;

  const speed =
    Number(speedInput.value);

  const automaticOperationStatus =
    autoOperationStatusInput.value === "true";

  if (
    !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(anchor)
  ) {
    saveMessage.textContent =
      "Anchorが不正です";

    return;
  }

  if (!ALLOWED_SPEEDS.includes(speed)) {
    saveMessage.textContent =
      "Speedが不正です";

    return;
  }

  saveButton.disabled = true;
  saveMessage.textContent = "保存中…";

  try {
    await update(
      ref(database, "system"),
      {
        anchor:
          anchor.length === 5
            ? `${anchor}:00`
            : anchor,

        speed,
        automaticOperationStatus
      }
    );

    saveMessage.textContent =
      "Firebaseに保存しました";

  } catch (error) {
    console.error(error);

    saveMessage.textContent =
      "保存失敗";

  } finally {
    saveButton.disabled = false;
  }
}


async function resetFirebaseData() {
  if (!firebaseReady) {
    saveMessage.textContent = "Firebase未接続";
    return;
  }

  const confirmed = window.confirm(
    "Firebaseの logs と currentState をすべて削除します。\nsystem の設定は残ります。\n実行しますか？"
  );
  if (!confirmed) return;

  resetButton.disabled = true;
  saveMessage.textContent = "ログ・状態を削除中…";

  try {
    await Promise.all([
      remove(ref(database, "logs")),
      remove(ref(database, "currentState"))
    ]);
    saveMessage.textContent = "logs・currentStateを削除しました（systemは保持）";
  } catch (error) {
    console.error("Firebaseリセットエラー:", error);
    saveMessage.textContent = "リセット失敗";
  } finally {
    resetButton.disabled = false;
  }
}


async function initializeFirebase() {
  firebaseStatus.textContent =
    USE_FIREBASE_EMULATOR
      ? "Firebase Emulator: 接続中…"
      : "Firebase: 接続中…";

  try {
    const app =
      initializeApp(firebaseConfig);

    database =
      getDatabase(app);

    if (USE_FIREBASE_EMULATOR) {
      connectDatabaseEmulator(
        database,
        EMULATOR_HOST,
        EMULATOR_DATABASE_PORT
      );
    }

    firebaseReady = true;

    firebaseStatus.textContent =
      USE_FIREBASE_EMULATOR
        ? "Firebase Emulator: 接続済み"
        : "Firebase: 接続済み";

    firebaseStatus.className =
      "connection connected";

    await initializeSettings();

  } catch (error) {
    console.error(
      "Firebase初期化エラー:",
      error
    );

    firebaseReady = false;

    firebaseStatus.textContent =
      USE_FIREBASE_EMULATOR
        ? "Firebase Emulator: 未接続"
        : "Firebase: 未接続";

    firebaseStatus.className =
      "connection disconnected";

    saveMessage.textContent =
      "Firebase設定を読み込めませんでした";
  }
}


saveButton.addEventListener(
  "click",
  saveSettings
);

resetButton.addEventListener(
  "click",
  resetFirebaseData
);


initializeFirebase();
