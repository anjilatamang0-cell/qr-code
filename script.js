"use strict";

/* ==========================================================
   QR名刺管理アプリ  script.js
   使う外部ライブラリ：html5-qrcode のみ（index.html で読み込み済み）

   目次
   1. 変数（データと状態）
   2. HTML要素の取得
   3. 便利な関数（日付・メッセージ）
   4. localStorage（保存と読み込み）
   5. QRコードの文字から名前を取り出す
   6. 登録処理（重複チェック・時刻の記録）
   7. 音（Web Audio API）
   8. 画像アップロードで読み取る
   9. カメラで読み取る
   10. 並び替えと検索
   11. 一覧と統計の表示
   12. 削除機能
   13. CSVダウンロード
   14. QRコード作成
   15. イベントの登録と開始
   ========================================================== */


/* ==========================================================
   1. 変数（データと状態）
   ========================================================== */

// localStorage に保存するときの名前（キー）
const STORAGE_KEY = "qrMeishiRecords";

// 登録データの配列。1件は { id, name, timestamp } というオブジェクト
let records = [];

// 今の並び順："name"（名前順）か "time"（時間順）
let currentSort = "time";

// 検索ボックスに入力された文字
let searchKeyword = "";

// カメラ関係の状態
let cameraScanner = null;      // Html5Qrcode のオブジェクト
let isCameraRunning = false;   // カメラが動いているか
let isCameraBusy = false;      // 開始中・停止中か（二重起動を防ぐ）

// 同じQRコードを連続で登録しないための記録
let lastScannedText = "";
let lastScannedTime = 0;
const SCAN_COOLDOWN_MS = 3000; // 同じQRは3秒間無視する

// 名前の最大文字数（長すぎる文字を名前にしないため）
const MAX_NAME_LENGTH = 100;

// 音を出すための AudioContext
let audioContext = null;

// 通知メッセージを消すタイマー
let messageTimerId = null;


/* ==========================================================
   2. HTML要素の取得
   ========================================================== */

const uploadBtn = document.getElementById("uploadBtn");
const qrFileInput = document.getElementById("qrFileInput");
const startCameraBtn = document.getElementById("startCameraBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const cameraBox = document.getElementById("cameraBox");
const reader = document.getElementById("reader");
const scanStatus = document.getElementById("scanStatus");
const notification = document.getElementById("notification");

const totalCountEl = document.getElementById("totalCount");
const recordCountEl = document.getElementById("recordCount");
const visibleCountEl = document.getElementById("visibleCount");

const searchInput = document.getElementById("searchInput");
const sortNameBtn = document.getElementById("sortNameBtn");
const sortTimeBtn = document.getElementById("sortTimeBtn");

const emptyMessage = document.getElementById("emptyMessage");
const recordList = document.getElementById("recordList");

const csvBtn = document.getElementById("csvBtn");
const deleteAllBtn = document.getElementById("deleteAllBtn");

// QRコード作成の部分
const qrTextInput = document.getElementById("qrTextInput");
const createQrBtn = document.getElementById("createQrBtn");
const qrResult = document.getElementById("qrResult");
const qrCanvas = document.getElementById("qrCanvas");
const qrCaption = document.getElementById("qrCaption");
const downloadQrBtn = document.getElementById("downloadQrBtn");


/* ==========================================================
   3. 便利な関数（日付・メッセージ）
   ========================================================== */

// 1桁の数字を2桁にする（例：5 → "05"）
function pad2(number) {
  return String(number).padStart(2, "0");
}

// 今の日時から "2026-11-18T12:30:00" の形の文字を作る
// new Date() で現在の日時を取り、年・月・日・時・分・秒を自動で取り出す
function createTimestamp(date) {
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1); // getMonth() は 0〜11 なので +1
  const day = pad2(date.getDate());
  const hours = pad2(date.getHours());
  const minutes = pad2(date.getMinutes());
  const seconds = pad2(date.getSeconds());
  return year + "-" + month + "-" + day + "T" + hours + ":" + minutes + ":" + seconds;
}

// "2026-11-18T12:30:00" を数字ごとに分ける（失敗したら null）
function parseTimestamp(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(timestamp));
  if (!match) {
    return null;
  }
  return { year: match[1], month: match[2], day: match[3], hours: match[4], minutes: match[5] };
}

// 表示用の日付：2026年11月18日
function formatDate(timestamp) {
  const parts = parseTimestamp(timestamp);
  if (!parts) {
    return "不明";
  }
  return parts.year + "年" + Number(parts.month) + "月" + Number(parts.day) + "日";
}

// 表示用の時刻：12:30
function formatTime(timestamp) {
  const parts = parseTimestamp(timestamp);
  if (!parts) {
    return "不明";
  }
  return parts.hours + ":" + parts.minutes;
}

// CSV用の日時：2026/11/18 12:30（Excelで日時として読みやすい形）
function formatDateTimeForCsv(timestamp) {
  const parts = parseTimestamp(timestamp);
  if (!parts) {
    return "";
  }
  return parts.year + "/" + parts.month + "/" + parts.day + " " + parts.hours + ":" + parts.minutes;
}

