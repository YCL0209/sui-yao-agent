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
    this.dashboardPublicUrl = opts.config.dashboard?.publicUrl || 'http://127.0.0.1:4000';
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
        // I2 v3：admin 審核全面移到 Dashboard；歷史訊息殭屍按鈕直接 short-circuit
        if (data.startsWith('admin:')) {
          await this.sendText(chatId,
            `⚠️ 此按鈕已失效，請到 Dashboard 處理：\n${this.dashboardPublicUrl}/#users`);
          await this.clearButtons(chatId, messageId);
          await this.bot.answerCallbackQuery(query.id, { text: '已失效' });
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
