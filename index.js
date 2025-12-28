require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Config
const config = {
  token: process.env.BOT_TOKEN,
  logChannel: process.env.LOG_CHANNEL,
  admins: process.env.ADMIN_IDS.split(',').map(id => parseInt(id)),
  botUsername: process.env.BOT_USERNAME
};

// JSON Database Path
const DB_PATH = path.join(__dirname, 'database.json');
let db = {
  users: {},
  files: {},
  settings: {
    adlink_domain: '',
    adlink_api: '',
    start_msg: '👋 *Welcome to File Store Bot!*\n\n📤 Send me any file and I\'ll give you a shareable link.\n\n💡 Share links with others to distribute your files easily!',
    help_msg: '📚 *How to Use:*\n\n1️⃣ Send any file to the bot\n2️⃣ Get a shareable link\n3️⃣ Share the link with others\n4️⃣ First-time users must verify via link\n5️⃣ After verification, direct file access\n\n👨‍💼 *Admin Commands:*\n/setadlink - Configure AdLinkFly\n/setstart - Custom start message\n/sethelp - Custom help message\n/autodelete - Set auto-delete timer\n/addchannel - Add force sub channel\n/removechannel - Remove channel\n/listchannels - List channels\n/protect - Content protection\n/settings - View settings\n/stats - Statistics',
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
    console.log('✅ Database loaded');
  } catch (err) {
    console.log('📝 Creating new database');
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

// AdLinkFly Shortener - Universal Logic
const createShortLink = async (url) => {
  try {
    const domain = db.settings.adlink_domain;
    const api = db.settings.adlink_api;
    
    if (!domain || !api) {
      console.log('⚠️ AdLinkFly not configured, returning original URL');
      return url;
    }

    // Universal shortening logic for all AdLinkFly domains
    const encodedUrl = encodeURIComponent(url);
    const apiUrl = `${domain}/api?api=${api}&url=${encodedUrl}`;
    
    const response = await axios.get(apiUrl, { timeout: 10000 });
    
    if (response.data.status === 'error') {
      console.error('AdLinkFly error:', response.data.message);
      return url;
    }
    
    return response.data.shortenedUrl;
  } catch (err) {
    console.error('Shortening error:', err.message);
    return url;
  }
};

// Check Force Subscription
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
    buttons.push([{ text: '✅ Verify Subscription', callback_data: 'verify_sub' }]);
    
    await ctx.reply(
      '⚠️ *Please join these channels first:*',
      { 
        reply_markup: { inline_keyboard: buttons },
        parse_mode: 'Markdown'
      }
    );
    return false;
  }
  return true;
};

// Auto Delete Message
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
    // File request with code
    const file = db.files[args];
    if (!file) {
      return ctx.reply('❌ File not found or expired.');
    }

    // Check force subscription
    if (!(await checkSubscription(ctx))) return;

    // Get or create user
    const userId = ctx.from.id;
    if (!db.users[userId]) {
      db.users[userId] = { 
        verified: false,
        firstName: ctx.from.first_name,
        username: ctx.from.username
      };
      await saveDB();
    }

    // Check if user is verified
    if (!db.users[userId].verified) {
      // Generate verification link
      const fileUrl = `https://t.me/${config.botUsername}?start=${args}`;
      const shortUrl = await createShortLink(fileUrl);
      
      const keyboard = {
        inline_keyboard: [
          [{ text: '🔗 Click Here to Verify', url: shortUrl }],
          [{ text: '✅ I Have Verified', callback_data: `verify_${args}` }]
        ]
      };
      
      return ctx.reply(
        '🔐 *Verification Required*\n\n' +
        '👆 Click the button above to verify.\n\n' +
        '✅ After verification, click "I Have Verified" to get your file.\n\n' +
        '💡 You only need to verify once!',
        { 
          reply_markup: keyboard,
          parse_mode: 'Markdown'
        }
      );
    }

    // User is verified - send file
    try {
      let sentMsg;
      
      if (file.fileType === 'document') {
        sentMsg = await ctx.replyWithDocument(file.fileId, {
          caption: file.caption,
          protect_content: db.settings.protect_content
        });
      } else if (file.fileType === 'video') {
        sentMsg = await ctx.replyWithVideo(file.fileId, {
          caption: file.caption,
          protect_content: db.settings.protect_content
        });
      } else if (file.fileType === 'audio') {
        sentMsg = await ctx.replyWithAudio(file.fileId, {
          caption: file.caption,
          protect_content: db.settings.protect_content
        });
      } else if (file.fileType === 'photo') {
        sentMsg = await ctx.replyWithPhoto(file.fileId, {
          caption: file.caption,
          protect_content: db.settings.protect_content
        });
      }
      
      autoDelete(ctx, sentMsg.message_id);
      
      // Log download
      await ctx.telegram.sendMessage(
        config.logChannel,
        `📥 *File Downloaded*\n\n` +
        `👤 User: ${ctx.from.first_name} (${userId})\n` +
        `📄 File: ${file.caption || 'No caption'}\n` +
        `🔑 Code: \`${args}\`\n` +
        `⏰ Time: ${new Date().toLocaleString()}`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      
    } catch (err) {
      console.error('Send file error:', err);
      ctx.reply('❌ Error sending file. Please contact admin.');
    }
  } else {
    // Regular start message
    await ctx.reply(db.settings.start_msg, { parse_mode: 'Markdown' });
  }
});