// 画面の上にメッセージを出す。type は "success" / "error" / "info"
function showMessage(text, type) {
  notification.textContent = text;
  notification.className = "notification " + type;
  notification.hidden = false;

  // 前のタイマーが残っていたら消す
  if (messageTimerId !== null) {
    clearTimeout(messageTimerId);
  }
  // 4秒後に自動で消す
  messageTimerId = setTimeout(function () {
    notification.hidden = true;
    messageTimerId = null;
  }, 4000);
}

// スキャナーの下の「状態メッセージ」を変える
function setScanStatus(text) {
  scanStatus.textContent = text;
}


/* ==========================================================
   4. localStorage（保存と読み込み）
   ========================================================== */

// 1件のデータが正しい形かどうかを調べる
function isValidRecord(item) {
  return (
    item !== null &&
    typeof item === "object" &&
    typeof item.name === "string" &&
    item.name.trim() !== "" &&
    typeof item.timestamp === "string" &&
    parseTimestamp(item.timestamp) !== null
  );
}

// localStorage から読み込む。データがない・壊れているときは空の配列を返す
function loadRecords() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw); // 文字 → 配列
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isValidRecord).map(function (item, index) {
      return {
        id: typeof item.id === "number" ? item.id : Date.now() + index,
        name: item.name.trim(),
        timestamp: item.timestamp
      };
    });
  } catch (error) {
    console.error("保存データを読み込めませんでした:", error);
    return [];
  }
}

// 今の records を localStorage に保存する
function saveRecords() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); // 配列 → 文字
    return true;
  } catch (error) {
    console.error("保存できませんでした:", error);
    showMessage("データを保存できませんでした。ブラウザの設定を確認してください。", "error");
    return false;
  }
}


/* ==========================================================
   5. QRコードの文字から名前を取り出す
   ========================================================== */

// vCard の値にある記号のエスケープを元に戻す（例：\, → ,）
function unescapeVcardValue(value) {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// 連続した空白を1つにして、前後の空白を消す
function cleanSpaces(text) {
  return text.replace(/\s+/g, " ").trim();
}

// vCard から名前を取り出す。FN を先に探し、なければ N を使う
function extractNameFromVcard(text) {
  // 行が途中で折り返されている vCard を1行にもどす
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  let fullName = "";
  let structuredName = "";

  for (let i = 0; i < lines.length; i++) {
    const match = /^(?:[A-Za-z0-9-]+\.)?(FN|N)(?:;[^:]*)?:(.*)$/i.exec(lines[i].trim());
    if (!match) {
      continue;
    }
    const property = match[1].toUpperCase();
    const value = match[2];

    if (property === "FN" && fullName === "") {
      fullName = cleanSpaces(unescapeVcardValue(value));
    } else if (property === "N" && structuredName === "") {
      // N は「姓;名;ミドルネーム;敬称;」の順番
      const parts = value.split(";").map(function (part) {
        return cleanSpaces(unescapeVcardValue(part));
      });
      const family = parts[0] || "";
      const given = parts[1] || "";
      const middle = parts[2] || "";
      structuredName = cleanSpaces([given, middle, family].join(" "));
    }
  }

  return fullName || structuredName;
}

// QRコードの文字から名前を取り出す。取り出せないときは空の文字 "" を返す
function extractName(decodedText) {
  if (typeof decodedText !== "string") {
    return "";
  }
  const trimmed = decodedText.trim();
  if (trimmed === "") {
    return "";
  }
  if (/BEGIN:VCARD/i.test(trimmed)) {
    return extractNameFromVcard(trimmed);
  }
  // ふつうの文字なら、そのまま名前として使う
  return cleanSpaces(trimmed);
}


/* ==========================================================
   6. 登録処理（重複チェック・時刻の記録）
   ========================================================== */

// 同じ名前がすでにあるか調べる（前後の空白を消して、大文字小文字は区別しない）
function isDuplicateName(name) {
  const target = name.trim().toLowerCase();
  const existingNames = records.map(function (record) {
    return record.name.trim().toLowerCase();
  });
  return existingNames.includes(target); // 配列検索：includes()
}

// QRコードの文字を受け取って登録する。登録できたら true を返す
function registerFromText(decodedText) {
  const name = extractName(decodedText);

  // 名前が空・undefined のときは登録しない
  if (!name) {
    showMessage("名前を読み取れませんでした。別のQRコードを試してください。", "error");
    playErrorSound();
    return false;
  }

  if (name.length > MAX_NAME_LENGTH) {
    showMessage("文字が長すぎるため、名前として登録できません。", "error");
    playErrorSound();
    return false;
  }

  // 重複チェック（登録する前に行う）
  if (isDuplicateName(name)) {
    showMessage("この名前はすでに登録されています。", "error");
    playErrorSound();
    return false; // 元のデータは変更しない
  }

  // 新しいデータを作る。登録時刻は new Date() から自動で取得する
  let newId = Date.now();
  while (records.some(function (record) { return record.id === newId; })) {
    newId += 1; // 同じ id にならないようにする
  }
  const newRecord = {
    id: newId,
    name: name,
    timestamp: createTimestamp(new Date())
  };

  records.push(newRecord);
  sortRecords();   // 今の並び順をたもつ
  saveRecords();   // localStorage に保存
  renderAll();     // 画面を更新

  showMessage("「" + name + "」を登録しました。", "success");
  playSuccessSound();
  return true;
}


/* ==========================================================
   7. 音（Web Audio API）
   外部の音ファイルは使わず、ブラウザで音を作る
   ========================================================== */

// AudioContext を準備する。ボタンを押したときに呼ぶ（iPhoneは操作のあとでないと音が出ないため）
function initAudio() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return;
    }
    if (!audioContext) {
      audioContext = new AudioContextClass();
    }
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  } catch (error) {
    console.error("音を準備できませんでした:", error);
  }
}

