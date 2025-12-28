require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Config
const config = {
  token: process.env.BOT_TOKEN,
  adlinkDomain: process.env.ADLINKFLY_DOMAIN || 'https://upload.mycodingtools.in',
  adlinkApi: process.env.ADLINKFLY_API,
  logChannel: process.env.LOG_CHANNEL,
  admins: process.env.ADMIN_IDS.split(',').map(id => parseInt(id)),
  botUsername: process.env.BOT_USERNAME
};

// JSON Database
const DB_PATH = path.join(__dirname, 'database.json');
let db = {
  users: {},
  files: {},
  settings: {
    adlink_domain: config.adlinkDomain,
    adlink_api: config.adlinkApi,
    start_msg: '👋 Welcome to File Store Bot!\n\n📤 Send me any file and I\'ll give you a shareable link.',
    help_msg: '📚 *Help*\n\n1️⃣ Send file to bot\n2️⃣ Get shareable link\n3️⃣ Share with others\n4️⃣ First-time users verify\n5️⃣ Direct access after verification',
    auto_delete: 0,
    protect_content: false
  },
  channels: []
};

// Load/Save Database
const loadDB = async () => {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    db = { ...db, ...JSON.parse(data) };
  } catch (err) {
    await saveDB();
  }
};

const saveDB = async () => {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
};

// Initialize Bot
const bot = new Telegraf(config.token);

// Helper Functions
const isAdmin = (userId) => config.admins.includes(userId);
const generateCode = () => Math.random().toString(36).substr(2, 8);

// AdLinkFly Shortener
const createShortLink = async (url) => {
  try {
    const domain = db.settings.adlink_domain;
    const api = db.settings.adlink_api;
    const apiUrl = `${domain}/api?api=${api}&url=${encodeURIComponent(url)}`;
    const { data } = await axios.get(apiUrl);
    
    if (data.status === 'error') throw new Error(data.message);
    return data.shortenedUrl;
  } catch (err) {
    console.error('AdLinkFly error:', err.message);
    return url;
  }
};

// Check Subscription
const checkSubscription = async (ctx) => {
  if (db.channels.length === 0) return true;

  const notJoined = [];
  for (const ch of db.channels) {
    try {
      const member = await ctx.telegram.getChatMember(ch.channelId, ctx.from.id);
      if (!['member', 'administrator', 'creator'].includes(member.status)) {
        notJoined.push(ch);
      }
    } catch (err) {
      console.error('Subscription check error:', err.message);
    }
  }

  if (notJoined.length > 0) {
    const buttons = notJoined.map(ch => [{
      text: `Join ${ch.username}`,
      url: `https://t.me/${ch.username.replace('@', '')}`
    }]);
    buttons.push([{ text: '✅ Verify', callback_data: 'verify_sub' }]);
    
    await ctx.reply('⚠️ Join required channels:', {
      reply_markup: { inline_keyboard: buttons }
    });
    return false;
  }
  return true;
};

// Auto Delete
const autoDelete = (ctx, msgId) => {
  const seconds = db.settings.auto_delete;
  if (seconds > 0) {
    setTimeout(() => {
      ctx.deleteMessage(msgId).catch(() => {});
    }, seconds * 1000);
  }
};