// HELP Command
bot.help((ctx) => {
  ctx.reply(db.settings.help_msg, { parse_mode: 'Markdown' });
});

// Verify Callback
bot.action(/verify_(.+)/, async (ctx) => {
  const code = ctx.match[1];
  const userId = ctx.from.id;
  
  // Mark user as verified
  if (!db.users[userId]) {
    db.users[userId] = { 
      verified: true,
      verifiedAt: new Date(),
      firstName: ctx.from.first_name,
      username: ctx.from.username
    };
  } else {
    db.users[userId].verified = true;
    db.users[userId].verifiedAt = new Date();
  }
  await saveDB();
  
  await ctx.answerCbQuery('✅ Verification successful!');
  await ctx.reply(
    '✅ *Verification Successful!*\n\n' +
    '🎉 You can now access all files directly.\n\n' +
    '📥 Click your original link again to get the file.',
    { parse_mode: 'Markdown' }
  );
  
  // Log verification
  await ctx.telegram.sendMessage(
    config.logChannel,
    `✅ *New User Verified*\n\n` +
    `👤 User: ${ctx.from.first_name} (${userId})\n` +
    `📝 Username: @${ctx.from.username || 'none'}\n` +
    `⏰ Time: ${new Date().toLocaleString()}`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});
});

// Subscription Verify Callback
bot.action('verify_sub', async (ctx) => {
  if (await checkSubscription(ctx)) {
    await ctx.answerCbQuery('✅ Subscription verified!');
    await ctx.reply('✅ Subscription verified! You can now use the bot.');
  } else {
    await ctx.answerCbQuery('❌ Please join all channels first!', { show_alert: true });
  }
});