// 短い音を1つ鳴らす（frequency=高さ, startAfter=開始までの秒, duration=長さ, volume=音量）
function playTone(frequency, startAfter, duration, type, volume) {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const startTime = audioContext.currentTime + startAfter;

  oscillator.type = type;
  oscillator.frequency.value = frequency;

  // 音をなめらかに出して消す（プツッという音を防ぐ）
  gainNode.gain.setValueAtTime(0.0001, startTime);
  gainNode.gain.exponentialRampToValueAtTime(volume, startTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + duration + 0.05);
}

// 成功の音：高い音が2つ（ピロン）
function playSuccessSound() {
  try {
    initAudio();
    if (!audioContext) {
      return;
    }
    playTone(880, 0, 0.12, "sine", 0.12);
    playTone(1318, 0.12, 0.2, "sine", 0.12);
  } catch (error) {
    console.error(error);
  }
}

// エラーの音：低い音が2つ（ブブッ）
function playErrorSound() {
  try {
    initAudio();
    if (!audioContext) {
      return;
    }
    playTone(220, 0, 0.15, "square", 0.05);
    playTone(165, 0.2, 0.2, "square", 0.05);
  } catch (error) {
    console.error(error);
  }
}


/* ==========================================================
   8. 画像アップロードで読み取る
   ========================================================== */

// 選ばれた画像ファイルからQRコードを読み取る
async function handleImageFile(file) {
  if (typeof Html5Qrcode === "undefined") {
    showMessage("QRコードのライブラリを読み込めませんでした。インターネット接続を確認してください。", "error");
    return;
  }

  setScanStatus("画像を読み取っています…");

  // カメラ用の #reader とは別の、見えない場所を使う
  const fileScanner = new Html5Qrcode("fileReader");

  try {
    const decodedText = await fileScanner.scanFile(file, false);
    const success = registerFromText(decodedText);
    setScanStatus(success ? "画像の読み取りが完了しました。" : "読み取りましたが、登録されませんでした。");
  } catch (error) {
    console.error("画像を読み取れませんでした:", error);
    showMessage("QRコードを読み取れませんでした。QRコードがはっきり写っている画像を選んでください。", "error");
    setScanStatus("画像からQRコードを読み取れませんでした。");
    playErrorSound();
  } finally {
    try {
      fileScanner.clear();
    } catch (clearError) {
      // clear() の失敗は無視してよい
    }
  }
}


/* ==========================================================
   9. カメラで読み取る
   ========================================================== */

// ボタンの有効・無効を、今の状態に合わせる
function updateCameraButtons() {
  startCameraBtn.disabled = isCameraRunning || isCameraBusy;
  stopCameraBtn.disabled = !isCameraRunning || isCameraBusy;
}

