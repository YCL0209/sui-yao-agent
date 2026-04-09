# 階段 H2-2：Dashboard 前端（五面板 + 穗鈅設計規範）

> H2-1 API 層已完成（HTTP + WebSocket + Telegram 登入）。
> 本階段建立 Dashboard 前端：單頁 HTML + CSS + JS，五個面板 tab 切換。
> 設計規範參照穗鈅科技 ERP v9.0 風格指南（UI_STYLE_GUIDE.md）。

---

## 專案位置

```
~/sui-yao-agent/
├── public/                            # Dashboard 前端
│   ├── index.html                     # 🔧 替換：完整 Dashboard 頁面
│   ├── style.css                      # ⚡ 新建：穗鈅設計規範 CSS
│   └── app.js                         # ⚡ 新建：前端邏輯
└── src/dashboard/                     # 不動（H2-1 已完成）
```

---

## 設計規範（必須遵守）

所有 CSS 使用穗鈅科技 ERP v9.0 風格指南定義的變數和色碼。

### 色彩

```
主色：#4073c2（按鈕、tab active、連結）
青綠：#14b5af（次要強調、特色元素）
主色深：#2c5282（hover、標題）
成功：#28a745   危險：#dc3545   警告：#ffc107
背景：#f7fafc   邊框：#e2e8f0
文字主：#2d3748   文字次：#718096
登入頁漸層：linear-gradient(135deg, #4073c2 0%, #14b5af 100%)
```

### 字體

```
字體：-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif
標題：24px / 700   卡片數值：18px / 600   按鈕：15px / 600
基礎：14px / 400   小字：12px
```

### 元件

```
卡片：bg #fff, radius 6px, shadow 0 2px 6px rgba(0,0,0,0.08)
按鈕：padding 10px 18px, radius 4px, hover translateY(-1px)
表格 th：bg #f7fafc, border-bottom 2px solid #e2e8f0
表格 tr:hover：bg #f7fafc
輸入框：padding 8px 12px, border 1px solid #e2e8f0, focus border #4073c2
```

---

## 頁面結構

### 登入頁

漸層背景，居中的白色登入卡片。兩步驟：輸入 Telegram 帳號 → 輸入驗證碼。

### Dashboard 頁（登入後）

```
Header：穗鈅助手 Dashboard                        [登出]
Tab Bar：[系統狀態] [提醒] [記憶] [Logs] [對話]
Tab Content：根據選中的 tab 顯示對應面板
```

---

## 五個面板

### Tab 1：系統狀態（預設）

- 六個統計卡片一排（flex-wrap）：Bot 狀態、待執行提醒、記憶數、Logs 數、用戶數、對話數
- 系統資訊面板：版本、模型、uptime、WS 連線數
- 最近 5 筆 skill 呼叫小表格
- API：`GET /api/status` + `GET /api/logs?limit=5`

### Tab 2：提醒

- 篩選列：status 下拉（pending/done/cancelled/全部）+ 刷新按鈕
- 表格：用戶、內容、提醒時間（MM/DD HH:mm）、重複、操作（🗑）
- 刪除呼叫 `DELETE /api/reminders/:id`
- API：`GET /api/reminders?status=pending`

### Tab 3：記憶管理

- 頂部：「記憶數：XX / 200」+ 用戶切換下拉（admin 才有）
- 卡片列表（不是表格），每張顯示：content、category、source、日期、importance 滑桿、accessCount、刪除按鈕
- importance 滑桿：`<input type="range" min="0" max="1" step="0.1">`，onChange 呼叫 `PUT /api/memories/:id`
- API：`GET /api/memories?userId=xxx`

### Tab 4：Execution Logs

- 篩選列：skill 下拉、status 下拉、limit 下拉
- 表格：時間、skill、用戶、狀態（✅/❌）、耗時
- 點擊一行展開詳情（input / output / error）
- WebSocket `new_log` 事件 → 新行從頂部插入
- API：`GET /api/logs?limit=50`

### Tab 5：對話歷史

- 表格：用戶、最後訊息（截取前 30 字）、更新時間
- 點擊展開完整對話：聊天氣泡樣式（user 靠右藍色、assistant 靠左灰色）
- 每條訊息顯示時間
- API：`GET /api/conversations`、`GET /api/conversations/:chatId`

---

## 前端架構

三個檔案，不用框架，純 vanilla JS：

### app.js 核心結構

```javascript
const state = {
  token: localStorage.getItem('dashboard_token') || null,
  currentTab: 'status',
  ws: null,
};

// API 呼叫（帶 token）
async function api(method, path, body) { ... }

// WebSocket 連線 + 自動重連
function connectWS() { ... }

// 登入流程
async function requestCode() { ... }
async function verifyCode() { ... }

// Tab 切換
function switchTab(tabName) { ... }

// 各面板載入 + 渲染
async function loadStatus() { ... }
function renderStatus(status, recentLogs) { ... }

async function loadReminders() { ... }
function renderReminders(reminders) { ... }

async function loadMemories() { ... }
function renderMemories(memories, userId) { ... }

async function loadLogs() { ... }
function renderLogs(logs) { ... }

async function loadConversations() { ... }
function renderConversations(conversations) { ... }
function renderConversationDetail(conv) { ... }

// 操作
async function deleteReminder(id) { ... }
async function deleteMemory(id) { ... }
async function updateImportance(memId, value) { ... }

// 初始化：檢查 token → 顯示登入或 Dashboard
document.addEventListener('DOMContentLoaded', init);
```

### 關鍵行為

1. **Token 存 localStorage**：重開瀏覽器不需重新登入（24 小時有效）
2. **401 自動回登入頁**：token 過期時 API 回 401，自動清除 token 顯示登入
3. **WebSocket 自動重連**：斷線 5 秒後重連
4. **刪除前 confirm()**：所有刪除操作先確認
5. **空狀態友善提示**：每個面板在沒資料時顯示提示文字，不顯示空表格
6. **時間格式統一**：`zh-TW` locale，`Asia/Taipei` 時區

---

## 驗證

### 檔案檢查

```bash
test -f public/index.html && echo '✅' || echo '❌'
test -f public/style.css && echo '✅' || echo '❌'
test -f public/app.js && echo '✅' || echo '❌'
```

### 視覺測試

1. 啟動 bot-server → 瀏覽器開 `http://127.0.0.1:4000`
2. 看到登入頁（漸層背景 + 白色卡片）
3. 輸入 chatId → Telegram 收到驗證碼 → 輸入 → 登入
4. 五個 tab 都能切換，資料正確
5. 記憶的 importance 滑桿可拖動
6. 刪除提醒/記憶有 confirm
7. Telegram 上操作後，Dashboard Logs 面板自動更新

### 設計規範檢查

- [ ] 主色 #4073c2 用在 tab active、主要按鈕
- [ ] 青綠 #14b5af 用在登入頁漸層
- [ ] 卡片有 box-shadow
- [ ] 表格 hover 有背景色
- [ ] 按鈕 hover 有 translateY(-1px)
- [ ] 字體大小遵守 CSS 變數

---

## 注意事項

1. **不用任何框架**：純 HTML + CSS + vanilla JS
2. **只有三個檔案**：index.html、style.css、app.js
3. **CSS 變數宣告在 style.css 開頭**：把 UI_STYLE_GUIDE.md 第 12 章的所有變數宣告一次
4. **響應式**：768px 以下 tab bar 可橫向滾動，卡片改成單列
