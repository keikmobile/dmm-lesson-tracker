// ============================================================
// DMM英会話 Lesson Tracker - popup.js
// ============================================================

// ---- 進捗リッスン（1回のみ登録）----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCRAPE_PROGRESS') {
    progressText.textContent = `${formatMonth(msg.month)} 取得中...`;
  }
  if (msg.type === 'BATCH_PROGRESS') {
    const el = document.getElementById('batchProgress');
    if (el) el.textContent = `取得中: ${msg.done}/${msg.total}`;
    if (msg.done === msg.total) {
      const btn = document.getElementById('btnBatch');
      if (btn) btn.textContent = '教材名を一括取得';
      renderHistory();
    }
  }
});

// ---- タブ切り替え ----
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'analyze') renderAnalyze();
    if (btn.dataset.tab === 'history') renderHistory();
  });
});

// ============================================================
// 取得タブ
// ============================================================
const fromMonthSel = document.getElementById('fromMonth');
const toMonthSel = document.getElementById('toMonth');
const btnScrape = document.getElementById('btnScrape');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusBox = document.getElementById('statusBox');
const lastScrapedEl = document.getElementById('lastScraped');

// 月セレクトを初期化
async function initMonthSelects() {
  try {
    const res = await sendMsg({ type: 'GET_MONTHS' });
    if (!res.ok) throw new Error(res.error);
    const months = res.months;
    const now = toMonthStr(new Date());
    const oldest = months[0];

    // 取得開始月・取得終了月: どちらもデフォルトは今月
    [fromMonthSel, toMonthSel].forEach(sel => {
      sel.innerHTML = '';
      months.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = formatMonth(m);
        sel.appendChild(opt);
      });
      sel.value = now;
    });

    // 最古月をラベルとして表示
    const note = document.getElementById('oldestMonthNote');
    if (note && oldest) {
      note.textContent = `※ 最古のレッスン履歴: ${formatMonth(oldest)}`;
    }
  } catch (e) {
    showStatus(`月リスト取得失敗: ${e.message} (DMM英会話にログイン済みか確認してください)`, 'error');
  }
}

// 最終取得日時を表示
async function updateLastScraped() {
  const res = await sendMsg({ type: 'GET_HISTORY' });
  if (res.ok && res.lastScraped) {
    const d = new Date(res.lastScraped);
    lastScrapedEl.textContent = `最終取得: ${d.toLocaleString('ja-JP')}`;
  }
}

btnScrape.addEventListener('click', async () => {
  const from = fromMonthSel.value;
  const to = toMonthSel.value;
  if (!from || !to) return;
  if (from > to) { showStatus('取得開始月は終了月以前にしてください', 'error'); return; }

  btnScrape.disabled = true;
  progressWrap.classList.add('show');
  progressFill.style.width = '0%';
  progressText.textContent = '取得開始中...';
  showStatus('', 'info');

  try {
    const res = await sendMsg({ type: 'START_SCRAPE', fromMonth: from, toMonth: to });
    progressFill.style.width = '100%';
    if (res.ok) {
      let msg = `✅ 完了: ${res.added}件追加, ${res.skipped}件更新`;
      if (res.warnings && res.warnings.length) {
        showStatusWithWarnings(msg, res.warnings);
      } else {
        showStatus(msg, 'success');
      }
      await updateLastScraped();
    } else {
      showStatus(`❌ エラー: ${res.error}`, 'error');
    }
  } catch (e) {
    showStatus(`❌ エラー: ${e.message}`, 'error');
  } finally {
    btnScrape.disabled = false;
    progressWrap.classList.remove('show');
  }
});

// ---- インポート ----
const importZone = document.getElementById('importZone');
const importFileInput = document.getElementById('importFileInput');

importZone.addEventListener('click', () => importFileInput.click());
importZone.addEventListener('dragover', e => { e.preventDefault(); importZone.classList.add('drag-over'); });
importZone.addEventListener('dragleave', () => importZone.classList.remove('drag-over'));
importZone.addEventListener('drop', e => {
  e.preventDefault();
  importZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadJsonFile(file);
});
importFileInput.addEventListener('change', e => {
  if (e.target.files[0]) loadJsonFile(e.target.files[0]);
});

