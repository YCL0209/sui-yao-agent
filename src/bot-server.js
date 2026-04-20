/**
 * 穗鈅助手 — Bot Server（核心）
 *
 * Telegram bot + Agent 迴圈，串接所有模組。
 *
 * 訊息處理流程：
 *   用戶訊息 → prompt-loader 組裝 system prompt
 *   → llm-adapter.chat() 呼叫 LLM（含 tools）
 *   → Agent 迴圈（tool_call → tool-executor → 結果回饋 → 直到一般回覆）
 *   → 解析 [記憶]/[日誌] 標記 → 回覆用戶
 *
 * @version 1.0.0
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const toolExecutor = require('./tool-executor');
const createOrderSkill = require('../skills/create-order');
const ism = require('./interactive-session');
const orderAgent = require('./agents/order-agent');
const docAgent = require('./agents/doc-agent');
const reminderAgent = require('./agents/reminder-agent');
const adminAgent = require('./agents/admin-agent');
const auth = require('./auth');
const dashboard = require('./dashboard/server');
const wsManager = require('./dashboard/ws-manager');

// Orchestrator：Agent loop 與訊息處理核心（Phase I1 抽出）
// 此 require 同時觸發 danger-confirm ISM handler 註冊與 skill definitions 載入
const orchestrator = require('./orchestrator');
const { handleMessage } = orchestrator;
const session = require('./session');

// ============================================================
// 啟動
// ============================================================

// Concurrency 控制：per-chatId Promise chain，同一用戶訊息序列化處理
const chatLocks = new Map();

// ============================================================
// 錯誤通知
// ============================================================

async function notifyError(bot, error, context = '') {
  if (!config.error.notifyEnabled) return;
  if (!config.telegram.adminChatId) return;

  try {
    const msg = `⚠️ 穗鈅助手錯誤\n\n${context}\n${error.message || error}`.slice(0, 4000);
    await bot.sendMessage(config.telegram.adminChatId, msg);
  } catch (_) {
    // 通知失敗就算了
  }
}

// ============================================================
// Telegram Bot 啟動
// ============================================================

// ============================================================
// 回覆輔助（支援 reply_markup）
// ============================================================

/**
 * 送出回覆，支援 inline keyboard
 * @param {TelegramBot} bot
 * @param {number} chatId
 * @param {string} text - 回覆文字
 * @param {Object} [replyMarkup] - Telegram reply_markup
 */