// このブラウザ・この接続でカメラが使えるか調べる
function isCameraSupported() {
  return Boolean(
    window.isSecureContext &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

// 読み取り枠の大きさを、画面に合わせて決める
function getQrBoxSize(viewfinderWidth, viewfinderHeight) {
  const size = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
  return { width: size, height: size };
}

// カメラでQRコードが読めたときに呼ばれる
function onCameraScanSuccess(decodedText) {
  const now = Date.now();

  // 同じQRコードが写り続けているあいだは、何度も登録しない
  if (decodedText === lastScannedText && now - lastScannedTime < SCAN_COOLDOWN_MS) {
    lastScannedTime = now; // 写っているあいだは、時間を更新し続ける
    return;
  }

  lastScannedText = decodedText;
  lastScannedTime = now;

  const success = registerFromText(decodedText);
  setScanStatus(success ? "登録しました。次のQRコードをかざしてください。" : "このQRコードは登録されませんでした。");
}

// 読み取れなかったフレームで呼ばれる（毎回呼ばれるので、何もしない）
function onCameraScanFailure() {
  // エラー音やメッセージを出さない
}

// カメラのエラーを、やさしい日本語にして表示する
function showCameraError(error) {
  const name = error && error.name ? error.name : "";
  const message = String(error && error.message ? error.message : error);
  let text;

  if (name === "NotAllowedError" || /permission|denied|NotAllowed/i.test(message)) {
    text = "カメラの使用が許可されていません。ブラウザの設定でカメラを許可してから、もう一度お試しください。画像アップロードも使えます。";
  } else if (name === "NotFoundError" || /NotFound|no camera|Requested device not found/i.test(message)) {
    text = "カメラが見つかりません。画像アップロードを使ってください。";
  } else if (name === "NotReadableError" || /NotReadable|in use/i.test(message)) {
    text = "カメラを使えません。ほかのアプリがカメラを使っていないか確認してください。";
  } else {
    text = "カメラを開始できませんでした。画像アップロードを使ってください。";
  }

  console.error("カメラエラー:", error);
  showMessage(text, "error");
  setScanStatus(text);
}

// カメラ開始（ボタンを押したときだけ、カメラの許可を求める）
async function startCamera() {
  // すでに動いているとき・準備中のときは、新しく始めない
  if (isCameraRunning || isCameraBusy) {
    return;
  }

  if (typeof Html5Qrcode === "undefined") {
    showMessage("QRコードのライブラリを読み込めませんでした。インターネット接続を確認してください。", "error");
    return;
  }

  if (!isCameraSupported()) {
    const unsupportedText = "このブラウザ（または接続）ではカメラを使えません。「画像を選ぶ」ボタンで読み取ってください。";
    showMessage(unsupportedText, "error");
    setScanStatus(unsupportedText);
    return;
  }

  isCameraBusy = true;
  updateCameraButtons();
  initAudio(); // ボタンを押した今のうちに、音を使えるようにする
  setScanStatus("カメラを準備しています…（許可のメッセージが出たら「許可」を選んでください）");
  cameraBox.classList.add("is-active");

  try {
    cameraScanner = new Html5Qrcode("reader");
    await cameraScanner.start(
      { facingMode: "environment" },   // 背面カメラを優先
      { fps: 10, qrbox: getQrBoxSize },
      onCameraScanSuccess,
      onCameraScanFailure
    );
    isCameraRunning = true;
    lastScannedText = "";
    lastScannedTime = 0;
    setScanStatus("カメラが動いています。QRコードを枠に入れてください。");
  } catch (error) {
    await releaseCamera();
    showCameraError(error);
  } finally {
    isCameraBusy = false;
    updateCameraButtons();
  }
}

// カメラを使い終わったあとの片づけ（映像を消して、カメラを手放す）
async function releaseCamera() {
  if (cameraScanner) {
    try {
      if (isCameraRunning) {
        await cameraScanner.stop(); // カメラを止める
      }
    } catch (error) {
      console.error("カメラを止められませんでした:", error);
    }
    try {
      cameraScanner.clear(); // 画面の映像を消す
    } catch (error) {
      // 無視してよい
    }
  }
  cameraScanner = null;
  isCameraRunning = false;
  lastScannedText = "";
  lastScannedTime = 0;
  reader.innerHTML = "";
  cameraBox.classList.remove("is-active");
}

// カメラ停止（ボタンを押したとき）
async function stopCamera() {
  if (!cameraScanner || isCameraBusy) {
    return;
  }
  isCameraBusy = true;
  updateCameraButtons();

  await releaseCamera();

  isCameraBusy = false;
  updateCameraButtons();
  setScanStatus("カメラを停止しました。");
}


/* ==========================================================
   10. 並び替えと検索
   ========================================================== */

// records の配列そのものを sort() で並び替える
function sortRecords() {
  if (currentSort === "name") {
    // 名前順：あいうえお・ABC順
    records.sort(function (a, b) {
      return a.name.localeCompare(b.name, "ja", { sensitivity: "base" });
    });
  } else {
    // 時間順：新しい登録が上。timestamp は "年-月-日T時:分:秒" なので文字の比較でよい
    records.sort(function (a, b) {
      const compared = b.timestamp.localeCompare(a.timestamp);
      return compared !== 0 ? compared : b.id - a.id;
    });
  }
}

// 並び替えボタンの色を、今の並び順に合わせる
function updateSortButtons() {
  sortNameBtn.setAttribute("aria-pressed", String(currentSort === "name"));
  sortTimeBtn.setAttribute("aria-pressed", String(currentSort === "time"));
}

// 並び替えボタンを押したとき
function changeSort(sortType) {
  currentSort = sortType;
  sortRecords();
  saveRecords();
  updateSortButtons();
  renderAll();
}

// 検索に合うデータだけを返す。filter() は新しい配列を作るので、元の records は変わらない
function getVisibleRecords() {
  const keyword = searchKeyword.trim().toLowerCase();
  if (keyword === "") {
    return records.slice();
  }
  return records.filter(function (record) {
    return record.name.toLowerCase().includes(keyword);
  });
}


/* ==========================================================
   11. 一覧と統計の表示
   ========================================================== */

// 1件分のカードを作る。textContent を使うので、QRの中身が HTML として動くことはない
function createRecordCard(record) {
  const li = document.createElement("li");
  li.className = "record-card";

  const info = document.createElement("div");
  info.className = "record-info";

  const nameEl = document.createElement("p");
  nameEl.className = "record-name";
  nameEl.textContent = record.name;

  const meta = document.createElement("p");
  meta.className = "record-meta";

  const dateEl = document.createElement("span");
  dateEl.textContent = "登録日：" + formatDate(record.timestamp);

  const timeEl = document.createElement("span");
  timeEl.textContent = "登録時刻：" + formatTime(record.timestamp);

  meta.appendChild(dateEl);
  meta.appendChild(timeEl);
  info.appendChild(nameEl);
  info.appendChild(meta);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn btn-danger record-delete";
  deleteBtn.textContent = "削除";
  deleteBtn.setAttribute("data-id", String(record.id));
  deleteBtn.setAttribute("aria-label", record.name + " を削除");

  li.appendChild(info);
  li.appendChild(deleteBtn);
  return li;
}

// 一覧を作り直す
function renderList() {
  const visibleRecords = getVisibleRecords();
  recordList.innerHTML = "";

  visibleRecords.forEach(function (record) {
    recordList.appendChild(createRecordCard(record));
  });

  // データがないときのメッセージ
  if (records.length === 0) {
    emptyMessage.textContent = "まだ登録されていません。QRコードを読み取ってみましょう。";
    emptyMessage.hidden = false;
  } else if (visibleRecords.length === 0) {
    emptyMessage.textContent = "検索に合う名前が見つかりません。";
    emptyMessage.hidden = false;
  } else {
    emptyMessage.hidden = true;
  }
}

// 統計を更新する
function updateStats() {
  totalCountEl.textContent = String(records.length);
  recordCountEl.textContent = String(records.length);
  visibleCountEl.textContent = String(getVisibleRecords().length);
}

// 一覧と統計をまとめて更新する
function renderAll() {
  renderList();
  updateStats();
}


/* ==========================================================
   12. 削除機能
   ========================================================== */

// 1件だけ削除する
function deleteRecord(id) {
  const target = records.find(function (record) {
    return record.id === id;
  });
  if (!target) {
    return;
  }
  records = records.filter(function (record) {
    return record.id !== id;
  });
  saveRecords();
  renderAll();
  showMessage("「" + target.name + "」を削除しました。", "info");
}

// すべて削除する（確認ダイアログで OK のときだけ）
function deleteAllRecords() {
  if (records.length === 0) {
    showMessage("削除するデータがありません。", "info");
    return;
  }

  const confirmed = window.confirm("登録されているデータをすべて削除します。よろしいですか？");
  if (!confirmed) {
    return; // キャンセルなら何も変えない
  }

  records = [];
  saveRecords();
  renderAll();
  showMessage("すべてのデータを削除しました。", "info");
}


/* ==========================================================
   13. CSVダウンロード
   ========================================================== */

// CSVの1つの値を安全な形にする
// ・全体を "" で囲む  ・中の " は "" にする
// ・= + - @ で始まる文字は、Excelで計算式と思われないように ' を前につける
function escapeCsvValue(value) {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }
  return '"' + text.replace(/"/g, '""') + '"';
}

// CSVファイルを作ってダウンロードする
function downloadCsv() {
  if (records.length === 0) {
    showMessage("ダウンロードするデータがありません。", "info");
    return;
  }

  const lines = ["名前,登録日時"];
  records.forEach(function (record) {
    lines.push(escapeCsvValue(record.name) + "," + escapeCsvValue(formatDateTimeForCsv(record.timestamp)));
  });

  // 先頭の BOM（\uFEFF）があると、Excelで日本語が文字化けしない
  const csvText = "\uFEFF" + lines.join("\r\n") + "\r\n";
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "qr_meishi_list.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 1000);

  showMessage("CSVファイルをダウンロードしました。", "success");
}


/* ==========================================================
   14. QRコード作成
   外部ライブラリは使わず、QRコードの規格（ISO/IEC 18004）の手順を
   自分のJavaScriptで実装しています。

   QRコードを作る流れ
   ① 文字を UTF-8 のバイトに変える（日本語もOK）
   ② 入るサイズ（バージョン1〜40）を決める
   ③ データのビット列を作る（モード・文字数・データ・終わりの印・うめ草）
   ④ 誤り訂正の符号（リード・ソロモン符号）をつける
   ⑤ 正方形のマス目に、位置検出パターンなどと一緒に並べる
   ⑥ マスク（模様）を8種類ためして、いちばん読みやすいものを選ぶ
   ⑦ canvas に描いて、画面に表示する（PNGでダウンロードできる）
   ========================================================== */

// 誤り訂正レベルは「M（約15%まで汚れても読める）」を使う
// 下の2つの配列は、バージョン1〜40ごとの数（0番目は使わない）
const QR_ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const QR_NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const QR_MAX_VERSION = 40;

// 画像の設定
const QR_DARK_COLOR = "#2d1b52";   // 濃い紫（白との差が大きく、読み取りやすい）
const QR_LIGHT_COLOR = "#ffffff";  // 白
const QR_QUIET_ZONE = 4;           // まわりの白い余白（規格では4マス以上）
const QR_TARGET_IMAGE_SIZE = 640;  // 画像の大きさのめやす（px）
const QR_MIN_MODULE_PIXELS = 4;    // 1マスの最小の大きさ（px）

// 最後に作ったQRコードの文字（ダウンロードできるか調べるために使う）
let generatedQrText = "";


/* ---------- ① 文字をバイトにする ---------- */

// 文字を UTF-8 のバイトの配列にする（例："あ" → [227, 129, 130]）
function textToUtf8Bytes(text) {
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(text));
  }
  // 古いブラウザ用の方法
  const binary = unescape(encodeURIComponent(text));
  return Array.from(binary, function (character) {
    return character.charCodeAt(0);
  });
}