// START Command
bot.start(async (ctx) => {
  const args = ctx.message.text.split(' ')[1];
  
  if (args) {
    // Handle file request
    const file = db.files[args];
    if (!file) {
      return ctx.reply('❌ File not found or expired.');
    }

    // Check subscription
    if (!(await checkSubscription(ctx))) return;

    // Check verification
    const userId = ctx.from.id;
    if (!db.users[userId]) {
      db.users[userId] = { verified: false };
      await saveDB();
    }

    if (!db.users[userId].verified) {
      const fileUrl = `https://t.me/${config.botUsername}?start=${args}`;
      const shortUrl = await createShortLink(fileUrl);
      
      await ctx.reply(
        '🔐 *Verification Required*\n\n' +
        'Click the link below to verify and access the file:\n\n' +
        `🔗 ${shortUrl}\n\n` +
        '✅ After verification once, you\'ll get direct access to all files!',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Send file
    try {
      const sentMsg = await ctx.telegram.sendDocument(
        ctx.chat.id,
        file.fileId,
        {
          caption: file.caption,
          protect_content: db.settings.protect_content
        }
      );
      autoDelete(ctx, sentMsg.message_id);
      
      // Log
      await ctx.telegram.sendMessage(
        config.logChannel,
        `📥 File Downloaded\n\n` +
        `User: ${ctx.from.first_name} (${userId})\n` +
        `File: ${file.caption || 'No caption'}\n` +
        `Code: ${args}`
      ).catch(() => {});
    } catch (err) {
      ctx.reply('❌ Error sending file. Please contact admin.');
    }
  } else {
    // Regular start
    await ctx.reply(db.settings.start_msg, { parse_mode: 'Markdown' });
  }
});

// HELP Command
bot.help((ctx) => {
  ctx.reply(db.settings.help_msg, { parse_mode: 'Markdown' });
});

// Verify Callback
bot.action('verify_sub', async (ctx) => {
  if (await checkSubscription(ctx)) {
    const userId = ctx.from.id;
    if (!db.users[userId]) db.users[userId] = {};
    db.users[userId].verified = true;
    db.users[userId].verifiedAt = new Date();
    await saveDB();
    
    await ctx.answerCbQuery('✅ Verified! Access the link again.');
    await ctx.reply('✅ You\'re verified! Now click your link again to get the file.');
  } else {
    await ctx.answerCbQuery('❌ Please join all channels first!');
  }
});

// File Handler
bot.on(['document', 'video', 'audio', 'photo'], async (ctx) => {
  let fileId, fileType, caption;

  if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
    fileType = 'document';
    caption = ctx.message.document.file_name;
  } else if (ctx.message.video) {
    fileId = ctx.message.video.file_id;
    fileType = 'video';
    caption = 'Video';
  } else if (ctx.message.audio) {
    fileId = ctx.message.audio.file_id;
    fileType = 'audio';
    caption = ctx.message.audio.title || 'Audio';
  } else if (ctx.message.photo) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    fileType = 'photo';
    caption = 'Photo';
  }

  if (ctx.message.caption) caption = ctx.message.caption;

  const shortCode = generateCode();
  db.files[shortCode] = {
    fileId,
    fileType,
    caption,
    uploadedBy: ctx.from.id,
    createdAt: new Date()
  };
  await saveDB();

  // Log to channel
  try {
    await ctx.telegram.forwardMessage(config.logChannel, ctx.chat.id, ctx.message.message_id);
    await ctx.telegram.sendMessage(
      config.logChannel,
      `📤 New File Uploaded\n\n` +
      `User: ${ctx.from.first_name} (${ctx.from.id})\n` +
      `File: ${caption}\n` +
      `Code: ${shortCode}\n` +
      `Link: https://t.me/${config.botUsername}?start=${shortCode}`
    );
  } catch (err) {
    console.error('Log error:', err.message);
  }

  const shareLink = `https://t.me/${config.botUsername}?start=${shortCode}`;
  await ctx.reply(
    `✅ *File Uploaded Successfully!*\n\n` +
    `📎 Share Link:\n\`${shareLink}\`\n\n` +
    `🔑 Code: \`${shortCode}\``,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Set AdLinkFly
bot.command('setadlink', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage: /setadlink <domain> <api_key>');
  }

  db.settings.adlink_domain = args[0];
  db.settings.adlink_api = args[1];
  await saveDB();
  ctx.reply('✅ AdLinkFly settings updated!');
});

// ADMIN: Set Start Message
bot.command('setstart', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const msg = ctx.message.text.replace('/setstart ', '');
  if (msg === '/setstart') {
    return ctx.reply('Usage: /setstart <message>');
  }

  db.settings.start_msg = msg;
  await saveDB();
  ctx.reply('✅ Start message updated!');
});