async function sendReply(bot, chatId, text, replyMarkup) {
  if (!text) return;
  const opts = replyMarkup ? { reply_markup: replyMarkup } : {};
  const MAX_LEN = 4096;
  if (text.length > MAX_LEN) {
    const chunks = text.match(/[\s\S]{1,4096}/g) || [text];
    for (let i = 0; i < chunks.length; i++) {
      // 只在最後一塊帶按鈕
      const chunkOpts = (i === chunks.length - 1) ? opts : {};
      await bot.sendMessage(chatId, chunks[i], chunkOpts);
    }
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/**
 * 送出 skill 結果（自動處理 reply_markup）
 */
async function sendSkillResult(bot, chatId, result) {
  if (!result) return;
  const text = result.data || result.summary || '';
  await sendReply(bot, chatId, text, result.reply_markup);
}

function startBot() {
  // 啟動時確保所有 MongoDB 索引存在（冪等）
  const { ensureAllIndexes } = require('../scripts/ensure-indexes');
  ensureAllIndexes().catch(err =>
    console.error('[bot-server] ensureAllIndexes 失敗:', err.message)
  );

  const bot = new TelegramBot(config.telegram.botToken, { polling: true });

  // dashboard 啟動時要顯示 skill 數量
  const definitions = orchestrator.definitions;

  // ---- callback_query handler（Inline keyboard 按鈕） ----
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const userId = `telegram:${chatId}`;

    console.log(`[bot] callback_query: ${data} (chat: ${chatId})`);

    try {
      // ======== Admin 審核 callback 短路（不走 ISM）========
      if (data.startsWith('admin:')) {
        const adminChatId = Number(config.telegram.adminChatId);
        if (chatId !== adminChatId) {
          await bot.answerCallbackQuery(query.id, { text: '無權限' });
          return;
        }
        const parts = data.split(':');
        const action = parts[1];
        const targetChatId = Number(parts[2]);
        const role = parts[3] || 'user';

        if (action === 'approve') {
          const roleName = role === 'advanced' ? '高級用戶' : '一般用戶';
          await auth.approveUser('telegram', targetChatId, 'approve', role, userId);
          await sendReply(bot, chatId, `✅ 已核准 ${targetChatId} 為${roleName}`);
          try { await bot.sendMessage(targetChatId, adminAgent.MESSAGES.welcomeAfterApproval); } catch (_) {}
        } else if (action === 'block') {
          await auth.approveUser('telegram', targetChatId, 'block', null, userId);
          await sendReply(bot, chatId, `🚫 已封鎖 ${targetChatId}`);
        } else if (action === 'setrole') {
          const newRole = parts[3] || 'user';
          const roleLabels = { admin: '管理員', advanced: '高級用戶', user: '一般用戶' };
          await auth.setUserRole('telegram', targetChatId, newRole);
          await sendReply(bot, chatId, `✅ 已將 ${targetChatId} 角色改為「${roleLabels[newRole] || newRole}」`);
          try { await bot.sendMessage(targetChatId, `📢 您的角色已更新為「${roleLabels[newRole] || newRole}」。`); } catch (_) {}
        }

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch (_) {}
        await bot.answerCallbackQuery(query.id);
        return;
      }

      // ======== 主路徑：交給 ISM ========
      const result = await ism.handleCallback(data, {
        chatId,
        userId,
        messageId: query.message.message_id,
      });

      if (result) {
        if (result.text) {
          await sendReply(bot, chatId, result.text, result.reply_markup);
        }
        if (result.images && result.images.length > 0) {
          const fs = require('fs');
          for (const img of result.images) {
            try {
              const filePath = img.localPath || img;
              await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: img.caption || '' });
            } catch (imgErr) {
              console.error('[bot-server] 發送圖片失敗:', imgErr.message);
            }
          }
        }
        // doc-agent 的 pickcustomer callback 完成後，啟動 order session
        if (result._startOrder && result._parsed) {
          const targetChatId = result._chatId || chatId;
          const targetUserId = result._userId || userId;
          const orderResult = await orderAgent.startOrderSession(targetChatId, targetUserId, { parsed: result._parsed });
          if (orderResult && orderResult.text) {
            await sendReply(bot, targetChatId, orderResult.text, orderResult.reply_markup);
          }
        }
      } else {
        // ======== Fallback：session 外的 callback ========

        // PDF 按鈕：在 order:confirm 回傳 done:true 之後才按，session 已清除
        if (data.startsWith('order:pdf:')) {
          const parts = data.split(':');
          const pdfType = parts[2];
          const orderRef = parts.slice(3).join(':');
          if (pdfType === 'skip') {
            await sendReply(bot, chatId, '好的，如需要再告訴我。');
          } else {
            try {
              const pdfResult = await createOrderSkill.generatePDF(orderRef, pdfType, { userId, chatId });
              if (pdfResult && pdfResult.localPaths) {
                await sendReply(bot, chatId, pdfResult.text);
                const fs = require('fs');
                for (const img of pdfResult.localPaths) {
                  try {
                    await bot.sendPhoto(chatId, fs.createReadStream(img.localPath || img), { caption: img.caption || '' });
                  } catch (imgErr) {
                    console.error('[bot-server] 發送圖片失敗:', imgErr.message);
                  }
                }
              } else {
                await sendReply(bot, chatId, pdfResult?.text || 'PDF 生成完成');
              }
            } catch (err) {
              await sendReply(bot, chatId, `PDF 生成失敗：${err.message}`);
            }
          }
        }

        // 殭屍按鈕兜底：session 已過期或未知 callback
        else {
          await sendReply(bot, chatId, '⏰ 此操作已過期，請重新開始。');
        }
      }

      // 統一清除按鈕（每個 callback 按完，原訊息的按鈕都拿掉）
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } catch (_) {}

      // 回應 Telegram（移除按鈕上的 loading）
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error(`[bot-server] callback_query 處理失敗:`, err);
      await bot.answerCallbackQuery(query.id, { text: '處理失敗，請重試' });
      await notifyError(bot, err, `Callback: ${data}\nChat: ${chatId}`);
    }
  });

  // ---- message handler ----
  bot.on('message', async (msg) => {
    console.log('[bot] 收到:', msg.text);
    const chatId = msg.chat.id;
    const userId = `telegram:${chatId}`;
    const text = msg.text;

    // /id 指令：在認證閘之前處理，讓所有人（含 pending/blocked）都能查自己的 chatId
    if (text === '/id') {
      const from = msg.from || {};
      const lines = [
        `🆔 你的 Telegram 資訊`,
        ``,
        `Chat ID：\`${chatId}\``,
        from.first_name ? `名稱：${[from.first_name, from.last_name].filter(Boolean).join(' ')}` : null,
        from.username ? `Username：@${from.username}` : `Username：（未設定）`,
      ].filter(Boolean).join('\n');
      try { await bot.sendMessage(chatId, lines, { parse_mode: 'Markdown' }); } catch (_) {
        await bot.sendMessage(chatId, lines);
      }
      return;
    }

    // ======== 認證閘 ========
    const from = msg.from || {};
    const authResult = await auth.authenticate({
      platform: 'telegram',
      chatId: msg.chat.id,
      profile: {
        firstName:    from.first_name || '',
        lastName:     from.last_name  || '',
        username:     from.username   || '',
        languageCode: from.language_code || '',
      },
    });

    if (authResult.status === 'new') {
      await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
      const notification = adminAgent.getNewUserNotification(authResult.user);
      const adminChatId = config.telegram.adminChatId;
      if (adminChatId) {
        await sendReply(bot, Number(adminChatId), notification.text, notification.reply_markup);
      }
      // Dashboard 推播
      try { wsManager.broadcast('new_user', { user: authResult.user }); } catch (_) {}
      return;
    }
    if (authResult.status === 'pending') {
      await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
      return;
    }
    if (authResult.status === 'blocked') {
      return; // 不回覆
    }

    const permissions = authResult.permissions;
    // ========================

    // ---- 非文字訊息處理（PDF / 圖片 → doc-agent） ----
    if (!text) {
      if (msg.document || msg.photo) {
        // 文件建單需要 create-order 權限
        if (!auth.canUseSkill(permissions, 'create-order')) {
          await bot.sendMessage(chatId, '您沒有文件建單的權限。');
          return;
        }
        const prev = chatLocks.get(chatId) || Promise.resolve();
        const current = prev.then(async () => {
          try {
            await bot.sendChatAction(chatId, 'typing');

            const result = await docAgent.handleDocument(msg, bot, { chatId, userId });

            if (!result) return; // null = 跳過（非商業內容）

            // 送出分類/解析結果
            if (result.text) {
              await sendReply(bot, chatId, result.text, result.reply_markup);
            }

            // doc-agent 標記要啟動 order session
            if (result._startOrder && result._parsed) {
              const orderResult = await orderAgent.startOrderSession(chatId, userId, { parsed: result._parsed });
              if (orderResult && orderResult.text) {
                await sendReply(bot, chatId, orderResult.text, orderResult.reply_markup);
              }
            }
          } catch (err) {
            console.error(`[bot-server] 文件處理失敗:`, err);
            await bot.sendMessage(chatId, `處理失敗：${err.message}`);
            await notifyError(bot, err, `Document/Photo\nChat: ${chatId}`);
          }
        });
        chatLocks.set(chatId, current.catch(() => {}));
      }
      return;
    }

    // reset 指令（同時清除建單 session）
    if (text === '/reset' || text === '/new') {
      session.clearHistory('telegram', chatId).catch(err =>
        console.error('[bot-server] 清除對話歷史失敗:', err.message)
      );
      ism.deleteSession(chatId);
      await bot.sendMessage(chatId, '🔄 對話已重置');
      return;
    }

    // /start 指令
    if (text === '/start') {
      await bot.sendMessage(chatId, '👋 你好！我是穗鈅助手，有什麼可以幫你的？');
      return;
    }

    // ---- Admin 用戶管理指令（只有 admin chatId 能用） ----
    const isAdminChat = chatId === Number(config.telegram.adminChatId);
    if (isAdminChat) {
      // 用戶列表
      if (/^(用戶列表|使用者列表|list ?users?)$/i.test(text)) {
        const users = await auth.listUsers();
        if (users.length === 0) {
          await sendReply(bot, chatId, '目前沒有用戶。');
          return;
        }
        const roleLabels = { admin: '👑管理員', advanced: '⭐高級', user: '👤一般' };
        const statusLabels = { active: '✅', pending: '⏳', blocked: '🚫' };
        const lines = users.map(u => {
          const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || '未知';
          const username = u.profile?.username ? `@${u.profile.username}` : '';
          const role = roleLabels[u.role] || u.role;
          const status = statusLabels[u.status] || u.status;
          return `${status} ${name} ${username}\n   角色：${role} | ID：${u.chatId}`;
        }).join('\n\n');
        await sendReply(bot, chatId, `📋 用戶列表（${users.length} 人）：\n\n${lines}`);
        return;
      }

      // 升級用戶 / 封鎖用戶 / 解封用戶
      const adminCmdMatch = text.match(/^(升級用戶|封鎖用戶|解封用戶)\s*(.+)$/);
      if (adminCmdMatch) {
        const cmd = adminCmdMatch[1];
        const searchName = adminCmdMatch[2].trim();
        const filter = cmd === '解封用戶' ? { status: 'blocked' } : {};
        const users = await auth.listUsers(filter);
        const matches = users.filter(u => {
          const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ');
          const username = u.profile?.username || '';
          return name.includes(searchName) || username.includes(searchName) || String(u.chatId) === searchName;
        });

        if (matches.length === 0) {
          await sendReply(bot, chatId, `找不到用戶「${searchName}」`);
          return;
        }
        if (matches.length > 1) {
          const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
          await sendReply(bot, chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
          return;
        }

        const target = matches[0];
        const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;

        if (cmd === '升級用戶') {
          await sendReply(bot, chatId, `選擇「${targetName}」的新角色：`, {
            inline_keyboard: [
              [
                { text: '👤 一般用戶', callback_data: `admin:setrole:${target.chatId}:user` },
                { text: '⭐ 高級用戶', callback_data: `admin:setrole:${target.chatId}:advanced` },
              ],
              [{ text: '👑 管理員', callback_data: `admin:setrole:${target.chatId}:admin` }],
            ],
          });
        } else if (cmd === '封鎖用戶') {
          await auth.approveUser('telegram', target.chatId, 'block', null, userId);
          await sendReply(bot, chatId, `🚫 已封鎖「${targetName}」`);
        } else if (cmd === '解封用戶') {
          await auth.approveUser('telegram', target.chatId, 'approve', target.role || 'user', userId);
          await sendReply(bot, chatId, `✅ 已解封「${targetName}」`);
        }
        return;
      }
    }

    // Concurrency 控制：同一 chatId 的訊息排隊處理
    const prev = chatLocks.get(chatId) || Promise.resolve();
    let processingMsg = null;
    const current = prev.then(async () => {
      try {
        await bot.sendChatAction(chatId, 'typing');

        // ---- ISM session 攔截：有 active session 時直接走 agent handler ----
        if (ism.hasActiveSession(chatId)) {
          const result = await ism.handleTextInput(chatId, text, { userId });
          if (result) {
            if (result.text) await sendReply(bot, chatId, result.text, result.reply_markup);
            if (result.images && result.images.length > 0) {
              const fs = require('fs');
              for (const img of result.images) {
                try {
                  await bot.sendPhoto(chatId, fs.createReadStream(img.localPath || img), { caption: img.caption || '' });
                } catch (imgErr) {
                  console.error('[bot-server] 發送圖片失敗:', imgErr.message);
                }
              }
            }
            return;
          }
          // result 為 null → ISM 不攔截，繼續走 LLM
        }

        // ---- 同步產品關鍵詞攔截（需 system-router 權限）----
        if (/同步產品|sync.?products?/i.test(text)) {
          if (!auth.canUseSkill(permissions, 'system-router')) {
            await sendReply(bot, chatId, '您沒有此操作的權限。');
            return;
          }
          const { syncProducts } = require('../scripts/sync-products');
          await sendReply(bot, chatId, '🔄 開始同步產品...');
          try {
            const stats = await syncProducts();
            await sendReply(bot, chatId,
              `✅ 產品同步完成\n新增: ${stats.added} | 更新: ${stats.updated} | 停用: ${stats.deactivated} | 跳過: ${stats.skipped} | 失敗: ${stats.failed}`
            );
          } catch (err) {
            await sendReply(bot, chatId, `❌ 同步失敗: ${err.message}`);
          }
          return;
        }

        // ---- 建立訂單關鍵詞直接攔截（需 create-order 權限）----
        if (/建立訂單|建單|開單|下訂單/.test(text)) {
          if (!auth.canUseSkill(permissions, 'create-order')) {
            await sendReply(bot, chatId, '您沒有建立訂單的權限。');
            return;
          }
          const result = await orderAgent.startOrderSession(chatId, userId, {});
          if (result) {
            await sendReply(bot, chatId, result.text, result.reply_markup);
            return;
          }
        }

        // ---- 查看提醒關鍵詞攔截 ----
        if (/查看提醒|我的提醒|有哪些提醒|提醒列表|list.?remind/i.test(text)) {
          const result = await reminderAgent.startReminderList(chatId, userId);
          if (result) {
            await sendReply(bot, chatId, result.text, result.reply_markup);
            return;
          }
        }

        // 本地模型先發「處理中」提示
        const isLocalModel = config.llm.chatProvider === 'ollama';
        if (isLocalModel) {
          processingMsg = await bot.sendMessage(chatId, '⏳ 處理中...');
        }

        const result = await handleMessage(userId, text, chatId, permissions);

        if (processingMsg) {
          // 本地模型：替換「處理中」為正式回覆
          try {
            if (result && result.reply) {
              await bot.editMessageText(result.reply, {
                chat_id: chatId,
                message_id: processingMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: result.reply_markup || undefined,
              });
            }
          } catch (editErr) {
            // editMessageText 失敗（文字相同、Markdown 格式錯誤等）→ fallback 發新訊息
            if (result && result.reply) {
              await sendReply(bot, chatId, result.reply, result.reply_markup);
            }
          }
          // 圖片另外發
          if (result && result.images && result.images.length > 0) {
            const fs = require('fs');
            for (const img of result.images) {
              try {
                await bot.sendPhoto(chatId, fs.createReadStream(img.localPath), { caption: img.caption || '' });
              } catch (imgErr) {
                console.error('[bot-server] 發送圖片失敗:', imgErr.message);
              }
            }
          }
        } else {
          // OpenAI：維持現有邏輯
          if (result && result.reply) {
            await sendReply(bot, chatId, result.reply, result.reply_markup);
          }
          if (result && result.images && result.images.length > 0) {
            const fs = require('fs');
            for (const img of result.images) {
              try {
                await bot.sendPhoto(chatId, fs.createReadStream(img.localPath), { caption: img.caption || '' });
              } catch (imgErr) {
                console.error('[bot-server] 發送圖片失敗:', imgErr.message);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[bot-server] 處理訊息失敗 (chat: ${chatId}):`, err);
        if (processingMsg) {
          try {
            await bot.editMessageText('抱歉，處理時發生錯誤，請稍後再試。', {
              chat_id: chatId,
              message_id: processingMsg.message_id,
            });
          } catch (_) {
            await bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
          }
        } else {
          await bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
        }
        await notifyError(bot, err, `Chat: ${chatId}\nMessage: ${text}`);
      }
    });
    chatLocks.set(chatId, current.catch(() => {}));
  });

  bot.on('polling_error', (err) => {
    console.error('[bot-server] Polling error:', err.message);
  });

  // 啟動完成
  bot.getMe().then(me => {
    console.log(`\n🤖 穗鈅助手已啟動`);
    console.log(`   Bot: @${me.username}`);
    console.log(`   Model: ${config.llm.chatProvider === 'ollama' ? config.ollama.chatModel : config.llm.defaultModel} (${config.llm.chatProvider})`);
    console.log(`   Skills: ${definitions.length} 個`);
    console.log(`   Agent 迴圈上限: ${config.agent.maxLoop} 次`);

    // 啟動 Dashboard server（HTTP + WebSocket）
    dashboard.start(bot);

    // 設定 tool-executor 執行 hook → 推送到 dashboard ws
    toolExecutor.setOnExecuteHook((event) => {
      try {
        wsManager.broadcast('new_log', event);
      } catch (_) {}
    });

    console.log('');
  });

  return bot;
}

// ============================================================
// 主程式
// ============================================================

if (require.main === module) {
  startBot();
}

// ============================================================
// Export（供測試和其他模組使用）
// ============================================================

module.exports = {
  parseMemoryTags: orchestrator.parseMemoryTags,
  handleMessage,
  startBot,
};
