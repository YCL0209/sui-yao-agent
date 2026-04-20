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
      if (!interaction.isButton()) return;

      try {
        const chatId = interaction.channelId;
        const userId = `discord:${chatId}`;

        const response = await this.orchestrator.handleCallback(
          this.platform,
          chatId,
          userId,
          interaction.customId,
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
            const components = response.buttons ? this._buttonsToComponents(response.buttons) : [];
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

    await this.client.login(this.dcConfig.token);
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
    const components = options.buttons ? this._buttonsToComponents(options.buttons) : [];

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
  // Button 轉譯
  // ============================================================

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
