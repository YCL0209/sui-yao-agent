/**
 * 穗鈅助手 — Discord Adapter（Phase I1）
 *
 * Discord.js v14。觸發策略：mention / channel 白名單 / both（見 _shouldRespond）。
 *
 * @version 1.0.0
 */

const {
  Client, GatewayIntentBits, Events, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder,
  StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const MessageAdapter = require('./adapter-interface');
const { normalizeDiscordInput } = require('../input-normalizer');
const wsManager = require('../dashboard/ws-manager');

class DiscordAdapter extends MessageAdapter {
  constructor(opts) {
    super(opts);
    this.platform = 'discord';
    this.dcConfig = opts.config.discord;
    this.maxLen = this.dcConfig.maxMessageLength || 1900;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
    });
  }

  async start() {
    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord-adapter] logged in as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot) return;
      if (!this._shouldRespond(msg)) return;

      try {
        msg.channel.sendTyping().catch(() => {});
        const raw = await normalizeDiscordInput(msg, this.client);
        const normalized = this._buildNormalized(raw);

        const response = await this.orchestrator.handleMessage(normalized);

        // _broadcast → 送到別 chat（例如新用戶通知 admin）
        if (response?._broadcast) {
          for (const b of response._broadcast) {
            if (b.platform === this.platform && b.chatId) {
              await this.sendText(b.chatId, b.text, { buttons: b.buttons }).catch(err =>
                console.error('[discord-adapter] broadcast 失敗:', err.message));
            }
          }
        }

        if (response?._newUser) {
          try { wsManager.broadcast('new_user', { user: response._newUser }); } catch (_) {}
        }

        if (response?.text) {
          await this.sendText(normalized.chatId, response.text, {
            buttons: response.buttons,
            selectMenu: response.selectMenu,
            replyToId: normalized.messageId,
          });
        }
        if (response?.images?.length > 0) {
          await this.sendImages(normalized.chatId, response.images);
        }
      } catch (err) {
        console.error('[discord-adapter] message 處理失敗:', err);
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

      try {
        const chatId = interaction.channelId;
        const userId = `discord:${chatId}`;

        // 特殊攔截：order:qty:modal:IDX 按鈕 → 彈 Discord Modal 讓用戶直接輸入數量
        // （不走 orchestrator；提交後由 isModalSubmit 分支組成 order:qty:set:IDX:N 再呼叫）
        if (interaction.isButton() && interaction.customId.startsWith('order:qty:modal:')) {
          const idx = interaction.customId.split(':')[3];
          const modal = new ModalBuilder()
            .setCustomId(`order:qty:set:${idx}`)
            .setTitle('修改品項數量');
          const qtyInput = new TextInputBuilder()
            .setCustomId('qty')
            .setLabel('新數量（輸入 0 或負數會移除此品項）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setPlaceholder('例：20');
          modal.addComponents(new ActionRowBuilder().addComponents(qtyInput));
          await interaction.showModal(modal);
          return;
        }

        // Button: customId 直接當 callback id
        // SelectMenu: customId + 選中的 value 組成 callback id（例：order:item:sel + 0 → order:item:sel:0）
        // ModalSubmit: customId + 輸入值組成（例：order:qty:set:0 + 20 → order:qty:set:0:20）
        let callbackId;
        if (interaction.isStringSelectMenu()) {
          callbackId = `${interaction.customId}:${interaction.values[0]}`;
        } else if (interaction.isModalSubmit()) {
          const qty = interaction.fields.getTextInputValue('qty');
          callbackId = `${interaction.customId}:${qty}`;
        } else {
          callbackId = interaction.customId;
        }

        const response = await this.orchestrator.handleCallback(
          this.platform,
          chatId,
          userId,
          callbackId,
          interaction.message.id
        );

        // 先清掉原訊息按鈕（避免重按）
        try {
          await interaction.update({ components: [] });
        } catch (_) {
          // 已 ack 過或時效過期，改用 deferUpdate
          try { await interaction.deferUpdate(); } catch (_) {}
        }

        if (response) {
          if (response.text) {
            // 用 followUp 發新訊息（避免 double reply）
            const components = this._buildComponents(response.buttons, response.selectMenu);
            const chunks = this._splitMessage(response.text, this.maxLen);
            for (let i = 0; i < chunks.length; i++) {
              const payload = { content: chunks[i] };
              if (i === chunks.length - 1 && components.length > 0) {
                payload.components = components;
              }
              await interaction.followUp(payload);
            }
          }
          if (response.images?.length > 0) {
            for (const img of response.images) {
              await interaction.followUp({
                content: img.caption || '',
                files: [new AttachmentBuilder(img.localPath)],
              });
            }
          }
        }
      } catch (err) {
        console.error('[discord-adapter] interaction 處理失敗:', err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '處理失敗', ephemeral: true }).catch(() => {});
        }
      }
    });

    this.client.on(Events.Error, (err) =>
      console.error('[discord-adapter] client error:', err));

    // login retry / backoff（連 4 次：立即 + 5s + 15s + 30s）
    // 處理 Discord gateway 暫時 unreachable 的情境，避免 launchd 無限重啟整個 bot
    const delays = [5000, 15000, 30000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await this.client.login(this.dcConfig.token);
        return;
      } catch (err) {
        lastErr = err;
        console.error(`[discord-adapter] login 失敗 (嘗試 ${attempt + 1}/${delays.length + 1}): ${err.message}`);
        if (attempt < delays.length) {
          console.log(`[discord-adapter] ${delays[attempt] / 1000}s 後重試...`);
          await new Promise(r => setTimeout(r, delays[attempt]));
        }
      }
    }
    throw lastErr;
  }

  async stop() {
    if (this.client) await this.client.destroy();
  }

  // ============================================================
  // 子類介面實作
  // ============================================================

  async sendText(chatId, text, options = {}) {
    if (!text) return;
    const channel = await this.client.channels.fetch(chatId);
    if (!channel) {
      console.error(`[discord-adapter] channel 不存在: ${chatId}`);
      return;
    }
    const chunks = this._splitMessage(text, this.maxLen);
    const components = this._buildComponents(options.buttons, options.selectMenu);

    for (let i = 0; i < chunks.length; i++) {
      const payload = { content: chunks[i] };
      if (i === chunks.length - 1 && components.length > 0) {
        payload.components = components;
      }
      if (i === 0 && options.replyToId) {
        payload.reply = { messageReference: options.replyToId, failIfNotExists: false };
      }
      try {
        await channel.send(payload);
      } catch (err) {
        console.error('[discord-adapter] channel.send 失敗:', err.message);
      }
    }
  }

  async sendImages(chatId, images) {
    const channel = await this.client.channels.fetch(chatId);
    if (!channel) return;
    for (const img of images) {
      try {
        await channel.send({
          content: img.caption || '',
          files: [new AttachmentBuilder(img.localPath)],
        });
      } catch (err) {
        console.error('[discord-adapter] sendImages 失敗:', err.message);
      }
    }
  }

  async sendTyping(chatId) {
    try {
      const channel = await this.client.channels.fetch(chatId);
      if (channel) await channel.sendTyping();
    } catch (_) {}
  }

  // ============================================================
  // 私有：raw → normalizedMsg
  // ============================================================

  _buildNormalized(raw) {
    return {
      platform: this.platform,
      chatId: String(raw.chatId),
      userId: `discord:${raw.chatId}`,
      externalUserId: String(raw.userId),
      profile: raw.profile || {},
      textContent: raw.textContent || '',
      attachments: raw.attachments || [],
      messageId: String(raw.messageId),
      replyToId: raw.replyToId ? String(raw.replyToId) : null,
      timestamp: raw.timestamp || new Date(),
    };
  }

  // ============================================================
  // 觸發策略
  // ============================================================

  _shouldRespond(msg) {
    // DM：若有 allowedUserIds 限制則檢查，否則允許
    if (!msg.guild) {
      if (this.dcConfig.allowedUserIds.length === 0) return true;
      return this.dcConfig.allowedUserIds.includes(msg.author.id);
    }

    // Guild 白名單
    if (this.dcConfig.allowedGuildIds.length > 0
        && !this.dcConfig.allowedGuildIds.includes(msg.guild.id)) {
      return false;
    }

    // 白名單 channel 內才回；其他（含 @mention）一律忽略（物理隔離策略）
    return this.dcConfig.allowedChannelIds.includes(msg.channel.id);
  }

  // ============================================================
  // Button / SelectMenu 轉譯
  // ============================================================

  // 組合 reply_markup → Discord ActionRow[]（SelectMenu 在上、Button 在下；共 5 排上限）
  _buildComponents(buttons, selectMenu) {
    const rows = [];
    if (selectMenu) {
      rows.push(this._selectMenuToRow(selectMenu));
    }
    if (Array.isArray(buttons) && buttons.length > 0) {
      rows.push(...this._buttonsToComponents(buttons));
    }
    return rows.slice(0, 5);
  }

  _selectMenuToRow(selectMenu) {
    const ar = new ActionRowBuilder();
    const options = (selectMenu.options || []).slice(0, 25).map(o => {
      const opt = {
        label: (o.label || ' ').slice(0, 100),
        value: String(o.value).slice(0, 100),
      };
      if (o.default) opt.default = true;
      if (o.description) opt.description = String(o.description).slice(0, 100);
      return opt;
    });
    const menu = new StringSelectMenuBuilder()
      .setCustomId((selectMenu.custom_id || 'select').slice(0, 100))
      .setPlaceholder((selectMenu.placeholder || '請選擇').slice(0, 150))
      .addOptions(options);
    ar.addComponents(menu);
    return ar;
  }

  _buttonsToComponents(buttons) {
    // Discord：每排 5 個、每訊息 5 排
    return buttons.slice(0, 5).map(row => {
      const ar = new ActionRowBuilder();
      row.slice(0, 5).forEach(b => {
        ar.addComponents(
          new ButtonBuilder()
            .setCustomId((b.data || '').slice(0, 100))
            .setLabel((b.text || ' ').slice(0, 80))
            .setStyle(this._inferButtonStyle(b.text || ''))
        );
      });
      return ar;
    });
  }

  _inferButtonStyle(text) {
    if (/✅|確定|確認|核准/.test(text)) return ButtonStyle.Success;
    if (/❌|取消|拒絕|封鎖/.test(text)) return ButtonStyle.Danger;
    if (/⚠️|警告/.test(text))            return ButtonStyle.Primary;
    return ButtonStyle.Secondary;
  }

  // ============================================================
  // 訊息分段（換行 > 空白 > 硬切）
  // ============================================================

  _splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const out = [];
    let rest = text;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf('\n', maxLen);
      if (cut < maxLen * 0.5) cut = rest.lastIndexOf(' ', maxLen);
      if (cut < maxLen * 0.5) cut = maxLen;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) out.push(rest);
    return out;
  }
}

module.exports = DiscordAdapter;