/* ---------- ② サイズ（バージョン）の計算 ---------- */

// そのバージョンで、データを置けるマスの数
function qrGetNumRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) {
      result -= 36;
    }
  }
  return result;
}

// そのバージョンで、入れられるデータのバイト数（誤り訂正の分をのぞく）
function qrGetNumDataCodewords(version) {
  return Math.floor(qrGetNumRawDataModules(version) / 8) -
    QR_ECC_CODEWORDS_PER_BLOCK[version] * QR_NUM_ERROR_CORRECTION_BLOCKS[version];
}


/* ---------- ④ 誤り訂正（リード・ソロモン符号） ---------- */

// 2つの数を、ガロア体 GF(256) でかけ算する
function qrReedSolomonMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// 割り算に使う式（ディバイザ）を作る
function qrReedSolomonComputeDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = qrReedSolomonMultiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = qrReedSolomonMultiply(root, 0x02);
  }
  return result;
}

// データを割り算した「余り」が、誤り訂正の符号になる
function qrReedSolomonComputeRemainder(data, divisor) {
  const result = divisor.map(function () {
    return 0;
  });
  data.forEach(function (byte) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach(function (coefficient, i) {
      result[i] ^= qrReedSolomonMultiply(coefficient, factor);
    });
  });
  return result;
}

