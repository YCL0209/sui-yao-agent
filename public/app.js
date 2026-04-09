/* ============================================================
   穗鈅助手 Dashboard — 前端邏輯
   ============================================================ */

const state = {
  token: localStorage.getItem('dashboard_token') || null,
  identifier: localStorage.getItem('dashboard_identifier') || null,
  currentTab: 'status',
  ws: null,
  wsReconnectTimer: null,
  liveLogs: [], // 接收 WS new_log 暫存
};

const TZ = { timeZone: 'Asia/Taipei' };

// ============================================================
// API 呼叫
// ============================================================

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(path, opts);
  if (res.status === 401 && state.token) {
    // token 過期 → 清除 + 回登入
    handleLogout();
    throw new Error('Unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ============================================================
// 登入流程
// ============================================================

async function requestCode() {
  const identifier = document.getElementById('identifier').value.trim();
  const errEl = document.getElementById('login-error-1');
  errEl.textContent = '';

  if (!identifier) {
    errEl.textContent = '請輸入 username 或 chat ID';
    return;
  }

  const btn = document.getElementById('btn-request-code');
  btn.disabled = true;
  btn.textContent = '發送中...';

  try {
    const result = await api('POST', '/api/auth/request-code', { identifier });
    if (result.success) {
      state.identifier = identifier;
      localStorage.setItem('dashboard_identifier', identifier);
      document.getElementById('display-name').textContent = result.displayName;
      document.getElementById('login-step-1').style.display = 'none';
      document.getElementById('login-step-2').style.display = 'block';
      document.getElementById('code').focus();
    } else {
      errEl.textContent = result.error || '請求失敗';
    }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '取得驗證碼';
  }
}

async function verifyCode() {
  const code = document.getElementById('code').value.trim();
  const errEl = document.getElementById('login-error-2');
  errEl.textContent = '';

  if (!code || code.length !== 6) {
    errEl.textContent = '請輸入 6 位驗證碼';
    return;
  }

  const btn = document.getElementById('btn-verify');
  btn.disabled = true;
  btn.textContent = '驗證中...';

  try {
    const result = await api('POST', '/api/auth/verify', {
      identifier: state.identifier,
      code,
    });
    if (result.success) {
      state.token = result.token;
      localStorage.setItem('dashboard_token', result.token);
      enterDashboard();
    } else {
      errEl.textContent = result.error || '驗證失敗';
    }
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '登入';
  }
}

function backToStep1() {
  document.getElementById('login-step-2').style.display = 'none';
  document.getElementById('login-step-1').style.display = 'block';
  document.getElementById('login-error-1').textContent = '';
  document.getElementById('login-error-2').textContent = '';
  document.getElementById('code').value = '';
}

async function handleLogout() {
  if (state.token) {
    try { await api('POST', '/api/auth/logout'); } catch (_) {}
  }
  localStorage.removeItem('dashboard_token');
  state.token = null;
  if (state.ws) { state.ws.close(); state.ws = null; }
  if (state.wsReconnectTimer) { clearTimeout(state.wsReconnectTimer); state.wsReconnectTimer = null; }
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  backToStep1();
}

// ============================================================
// WebSocket
// ============================================================

function connectWS() {
  if (!state.token) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?token=${state.token}`;

  try {
    state.ws = new WebSocket(url);
  } catch (err) {
    console.error('[ws] connect error:', err);
    return;
  }

  state.ws.addEventListener('open', () => {
    console.log('[ws] connected');
    setWsStatus('● 即時連線');
  });

  state.ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      handleWsMessage(msg);
    } catch (err) {
      console.error('[ws] parse error:', err);
    }
  });

  state.ws.addEventListener('close', (ev) => {
    console.log('[ws] disconnected', ev.code);
    setWsStatus('● 已斷線');
    state.ws = null;
    // 5 秒後重連（除非是 unauthorized）
    if (state.token && ev.code !== 4001) {
      state.wsReconnectTimer = setTimeout(connectWS, 5000);
    }
  });

  state.ws.addEventListener('error', (err) => {
    console.error('[ws] error:', err);
  });
}

function setWsStatus(text) {
  const el = document.getElementById('ws-status');
  if (el) el.textContent = text;
}

function handleWsMessage(msg) {
  if (msg.type === 'new_log') {
    // 如果在 logs tab，新增到列表頂端
    if (state.currentTab === 'logs') {
      state.liveLogs.unshift({
        ...msg.data,
        timestamp: msg.timestamp,
        _id: 'live-' + Date.now() + Math.random(),
      });
      // 重新 render（保留現有資料）
      const logsListEl = document.getElementById('logs-list');
      const existingLogs = state.liveLogs.slice();
      // 只重 render 不重抓
      renderLogsAppend(existingLogs);
    }
  }
  // new_user / new_reminder / status — 預留
}

// ============================================================
// Tab 切換
// ============================================================

function switchTab(tabName) {
  state.currentTab = tabName;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabName}`);
  });

  // 載入該 tab 的資料
  switch (tabName) {
    case 'status': loadStatus(); break;
    case 'reminders': loadReminders(); break;
    case 'memories': loadMemories(); break;
    case 'logs': loadLogs(); break;
    case 'conversations': loadConversations(); break;
  }
}

