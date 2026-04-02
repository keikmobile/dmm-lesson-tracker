# DMM英会話 Lesson Tracker

DMM英会話のレッスン履歴を収集・分析する Chrome 拡張機能。

## 概要

DMM英会話のレッスン履歴ページ（`/lesson/`）をスクレイピングし、受講データをローカルに保存・分析する。レッスン中に教材名を自動取得してレコードに追加する機能、およびレッスン録音を1クリックでダウンロードする機能を備える。外部サービスへのデータ送信は一切行わない。

---

## インストール

1. このリポジトリをクローンまたは ZIP でダウンロード
2. Chrome のアドレスバーに `chrome://extensions` を入力
3. 右上の「デベロッパーモード」をオン
4. 「パッケージ化されていない拡張機能を読み込む」→ `dmm-lesson-tracker` フォルダを選択

**前提**: DMM英会話（eikaiwa.dmm.com）にログイン済みであること。

---

## 機能

### 取得タブ

| 項目 | 内容 |
|------|------|
| 取得開始月 | デフォルトは今月。セレクトで任意の月に変更可能 |
| 取得終了月 | デフォルトは今月 |
| 履歴を取得 | 指定月から終了月まで全月・全ページをスクレイピング |
| JSONインポート | 既存の JSON ファイルを読み込んでストレージにマージ |

スクレイピング中は拡張アイコンのバッジに進捗（例: `3/12`）を表示する。ポップアップを閉じても確認できる。

**マージ仕様:** スクレイプとインポートどちらも `timestamp` をキーに重複除去。同じ `timestamp` が既存にある場合は新しいデータで上書きする（フィールド追加時の再取得に対応）。

### 分析タブ

| 項目 | 内容 |
|------|------|
| 総レッスン数 | 全レコード件数 |
| 月平均レッスン数 | 総件数 ÷ 受講月数 |
| 受講月数 | データがある月の数 |
| 累計受講時間 | `duration_min` がある全レコードの合計（例: `399h 22m`） |
| 平均レッスン時間 | `duration_min` がある全レコードの平均（分） |
| 講師 TOP15 | 受講回数上位15名の棒グラフ |
| レッスン種別 | 種別ごとの受講回数棒グラフ |
| 講師の国 | 国別の受講回数棒グラフ |
| 教材 TOP15 | 受講回数上位15教材の棒グラフ（教材名取得済み件数を併記） |
| 時間帯別 | 朝（5〜11時）/ 昼（11〜17時）/ 夜（17〜5時）の件数・割合 |
| 月別推移 | 月ごとの受講回数バーチャート |

> `duration_min` は取得時に開始・終了時刻の差分から計算されるフィールド。インポートした既存 JSON に含まれない場合は `—` 表示。

### 履歴タブ

- 全レコードを `timestamp` 降順で一覧表示
- 講師名・レッスン種別・教材名でのテキスト検索
- **教材件数サマリー:** リスト上部に「教材取得済み / 未取得 / 取得不可 (全N件)」を表示
- **未取得フィルター:** `material_title` がなく取得不可マークもないレコードのみ表示
- **取得不可フィルター:** 取得不可マークが付いたレコードのみ表示
- **教材名を一括取得:** 未取得レコードを順番にバックグラウンドタブで開き、教材名を自動取得（詳細は後述）
- **JSONエクスポート:** `dmm-history-YYYY-MM-DD.json` として保存
- **消去:** ストレージの全データを削除

各レコードの表示内容:
- 日時（年/月/日(曜) HH:MM 形式）
- レッスン種別
- 教材名（取得済みの場合）／「教材名を取得」リンク（未取得の場合）／「取得不可」バッジ（取得不可マークの場合）
- 講師名・国
- 受講時間
- レッスンノートへのリンク
- 🎙 ボタン（録音ダウンロード。`lesson_booking_url` があるレコードのみ表示）

「教材名を取得」リンクの横の **×** ボタンで取得不可マークを付けられる。取得不可フィルター表示中に **元に戻す** ボタンでマークを解除できる。

---

## 録音ダウンロード

履歴タブの各レコードにある 🎙 ボタンをクリックすると、そのレッスンの録音（両者ミックス済み WebM）をダウンロードできる。

### 仕組み

1. `lesson_booking_url` をバックグラウンドタブで開く
2. `/app/calls/full-screen` へのリダイレクトを待機（React レンダー完了まで 2.5 秒待機）
3. 「その他のツール」メニューを開き「音声をダウンロード」ボタンを自動クリック
4. ページ側がチャンク結合・Blob 作成・ダウンロードを実行
5. ダウンロード開始を `chrome.downloads.onCreated` で検知してタブを閉じる

ファイル名は `dmm-lesson-YYYY-MM-DD-教材名.webm` 形式。教材名が未取得の場合は `dmm-lesson-YYYY-MM-DD.webm`。

> **前提:** 事前に「履歴を取得」を実行して `lesson_booking_url` をレコードに保存しておくこと。録音が存在しないレッスンはダウンロードボタンクリック後にエラーになる。

---

## 教材名の自動取得