// データをブロックに分け、それぞれに誤り訂正をつけて、交互にならべる
function qrAddEccAndInterleave(data, version) {
  const numBlocks = QR_NUM_ERROR_CORRECTION_BLOCKS[version];
  const blockEccLen = QR_ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(qrGetNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = qrReedSolomonComputeDivisor(blockEccLen);
  let position = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLength = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const blockData = data.slice(position, position + dataLength);
    position += dataLength;
    const ecc = qrReedSolomonComputeRemainder(blockData, divisor);
    if (i < numShortBlocks) {
      blockData.push(0); // 長さをそろえるためのダミー
    }
    blocks.push(blockData.concat(ecc));
  }

  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach(function (block, j) {
      // 短いブロックのダミーは入れない
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]);
      }
    });
  }
  return result;
}


/* ---------- ⑤ マス目を作って並べる ---------- */

// 空のマス目を作る。modules[y][x] が true なら濃いマス
// isFunction[y][x] が true のマスは「位置検出などの特別なマス」（データは入れない）
function qrCreateGrid(version) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(false));
    isFunction.push(new Array(size).fill(false));
  }
  return { version: version, size: size, modules: modules, isFunction: isFunction };
}

// 特別なマスに色をつける
function qrSetFunctionModule(grid, x, y, isDark) {
  grid.modules[y][x] = isDark;
  grid.isFunction[y][x] = true;
}

// 位置検出パターン（3つの大きな四角）を、中心 (x, y) に描く
function qrDrawFinderPattern(grid, x, y) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && xx < grid.size && yy >= 0 && yy < grid.size) {
        qrSetFunctionModule(grid, xx, yy, distance !== 2 && distance !== 4);
      }
    }
  }
}

// 位置合わせパターン（小さな四角）を、中心 (x, y) に描く
function qrDrawAlignmentPattern(grid, x, y) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      qrSetFunctionModule(grid, x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

// 位置合わせパターンを置く場所の一覧
function qrGetAlignmentPatternPositions(version, size) {
  if (version === 1) {
    return [];
  }
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < numAlign; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

// 形式情報（誤り訂正レベルとマスクの番号）を描く。レベルMは 00
function qrDrawFormatBits(grid, mask) {
  const size = grid.size;
  const data = (0 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const getBit = function (i) {
    return ((bits >>> i) & 1) !== 0;
  };

  // 左上のまわり
  for (let i = 0; i <= 5; i++) {
    qrSetFunctionModule(grid, 8, i, getBit(i));
  }
  qrSetFunctionModule(grid, 8, 7, getBit(6));
  qrSetFunctionModule(grid, 8, 8, getBit(7));
  qrSetFunctionModule(grid, 7, 8, getBit(8));
  for (let i = 9; i < 15; i++) {
    qrSetFunctionModule(grid, 14 - i, 8, getBit(i));
  }

  // 右上と左下（同じ情報をもう一度）
  for (let i = 0; i < 8; i++) {
    qrSetFunctionModule(grid, size - 1 - i, 8, getBit(i));
  }
  for (let i = 8; i < 15; i++) {
    qrSetFunctionModule(grid, 8, size - 15 + i, getBit(i));
  }
  qrSetFunctionModule(grid, 8, size - 8, true); // いつも濃いマス
}

// バージョン情報を描く（バージョン7以上のときだけ必要）
function qrDrawVersion(grid) {
  if (grid.version < 7) {
    return;
  }
  let remainder = grid.version;
  for (let i = 0; i < 12; i++) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1F25);
  }
  const bits = (grid.version << 12) | remainder;
  for (let i = 0; i < 18; i++) {
    const isDark = ((bits >>> i) & 1) !== 0;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    qrSetFunctionModule(grid, a, b, isDark);
    qrSetFunctionModule(grid, b, a, isDark);
  }
}

// 特別なマス（タイミング・位置検出・位置合わせ・形式・バージョン）をすべて描く
function qrDrawFunctionPatterns(grid) {
  const size = grid.size;

  // タイミングパターン（濃い・薄いが交互に並ぶ線）
  for (let i = 0; i < size; i++) {
    qrSetFunctionModule(grid, 6, i, i % 2 === 0);
    qrSetFunctionModule(grid, i, 6, i % 2 === 0);
  }

  // 3つの角の位置検出パターン
  qrDrawFinderPattern(grid, 3, 3);
  qrDrawFinderPattern(grid, size - 4, 3);
  qrDrawFinderPattern(grid, 3, size - 4);

  // 位置合わせパターン
  const positions = qrGetAlignmentPatternPositions(grid.version, size);
  const count = positions.length;
  for (let i = 0; i < count; i++) {
    for (let j = 0; j < count; j++) {
      const overlapsFinder =
        (i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0);
      if (!overlapsFinder) {
        qrDrawAlignmentPattern(grid, positions[i], positions[j]);
      }
    }
  }

  qrDrawFormatBits(grid, 0); // 場所を先にとっておく（あとで正しい値で上書き）
  qrDrawVersion(grid);
}

// データのビットを、右下から「ジグザグ」に並べていく
function qrDrawCodewords(grid, codewords) {
  const size = grid.size;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5; // 6列目はタイミングパターンなので飛ばす
    }
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!grid.isFunction[y][x] && bitIndex < codewords.length * 8) {
          grid.modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }
}


