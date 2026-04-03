// ============================================================
// DMM英会話 Lesson Tracker - background.js (Service Worker)
// ============================================================

const BASE_URL = 'https://eikaiwa.dmm.com/lesson/';
const STORAGE_KEY = 'dmm_history';
const LAST_SCRAPED_KEY = 'dmm_last_scraped';
const DELAY_MS = 400; // 月ごとのウェイト

// ------------------------------------------------------------
// メッセージハンドラ
// ------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_SCRAPE') {
    startScrape(msg.fromMonth, msg.toMonth)
      .then(result => {
        sendResponse({ ok: true, ...result });
        // スクレイプ完了後、新規追加分のみ教材名を取得
        const newPending = (result.newRecords || []).filter(r => r.lesson_booking_url);
        if (newPending.length > 0 && !batchRunning) {
          batchRunning = true;
          batchFetchMaterials(newPending).finally(() => { batchRunning = false; });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // 非同期レスポンス
  }
  if (msg.type === 'IMPORT_JSON') {
    importJson(msg.records)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_MONTHS') {
    getAvailableMonths()
      .then(months => sendResponse({ ok: true, months }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_STATS') {
    getStats()
      .then(stats => sendResponse({ ok: true, stats }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'GET_HISTORY') {
    getHistory()
      .then(data => sendResponse({ ok: true, ...data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'CLEAR_STORAGE') {
    chrome.storage.local.remove([STORAGE_KEY, LAST_SCRAPED_KEY], () => {
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'SET_MATERIAL_UNAVAILABLE') {
    setMaterialUnavailable(msg.timestamp, msg.unavailable)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (msg.type === 'DOWNLOAD_RECORDINGS') {
    downloadRecordings(msg.lessonBookingUrl, msg.timestamp, msg.materialTitle)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ------------------------------------------------------------
// スクレイピング
// ------------------------------------------------------------
async function startScrape(fromMonth, toMonth) {
  // 対象月リストを生成
  const months = generateMonthRange(fromMonth, toMonth);
  let totalAdded = 0;
  let totalSkipped = 0;
  const warnings = [];
  const totalNewRecords = [];

  const total = months.length;
  chrome.action.setBadgeBackgroundColor({ color: '#d62b2b' });

  for (const [idx, month] of months.entries()) {
    // バッジに進捗を表示（例: 3/12）
    chrome.action.setBadgeText({ text: `${idx}/${total}` });

    // 進捗を popup に通知
    chrome.runtime.sendMessage({
      type: 'SCRAPE_PROGRESS',
      month,
      done: idx,
      total
    }).catch(() => {}); // popup が閉じていても無視

    // --- 1ページ目を取得して総ページ数を確認 ---
    const page1url = `${BASE_URL}?history_date=${month}&page=1`;
    let html1;
    try {
      const res = await fetch(page1url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html1 = await res.text();
    } catch (e) {
      warnings.push(`${month}: fetch失敗 (${e.message})`);
      continue;
    }

    // 総件数から最終ページを計算
    // "<span>57件中</span> 11～20件" のパターンから総件数取得
    const totalMatch = html1.match(/<span>(\d+)件中<\/span>/);
    const totalCount = totalMatch ? parseInt(totalMatch[1]) : 0;
    const lastPage = totalCount > 0 ? Math.ceil(totalCount / 10) : 1;

    // 全ページのレコードを収集
    const allRecords = parseHTML(html1, month);

    for (let page = 2; page <= lastPage; page++) {
      await sleep(300); // ページ間ウェイト
      const pageUrl = `${BASE_URL}?history_date=${month}&page=${page}`;
      try {
        const res = await fetch(pageUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const records = parseHTML(html, month);
        allRecords.push(...records);
      } catch (e) {
        warnings.push(`${month} page${page}: fetch失敗 (${e.message})`);
        break;
      }
    }

    const check = sanityCheck(allRecords, month);
    if (check.warnings.length) warnings.push(...check.warnings);

    const { added, skipped, addedRecords } = await mergeRecords(allRecords);
    totalAdded += added;
    totalSkipped += skipped;
    totalNewRecords.push(...addedRecords);

    await sleep(DELAY_MS);
  }

  await chrome.storage.local.set({ [LAST_SCRAPED_KEY]: new Date().toISOString() });
  chrome.action.setBadgeText({ text: '' });

  return { added: totalAdded, skipped: totalSkipped, warnings, newRecords: totalNewRecords };
}

// ------------------------------------------------------------
// HTMLパーサー（Service Worker対応: DOMParser不使用・正規表現ベース）
// ------------------------------------------------------------
function parseHTML(html, month) {
  const records = [];
  // <div id="contents"> ブロックを分割
  const blocks = splitContentBlocks(html);
  for (const block of blocks) {
    try {
      const rec = parseContentBlock(block, month);
      if (rec) records.push(rec);
    } catch (e) {
      // パース失敗は skip（sanityCheck で検知）
    }
  }
  return records;
}

// <div id="contents">〜</div> を切り出す
function splitContentBlocks(html) {
  const blocks = [];
  const startTag = '<div id="contents"';
  let pos = 0;
  while (true) {
    const start = html.indexOf(startTag, pos);
    if (start === -1) break;
    // 対応する閉じタグを深さカウントで探す
    let depth = 0;
    let i = start;
    while (i < html.length) {
      const open = html.indexOf('<div', i);
      const close = html.indexOf('</div>', i);
      if (open === -1 && close === -1) break;
      if (open !== -1 && (close === -1 || open < close)) {
        depth++;
        i = open + 4;
      } else {
        depth--;
        i = close + 6;
        if (depth === 0) {
          blocks.push(html.slice(start, i));
          pos = i;
          break;
        }
      }
    }
    if (i >= html.length) break;
  }
  return blocks;
}

function parseContentBlock(block, month) {
  // --- data-start-time（最優先）---
  const startTimeMatch = block.match(/data-start-time="([^"]+)"/);
  let timestamp = null;
  let duration_min = null;

  if (startTimeMatch) {
    timestamp = startTimeMatch[1].replace(' ', 'T');
  }

  // --- header#time からテキスト取得 ---
  const timeHeaderMatch = block.match(/<header[^>]*id="time"[^>]*>([\s\S]*?)<\/header>/);
  if (timeHeaderMatch) {
    const timeRaw = timeHeaderMatch[1].replace(/<[^>]+>/g, ' ');
    // duration計算: "08:30 - 08:55"
    const timeRangeMatch = timeRaw.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);
    if (timeRangeMatch) {
      duration_min = calcDuration(timeRangeMatch[1], timeRangeMatch[2]);
    }
    // timestampフォールバック
    if (!timestamp) {
      timestamp = parseJaDatetime(timeRaw);
    }
  }

  if (!timestamp) return null;

  // --- レッスンノートURL ---
  const noteMatch = block.match(/href="(\/lesson\/note\/[^"]+)"/);
  const note_url = noteMatch ? noteMatch[1] : null;

  // --- レッスンページURL（/app/lesson-booking/p-XXXX）---
  const lessonBtnMatch = block.match(/href="(https:\/\/eikaiwa\.dmm\.com\/app\/lesson-booking\/[^"]+)"/);
  const lesson_booking_url = lessonBtnMatch ? lessonBtnMatch[1] : null;

  // --- 講師情報 ---
  // <dt id="en">Anna Marie</dt>
  const teacherEnMatch = block.match(/<dt[^>]*id="en"[^>]*>\s*([\s\S]*?)\s*<\/dt>/);
  const teacher_en = teacherEnMatch ? teacherEnMatch[1].replace(/<[^>]+>/g, '').trim() : null;

  // <dd id="ja">（アナ・マリー）</dd>
  const teacherJaMatch = block.match(/<dd[^>]*id="ja"[^>]*>\s*([\s\S]*?)\s*<\/dd>/);
  const teacher_ja = teacherJaMatch
    ? teacherJaMatch[1].replace(/<[^>]+>/g, '').replace(/[（）()]/g, '').trim()
    : null;

  // <dd id="country">フィリピン</dd>
  const countryMatch = block.match(/<dd[^>]*id="country"[^>]*>\s*([\s\S]*?)\s*<\/dd>/);
  const teacher_country = countryMatch ? countryMatch[1].replace(/<[^>]+>/g, '').trim() : null;

  // 講師URL: <a href="/teacher/index/22253/">
  const teacherUrlMatch = block.match(/href="(\/teacher\/index\/\d+\/)"/);
  const teacher_url = teacherUrlMatch ? teacherUrlMatch[1] : null;

  // --- レッスン内容 ---
  // <div id="lessonStyleBox" ...><div class="inner">英語</div></div>
  const styleBoxMatches = [...block.matchAll(/<div[^>]*id="lessonStyleBox"[^>]*>[\s\S]*?<div[^>]*class="inner"[^>]*>\s*([\s\S]*?)\s*<\/div>/g)];
  const lesson_lang = styleBoxMatches[0] ? styleBoxMatches[0][1].replace(/<[^>]+>/g, '').trim() : null;
  const lesson_type = styleBoxMatches[1] ? styleBoxMatches[1][1].replace(/<[^>]+>/g, '').trim() : null;

  return {
    timestamp,
    source: 'dmm',
    teacher_en,
    teacher_ja,
    teacher_country,
    teacher_url,
    lesson_lang,
    lesson_type,
    duration_min,
    note_url,
    lesson_booking_url,
    month
  };
}

// --- 日時パース（フォールバック用）
// "2026年3月9日（月） 08:30 - 08:55"
function parseJaDatetime(text) {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[^０-９\d]*(\d{2}):(\d{2})/);
  if (!m) return null;
  const [_, y, mo, d, h, min] = m;
  return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T${h}:${min}:00`;
}

// --- 受講時間計算（分）
function calcDuration(startStr, endStr) {
  const [sh, sm] = startStr.split(':').map(Number);
  const [eh, em] = endStr.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const diff = endMin - startMin;
  return diff > 0 ? diff : diff + 1440; // 日跨ぎ対応
}

// ------------------------------------------------------------
// 利用可能月リストの取得
// ------------------------------------------------------------
async function getAvailableMonths() {
  const res = await fetch(BASE_URL, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  // <option value="202603">...</option> を正規表現で抽出（Service Worker: DOMParser不可）
  const matches = [...html.matchAll(/<option[^>]*value=['"]?(\d{6})['"]?[^>]*>/g)];
  const months = [...new Set(matches.map(m => m[1]))].filter(v => /^\d{6}$/.test(v)).sort();
  if (months.length === 0) throw new Error('月リストが取得できませんでした（ログイン状態を確認してください）');
  return months;
}

// ------------------------------------------------------------
// 月レンジ生成
// ------------------------------------------------------------
function generateMonthRange(from, to) {
  const months = [];
  let [y, m] = [parseInt(from.slice(0,4)), parseInt(from.slice(4,6))];
  const [ey, em] = [parseInt(to.slice(0,4)), parseInt(to.slice(4,6))];
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}${String(m).padStart(2,'0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// ------------------------------------------------------------
// ストレージ操作
// ------------------------------------------------------------
async function mergeRecords(newRecords) {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const existing = data[STORAGE_KEY] || [];
  const existingMap = new Map(existing.map(r => [`${r.source}_${r.timestamp}`, r]));

  let added = 0, skipped = 0;
  const addedRecords = [];
  for (const rec of newRecords) {
    const key = `${rec.source}_${rec.timestamp}`;
    if (!existingMap.has(key)) {
      existingMap.set(key, rec);
      addedRecords.push(rec);
      added++;
    } else {
      // フィールド追加時の上書き（同一ソース・timestampなら新データで更新）
      existingMap.set(key, { ...existingMap.get(key), ...rec });
      skipped++;
    }
  }

  const merged = [...existingMap.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return { added, skipped, addedRecords };
}

async function importJson(records) {
  if (!Array.isArray(records)) throw new Error('配列形式のJSONが必要です');
  return mergeRecords(records);
}

async function getHistory() {
  const data = await chrome.storage.local.get([STORAGE_KEY, LAST_SCRAPED_KEY]);
  return {
    records: data[STORAGE_KEY] || [],
    lastScraped: data[LAST_SCRAPED_KEY] || null
  };
}

// ------------------------------------------------------------
// 統計
// ------------------------------------------------------------
async function getStats() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const records = data[STORAGE_KEY] || [];
  if (records.length === 0) return null;

  const months = [...new Set(records.map(r => r.month))];
  const monthCount = months.length;
  const totalLessons = records.length;
  const avgPerMonth = totalLessons / monthCount;

  const withDuration = records.filter(r => r.duration_min != null);
  const totalMinutes = withDuration.reduce((s, r) => s + r.duration_min, 0);
  const avgDuration = withDuration.length ? (totalMinutes / withDuration.length).toFixed(1) : null;
  const totalHours = Math.floor(totalMinutes / 60);
  const remainMin = totalMinutes % 60;

  // 講師ランキング TOP15
  const teacherCount = {};
  records.forEach(r => {
    if (r.teacher_en) teacherCount[r.teacher_en] = (teacherCount[r.teacher_en] || 0) + 1;
  });
  const teacherRank = Object.entries(teacherCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  // レッスン種別
  const typeCount = {};
  records.forEach(r => {
    const t = r.lesson_type || '不明';
    typeCount[t] = (typeCount[t] || 0) + 1;
  });
  const typeRank = Object.entries(typeCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  // 時間帯別（JST）
  const timeSlots = { 朝: 0, 昼: 0, 夜: 0 };
  records.forEach(r => {
    const h = parseInt(r.timestamp.slice(11, 13));
    if (h >= 5 && h < 11) timeSlots['朝']++;
    else if (h >= 11 && h < 17) timeSlots['昼']++;
    else timeSlots['夜']++;
  });

  // 月別レッスン数
  const byMonth = {};
  records.forEach(r => { byMonth[r.month] = (byMonth[r.month] || 0) + 1; });

  // 国別
  const countryCount = {};
  records.forEach(r => {
    if (r.teacher_country) countryCount[r.teacher_country] = (countryCount[r.teacher_country] || 0) + 1;
  });

  const countryRank = Object.entries(countryCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // 教材ランキング TOP15
  const materialCount = {};
  records.forEach(r => {
    if (r.material_title) materialCount[r.material_title] = (materialCount[r.material_title] || 0) + 1;
  });
  const materialRank = Object.entries(materialCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([name, count]) => ({ name, count }));

  const materialTotal = records.filter(r => r.material_title).length;

  return {
    totalLessons,
    monthCount,
    avgPerMonth: avgPerMonth.toFixed(1),
    totalTime: `${totalHours}h ${remainMin}m`,
    avgDuration,
    teacherRank,
    typeRank,
    timeSlots,
    byMonth,
    countryRank,
    materialRank,
    materialTotal
  };
}

// ------------------------------------------------------------
// sanityCheck
// ------------------------------------------------------------
function sanityCheck(records, month) {
  const warnings = [];
  const n = records.length;
  if (n === 0) {
    warnings.push(`⚠️ ${month}: レコード0件 (HTML構造変化またはログイン切れ)`);
    return { warnings };
  }
  const tsFailRate = records.filter(r => !r.timestamp).length / n;
  if (tsFailRate > 0.3) warnings.push(`⚠️ ${month}: timestamp取得失敗 ${Math.round(tsFailRate*100)}% (日時フォーマット変化の可能性)`);
  const teacherFailRate = records.filter(r => !r.teacher_en).length / n;
  if (teacherFailRate > 0.5) warnings.push(`⚠️ ${month}: teacher取得失敗 ${Math.round(teacherFailRate*100)}% (HTML構造変化の可能性)`);
  const durationFailRate = records.filter(r => r.duration_min == null).length / n;
  if (durationFailRate > 0.5) warnings.push(`⚠️ ${month}: duration_min取得失敗 ${Math.round(durationFailRate*100)}% (受講時間の計算元となる時刻情報変化の可能性)`);
  return { warnings };
}

// ------------------------------------------------------------
// ユーティリティ
// ------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// 教材名取得（content-material.js から呼ばれる）
// ============================================================

// 一括取得: タブID → { resolve, timeout } のマップ
const batchPendingTabs = new Map();
let batchRunning = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_MATERIAL') {
    const tabId = sender.tab?.id;
    fetchMaterial(msg.callBookingId, msg.accessToken, msg.domTitle || null, msg.domTitleJa || null)
      .then(result => {
        sendResponse({ ok: true, ...result });
        // skipped（LessonHeader未ロード）の場合はタブを閉じず、リトライを待つ
        if (result.skipped) return;
        if (tabId != null && batchPendingTabs.has(tabId)) {
          const { resolve, timeout } = batchPendingTabs.get(tabId);
          clearTimeout(timeout);
          batchPendingTabs.delete(tabId);
          setTimeout(() => chrome.tabs.remove(tabId, () => {}), 500);
          resolve(result);
        }
      })
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
        if (tabId != null && batchPendingTabs.has(tabId)) {
          const { resolve, timeout } = batchPendingTabs.get(tabId);
          clearTimeout(timeout);
          batchPendingTabs.delete(tabId);
          setTimeout(() => chrome.tabs.remove(tabId, () => {}), 500);
          resolve({ skipped: true, reason: err.message });
        }
      });
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'START_BATCH_FETCH') {
    if (batchRunning) { sendResponse({ ok: false, error: 'already_running' }); return; }
    batchRunning = true;
    batchFetchMaterials()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: err.message }))
      .finally(() => { batchRunning = false; });
    return true;
  }
  if (msg.type === 'STOP_BATCH_FETCH') {
    batchRunning = false;
    sendResponse({ ok: true });
  }
});

/**
 * callBookingId から教材名を取得し、対応するストレージレコードを更新する
 *
 * ストレージキー: 'dmm_history'（chrome.storage.local）
 * レコード突合キー: timestamp（JST）かつ source === 'dmm'
 * 追加フィールド: material_title（英語）, material_title_ja（日本語）
 *
 * timestamp の形式: "2026-03-29T10:00:00"（JST、秒まで）
 * combined API の time.min 形式: "2026-03-29T01:00:00Z"（UTC）→ JST変換が必要
 */
async function fetchMaterial(callBookingId, accessToken, domTitle = null, domTitleJa = null) {
  const res = await fetch(
    'https://api.engoo.com/api/lesson_bookings/' + callBookingId + '/combined',
    {
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error('combined API: HTTP ' + res.status);

  const data = await res.json();
  if (data.error) throw new Error('combined API: ' + (data.error.detail || data.error));

  // time.min (UTC) → JST timestamp（ストレージの timestamp と同形式）
  const timeMin = data.data?.time?.min || data.data?.slot_time_ranges?.[0]?.min;
  if (!timeMin) {
    console.log('[fetchMaterial] skipped: time.min not found', { callBookingId });
    return { skipped: true, reason: 'time.min not found' };
  }

  const jstTimestamp = utcToJstTimestamp(timeMin);

  // DOM から取得済みの場合はそれを優先。なければ references から LessonHeader を探す
  let materialTitle = domTitle;
  let materialTitleJa = domTitleJa;

  if (!materialTitle) {
    // references はトップレベルフィールド（data の中ではない点に注意）
    const refs = data.references || {};
    for (const ref of Object.values(refs)) {
      if (ref._type === 'LessonHeader' && ref.title_text && ref.title_text.text) {
        materialTitle = ref.title_text.text.trim();
        const translations = ref.title_text.text_translations || [];
        const ja = translations.find(t => t.language === 'ja');
        materialTitleJa = ja ? ja.translation.trim() : null;
        break;
      }
    }
  }

  // ストレージの既存レコードと突合して更新
  const stored = await new Promise(resolve =>
    chrome.storage.local.get(STORAGE_KEY, resolve)
  );
  const history = stored[STORAGE_KEY] || [];
  let updated = 0;

  // 教材名が取れなかった場合はリトライ可能な skipped として返す（自動マークしない）
  if (!materialTitle) {
    console.log('[fetchMaterial] skipped: LessonHeader not found', { callBookingId, jstTimestamp });
    return { skipped: true, reason: 'LessonHeader not found', jstTimestamp };
  }

  const newHistory = history.map(record => {
    if (record.timestamp === jstTimestamp && record.source === 'dmm') {
      updated++;
      return { ...record, material_title: materialTitle, material_title_ja: materialTitleJa };
    }
    return record;
  });

  if (updated === 0) {
    console.log('[fetchMaterial] skipped: no matching record in storage', { callBookingId, jstTimestamp });
  }
  if (updated > 0) {
    await new Promise(resolve =>
      chrome.storage.local.set({ [STORAGE_KEY]: newHistory }, resolve)
    );
  }

  return { materialTitle, materialTitleJa, jstTimestamp, updated };
}

/**
 * UTC ISO文字列 → JST timestamp文字列（ストレージの timestamp と同形式）
 * 例: "2026-03-29T01:00:00Z" → "2026-03-29T10:00:00"
 */
function utcToJstTimestamp(utcStr) {
  const d = new Date(utcStr);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return jst.getUTCFullYear() + '-'
    + pad(jst.getUTCMonth() + 1) + '-'
    + pad(jst.getUTCDate()) + 'T'
    + pad(jst.getUTCHours()) + ':'
    + pad(jst.getUTCMinutes()) + ':'
    + pad(jst.getUTCSeconds());
}

async function setMaterialUnavailable(timestamp, unavailable) {
  const stored = await new Promise(resolve => chrome.storage.local.get(STORAGE_KEY, resolve));
  const history = stored[STORAGE_KEY] || [];
  const newHistory = history.map(r => {
    if (r.timestamp !== timestamp || r.source !== 'dmm') return r;
    if (unavailable) return { ...r, material_unavailable: true };
    const { material_unavailable, ...rest } = r;
    return rest;
  });
  await new Promise(resolve => chrome.storage.local.set({ [STORAGE_KEY]: newHistory }, resolve));
}

// ============================================================
// 一括教材名取得
// ============================================================

/**
 * material_title 未取得かつ lesson_booking_url があるレコードを順番にタブで開き、
 * Content Script が FETCH_MATERIAL を送信したら自動でタブを閉じて次へ進む
 */
async function batchFetchMaterials(targetRecords = null) {
  let pending;
  if (targetRecords) {
    pending = targetRecords.filter(r => !r.material_title && r.lesson_booking_url);
  } else {
    const stored = await new Promise(resolve => chrome.storage.local.get(STORAGE_KEY, resolve));
    const history = stored[STORAGE_KEY] || [];
    pending = history.filter(r => !r.material_title && r.lesson_booking_url);
  }

  let done = 0;
  const total = pending.length;

  for (const record of pending) {
    if (!batchRunning) break;
    await openTabAndWait(record.lesson_booking_url);
    done++;
    chrome.runtime.sendMessage({ type: 'BATCH_PROGRESS', done, total }).catch(() => {});
    await sleep(500);
  }

  return { done, total };
}

/**
 * URL をバックグラウンドタブで開き、FETCH_MATERIAL 完了またはタイムアウトまで待つ
 */
function openTabAndWait(url, timeoutMs = 30000) {
  return new Promise(resolve => {
    chrome.tabs.create({ url, active: false }, tab => {
      const timeout = setTimeout(() => {
        batchPendingTabs.delete(tab.id);
        chrome.tabs.remove(tab.id, () => {});
        resolve({ skipped: true, reason: 'timeout' });
      }, timeoutMs);
      batchPendingTabs.set(tab.id, { resolve, timeout });
    });
  });
}

// ============================================================
// 録音ダウンロード
// ============================================================

/**
 * lesson_booking_url をタブで開き、ページの「音声をダウンロード」ボタンを
 * DOM クリックで自動実行する。ページ側がチャンク結合・Blob化・ダウンロードを行う。
 *
 * フロー:
 *   lesson_booking_url → リダイレクト → /app/calls/full-screen
 *   → React レンダー待機
 *   → 「...」メニューボタンをクリック
 *   → 「音声をダウンロード」ボタンをクリック
 *   → ページがダウンロードを実行 → タブを閉じる
 */
function downloadRecordings(lessonBookingUrl, timestamp, materialTitle) {
  const dateStr = (timestamp || '').slice(0, 16).replace('T', '-').replace(/:/g, '') || 'unknown';
  const safeTitle = (materialTitle || '').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_').slice(0, 60);
  const filename = safeTitle ? `dmm-lesson-${dateStr}-${safeTitle}.webm` : `dmm-lesson-${dateStr}.webm`;

  return new Promise((resolve, reject) => {
    let tabId = null;
    let done = false;
    let dlTimer = null;
    let dlListener = null;

    const finish = (ok, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(dlTimer);
      if (dlListener) chrome.downloads.onCreated.removeListener(dlListener);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (tabId != null) setTimeout(() => chrome.tabs.remove(tabId, () => {}), 1000);
      ok ? resolve(value) : reject(new Error(value));
    };

    const timer = setTimeout(() => finish(false, 'タイムアウト (60s)'), 60000);

    const onUpdated = (id, changeInfo) => {
      if (id !== tabId) return;
      const url = changeInfo.url || '';
      if (!url.includes('/app/calls/full-screen')) return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      sleep(2500).then(() => chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [filename],
        func: (filename) => new Promise((res, rej) => {
          const origClick = HTMLAnchorElement.prototype.click;
          // blob ダウンロードの <a>.click() を1回だけ横取りしてファイル名を上書き
          HTMLAnchorElement.prototype.click = function () {
            if (this.href && this.href.startsWith('blob:') && this.download) {
              this.download = filename;
              HTMLAnchorElement.prototype.click = origClick;
            }
            return origClick.call(this);
          };

          const deadline = Date.now() + 20000;
          let menuTried = false;

          const poll = setInterval(() => {
            const dlBtns = [...document.querySelectorAll('button,[role="menuitem"],li')]
              .filter(el => el.textContent.trim().includes('音声をダウンロード'));
            const dlBtn = dlBtns[dlBtns.length - 1];
            if (dlBtn) {
              clearInterval(poll);
              dlBtn.click();
              res(true);
              return;
            }

            if (!menuTried) {
              menuTried = true;
              document.querySelectorAll('button[aria-label="その他のツール"]').forEach(b => b.click());
            }

            if (Date.now() > deadline) {
              clearInterval(poll);
              rej(new Error('ダウンロードボタンが見つかりませんでした'));
            }
          }, 300);
        })
      })).then(results => {
        if (!results?.[0]?.result) {
          finish(false, 'スクリプト実行失敗');
          return;
        }
        dlListener = (item) => {
          if (!item.url.startsWith('blob:https://eikaiwa.dmm.com')) return;
          finish(true, { chunks: 1 });
        };
        chrome.downloads.onCreated.addListener(dlListener);
        dlTimer = setTimeout(() => finish(false, 'ダウンロード開始タイムアウト (5分)'), 300000);
      }).catch(e => finish(false, e.message));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.create({ url: lessonBookingUrl, active: false }, tab => {
      tabId = tab.id;
    });
  });
}