DMM英会話の履歴ページ（`/lesson/`）には教材名が含まれない。教材名は Engoo API（`api.engoo.com`）から取得する。

### 仕組み

1. レッスン中またはレッスン後に `/app/calls/full-screen?callBookingId=UUID` を開く
2. Content Script（`content-material.js`）が `callBookingId` と認証トークンを取得
3. MutationObserver で DOM 内の `<span lang="en">` の出現を監視し、教材名を取得（最大15秒待機）
4. DOM から取得できた場合はそのまま使用。取得できない場合は Service Worker（`background.js`）が Engoo API の `combined` エンドポイントの `references` から `LessonHeader` を探す
5. Engoo API の `time.min`（UTC）を JST 変換してストレージの `timestamp` と突合し、該当レコードに `material_title` / `material_title_ja` を追記

### 手動取得

1. 履歴ページ（`https://eikaiwa.dmm.com/lesson/`）から「レッスンページに入る」をクリック
2. `/app/calls/full-screen` に遷移すると自動で教材名を取得

### 一括取得

ポップアップの履歴タブ →「教材名を一括取得」ボタン:

1. `lesson_booking_url` があり `material_title` がないレコードを順番にバックグラウンドタブで開く
2. Content Script が `FETCH_MATERIAL` を送信したら自動でタブを閉じて次へ進む
3. 30秒でタイムアウトした場合はスキップして次へ
4. ポップアップに進捗（「取得中: 5/59」）を表示。「停止」ボタンで中断可能

「履歴を取得」実行時は、**新規追加レコードのみ**自動で一括取得を行う（既存レコードは対象外）。

> **前提:** 事前に「履歴を取得」を実行して `lesson_booking_url` をレコードに保存しておくこと。

---

## データ仕様

### レコード構造

```json
{
  "timestamp":           "2026-03-09T08:30:00",
  "source":              "dmm",
  "teacher_en":          "Teacher Name",
  "teacher_ja":          "講師名",
  "teacher_country":     "フィリピン",
  "teacher_url":         "/teacher/index/XXXXX/",
  "lesson_lang":         "英語",
  "lesson_type":         "オリジナル教材 - デイリーニュース",
  "duration_min":        25,
  "note_url":            "/lesson/note/XXXXXXXXX/view/",
  "lesson_booking_url":  "https://eikaiwa.dmm.com/app/lesson-booking/pXXXXXX",
  "month":               "202603",
  "material_title":      "The Science of Making New Friends",
  "material_title_ja":   "新しい友達を作る科学",
  "material_unavailable": false
}
```

### フィールド仕様

| フィールド | 型 | 内容 |
|-----------|-----|------|
| `timestamp` | string (ISO 8601) | 受講開始日時（JST） |
| `source` | string | データソース識別子（固定値: `"dmm"`） |
| `teacher_en` | string \| null | 講師名（英語） |
| `teacher_ja` | string \| null | 講師名（日本語） |
| `teacher_country` | string \| null | 講師の国 |
| `teacher_url` | string \| null | 講師ページの相対URL |
| `lesson_lang` | string \| null | 受講言語（例: 英語） |
| `lesson_type` | string \| null | レッスン種別（例: オリジナル教材 - デイリーニュース） |
| `duration_min` | number \| null | 受講時間（分）。開始・終了時刻から計算 |
| `note_url` | string \| null | レッスンノートの相対URL |
| `lesson_booking_url` | string \| null | レッスン予約ページの URL（`/app/lesson-booking/p-XXXX` 形式）。スクレイプ時に取得 |
| `month` | string (YYYYMM) | 受講月 |
| `material_title` | string \| null | 教材名（英語）。教材名取得後に追加 |
| `material_title_ja` | string \| null | 教材名（日本語）。教材名取得後に追加 |
| `material_unavailable` | true \| undefined | 手動で「取得不可」マークを付けた場合に `true` |

### 統合時のフィールド互換性