// File Handler (Document, Video, Audio, Photo)
bot.on(['document', 'video', 'audio', 'photo'], async (ctx) => {
  let fileId, fileType, caption;

  if (ctx.message.document) {
    fileId = ctx.message.document.file_id;
    fileType = 'document';
    caption = ctx.message.document.file_name;
  } else if (ctx.message.video) {
    fileId = ctx.message.video.file_id;
    fileType = 'video';
    caption = ctx.message.video.file_name || 'Video File';
  } else if (ctx.message.audio) {
    fileId = ctx.message.audio.file_id;
    fileType = 'audio';
    caption = ctx.message.audio.title || ctx.message.audio.file_name || 'Audio File';
  } else if (ctx.message.photo) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    fileType = 'photo';
    caption = 'Photo';
  }

  if (ctx.message.caption) {
    caption = ctx.message.caption;
  }

  // Generate unique code
  const shortCode = generateCode();
  db.files[shortCode] = {
    fileId,
    fileType,
    caption,
    uploadedBy: ctx.from.id,
    uploadedAt: new Date()
  };
  await saveDB();

  // Forward to log channel
  try {
    await ctx.telegram.forwardMessage(
      config.logChannel,
      ctx.chat.id,
      ctx.message.message_id
    );
    await ctx.telegram.sendMessage(
      config.logChannel,
      `📤 *New File Uploaded*\n\n` +
      `👤 User: ${ctx.from.first_name} (${ctx.from.id})\n` +
      `📄 File: ${caption}\n` +
      `📎 Type: ${fileType}\n` +
      `🔑 Code: \`${shortCode}\`\n` +
      `🔗 Link: \`https://t.me/${config.botUsername}?start=${shortCode}\`\n` +
      `⏰ Time: ${new Date().toLocaleString()}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Log channel error:', err.message);
  }

  // Send shareable link to user
  const shareLink = `https://t.me/${config.botUsername}?start=${shortCode}`;
  await ctx.reply(
    `✅ *File Uploaded Successfully!*\n\n` +
    `📎 *Share Link:*\n\`${shareLink}\`\n\n` +
    `🔑 *Short Code:* \`${shortCode}\`\n\n` +
    `💡 Share this link with others to let them access your file.`,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Set AdLinkFly
bot.command('setadlink', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      '📝 *Set AdLinkFly Configuration*\n\n' +
      '*Usage:* `/setadlink <domain> <api_key>`\n\n' +
      '*Example:*\n' +
      '`/setadlink https://upload.mycodingtools.in 150873c1be29...`',
      { parse_mode: 'Markdown' }
    );
  }

  db.settings.adlink_domain = args[0];
  db.settings.adlink_api = args[1];
  await saveDB();
  
  ctx.reply(
    '✅ *AdLinkFly Configuration Updated!*\n\n' +
    `🔗 Domain: \`${args[0]}\`\n` +
    `🔑 API: \`${args[1].substr(0, 10)}...\``,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Set Start Message
bot.command('setstart', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const msg = ctx.message.text.replace('/setstart ', '').trim();
  if (msg === '/setstart' || msg === '') {
    return ctx.reply(
      '📝 *Set Start Message*\n\n' +
      '*Usage:* `/setstart <your message>`\n\n' +
      '*Example:*\n' +
      '`/setstart Welcome! Send files to get shareable links 🚀`',
      { parse_mode: 'Markdown' }
    );
  }

  db.settings.start_msg = msg;
  await saveDB();
  ctx.reply('✅ Start message updated successfully!', { parse_mode: 'Markdown' });
});

// ADMIN: Set Help Message
bot.command('sethelp', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const msg = ctx.message.text.replace('/sethelp ', '').trim();
  if (msg === '/sethelp' || msg === '') {
    return ctx.reply(
      '📝 *Set Help Message*\n\n' +
      '*Usage:* `/sethelp <your message>`',
      { parse_mode: 'Markdown' }
    );
  }

  db.settings.help_msg = msg;
  await saveDB();
  ctx.reply('✅ Help message updated successfully!');
});

// ADMIN: Auto Delete
bot.command('autodelete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const seconds = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(seconds)) {
    return ctx.reply(
      '⏱ *Set Auto-Delete Timer*\n\n' +
      '*Usage:* `/autodelete <seconds>`\n\n' +
      '*Examples:*\n' +
      '`/autodelete 300` - Delete after 5 minutes\n' +
      '`/autodelete 0` - Disable auto-delete',
      { parse_mode: 'Markdown' }
    );
  }

  db.settings.auto_delete = seconds;
  await saveDB();
  
  if (seconds === 0) {
    ctx.reply('✅ Auto-delete disabled!');
  } else {
    ctx.reply(`✅ Auto-delete set to ${seconds} seconds (${Math.floor(seconds / 60)} minutes)!`);
  }
});

// ADMIN: Add Channel
bot.command('addchannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const username = ctx.message.text.split(' ')[1];
  if (!username || !username.startsWith('@')) {
    return ctx.reply(
      '📺 *Add Force Subscription Channel*\n\n' +
      '*Usage:* `/addchannel @channelname`\n\n' +
      '*Example:*\n' +
      '`/addchannel @mychannel`\n\n' +
      '⚠️ Make sure bot is admin in the channel!',
      { parse_mode: 'Markdown' }
    );
  }

  try {
    const chat = await ctx.telegram.getChat(username);
    const exists = db.channels.find(ch => ch.channelId === chat.id.toString());
    
    if (exists) {
      return ctx.reply('❌ This channel is already added!');
    }

    db.channels.push({
      channelId: chat.id.toString(),
      username: username,
      title: chat.title
    });
    await saveDB();
    
    ctx.reply(
      `✅ *Channel Added Successfully!*\n\n` +
      `📺 Channel: ${username}\n` +
      `📝 Title: ${chat.title}\n\n` +
      `Users must now join this channel to access files.`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    ctx.reply(
      '❌ *Error adding channel!*\n\n' +
      'Make sure:\n' +
      '1️⃣ Bot is admin in the channel\n' +
      '2️⃣ Channel username is correct\n' +
      '3️⃣ Channel is public or bot has access',
      { parse_mode: 'Markdown' }
    );
  }
});

