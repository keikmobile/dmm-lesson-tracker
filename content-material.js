/**
 * DMM英会話 Lesson Tracker - content-material.js
 *
 * 対象ページ: https://eikaiwa.dmm.com/app/* (SPA全体)
 * 発火条件: /app/calls/full-screen に遷移したとき（URL変化をポーリングで検知）
 *
 * 動作:
 *   1. URLから callBookingId を取得
 *   2. localStorage.AUTH から Bearer トークンを取得
 *   3. MutationObserver で DOM に span[lang="en"] が出現するのを待つ
 *   4. 出現したらタイトルを DOM から取得して background.js に送信
 *      → background.js は API でタイムスタンプを取得してストレージを更新
 *   5. DOM から取れない場合は API の references にフォールバック
 *
 * 注意:
 *   - 200ms間隔でURLを監視し、/app/calls/full-screen への遷移を検知する
 *   - callBookingId または accessToken が取れない場合は何もしない（静かに終了）
 *   - ストレージへの書き込みは background.js 側で行う
 */
(function () {
  function isTargetUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname.startsWith('/app/calls/full-screen');
    } catch (e) {
      return false;
    }
  }

  function getCredentials() {
    const params = new URLSearchParams(location.search);
    const callBookingId = params.get('callBookingId');
    if (!callBookingId) return null;

    const callBookingType = params.get('callBookingType');
    if (callBookingType && callBookingType !== 'lesson') return null;

    try {
      const auth = JSON.parse(localStorage.getItem('AUTH') || '{}');
      const accessToken = auth.access_token || null;
      if (!accessToken) return null;
      return { callBookingId, accessToken };
    } catch (e) {
      return null;
    }
  }

  function sendFetch(callBookingId, accessToken, domTitle, domTitleJa) {
    chrome.runtime.sendMessage({
      type: 'FETCH_MATERIAL',
      callBookingId,
      accessToken,
      domTitle: domTitle || null,
      domTitleJa: domTitleJa || null,
    });
  }

  // DOM に span[lang="en"] が出現するのを監視してタイトルを取得
  function watchDomTitle(callBookingId, accessToken) {
    function extractTitles() {
      const enSpan = document.querySelector('span[lang="en"]');
      if (!enSpan || !enSpan.textContent.trim()) return null;
      const jaSpan = document.querySelector('span[lang="ja"]');
      return {
        en: enSpan.textContent.trim(),
        ja: jaSpan ? jaSpan.textContent.trim() : null,
      };
    }

    // すでに DOM にある場合
    const titles = extractTitles();
    if (titles) {
      sendFetch(callBookingId, accessToken, titles.en, titles.ja);
      return;
    }

    // MutationObserver で出現を待つ（最大15秒）
    const observer = new MutationObserver(() => {
      const titles = extractTitles();
      if (titles) {
        observer.disconnect();
        clearTimeout(fallbackTimer);
        sendFetch(callBookingId, accessToken, titles.en, titles.ja);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 15秒経っても DOM に出なければ API のみで試みる
    const fallbackTimer = setTimeout(() => {
      observer.disconnect();
      sendFetch(callBookingId, accessToken, null, null);
    }, 15000);
  }

  function tryFetch() {
    const creds = getCredentials();
    if (!creds) return;
    watchDomTitle(creds.callBookingId, creds.accessToken);
  }

  // URL変化をポーリングで検知
  let lastUrl = location.href;
  setInterval(() => {
    const url = location.href;
    if (url !== lastUrl) {
      lastUrl = url;
      if (isTargetUrl(url)) {
        tryFetch();
      }
    }
  }, 200);

  // 直接 /app/calls/full-screen で開かれた場合
  if (isTargetUrl(location.href)) {
    tryFetch();
  }
})();