[nc-lesson-tracker](https://github.com/keikmobile/nc-lesson-tracker) と JSON をやりとりする場合、以下のフィールドは相手側に存在しない（`null` または省略）。

| フィールド | DMM | NC |
|-----------|-----|----|
| `teacher_url` | あり | なし |
| `lesson_lang` | あり | なし |
| `note_url` | あり | なし |
| `lesson_booking_url` | あり | なし |
| `material_title` | あり | なし |
| `material_title_ja` | あり | なし |
| `level` | なし | あり |
| `topic` | なし | あり |
| `textbook_url` | なし | あり |

`source` フィールド（`"dmm"` / `"nativecamp"`）で判別できる。

### ストレージ

`chrome.storage.local` に以下のキーで保存。

| キー | 内容 |
|------|------|
| `dmm_history` | レコードの配列（timestamp 降順） |
| `dmm_last_scraped` | 最終取得日時（ISO 8601） |

---

## スクレイピング仕様

### 対象 URL

```
https://eikaiwa.dmm.com/lesson/?history_date=YYYYMM&page=N
```

- `history_date` は YYYYMM 形式（例: `202603`）
- `page=1` から開始し、総件数から最終ページを計算してループ
- 1ページあたり10件固定

### ページ数の計算

1ページ目の HTML に含まれる件数表示から総ページ数を算出する。

```
<span>57件中</span> 11～20件 10ページ目を表示
↓
総件数 57 → Math.ceil(57 / 10) = 6 ページ
```

### ウェイト

| 区間 | 待機時間 |
|------|---------|
| 月間（次の月へ移る前） | 400ms |
| ページ間（同月内の次ページへ） | 300ms |

### パーサーが依存している HTML 構造

| 取得内容 | 依存パターン |
|---------|-------------|
| 開始日時 | `data-start-time="2026-03-09 08:30:00"` 属性 |
| 受講時間 | `header#time` 内の `HH:MM - HH:MM` テキスト（差分計算） |
| 講師名（英語） | `<dt id="en">` |
| 講師名（日本語） | `<dd id="ja">` |
| 講師の国 | `<dd id="country">` |
| 講師URL | `href="/teacher/index/XXXXX/"` パターン |
| レッスン言語 | `div#lessonStyleBox .inner`（1個目） |
| レッスン種別 | `div#lessonStyleBox .inner`（2個目） |
| レッスンノートURL | `href="/lesson/note/XXXXXXXXX/view/"` パターン |
| レッスン予約URL | `href="https://eikaiwa.dmm.com/app/lesson-booking/..."` パターン |

**注意:** Manifest V3 の Service Worker 環境では `DOMParser` が使用不可のため、パーサーは正規表現ベースで実装している。

### 仕様変化検知（sanityCheck）

取得完了後に各月のレコードを自動チェックし、DMM側の HTML 構造変化を検知する。問題があればポップアップに ⚠️ 警告として表示する。

| チェック条件 | 閾値 | 意味 |
|-------------|------|------|
| レコード件数が 0 | — | HTML 構造変化またはログイン切れ |
| timestamp 取得失敗 | 30% 超 | 日時フォーマット変化の可能性 |
| teacher 取得失敗 | 50% 超 | 講師情報構造変化の可能性 |
| `duration_min` 取得失敗 | 50% 超 | 受講時間の計算元となる時刻情報変化の可能性 |

**警告が出たときの対処:**

1. ログイン状態を確認（件数 0 の場合）
2. DMM英会話のレッスン履歴ページを「名前を付けて保存」で手元に保存
3. そのファイルを AI に渡して `parseContentBlock` 関数を書き直す

---

## ファイル構成

```
dmm-lesson-tracker/
├── manifest.json          # 拡張機能設定（Manifest V3）
├── background.js          # Service Worker（スクレイピング・データ管理・教材名取得・録音ダウンロード）
├── content-material.js    # Content Script（教材名取得用）
├── popup.html             # ポップアップ UI
├── popup.js               # ポップアップのロジック
├── README.md              # このファイル
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## パーミッション

| パーミッション | 用途 |
|--------------|------|
| `storage` | レッスン履歴のローカル保存 |
| `tabs` | 教材名一括取得・録音ダウンロード時のバックグラウンドタブ操作 |
| `scripting` | 録音ダウンロード時のページへのスクリプト注入（ボタン自動クリック・ファイル名書き換え） |
| `downloads` | 録音ダウンロード開始の検知 |
| `host_permissions: eikaiwa.dmm.com/lesson/*` | レッスン履歴ページのスクレイピング |
| `host_permissions: api.engoo.com/api/lesson_bookings/*` | 教材名取得 API へのアクセス |
| `content_scripts: eikaiwa.dmm.com/app/*` | レッスン中ページでの callBookingId・認証トークン取得 |

---

## セキュリティポリシー

| 項目 | 方針 |
|------|------|
| ネットワークアクセス | `https://eikaiwa.dmm.com/lesson/*` および `https://api.engoo.com/api/lesson_bookings/*` のみ（録音ダウンロードはページ側のフェッチを利用） |
| 認証情報（スクレイピング） | `fetch` に `credentials: 'include'` を指定し、ログイン済みセッションクッキーを利用。クッキー自体は拡張機能が読み取らず、ブラウザが自動付与する |
| 認証情報（教材名取得） | Content Script が `localStorage.AUTH.access_token` を読み取り、Service Worker に渡す。トークンはストレージに保存しない |
| 認証情報（録音ダウンロード） | ページ側の認証情報をそのまま利用。拡張機能はトークンを読み取らない |
| データ保存 | `chrome.storage.local` に平文で保存。OS のユーザーアカウント保護に依存。外部サーバーへの送信は行わない |
| スクリプト実行 | CSP で `script-src 'self'` を明示。`eval` ・インラインスクリプト・外部スクリプトの実行を禁止 |
| XSS 対策 | ストレージから読み出したフィールドを `innerHTML` に挿入する前に `escapeHtml()` でサニタイズ |
| パーミッション | 必要最小限のみ要求 |

---

## 注意事項

- **個人利用のみ**を想定。スクレイピングの過度な実行は避けること
- データはすべてローカルの `chrome.storage.local` に保存。外部送信なし
- DMM英会話側の HTML 構造が変わるとパーサーが壊れる可能性がある（sanityCheck で検知）