// ADMIN: Remove Channel
bot.command('removechannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const username = ctx.message.text.split(' ')[1];
  if (!username) {
    return ctx.reply(
      '📺 *Remove Force Subscription Channel*\n\n' +
      '*Usage:* `/removechannel @channelname`',
      { parse_mode: 'Markdown' }
    );
  }

  const before = db.channels.length;
  db.channels = db.channels.filter(ch => ch.username !== username);
  await saveDB();
  
  if (db.channels.length < before) {
    ctx.reply(`✅ Channel ${username} removed successfully!`);
  } else {
    ctx.reply(`❌ Channel ${username} not found in the list.`);
  }
});

// ADMIN: List Channels
bot.command('listchannels', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  if (db.channels.length === 0) {
    return ctx.reply('📺 No force subscription channels added yet.');
  }

  const list = db.channels.map((ch, i) => 
    `${i + 1}. ${ch.username}\n   📝 ${ch.title}`
  ).join('\n\n');
  
  ctx.reply(
    `📺 *Force Subscription Channels:*\n\n${list}`,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Content Protection
bot.command('protect', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const arg = ctx.message.text.split(' ')[1];
  if (arg === 'on') {
    db.settings.protect_content = true;
    await saveDB();
    ctx.reply('🛡 Content protection enabled! Files cannot be forwarded.');
  } else if (arg === 'off') {
    db.settings.protect_content = false;
    await saveDB();
    ctx.reply('🛡 Content protection disabled!');
  } else {
    ctx.reply(
      '🛡 *Content Protection*\n\n' +
      '*Usage:* `/protect <on/off>`\n\n' +
      '*Examples:*\n' +
      '`/protect on` - Enable protection\n' +
      '`/protect off` - Disable protection',
      { parse_mode: 'Markdown' }
    );
  }
});

// ADMIN: Settings
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const settings = 
    `⚙️ *Current Bot Settings*\n\n` +
    `🔗 *AdLinkFly:*\n` +
    `   Domain: ${db.settings.adlink_domain || 'Not set'}\n` +
    `   API: ${db.settings.adlink_api ? db.settings.adlink_api.substr(0, 15) + '...' : 'Not set'}\n\n` +
    `⏱ *Auto Delete:* ${db.settings.auto_delete}s ${db.settings.auto_delete > 0 ? '(' + Math.floor(db.settings.auto_delete / 60) + ' min)' : '(Disabled)'}\n\n` +
    `🛡 *Content Protection:* ${db.settings.protect_content ? 'Enabled' : 'Disabled'}\n\n` +
    `📺 *Force Sub Channels:* ${db.channels.length}`;
  
  ctx.reply(settings, { parse_mode: 'Markdown' });
});

// ADMIN: Statistics
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('❌ This command is only for admins.');
  }
  
  const totalUsers = Object.keys(db.users).length;
  const verifiedUsers = Object.values(db.users).filter(u => u.verified).length;
  const totalFiles = Object.keys(db.files).length;
  
  const stats = 
    `📊 *Bot Statistics*\n\n` +
    `👥 *Users:*\n` +
    `   Total: ${totalUsers}\n` +
    `   Verified: ${verifiedUsers}\n` +
    `   Unverified: ${totalUsers - verifiedUsers}\n\n` +
    `📁 *Files:* ${totalFiles}\n\n` +
    `📺 *Force Sub Channels:* ${db.channels.length}\n\n` +
    `🛡 *Protection:* ${db.settings.protect_content ? 'ON' : 'OFF'}\n` +
    `⏱ *Auto-Delete:* ${db.settings.auto_delete}s`;
  
  ctx.reply(stats, { parse_mode: 'Markdown' });
});

// Error Handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// Start Bot
loadDB().then(() => {
  bot.launch();
  console.log('✅ Bot started successfully!');
  console.log(`📱 Bot Username: @${config.botUsername}`);
  
  // Graceful shutdown
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}).catch(err => {
  console.error('❌ Failed to start bot:', err);
  process.exit(1);
});
