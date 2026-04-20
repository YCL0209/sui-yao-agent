/**
 * 穗鈅助手 — Platform Adapter 抽象介面（Phase I1）
 *
 * 所有平台 adapter（Telegram / Discord / LINE...）都繼承這個類別。
 * Bot launcher 只認這個介面，不關心底下是哪個平台。
 *
 * 子類別必須：
 *   - 在 constructor 中設定 this.platform
 *   - 實作 start() / stop()
 *   - 實作 sendText() / sendImages()
 *   - 在收到原始訊息後組成 raw object 並呼叫 this.handleIncoming(raw)
 *
 * @version 1.0.0
 */

class MessageAdapter {
  /**
   * @param {Object} opts
   * @param {Object} opts.config        - 全局 config
   * @param {Object} opts.orchestrator  - Orchestrator 實例（提供 handleMessage / handleCallback）
   */
  constructor({ config, orchestrator }) {
    if (!config) throw new Error('MessageAdapter: config required');
    if (!orchestrator) throw new Error('MessageAdapter: orchestrator required');
    this.platform = 'unknown';   // 子類必須覆寫（'telegram' | 'discord'）
    this.config = config;
    this.orchestrator = orchestrator;
  }

  // ---- 生命週期 ----
  async start() { throw new Error(`${this.platform}: start() not implemented`); }
  async stop()  { throw new Error(`${this.platform}: stop() not implemented`); }

  // ---- 子類必須實作的送訊息介面 ----

  /**
   * 發送文字訊息（可選帶按鈕）
   * @param {string} chatId
   * @param {string} text
   * @param {Object} [options]
   * @param {Array<Array<{text,data}>>} [options.buttons]  - 平台無關按鈕格式
   * @param {string}                    [options.replyToId] - 回覆特定訊息
   */
  async sendText(chatId, text, options = {}) {
    throw new Error(`${this.platform}: sendText() not implemented`);
  }

  /**
   * 發送圖片
   * @param {string} chatId
   * @param {Array<{localPath, caption?}>} images
   */
  async sendImages(chatId, images) {
    throw new Error(`${this.platform}: sendImages() not implemented`);
  }

  /**
   * 顯示「正在輸入」（選配，預設 no-op）
   */
  async sendTyping(chatId) { /* optional */ }

  /**
   * 清除指定訊息的按鈕（callback 完成後呼叫；選配）
   */
  async clearButtons(chatId, messageId) { /* optional */ }

  // ---- 共用：處理進來的訊息 ----

  /**
   * 子類收到訊息後組好 raw 後呼叫這裡。
   *   產生 normalizedMsg → 丟 orchestrator → 用 sendText/sendImages 回覆。
   *
   * @param {Object} raw
   *   @property {string|number} chatId
   *   @property {string|number} userId        - 平台 user id（≠ chatId 時：群組情境）
   *   @property {Object}        profile       - { firstName?, lastName?, username?, languageCode?, discriminator?, avatarUrl? }
   *   @property {string}        textContent   - 可為 ''
   *   @property {Array}         attachments   - [{ type, filePath, mimeType, ... }]
   *   @property {string|number} messageId
   *   @property {string|number} [replyToId]
   *   @property {Date}          [timestamp]
   * @returns {Promise<void>}
   */
  async handleIncoming(raw) {
    const chatIdStr = String(raw.chatId);
    const normalized = {
      platform: this.platform,
      chatId: chatIdStr,
      userId: `${this.platform}:${chatIdStr}`,         // 內部統一 ID
      externalUserId: String(raw.userId ?? raw.chatId),
      profile: raw.profile || {},
      textContent: raw.textContent || '',
      attachments: raw.attachments || [],
      messageId: raw.messageId != null ? String(raw.messageId) : null,
      replyToId: raw.replyToId != null ? String(raw.replyToId) : null,
      timestamp: raw.timestamp || new Date(),
    };

    const response = await this.orchestrator.handleMessage(normalized);
    if (!response) return;

    if (response.text) {
      await this.sendText(normalized.chatId, response.text, {
        buttons: response.buttons,
        replyToId: normalized.messageId,
      });
    }
    if (Array.isArray(response.images) && response.images.length > 0) {
      await this.sendImages(normalized.chatId, response.images);
    }
  }
}

module.exports = MessageAdapter;