/* ---------- ⑥ マスク（模様）の選択 ---------- */

// マスクをかける（同じ関数をもう一度呼ぶと、元にもどる）
function qrApplyMask(grid, mask) {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (!grid.isFunction[y][x] && invert) {
        grid.modules[y][x] = !grid.modules[y][x];
      }
    }
  }
}

// 位置検出パターンに似た並び（1:1:3:1:1 と白4マス）か調べる
function qrLooksLikeFinderPattern(line, start) {
  const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const patternB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  let matchA = true;
  let matchB = true;
  for (let i = 0; i < 11; i++) {
    if (line[start + i] !== patternA[i]) {
      matchA = false;
    }
    if (line[start + i] !== patternB[i]) {
      matchB = false;
    }
  }
  return matchA || matchB;
}

// 読み取りにくさの点数（小さいほど読みやすい）
function qrComputePenalty(grid) {
  const size = grid.size;
  const modules = grid.modules;
  let score = 0;

  // 同じ色が5マス以上つづく行・列、位置検出に似た並び
  for (let direction = 0; direction < 2; direction++) {
    for (let a = 0; a < size; a++) {
      const line = [];
      let runColor = null;
      let runLength = 0;
      for (let b = 0; b < size; b++) {
        const isDark = direction === 0 ? modules[a][b] : modules[b][a];
        line.push(isDark ? 1 : 0);
        if (isDark === runColor) {
          runLength++;
          if (runLength === 5) {
            score += 3;
          } else if (runLength > 5) {
            score += 1;
          }
        } else {
          runColor = isDark;
          runLength = 1;
        }
      }
      for (let i = 0; i + 11 <= size; i++) {
        if (qrLooksLikeFinderPattern(line, i)) {
          score += 40;
        }
      }
    }
  }

  // 同じ色の 2x2 のかたまり
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const color = modules[y][x];
      if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
        score += 3;
      }
    }
  }

  // 濃いマスと薄いマスの割合のかたより
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        darkCount++;
      }
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  score += Math.max(k, 0) * 10;

  return score;
}


/* ---------- QRコードのマス目を作る（メインの関数） ---------- */

// 文字を受け取って { version, size, modules } を返す。長すぎるときは Error("TOO_LONG")
function qrCreateMatrix(text) {
  // ① 文字をバイトにする
  const bytes = textToUtf8Bytes(text);

  // ② 入る最小のバージョンを探す
  let version = 1;
  let characterCountBits = 8;
  let dataCapacityBits = 0;
  while (true) {
    if (version > QR_MAX_VERSION) {
      throw new Error("TOO_LONG");
    }
    characterCountBits = version <= 9 ? 8 : 16;
    dataCapacityBits = qrGetNumDataCodewords(version) * 8;
    if (4 + characterCountBits + bytes.length * 8 <= dataCapacityBits) {
      break;
    }
    version++;
  }

  // ③ データのビット列を作る
  const bits = [];
  const appendBits = function (value, length) {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  appendBits(0x4, 4);                         // モード：バイト（0100）
  appendBits(bytes.length, characterCountBits); // バイト数
  bytes.forEach(function (byte) {
    appendBits(byte, 8);                      // データ本体
  });
  appendBits(0, Math.min(4, dataCapacityBits - bits.length)); // 終わりの印
  while (bits.length % 8 !== 0) {
    bits.push(0);                             // 8の倍数にそろえる
  }
  for (let padByte = 0xEC; bits.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11) {
    appendBits(padByte, 8);                   // うめ草（EC と 11 を交互に）
  }

  // ビット列を、8ビットずつのバイトにまとめる
  const dataCodewords = new Array(bits.length / 8).fill(0);
  bits.forEach(function (bit, i) {
    dataCodewords[i >>> 3] |= bit << (7 - (i & 7));
  });

  // ④ 誤り訂正をつけて並べる
  const allCodewords = qrAddEccAndInterleave(dataCodewords, version);

  // ⑤ マス目に並べる
  const grid = qrCreateGrid(version);
  qrDrawFunctionPatterns(grid);
  qrDrawCodewords(grid, allCodewords);

  // ⑥ 8種類のマスクをためして、点数がいちばん小さいものを選ぶ
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qrApplyMask(grid, mask);
    qrDrawFormatBits(grid, mask);
    const penalty = qrComputePenalty(grid);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    qrApplyMask(grid, mask); // 元にもどす
  }
  qrApplyMask(grid, bestMask);
  qrDrawFormatBits(grid, bestMask);

  return { version: version, size: grid.size, modules: grid.modules };
}