async function loadJsonFile(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    // ラッパー形式 {schema_version, records: [...]} にも対応
    const records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.records) ? parsed.records : null);
    if (!records) throw new Error('レコード配列が見つかりません');
    const res = await sendMsg({ type: 'IMPORT_JSON', records });
    if (res.ok) {
      showStatus(`✅ インポート完了: ${res.added}件追加, ${res.skipped}件更新`, 'success');
    } else {
      showStatus(`❌ インポートエラー: ${res.error}`, 'error');
    }
  } catch (e) {
    showStatus(`❌ JSONパースエラー: ${e.message}`, 'error');
  }
}

// ============================================================
// 分析タブ
// ============================================================
async function renderAnalyze() {
  const res = await sendMsg({ type: 'GET_STATS' });
  const el = document.getElementById('analyzeContent');
  if (!res.ok || !res.stats) {
    el.innerHTML = '<div class="empty-state">データがありません。まず「取得」タブで履歴を取得してください。</div>';
    return;
  }
  const s = res.stats;

  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">総レッスン数</div>
        <div class="value">${s.totalLessons.toLocaleString()}<span class="unit"> 回</span></div>
      </div>
      <div class="stat-card">
        <div class="label">月平均レッスン数</div>
        <div class="value">${s.avgPerMonth}<span class="unit"> 回</span></div>
      </div>
      <div class="stat-card">
        <div class="label">受講月数</div>
        <div class="value">${s.monthCount}<span class="unit"> ヶ月</span></div>
      </div>
      <div class="stat-card">
        <div class="label">累計受講時間</div>
        <div class="value">${s.totalTime}</div>
      </div>
      <div class="stat-card">
        <div class="label">平均レッスン時間</div>
        <div class="value">${s.avgDuration ?? '—'}<span class="unit"> 分</span></div>
      </div>
    </div>

    <div class="chart-section">
      <h3>🕐 時間帯別</h3>
      <div class="timeslot-grid">
        ${['朝', '昼', '夜'].map(t => {
          const c = s.timeSlots[t] || 0;
          const pct = s.totalLessons ? ((c / s.totalLessons) * 100).toFixed(0) : 0;
          return `<div class="timeslot-card">
            <div class="ts-label">${t}（${t==='朝'?'5〜11':''}${t==='昼'?'11〜17':''}${t==='夜'?'17〜5':''}時）</div>
            <div class="ts-count">${c}</div>
            <div class="ts-pct">${pct}%</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="chart-section">
      <h3>👩‍🏫 講師 TOP15</h3>
      ${renderBarList(s.teacherRank)}
    </div>

    <div class="chart-section">
      <h3>📖 レッスン種別</h3>
      ${renderBarList(s.typeRank)}
    </div>

    <div class="chart-section">
      <h3>🌏 講師の国</h3>
      ${renderBarList(s.countryRank)}
    </div>

    <div class="chart-section">
      <h3>📚 教材 TOP15 <span style="font-weight:normal;color:#aaa;">(取得済み ${s.materialTotal}件)</span></h3>
      ${renderBarList(s.materialRank)}
    </div>

    <div class="chart-section">
      <h3>📅 月別推移</h3>
      <canvas id="monthlyChart"></canvas>
    </div>
  `;

  renderMonthlyChart(s.byMonth);
}

function renderBarList(items) {
  if (!items || items.length === 0) return '<div style="color:#aaa;font-size:12px;">データなし</div>';
  const max = items[0].count;
  return `<div class="bar-list">
    ${items.map(({ name, count }) => `
      <div class="bar-item">
        <div class="bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.round(count/max*100)}%"></div>
        </div>
        <div class="bar-count">${count}</div>
      </div>
    `).join('')}
  </div>`;
}

function renderMonthlyChart(byMonth) {
  const canvas = document.getElementById('monthlyChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const months = Object.keys(byMonth).sort();
  const counts = months.map(m => byMonth[m]);
  if (months.length === 0) return;

  const W = canvas.offsetWidth || 388;
  const H = 80;
  canvas.width = W;
  canvas.height = H;

  const maxC = Math.max(...counts);
  const pad = { l: 4, r: 4, t: 6, b: 20 };
  const barW = Math.max(2, Math.floor((W - pad.l - pad.r) / months.length) - 1);

  ctx.clearRect(0, 0, W, H);

  months.forEach((m, i) => {
    const x = pad.l + i * ((W - pad.l - pad.r) / months.length);
    const barH = maxC > 0 ? ((counts[i] / maxC) * (H - pad.t - pad.b)) : 0;
    const y = H - pad.b - barH;
    ctx.fillStyle = '#d62b2b';
    ctx.globalAlpha = 0.75;
    ctx.fillRect(x, y, barW, barH);
  });

  // 年ラベル（毎年1月）
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#999';
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';
  months.forEach((m, i) => {
    if (m.endsWith('01')) {
      const x = pad.l + i * ((W - pad.l - pad.r) / months.length) + barW / 2;
      ctx.fillText(m.slice(0, 4), x, H - 4);
    }
  });
}

// ============================================================
// 履歴タブ
// ============================================================
let allRecords = [];

async function renderHistory() {
  const res = await sendMsg({ type: 'GET_HISTORY' });
  if (!res.ok) return;
  allRecords = res.records || [];

  const total = allRecords.length;
  const withMaterial = allRecords.filter(r => r.material_title).length;
  const unavailable = allRecords.filter(r => r.material_unavailable).length;
  const pending = allRecords.filter(r => !r.material_title && !r.material_unavailable).length;
  const statsEl = document.getElementById('materialStats');
  if (statsEl) {
    statsEl.textContent = `教材取得済み: ${withMaterial} / 未取得: ${pending} / 取得不可: ${unavailable}  (全${total}件)`;
  }

  filterAndRenderHistory(document.getElementById('searchInput').value);
  if (res.lastScraped) {
    const d = new Date(res.lastScraped);
    document.getElementById('lastScraped').textContent = `最終取得: ${d.toLocaleString('ja-JP')}`;
  }
}

// 0: 全件, 1: 未取得のみ, 2: 取得不可のみ
let materialFilter = 0;

document.getElementById('searchInput').addEventListener('input', e => {
  filterAndRenderHistory(e.target.value);
});

document.getElementById('btnFilterNoMaterial').addEventListener('click', () => {
  materialFilter = materialFilter === 1 ? 0 : 1;
  document.getElementById('btnFilterNoMaterial').classList.toggle('active', materialFilter === 1);
  document.getElementById('btnFilterUnavailable').classList.remove('active');
  if (materialFilter !== 2) materialFilter = materialFilter === 1 ? 1 : 0;
  filterAndRenderHistory(document.getElementById('searchInput').value);
});

document.getElementById('btnFilterUnavailable').addEventListener('click', () => {
  materialFilter = materialFilter === 2 ? 0 : 2;
  document.getElementById('btnFilterUnavailable').classList.toggle('active', materialFilter === 2);
  document.getElementById('btnFilterNoMaterial').classList.toggle('active', false);
  filterAndRenderHistory(document.getElementById('searchInput').value);
});

function filterAndRenderHistory(query) {
  const q = query.toLowerCase();
  let filtered = q
    ? allRecords.filter(r =>
        (r.teacher_en || '').toLowerCase().includes(q) ||
        (r.teacher_ja || '').includes(q) ||
        (r.lesson_type || '').includes(q) ||
        (r.lesson_lang || '').includes(q) ||
        (r.material_title || '').toLowerCase().includes(q) ||
        (r.material_title_ja || '').includes(q)
      )
    : allRecords;
  if (materialFilter === 1) filtered = filtered.filter(r => !r.material_title && !r.material_unavailable);
  if (materialFilter === 2) filtered = filtered.filter(r => r.material_unavailable);

  const list = document.getElementById('historyList');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">データがありません</div>';
    return;
  }

  list.innerHTML = filtered.map(r => {
    const dt = formatDatetime(r.timestamp);
    const dur = r.duration_min != null ? `${r.duration_min}分` : '—';
    const materialEl = r.material_title
      ? `<div class="hi-material">${escapeHtml(r.material_title)}</div>`
      : r.material_unavailable
        ? `<div class="hi-unavailable">取得不可 <button class="btn-undo" data-ts="${escapeHtml(r.timestamp)}">元に戻す</button></div>`
        : `<div class="hi-material-link"><a href="${r.lesson_booking_url || 'https://eikaiwa.dmm.com/app/'}" target="_blank">教材名を取得</a> <button class="btn-unavailable" data-ts="${escapeHtml(r.timestamp)}">×</button></div>`;
    return `<div class="history-item">
      <div>
        <div class="hi-datetime">${dt}</div>
        <div class="hi-lesson">${escapeHtml(r.lesson_type || r.lesson_lang) || '—'}</div>
        ${materialEl}
      </div>
      <div>
        <div class="hi-teacher">${escapeHtml(r.teacher_en) || '—'}</div>
        <div class="hi-country">${escapeHtml(r.teacher_country)}</div>
      </div>
      <div>
        <div class="hi-duration">${dur}</div>
        ${r.note_url ? `<div class="hi-note"><a href="https://eikaiwa.dmm.com${r.note_url}" target="_blank">Note</a></div>` : ''}
      </div>
    </div>`;
  }).join('');

  // 取得不可ボタンのイベント委譲
  list.addEventListener('click', async e => {
    const unavailBtn = e.target.closest('.btn-unavailable');
    const undoBtn = e.target.closest('.btn-undo');
    if (unavailBtn) {
      await sendMsg({ type: 'SET_MATERIAL_UNAVAILABLE', timestamp: unavailBtn.dataset.ts, unavailable: true });
      await renderHistory();
    } else if (undoBtn) {
      await sendMsg({ type: 'SET_MATERIAL_UNAVAILABLE', timestamp: undoBtn.dataset.ts, unavailable: false });
      await renderHistory();
    }
  }, { once: true });
}

// ---- エクスポート ----
document.getElementById('btnExport').addEventListener('click', async () => {
  const res = await sendMsg({ type: 'GET_HISTORY' });
  if (!res.ok || !res.records.length) { alert('データがありません'); return; }
  const payload = { schema_version: 1, exported_at: new Date().toISOString(), records: res.records };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dmm-history-${toDateStr(new Date())}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---- 一括取得 ----
document.getElementById('btnBatch').addEventListener('click', async () => {
  const btn = document.getElementById('btnBatch');
  const progressEl = document.getElementById('batchProgress');
  if (btn.textContent === '停止') {
    await sendMsg({ type: 'STOP_BATCH_FETCH' });
    btn.textContent = '教材名を一括取得';
    progressEl.textContent = '';
    return;
  }
  btn.textContent = '停止';
  progressEl.textContent = '開始中...';
  const res = await sendMsg({ type: 'START_BATCH_FETCH' });
  btn.textContent = '教材名を一括取得';
  if (res.ok) {
    progressEl.textContent = `完了: ${res.done}/${res.total}`;
    renderHistory();
  } else {
    progressEl.textContent = res.error === 'already_running' ? '実行中です' : `エラー: ${res.error}`;
  }
});

// ---- 消去 ----
document.getElementById('btnClear').addEventListener('click', async () => {
  if (!confirm('ストレージのデータをすべて削除しますか？この操作は取り消せません。')) return;
  const res = await sendMsg({ type: 'CLEAR_STORAGE' });
  if (res.ok) {
    allRecords = [];
    filterAndRenderHistory('');
    showStatus('ストレージを消去しました', 'info');
  }
});

// ============================================================
// ユーティリティ
// ============================================================
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

function showStatus(msg, type) {
  statusBox.className = `status-box show ${type}`;
  statusBox.innerHTML = msg;
  if (!msg) statusBox.classList.remove('show');
}

function showStatusWithWarnings(msg, warnings) {
  statusBox.className = 'status-box show warning';
  statusBox.innerHTML = `${msg}<ul class="warning-list">${warnings.map(w => `<li>${w}</li>`).join('')}</ul>`;
}

function formatMonth(m) {
  return `${m.slice(0,4)}年${parseInt(m.slice(4,6))}月`;
}

function toMonthStr(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
}

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDatetime(ts) {
  if (!ts) return '—';
  const d = new Date(ts.replace('T', ' '));
  const days = ['日','月','火','水','木','金','土'];
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}(${days[d.getDay()]}) ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ============================================================
// 初期化
// ============================================================
initMonthSelects();
updateLastScraped();