// ADMIN: Set Help Message
bot.command('sethelp', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const msg = ctx.message.text.replace('/sethelp ', '');
  if (msg === '/sethelp') {
    return ctx.reply('Usage: /sethelp <message>');
  }

  db.settings.help_msg = msg;
  await saveDB();
  ctx.reply('✅ Help message updated!');
});

// ADMIN: Auto Delete
bot.command('autodelete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const seconds = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(seconds)) {
    return ctx.reply('Usage: /autodelete <seconds>\nExample: /autodelete 300 (5 min)\nUse 0 to disable');
  }

  db.settings.auto_delete = seconds;
  await saveDB();
  ctx.reply(`✅ Auto-delete set to ${seconds} seconds!`);
});

// ADMIN: Add Channel
bot.command('addchannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const username = ctx.message.text.split(' ')[1];
  if (!username || !username.startsWith('@')) {
    return ctx.reply('Usage: /addchannel @channelname');
  }

  try {
    const chat = await ctx.telegram.getChat(username);
    const exists = db.channels.find(ch => ch.channelId === chat.id.toString());
    
    if (exists) {
      return ctx.reply('❌ Channel already added!');
    }

    db.channels.push({
      channelId: chat.id.toString(),
      username: username,
      title: chat.title
    });
    await saveDB();
    ctx.reply(`✅ Channel ${username} added for force subscription!`);
  } catch (err) {
    ctx.reply('❌ Error: Make sure bot is admin in the channel!');
  }
});

// ADMIN: Remove Channel
bot.command('removechannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const username = ctx.message.text.split(' ')[1];
  if (!username) {
    return ctx.reply('Usage: /removechannel @channelname');
  }

  db.channels = db.channels.filter(ch => ch.username !== username);
  await saveDB();
  ctx.reply(`✅ Channel ${username} removed!`);
});

// ADMIN: List Channels
bot.command('listchannels', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  if (db.channels.length === 0) {
    return ctx.reply('No force subscription channels added.');
  }

  const list = db.channels.map((ch, i) => 
    `${i + 1}. ${ch.username} - ${ch.title}`
  ).join('\n');
  
  ctx.reply(`📋 *Force Subscription Channels:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// ADMIN: Protect Content
bot.command('protect', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const arg = ctx.message.text.split(' ')[1];
  if (arg === 'on') {
    db.settings.protect_content = true;
    await saveDB();
    ctx.reply('✅ Content protection enabled!');
  } else if (arg === 'off') {
    db.settings.protect_content = false;
    await saveDB();
    ctx.reply('✅ Content protection disabled!');
  } else {
    ctx.reply('Usage: /protect <on/off>');
  }
});

// ADMIN: Stats
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const stats = `📊 *Bot Statistics*\n\n` +
    `👥 Total Users: ${Object.keys(db.users).length}\n` +
    `✅ Verified Users: ${Object.values(db.users).filter(u => u.verified).length}\n` +
    `📁 Total Files: ${Object.keys(db.files).length}\n` +
    `📺 Force Sub Channels: ${db.channels.length}\n` +
    `🔐 Content Protection: ${db.settings.protect_content ? 'ON' : 'OFF'}\n` +
    `⏱ Auto Delete: ${db.settings.auto_delete}s`;
  
  ctx.reply(stats, { parse_mode: 'Markdown' });
});

// ADMIN: Settings
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  
  const settings = `⚙️ *Current Settings*\n\n` +
    `🔗 AdLinkFly Domain: ${db.settings.adlink_domain}\n` +
    `🔑 API Key: ${db.settings.adlink_api.substr(0, 10)}...\n` +
    `⏱ Auto Delete: ${db.settings.auto_delete}s\n` +
    `🔐 Protect Content: ${db.settings.protect_content ? 'ON' : 'OFF'}\n` +
    `📺 Force Sub Channels: ${db.channels.length}`;
  
  ctx.reply(settings, { parse_mode: 'Markdown' });
});

// Start Bot
loadDB().then(() => {
  bot.launch();
  console.log('✅ Bot started successfully!');
  
  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}).catch(err => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});