/* ---------- ⑦ 画面に表示・ダウンロード ---------- */

// canvas にQRコードを描く。1マスを整数のピクセルで描くので、くっきり読める
function drawQrToCanvas(canvas, matrix) {
  const totalModules = matrix.size + QR_QUIET_ZONE * 2;
  const scale = Math.max(QR_MIN_MODULE_PIXELS, Math.floor(QR_TARGET_IMAGE_SIZE / totalModules));
  const pixelSize = totalModules * scale;

  canvas.width = pixelSize;
  canvas.height = pixelSize;

  const context = canvas.getContext("2d");
  context.fillStyle = QR_LIGHT_COLOR;
  context.fillRect(0, 0, pixelSize, pixelSize);

  context.fillStyle = QR_DARK_COLOR;
  for (let y = 0; y < matrix.size; y++) {
    for (let x = 0; x < matrix.size; x++) {
      if (matrix.modules[y][x]) {
        context.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale);
      }
    }
  }
}

// 「QRコードを作成」ボタンを押したとき
function createQrCode() {
  const text = qrTextInput.value.trim();

  // 空のチェック
  if (text === "") {
    showMessage("QRコードにする名前または連絡先を入力してください。", "error");
    qrTextInput.focus();
    return;
  }

  try {
    const matrix = qrCreateMatrix(text);
    drawQrToCanvas(qrCanvas, matrix);
    generatedQrText = text;

    const oneLine = text.replace(/\s+/g, " ");
    qrCaption.textContent = "内容：" + (oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine);
    qrResult.hidden = false;
    showMessage("QRコードを作成しました。", "success");
  } catch (error) {
    console.error("QRコードを作成できませんでした:", error);
    if (error && error.message === "TOO_LONG") {
      showMessage("文字が長すぎて、QRコードを作成できません。短くしてください。", "error");
    } else {
      showMessage("QRコードを作成できませんでした。", "error");
    }
  }
}

// ファイルとして保存を始める
function saveUrlAsFile(url, filename, shouldRevoke) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  if (shouldRevoke) {
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }
}

// 「画像をダウンロード」ボタンを押したとき（PNG画像で保存）
function downloadQrImage() {
  if (generatedQrText === "") {
    showMessage("先にQRコードを作成してください。", "error");
    return;
  }

  if (typeof qrCanvas.toBlob === "function") {
    qrCanvas.toBlob(function (blob) {
      if (!blob) {
        showMessage("画像を保存できませんでした。", "error");
        return;
      }
      saveUrlAsFile(URL.createObjectURL(blob), "qr_code.png", true);
      showMessage("QRコードの画像をダウンロードしました。", "success");
    }, "image/png");
  } else {
    // toBlob が使えない古いブラウザ用
    saveUrlAsFile(qrCanvas.toDataURL("image/png"), "qr_code.png", false);
    showMessage("QRコードの画像をダウンロードしました。", "success");
  }
}


/* ==========================================================
   15. イベントの登録と開始
   ========================================================== */

function setupEvents() {
  // 画像を選ぶ
  uploadBtn.addEventListener("click", function () {
    initAudio();
    qrFileInput.click();
  });

  qrFileInput.addEventListener("change", function () {
    const file = qrFileInput.files && qrFileInput.files[0];
    if (file) {
      handleImageFile(file);
    }
    qrFileInput.value = ""; // 同じ画像をもう一度選べるようにする
  });

  // カメラ
  startCameraBtn.addEventListener("click", startCamera);
  stopCameraBtn.addEventListener("click", stopCamera);

  // 検索（入力するたびに一覧を更新）
  searchInput.addEventListener("input", function () {
    searchKeyword = searchInput.value;
    renderAll();
  });

  // 並び替え
  sortNameBtn.addEventListener("click", function () {
    changeSort("name");
  });
  sortTimeBtn.addEventListener("click", function () {
    changeSort("time");
  });

  // 個別削除（一覧の中の削除ボタンを、まとめて1か所で受け取る）
  recordList.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-id]");
    if (!button) {
      return;
    }
    deleteRecord(Number(button.getAttribute("data-id")));
  });

  // 下のボタン
  csvBtn.addEventListener("click", downloadCsv);
  deleteAllBtn.addEventListener("click", deleteAllRecords);

  // QRコード作成
  createQrBtn.addEventListener("click", createQrCode);
  downloadQrBtn.addEventListener("click", downloadQrImage);

  // ページを閉じる・移動するときは、カメラを手放す
  window.addEventListener("pagehide", function () {
    if (cameraScanner) {
      releaseCamera();
    }
  });
}

// アプリの開始
function init() {
  records = loadRecords();
  sortRecords();
  updateSortButtons();
  renderAll();
  updateCameraButtons();
  setupEvents();

  if (!isCameraSupported()) {
    setScanStatus("この接続ではカメラを使えない場合があります。「画像を選ぶ」ボタンも使えます。");
  }
}

init();