// ============================================================
// 進入 Dashboard
// ============================================================

function enterDashboard() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('dashboard').style.display = 'flex';
  document.getElementById('header-user').textContent = state.identifier || '';

  switchTab('status');
  connectWS();
}

// ============================================================
// 工具
// ============================================================

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-TW', { ...TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

function fmtDateShort(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-TW', { ...TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso; }
}

function fmtDuration(seconds) {
  if (!seconds) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function emptyState(icon, text) {
  return `<div class="empty-state"><span class="icon">${icon}</span>${text}</div>`;
}

// ============================================================
// Tab 1: 系統狀態
// ============================================================

async function loadStatus() {
  try {
    const [status, logsResp] = await Promise.all([
      api('GET', '/api/status'),
      api('GET', '/api/logs?limit=5'),
    ]);
    renderStatus(status, logsResp.logs || []);
  } catch (err) {
    document.getElementById('status-cards').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderStatus(s, recentLogs) {
  document.getElementById('status-cards').innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Bot 狀態</div>
      <div class="stat-value">運行中</div>
    </div>
    <div class="stat-card warning">
      <div class="stat-label">待執行提醒</div>
      <div class="stat-value">${s.pendingReminders}</div>
    </div>
    <div class="stat-card teal">
      <div class="stat-label">記憶數</div>
      <div class="stat-value">${s.memories}</div>
    </div>
    <div class="stat-card success">
      <div class="stat-label">Logs 數</div>
      <div class="stat-value">${s.executionLogs}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">用戶數</div>
      <div class="stat-value">${s.users}</div>
    </div>
    <div class="stat-card teal">
      <div class="stat-label">對話數</div>
      <div class="stat-value">${s.conversations}</div>
    </div>
  `;

  document.getElementById('system-info').innerHTML = `
    <div class="info-item"><span class="label">應用</span><span class="value">${escapeHtml(s.bot.name)} v${s.bot.version}</span></div>
    <div class="info-item"><span class="label">模型</span><span class="value">${escapeHtml(s.bot.model)}</span></div>
    <div class="info-item"><span class="label">運行時間</span><span class="value">${fmtDuration(s.uptime)}</span></div>
    <div class="info-item"><span class="label">WS 連線數</span><span class="value">${s.dashboard.wsConnections}</span></div>
  `;

  if (recentLogs.length === 0) {
    document.getElementById('recent-logs').innerHTML = emptyState('📭', '尚無 skill 呼叫紀錄');
  } else {
    document.getElementById('recent-logs').innerHTML = renderLogsTable(recentLogs, false);
  }
}

// ============================================================
// Tab 2: 提醒
// ============================================================

async function loadReminders() {
  const status = document.getElementById('reminder-status').value;
  const qs = status ? `?status=${status}` : '';
  document.getElementById('reminders-list').innerHTML = '<div class="loading">載入中...</div>';
  try {
    const { reminders } = await api('GET', `/api/reminders${qs}`);
    renderReminders(reminders);
  } catch (err) {
    document.getElementById('reminders-list').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderReminders(reminders) {
  if (!reminders || reminders.length === 0) {
    document.getElementById('reminders-list').innerHTML = emptyState('⏰', '沒有提醒');
    return;
  }

  const rows = reminders.map(r => {
    const repeatStr = r.repeat ? `🔁${r.repeat.type || ''}` : '-';
    const statusBadge = r.status === 'pending'
      ? '<span class="badge badge-warning">待執行</span>'
      : r.status === 'done'
        ? '<span class="badge badge-success">已完成</span>'
        : '<span class="badge badge-muted">已取消</span>';
    return `
      <tr>
        <td>${escapeHtml(r.userId || '-')}</td>
        <td>${escapeHtml(r.content)}</td>
        <td class="col-time">${fmtDateShort(r.remindAt)}</td>
        <td>${repeatStr}</td>
        <td>${statusBadge}</td>
        <td class="col-action">
          ${r.status === 'pending' ? `<button class="btn-icon" onclick="deleteReminder('${r._id}')">🗑</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('reminders-list').innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>用戶</th><th>內容</th><th>時間</th><th>重複</th><th>狀態</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function deleteReminder(id) {
  if (!confirm('確定要取消此提醒？')) return;
  try {
    await api('DELETE', `/api/reminders/${id}`);
    loadReminders();
  } catch (err) {
    alert('刪除失敗：' + err.message);
  }
}

// ============================================================
// Tab 3: 記憶
// ============================================================

async function loadMemories() {
  const userId = document.getElementById('memory-user-select').value;
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  document.getElementById('memories-list').innerHTML = '<div class="loading">載入中...</div>';
  try {
    const data = await api('GET', `/api/memories${qs}`);
    renderMemories(data.memories || [], data.userId);
  } catch (err) {
    document.getElementById('memories-list').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderMemories(memories, userId) {
  document.getElementById('memory-count').textContent = `記憶數：${memories.length} / 200`;

  if (memories.length === 0) {
    document.getElementById('memories-list').innerHTML = emptyState('🧠', '尚無記憶');
    return;
  }

  const cards = memories.map(m => {
    const importance = m.importance ?? 0.5;
    return `
      <div class="memory-card">
        <div class="content">${escapeHtml(m.content || '')}</div>
        <div class="meta">
          ${m.category ? `<span>${escapeHtml(m.category)}</span>` : ''}
          ${m.source ? `<span>${escapeHtml(m.source)}</span>` : ''}
          <span>access: ${m.accessCount || 0}</span>
          <span>${fmtDateShort(m.createdAt)}</span>
        </div>
        <div class="importance-row">
          <label>importance</label>
          <input type="range" min="0" max="1" step="0.1" value="${importance}"
            oninput="this.nextElementSibling.textContent=parseFloat(this.value).toFixed(1)"
            onchange="updateImportance('${m.id}', this.value)">
          <span class="val">${parseFloat(importance).toFixed(1)}</span>
        </div>
        <div class="actions">
          <button class="btn-icon" onclick="deleteMemory('${m.id}')">🗑</button>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('memories-list').innerHTML = `<div class="memory-grid">${cards}</div>`;
}

async function updateImportance(memId, value) {
  try {
    const userId = document.getElementById('memory-user-select').value;
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    await api('PUT', `/api/memories/${memId}${qs}`, { importance: parseFloat(value) });
  } catch (err) {
    alert('更新失敗：' + err.message);
  }
}

async function deleteMemory(memId) {
  if (!confirm('確定要刪除此記憶？')) return;
  try {
    const userId = document.getElementById('memory-user-select').value;
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    await api('DELETE', `/api/memories/${memId}${qs}`);
    loadMemories();
  } catch (err) {
    alert('刪除失敗：' + err.message);
  }
}

// ============================================================
// Tab 4: Execution Logs
// ============================================================

async function loadLogs() {
  const skill = document.getElementById('log-skill').value;
  const status = document.getElementById('log-status').value;
  const limit = document.getElementById('log-limit').value;
  const params = new URLSearchParams();
  if (skill) params.set('skill', skill);
  if (status) params.set('status', status);
  if (limit) params.set('limit', limit);

  document.getElementById('logs-list').innerHTML = '<div class="loading">載入中...</div>';
  try {
    const { logs } = await api('GET', `/api/logs?${params.toString()}`);
    state.liveLogs = logs || [];
    renderLogs(state.liveLogs);
  } catch (err) {
    document.getElementById('logs-list').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    document.getElementById('logs-list').innerHTML = emptyState('📋', '尚無 logs');
    return;
  }
  document.getElementById('logs-list').innerHTML = renderLogsTable(logs, true);
}

function renderLogsAppend(logs) {
  document.getElementById('logs-list').innerHTML = renderLogsTable(logs, true);
}

function renderLogsTable(logs, expandable) {
  const rows = logs.map(l => {
    const statusBadge = l.status === 'success'
      ? '<span class="badge badge-success">✅</span>'
      : '<span class="badge badge-danger">❌</span>';
    const detailId = `detail-${l._id}`;
    const detailRow = expandable ? `
      <tr id="${detailId}" style="display:none;">
        <td colspan="5" style="background:var(--bg-page);">
          <div style="font-family:monospace; font-size:12px; white-space:pre-wrap; word-break:break-all;">
${escapeHtml(JSON.stringify({ input: l.input, output: l.output, error: l.error }, null, 2))}
          </div>
        </td>
      </tr>
    ` : '';
    const onClick = expandable ? `onclick="toggleLogDetail('${detailId}')"` : '';
    return `
      <tr style="cursor:${expandable ? 'pointer' : 'default'};" ${onClick}>
        <td class="col-time">${fmtDateShort(l.timestamp)}</td>
        <td><strong>${escapeHtml(l.skill)}</strong></td>
        <td>${escapeHtml((l.userId || '').replace('telegram:', ''))}</td>
        <td>${statusBadge}</td>
        <td class="col-num">${l.durationMs || 0}ms</td>
      </tr>
      ${detailRow}
    `;
  }).join('');

  return `
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>時間</th><th>Skill</th><th>用戶</th><th>狀態</th><th>耗時</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function toggleLogDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

// ============================================================
// Tab 5: 對話歷史
// ============================================================

async function loadConversations() {
  document.getElementById('conversations-list').innerHTML = '<div class="loading">載入中...</div>';
  document.getElementById('conversation-detail').style.display = 'none';
  try {
    const { conversations } = await api('GET', '/api/conversations');
    renderConversations(conversations || []);
  } catch (err) {
    document.getElementById('conversations-list').innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderConversations(conversations) {
  if (!conversations || conversations.length === 0) {
    document.getElementById('conversations-list').innerHTML = emptyState('💬', '尚無對話');
    return;
  }

  const rows = conversations.map(c => {
    const lastMsg = (c.messages && c.messages.length > 0) ? c.messages[c.messages.length - 1] : null;
    const preview = lastMsg ? (lastMsg.content || '').slice(0, 30) : '-';
    return `
      <tr style="cursor:pointer;" onclick="loadConversationDetail(${c.chatId})">
        <td>${escapeHtml(c.userId || '-')}</td>
        <td>${escapeHtml(preview)}${preview.length === 30 ? '...' : ''}</td>
        <td class="col-time">${fmtDateShort(c.updatedAt)}</td>
        <td class="col-num">${c.messages?.length || 0} 條</td>
      </tr>
    `;
  }).join('');

  document.getElementById('conversations-list').innerHTML = `
    <div class="table-wrapper">
      <table>
        <thead><tr>
          <th>用戶</th><th>最後訊息</th><th>更新時間</th><th>訊息數</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function loadConversationDetail(chatId) {
  const detailEl = document.getElementById('conversation-detail');
  detailEl.style.display = 'block';
  detailEl.innerHTML = '<div class="loading">載入中...</div>';
  try {
    const conv = await api('GET', `/api/conversations/${chatId}`);
    renderConversationDetail(conv);
  } catch (err) {
    detailEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
  }
}

function renderConversationDetail(conv) {
  const messages = conv.messages || [];
  if (messages.length === 0) {
    document.getElementById('conversation-detail').innerHTML = emptyState('💬', '此對話無訊息');
    return;
  }
  const bubbles = messages.map(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    return `
      <div class="conv-bubble ${role}">
        <div class="text">${escapeHtml(m.content || '')}</div>
        ${m.ts ? `<div class="ts">${fmtDateShort(m.ts)}</div>` : ''}
      </div>
    `;
  }).join('');

  document.getElementById('conversation-detail').innerHTML = `
    <h2 class="section-title">對話詳情（${escapeHtml(conv.userId || '')}）</h2>
    <div class="conv-detail">${bubbles}</div>
  `;
}

// ============================================================
// 初始化
// ============================================================

function init() {
  // 事件綁定
  document.getElementById('btn-request-code').addEventListener('click', requestCode);
  document.getElementById('btn-verify').addEventListener('click', verifyCode);
  document.getElementById('btn-back').addEventListener('click', backToStep1);
  document.getElementById('btn-logout').addEventListener('click', handleLogout);

  // Enter key
  document.getElementById('identifier').addEventListener('keydown', e => {
    if (e.key === 'Enter') requestCode();
  });
  document.getElementById('code').addEventListener('keydown', e => {
    if (e.key === 'Enter') verifyCode();
  });

  // Tab 切換
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 篩選 / 刷新
  document.getElementById('btn-refresh-reminders').addEventListener('click', loadReminders);
  document.getElementById('reminder-status').addEventListener('change', loadReminders);
  document.getElementById('btn-refresh-memories').addEventListener('click', loadMemories);
  document.getElementById('memory-user-select').addEventListener('change', loadMemories);
  document.getElementById('btn-refresh-logs').addEventListener('click', loadLogs);
  document.getElementById('log-skill').addEventListener('change', loadLogs);
  document.getElementById('log-status').addEventListener('change', loadLogs);
  document.getElementById('log-limit').addEventListener('change', loadLogs);
  document.getElementById('btn-refresh-conversations').addEventListener('click', loadConversations);

  // 還原 identifier
  if (state.identifier) {
    document.getElementById('identifier').value = state.identifier;
  }

  // 已有 token → 直接進 Dashboard
  if (state.token) {
    enterDashboard();
  }
}

document.addEventListener('DOMContentLoaded', init);
