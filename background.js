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
      .then(result => sendResponse({ ok: true, ...result }))
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

  for (const month of months) {
    // 進捗を popup に通知
    chrome.runtime.sendMessage({
      type: 'SCRAPE_PROGRESS',
      month,
      done: totalAdded + totalSkipped,
      total: months.length
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

    const { added, skipped } = await mergeRecords(allRecords);
    totalAdded += added;
    totalSkipped += skipped;

    await sleep(DELAY_MS);
  }

  await chrome.storage.local.set({ [LAST_SCRAPED_KEY]: new Date().toISOString() });

  return { added: totalAdded, skipped: totalSkipped, warnings };
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
  for (const rec of newRecords) {
    const key = `${rec.source}_${rec.timestamp}`;
    if (!existingMap.has(key)) {
      existingMap.set(key, rec);
      added++;
    } else {
      // フィールド追加時の上書き（同一ソース・timestampなら新データで更新）
      existingMap.set(key, { ...existingMap.get(key), ...rec });
      skipped++;
    }
  }

  const merged = [...existingMap.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
  return { added, skipped };
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
    countryRank
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
