/**
 * 穗鈅助手 — Telegram Adapter（Phase I1）
 *
 * 把所有 Telegram 專屬邏輯收進這裡：polling、callback_query、admin 指令、
 * 訊息分段、按鈕轉譯、Ollama 處理中提示。
 *
 * Orchestrator 是平台無關的；本 adapter 把進來的訊息標準化、把回覆轉譯回 Telegram。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const MessageAdapter = require('./adapter-interface');
const { normalizeTelegramInput } = require('../input-normalizer');
const auth = require('../auth');
const ism = require('../interactive-session');
const adminAgent = require('../agents/admin-agent');
const wsManager = require('../dashboard/ws-manager');

const TELEGRAM_MAX_LEN = 4096;

class TelegramAdapter extends MessageAdapter {
  constructor(opts) {
    super(opts);
    this.platform = 'telegram';
    this.tgConfig = opts.config.telegram;
    this.adminChatId = opts.config.telegram.adminChatId
      ? Number(opts.config.telegram.adminChatId)
      : null;
    this.bot = null;
    this.chatLocks = new Map();
  }

  async start() {
    this.bot = new TelegramBot(this.tgConfig.botToken, { polling: true });

    this._wireMessage();
    this._wireCallback();

    this.bot.on('polling_error', (err) =>
      console.error('[telegram-adapter] polling_error:', err.message));

    const me = await this.bot.getMe();
    console.log(`[telegram-adapter] logged in as @${me.username}`);
  }

  async stop() {
    if (this.bot) await this.bot.stopPolling();
  }

  // ============================================================
  // 子類介面實作
  // ============================================================

  async sendText(chatId, text, options = {}) {
    if (!text) return;
    const numChatId = Number(chatId);
    const replyMarkup = options.buttons ? this._buttonsToReplyMarkup(options.buttons) : null;
    const replyTo = options.replyToId ? Number(options.replyToId) : null;

    const chunks = text.length > TELEGRAM_MAX_LEN
      ? text.match(/[\s\S]{1,4096}/g)
      : [text];

    for (let i = 0; i < chunks.length; i++) {
      const opts = {};
      if (i === chunks.length - 1 && replyMarkup) opts.reply_markup = replyMarkup;
      if (i === 0 && replyTo) opts.reply_to_message_id = replyTo;
      try {
        await this.bot.sendMessage(numChatId, chunks[i], opts);
      } catch (err) {
        console.error('[telegram-adapter] sendMessage 失敗:', err.message);
      }
    }
  }

  async sendImages(chatId, images) {
    const numChatId = Number(chatId);
    for (const img of images) {
      try {
        await this.bot.sendPhoto(numChatId, fs.createReadStream(img.localPath), {
          caption: img.caption || '',
        });
      } catch (err) {
        console.error('[telegram-adapter] 發送圖片失敗:', err.message);
      }
    }
  }

  async sendTyping(chatId) {
    try {
      await this.bot.sendChatAction(Number(chatId), 'typing');
    } catch (_) {}
  }

  async clearButtons(chatId, messageId) {
    try {
      await this.bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: Number(chatId), message_id: Number(messageId) }
      );
    } catch (_) {}
  }

  // ============================================================
  // 訊息事件
  // ============================================================

  _wireMessage() {
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const userId = `telegram:${chatId}`;
      const text = msg.text;

      try {
        // ---- /id：認證閘前處理（pending/blocked 也能用）----
        if (text === '/id') {
          const from = msg.from || {};
          const lines = [
            `🆔 你的 Telegram 資訊`,
            ``,
            `Chat ID：\`${chatId}\``,
            from.first_name ? `名稱：${[from.first_name, from.last_name].filter(Boolean).join(' ')}` : null,
            from.username ? `Username：@${from.username}` : `Username：（未設定）`,
          ].filter(Boolean).join('\n');
          try { await this.bot.sendMessage(chatId, lines, { parse_mode: 'Markdown' }); }
          catch (_) { await this.bot.sendMessage(chatId, lines); }
          return;
        }

        // ---- Admin 文字指令短路（Telegram-only）----
        const isAdminChat = this.adminChatId && chatId === this.adminChatId;
        if (isAdminChat && text && await this._handleAdminTextCmd(chatId, text, userId)) {
          return;
        }

        // ---- per-chat 序列化 ----
        const prev = this.chatLocks.get(chatId) || Promise.resolve();
        const current = prev.then(() => this._processMessage(msg, chatId, userId, text));
        this.chatLocks.set(chatId, current.catch(() => {}));
        await current;
      } catch (err) {
        console.error('[telegram-adapter] message error:', err);
        await this._notifyError(err, `Chat: ${chatId}\nText: ${text}`);
      }
    });
  }

  async _processMessage(msg, chatId, userId, text) {
    let processingMsg = null;

    try {
      await this.sendTyping(chatId);

      // Ollama 模式先發「處理中」（純 Telegram 體驗優化）
      const isLocalModel = this.config.llm.chatProvider === 'ollama';
      if (isLocalModel && text) {
        try {
          processingMsg = await this.bot.sendMessage(chatId, '⏳ 處理中...');
        } catch (_) {}
      }

      // normalize → orchestrator
      const raw = await normalizeTelegramInput(msg, this.bot);
      const normalized = {
        platform: this.platform,
        chatId: String(raw.chatId),
        userId,
        externalUserId: String(raw.userId),
        profile: raw.profile,
        textContent: raw.textContent,
        attachments: raw.attachments,
        messageId: raw.messageId,
        replyToId: raw.replyToId,
        timestamp: raw.timestamp,
      };

      const response = await this.orchestrator.handleMessage(normalized);

      // _broadcast：附帶要送到別 chat 的訊息（例如新用戶通知 admin）
      if (response?._broadcast) {
        for (const b of response._broadcast) {
          if (b.platform === 'telegram' && b.chatId) {
            await this.sendText(b.chatId, b.text, { buttons: b.buttons }).catch(err =>
              console.error('[telegram-adapter] broadcast 失敗:', err.message));
          }
        }
      }

      // _newUser：推到 dashboard ws
      if (response?._newUser) {
        try { wsManager.broadcast('new_user', { user: response._newUser }); } catch (_) {}
      }

      // 主訊息回覆
      if (response?.text) {
        if (processingMsg) {
          // Ollama：用 editMessageText 替換「處理中」
          try {
            await this.bot.editMessageText(response.text, {
              chat_id: chatId,
              message_id: processingMsg.message_id,
              parse_mode: 'Markdown',
              reply_markup: response.buttons ? this._buttonsToReplyMarkup(response.buttons) : undefined,
            });
            processingMsg = null;
          } catch (_) {
            await this.sendText(chatId, response.text, { buttons: response.buttons });
          }
        } else {
          await this.sendText(chatId, response.text, { buttons: response.buttons });
        }
      } else if (processingMsg) {
        // 沒有文字回覆但有 placeholder，刪掉
        try { await this.bot.deleteMessage(chatId, processingMsg.message_id); } catch (_) {}
      }

      if (response?.images?.length > 0) {
        await this.sendImages(chatId, response.images);
      }
    } catch (err) {
      console.error(`[telegram-adapter] 處理訊息失敗 (chat: ${chatId}):`, err);
      if (processingMsg) {
        try {
          await this.bot.editMessageText('抱歉，處理時發生錯誤，請稍後再試。', {
            chat_id: chatId,
            message_id: processingMsg.message_id,
          });
        } catch (_) {
          await this.bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
        }
      } else {
        await this.bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
      }
      await this._notifyError(err, `Chat: ${chatId}\nMessage: ${text}`);
    }
  }

  // ============================================================
  // Callback 事件
  // ============================================================

  _wireCallback() {
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const data = query.data;
      const userId = `telegram:${chatId}`;
      const messageId = query.message.message_id;

      console.log(`[telegram-adapter] callback_query: ${data} (chat: ${chatId})`);

      try {
        // Admin callback 短路（Telegram-only）
        if (data.startsWith('admin:')) {
          if (chatId !== this.adminChatId) {
            await this.bot.answerCallbackQuery(query.id, { text: '無權限' });
            return;
          }
          await this._handleAdminCallback(chatId, data, userId);
          await this.clearButtons(chatId, messageId);
          await this.bot.answerCallbackQuery(query.id);
          return;
        }

        // 主路徑 → orchestrator
        const response = await this.orchestrator.handleCallback(
          this.platform, String(chatId), userId, data, String(messageId)
        );

        if (response) {
          if (response.text) {
            await this.sendText(chatId, response.text, { buttons: response.buttons });
          }
          if (response.images?.length > 0) {
            await this.sendImages(chatId, response.images);
          }
        }

        await this.clearButtons(chatId, messageId);
        await this.bot.answerCallbackQuery(query.id);
      } catch (err) {
        console.error(`[telegram-adapter] callback_query 失敗:`, err);
        await this.bot.answerCallbackQuery(query.id, { text: '處理失敗，請重試' });
        await this._notifyError(err, `Callback: ${data}\nChat: ${chatId}`);
      }
    });
  }

  async _handleAdminCallback(chatId, data, userId) {
    const parts = data.split(':');
    const action = parts[1];
    const targetChatId = parts[2];
    const role = parts[3] || 'user';

    if (action === 'approve') {
      const roleName = role === 'advanced' ? '高級用戶' : '一般用戶';
      await auth.approveUser('telegram', targetChatId, 'approve', role, userId);

      // 查 target user 的 platform，若為 discord 則 append 建 channel 提醒
      // 注意：approveUser 目前第一參數 hardcode 為 'telegram'，Discord 用戶核准實際會失敗
      // 這段提醒邏輯為未來（approveUser 跨平台修好 / Dashboard 審核）預留
      const matching = await auth.listUsers({ chatId: String(targetChatId) });
      const targetUser = matching[0];

      let reply = `✅ 已核准 ${targetChatId} 為${roleName}`;
      if (targetUser?.platform === 'discord') {
        reply += '\n\n📋 記得為此用戶建立 Discord 操作 channel';
        reply += '\n   參考：docs/discord-add-user-sop.md';
      }
      await this.sendText(chatId, reply);
      try { await this.bot.sendMessage(Number(targetChatId), adminAgent.MESSAGES.welcomeAfterApproval); } catch (_) {}
    } else if (action === 'block') {
      await auth.approveUser('telegram', targetChatId, 'block', null, userId);
      await this.sendText(chatId, `🚫 已封鎖 ${targetChatId}`);
    } else if (action === 'setrole') {
      const newRole = parts[3] || 'user';
      const roleLabels = { admin: '管理員', advanced: '高級用戶', user: '一般用戶' };
      await auth.setUserRole('telegram', targetChatId, newRole);
      await this.sendText(chatId, `✅ 已將 ${targetChatId} 角色改為「${roleLabels[newRole] || newRole}」`);
      try { await this.bot.sendMessage(Number(targetChatId), `📢 您的角色已更新為「${roleLabels[newRole] || newRole}」。`); } catch (_) {}
    }
  }

  // ============================================================
  // Admin 文字指令（用戶列表 / 升級用戶 / 封鎖用戶 / 解封用戶）
  // ============================================================

  /**
   * @returns {Promise<boolean>} true 表示已處理（消化掉訊息）
   */
  async _handleAdminTextCmd(chatId, text, userId) {
    // 用戶列表
    if (/^(用戶列表|使用者列表|list ?users?)$/i.test(text)) {
      const users = await auth.listUsers();
      if (users.length === 0) {
        await this.sendText(chatId, '目前沒有用戶。');
        return true;
      }
      const roleLabels = { admin: '👑管理員', advanced: '⭐高級', user: '👤一般' };
      const statusLabels = { active: '✅', pending: '⏳', blocked: '🚫' };
      const lines = users.map(u => {
        const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || '未知';
        const username = u.profile?.username ? `@${u.profile.username}` : '';
        const role = roleLabels[u.role] || u.role;
        const status = statusLabels[u.status] || u.status;
        const platTag = u.platform === 'discord' ? ' [DC]' : '';
        return `${status} ${name} ${username}${platTag}\n   角色：${role} | ID：${u.chatId}`;
      }).join('\n\n');
      await this.sendText(chatId, `📋 用戶列表（${users.length} 人）：\n\n${lines}`);
      return true;
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
        await this.sendText(chatId, `找不到用戶「${searchName}」`);
        return true;
      }
      if (matches.length > 1) {
        const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
        await this.sendText(chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
        return true;
      }

      const target = matches[0];
      const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;

      if (cmd === '升級用戶') {
        await this.sendText(chatId, `選擇「${targetName}」的新角色：`, {
          buttons: [
            [
              { text: '👤 一般用戶', data: `admin:setrole:${target.chatId}:user` },
              { text: '⭐ 高級用戶', data: `admin:setrole:${target.chatId}:advanced` },
            ],
            [{ text: '👑 管理員', data: `admin:setrole:${target.chatId}:admin` }],
          ],
        });
      } else if (cmd === '封鎖用戶') {
        await auth.approveUser('telegram', target.chatId, 'block', null, userId);
        await this.sendText(chatId, `🚫 已封鎖「${targetName}」`);
      } else if (cmd === '解封用戶') {
        await auth.approveUser('telegram', target.chatId, 'approve', target.role || 'user', userId);
        await this.sendText(chatId, `✅ 已解封「${targetName}」`);
      }
      return true;
    }

    return false;
  }

  // ============================================================
  // 錯誤通知
  // ============================================================

  async _notifyError(error, context = '') {
    if (!this.config.error.notifyEnabled) return;
    if (!this.adminChatId) return;
    try {
      const msg = `⚠️ 穗鈅助手錯誤\n\n${context}\n${error.message || error}`.slice(0, 4000);
      await this.bot.sendMessage(this.adminChatId, msg);
    } catch (_) {}
  }

  // ============================================================
  // helper
  // ============================================================

  _buttonsToReplyMarkup(buttons) {
    return {
      inline_keyboard: buttons.map(row =>
        row.map(b => ({ text: b.text, callback_data: b.data }))
      ),
    };
  }
}

module.exports = TelegramAdapter;
