require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');
const axios = require('axios');

// Config
const config = {
  token: process.env.BOT_TOKEN,
  mongodb: process.env.MONGODB_URI,
  apiId: process.env.API_ID,
  apiHash: process.env.API_HASH,
  logChannel: process.env.LOG_CHANNEL,
  ownerId: parseInt(process.env.OWNER_ID),
  admins: process.env.ADMIN_IDS.split(',').map(id => parseInt(id)),
  botUsername: process.env.BOT_USERNAME
};

// Database Schemas
const UserSchema = new mongoose.Schema({
  userId: { type: Number, unique: true, required: true, index: true },
  firstName: String,
  username: String,
  isVerified: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  verifiedAt: Date,
  lastActive: { type: Date, default: Date.now },
  filesShared: { type: Number, default: 0 },
  filesAccessed: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now }
});

const FileSchema = new mongoose.Schema({
  fileId: { type: String, required: true },
  fileUniqueId: { type: String, unique: true },
  fileType: String,
  fileName: String,
  fileSize: Number,
  caption: String,
  shortCode: { type: String, unique: true, required: true, index: true },
  uploadedBy: { type: Number, required: true },
  views: { type: Number, default: 0 },
  downloads: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now, index: true }
});

const SettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

const ChannelSchema = new mongoose.Schema({
  channelId: { type: String, unique: true, required: true },
  username: String,
  title: String,
  addedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const File = mongoose.model('File', FileSchema);
const Setting = mongoose.model('Setting', SettingSchema);
const Channel = mongoose.model('Channel', ChannelSchema);

// Initialize Bot
const bot = new Telegraf(config.token);

// Helper Functions
const isOwner = (userId) => userId === config.ownerId;
const isAdmin = (userId) => config.admins.includes(userId) || isOwner(userId);

const getSetting = async (key, defaultValue = null) => {
  try {
    const setting = await Setting.findOne({ key });
    return setting ? setting.value : defaultValue;
  } catch (err) {
    return defaultValue;
  }
};

const setSetting = async (key, value) => {
  await Setting.findOneAndUpdate(
    { key },
    { value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
};

const generateCode = () => Math.random().toString(36).substr(2, 8);

const formatFileSize = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};

// AdLinkFly Shortener
const createShortLink = async (url) => {
  try {
    const domain = await getSetting('adlink_domain');
    const api = await getSetting('adlink_api');
    
    if (!domain || !api) {
      console.log('⚠️ AdLinkFly not configured');
      return url;
    }

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
  try {
    const channels = await Channel.find();
    if (channels.length === 0) return true;

    const notJoined = [];
    for (const ch of channels) {
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
        text: `📢 Join ${ch.username}`,
        url: `https://t.me/${ch.username.replace('@', '')}`
      }]);
      buttons.push([{ text: '✅ I Joined, Verify Now', callback_data: 'verify_sub' }]);
      
      await ctx.reply(
        '⚠️ *Access Restricted*\n\n' +
        '🔒 Please join our channels to access files:',
        { 
          reply_markup: { inline_keyboard: buttons },
          parse_mode: 'Markdown'
        }
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error('Check subscription error:', err);
    return true;
  }
};

// Auto Delete
const autoDelete = async (ctx, msgId) => {
  try {
    const seconds = await getSetting('auto_delete', 0);
    if (seconds > 0) {
      setTimeout(() => {
        ctx.deleteMessage(msgId).catch(() => {});
      }, seconds * 1000);
    }
  } catch (err) {
    console.error('Auto delete error:', err);
  }
};

// Update user activity
const updateUserActivity = async (userId, data = {}) => {
  try {
    await User.findOneAndUpdate(
      { userId },
      { 
        ...data,
        lastActive: new Date()
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error('Update user error:', err);
  }
};

// START Command
bot.start(async (ctx) => {
  try {
    const args = ctx.message.text.split(' ')[1];
    
    // Update user info
    await updateUserActivity(ctx.from.id, {
      firstName: ctx.from.first_name,
      username: ctx.from.username
    });

    if (args) {
      // File request
      const file = await File.findOne({ shortCode: args, isActive: true });
      if (!file) {
        return ctx.reply('❌ File not found or has been removed.');
      }

      // Check if user is banned
      const user = await User.findOne({ userId: ctx.from.id });
      if (user && user.isBanned) {
        return ctx.reply('🚫 You are banned from using this bot.');
      }

      // Check subscription
      if (!(await checkSubscription(ctx))) return;

      // Check verification
      if (!user || !user.isVerified) {
        const fileUrl = `https://t.me/${config.botUsername}?start=${args}`;
        const shortUrl = await createShortLink(fileUrl);
        
        // Update file views
        file.views += 1;
        await file.save();
        
        const keyboard = {
          inline_keyboard: [
            [{ text: '🔗 Click Here to Verify & Access', url: shortUrl }],
            [{ text: '✅ I Have Verified', callback_data: `verify_${args}` }]
          ]
        };
        
        return ctx.reply(
          '🔐 *Verification Required*\n\n' +
          '👉 Click the button below to verify:\n\n' +
          '✅ After completing verification, click "I Have Verified"\n\n' +
          '💡 *Note:* You only need to verify once. After that, you\'ll get direct access to all files!',
          { 
            reply_markup: keyboard,
            parse_mode: 'Markdown'
          }
        );
      }

      // Send file
      try {
        const protectContent = await getSetting('protect_content', false);
        let sentMsg;
        
        if (file.fileType === 'document') {
          sentMsg = await ctx.replyWithDocument(file.fileId, {
            caption: file.caption,
            protect_content: protectContent
          });
        } else if (file.fileType === 'video') {
          sentMsg = await ctx.replyWithVideo(file.fileId, {
            caption: file.caption,
            protect_content: protectContent
          });
        } else if (file.fileType === 'audio') {
          sentMsg = await ctx.replyWithAudio(file.fileId, {
            caption: file.caption,
            protect_content: protectContent
          });
        } else if (file.fileType === 'photo') {
          sentMsg = await ctx.replyWithPhoto(file.fileId, {
            caption: file.caption,
            protect_content: protectContent
          });
        }
        
        // Update stats
        file.downloads += 1;
        await file.save();
        
        user.filesAccessed += 1;
        await user.save();
        
        autoDelete(ctx, sentMsg.message_id);
        
        // Log download
        await ctx.telegram.sendMessage(
          config.logChannel,
          `📥 *File Downloaded*\n\n` +
          `👤 User: ${ctx.from.first_name} (${ctx.from.id})\n` +
          `📝 Username: @${ctx.from.username || 'none'}\n` +
          `📄 File: ${file.fileName || file.caption || 'Unknown'}\n` +
          `🔑 Code: \`${args}\`\n` +
          `📊 Views: ${file.views} | Downloads: ${file.downloads}\n` +
          `⏰ Time: ${new Date().toLocaleString()}`,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        
      } catch (err) {
        console.error('Send file error:', err);
        ctx.reply('❌ Error sending file. Please contact admin.');
      }
    } else {
      // Regular start
      const startMsg = await getSetting('start_msg', 
        '👋 *Welcome to File Store Bot!*\n\n' +
        '📤 Send me any file and I\'ll give you a shareable link.\n\n' +
        '💡 Share links with others to distribute your files easily!\n\n' +
        '📚 Type /help for more information.'
      );
      await ctx.reply(startMsg, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    console.error('Start command error:', err);
    ctx.reply('❌ An error occurred. Please try again later.');
  }
});

// HELP Command
bot.help(async (ctx) => {
  const helpMsg = await getSetting('help_msg',
    '📚 *Help Menu*\n\n' +
    '*For Users:*\n' +
    '1️⃣ Send any file to the bot\n' +
    '2️⃣ Get a shareable link\n' +
    '3️⃣ Share the link with others\n' +
    '4️⃣ First-time users verify via link\n' +
    '5️⃣ Direct access after verification\n\n' +
    '*Supported Files:*\n' +
    '📄 Documents (PDF, ZIP, etc.)\n' +
    '🎥 Videos\n' +
    '🎵 Audio\n' +
    '🖼 Photos\n\n' +
    '*Admin Commands:*\n' +
    '/setadlink - Configure AdLinkFly\n' +
    '/broadcast - Send message to all users\n' +
    '/stats - View bot statistics\n' +
    '/ban - Ban a user\n' +
    '/unban - Unban a user\n' +
    '/deletefile - Delete a file\n' +
    '/settings - View all settings'
  );
  ctx.reply(helpMsg, { parse_mode: 'Markdown' });
});

// Verify Callback
bot.action(/verify_(.+)/, async (ctx) => {
  try {
    const code = ctx.match[1];
    const userId = ctx.from.id;
    
    await User.findOneAndUpdate(
      { userId },
      { 
        verified: true,
        verifiedAt: new Date(),
        firstName: ctx.from.first_name,
        username: ctx.from.username
      },
      { upsert: true, new: true }
    );
    
    await ctx.answerCbQuery('✅ Verification successful!');
    await ctx.reply(
      '✅ *Congratulations!*\n\n' +
      '🎉 You are now verified and can access all files directly.\n\n' +
      '📥 Click your original link again to download the file.',
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
  } catch (err) {
    console.error('Verify callback error:', err);
    ctx.answerCbQuery('❌ Verification failed. Please try again.');
  }
});

// Subscription Verify Callback
bot.action('verify_sub', async (ctx) => {
  if (await checkSubscription(ctx)) {
    await ctx.answerCbQuery('✅ Subscription verified!');
    await ctx.reply('✅ Great! You can now use the bot. Click your file link again.');
  } else {
    await ctx.answerCbQuery('❌ Please join all channels first!', { show_alert: true });
  }
});

// File Handler
bot.on(['document', 'video', 'audio', 'photo'], async (ctx) => {
  try {
    let fileId, fileType, fileName, fileSize, caption;

    if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      fileType = 'document';
      fileName = ctx.message.document.file_name;
      fileSize = ctx.message.document.file_size;
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
      fileType = 'video';
      fileName = ctx.message.video.file_name || 'Video';
      fileSize = ctx.message.video.file_size;
    } else if (ctx.message.audio) {
      fileId = ctx.message.audio.file_id;
      fileType = 'audio';
      fileName = ctx.message.audio.title || ctx.message.audio.file_name || 'Audio';
      fileSize = ctx.message.audio.file_size;
    } else if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = photo.file_id;
      fileType = 'photo';
      fileName = 'Photo';
      fileSize = photo.file_size;
    }

    caption = ctx.message.caption || fileName;

    // Generate unique code
    let shortCode;
    let isUnique = false;
    while (!isUnique) {
      shortCode = generateCode();
      const exists = await File.findOne({ shortCode });
      if (!exists) isUnique = true;
    }

    // Save to database
    const file = new File({
      fileId,
      fileType,
      fileName,
      fileSize,
      caption,
      shortCode,
      uploadedBy: ctx.from.id
    });
    await file.save();

    // Update user stats
    await User.findOneAndUpdate(
      { userId: ctx.from.id },
      { $inc: { filesShared: 1 } },
      { upsert: true }
    );

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
        `📝 Username: @${ctx.from.username || 'none'}\n` +
        `📄 File: ${fileName}\n` +
        `📦 Size: ${formatFileSize(fileSize)}\n` +
        `📎 Type: ${fileType}\n` +
        `🔑 Code: \`${shortCode}\`\n` +
        `🔗 Link: \`https://t.me/${config.botUsername}?start=${shortCode}\`\n` +
        `⏰ Time: ${new Date().toLocaleString()}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Log channel error:', err.message);
    }

    // Send response to user
    const shareLink = `https://t.me/${config.botUsername}?start=${shortCode}`;
    const keyboard = {
      inline_keyboard: [
        [{ text: '🔗 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(shareLink)}` }]
      ]
    };
    
    await ctx.reply(
      `✅ *File Uploaded Successfully!*\n\n` +
      `📄 *File:* ${fileName}\n` +
      `📦 *Size:* ${formatFileSize(fileSize)}\n\n` +
      `📎 *Share Link:*\n\`${shareLink}\`\n\n` +
      `🔑 *Code:* \`${shortCode}\`\n\n` +
      `💡 Share this link to let others access your file.`,
      { 
        parse_mode: 'Markdown',
        reply_markup: keyboard
      }
    );
  } catch (err) {
    console.error('File handler error:', err);
    ctx.reply('❌ Error uploading file. Please try again.');
  }
});

// ADMIN: Set AdLinkFly
bot.command('setadlink', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      '📝 *Set AdLinkFly*\n\n' +
      '*Usage:* `/setadlink <domain> <api>`\n\n' +
      '*Example:*\n`/setadlink https://upload.mycodingtools.in 150873c1be29...`',
      { parse_mode: 'Markdown' }
    );
  }

  await setSetting('adlink_domain', args[0]);
  await setSetting('adlink_api', args[1]);
  
  ctx.reply(
    '✅ *AdLinkFly Updated!*\n\n' +
    `🔗 Domain: \`${args[0]}\`\n` +
    `🔑 API: \`${args[1].substr(0, 10)}...\``,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Broadcast
bot.command('broadcast', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('❌ Owner only command.');
  
  const msg = ctx.message.text.replace('/broadcast ', '').trim();
  if (msg === '/broadcast') {
    return ctx.reply(
      '📢 *Broadcast Message*\n\n' +
      '*Usage:* `/broadcast <message>`\n\n' +
      'This will send the message to all users.',
      { parse_mode: 'Markdown' }
    );
  }

  const users = await User.find({ isBanned: false });
  let success = 0, failed = 0;
  
  const statusMsg = await ctx.reply(`📤 Broadcasting to ${users.length} users...`);
  
  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.userId, msg, { parse_mode: 'Markdown' });
      success++;
      
      if (success % 10 === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `📤 Broadcasting...\n✅ Sent: ${success}\n❌ Failed: ${failed}`
        ).catch(() => {});
      }
      
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (err) {
      failed++;
    }
  }
  
  ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMsg.message_id,
    null,
    `✅ *Broadcast Complete!*\n\n📊 Sent: ${success}\n❌ Failed: ${failed}`,
    { parse_mode: 'Markdown' }
  );
});

// ADMIN: Ban User
bot.command('ban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const userId = parseInt(ctx.message.text.split(' ')[1]);
  if (!userId) {
    return ctx.reply('*Usage:* `/ban <user_id>`', { parse_mode: 'Markdown' });
  }

  await User.findOneAndUpdate(
    { userId },
    { isBanned: true },
    { upsert: true }
  );
  
  ctx.reply(`✅ User \`${userId}\` has been banned.`, { parse_mode: 'Markdown' });
});

// ADMIN: Unban User
bot.command('unban', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const userId = parseInt(ctx.message.text.split(' ')[1]);
  if (!userId) {
    return ctx.reply('*Usage:* `/unban <user_id>`', { parse_mode: 'Markdown' });
  }

  await User.findOneAndUpdate(
    { userId },
    { isBanned: false }
  );
  
  ctx.reply(`✅ User \`${userId}\` has been unbanned.`, { parse_mode: 'Markdown' });
});

// ADMIN: Delete File
bot.command('deletefile', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const code = ctx.message.text.split(' ')[1];
  if (!code) {
    return ctx.reply('*Usage:* `/deletefile <code>`', { parse_mode: 'Markdown' });
  }

  const file = await File.findOneAndUpdate(
    { shortCode: code },
    { isActive: false }
  );
  
  if (file) {
    ctx.reply(`✅ File \`${code}\` has been deleted.`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply(`❌ File \`${code}\` not found.`, { parse_mode: 'Markdown' });
  }
});

// ADMIN: Set Start Message
bot.command('setstart', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const msg = ctx.message.text.replace('/setstart ', '').trim();
  if (msg === '/setstart') {
    return ctx.reply('*Usage:* `/setstart <message>`', { parse_mode: 'Markdown' });
  }

  await setSetting('start_msg', msg);
  ctx.reply('✅ Start message updated!');
});

// ADMIN: Set Help Message
bot.command('sethelp', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const msg = ctx.message.text.replace('/sethelp ', '').trim();
  if (msg === '/sethelp') {
    return ctx.reply('*Usage:* `/sethelp <message>`', { parse_mode: 'Markdown' });
  }

  await setSetting('help_msg', msg);
  ctx.reply('✅ Help message updated!');
});

// ADMIN: Auto Delete
bot.command('autodelete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const seconds = parseInt(ctx.message.text.split(' ')[1]);
  if (isNaN(seconds)) {
    return ctx.reply(
      '⏱ *Auto-Delete*\n\n*Usage:* `/autodelete <seconds>`\n\nExample: `/autodelete 300` (5 min)',
      { parse_mode: 'Markdown' }
    );
  }

  await setSetting('auto_delete', seconds);
  ctx.reply(`✅ Auto-delete set to ${seconds}s!`);
});

// ADMIN: Add Channel
bot.command('addchannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const username = ctx.message.text.split(' ')[1];
  if (!username || !username.startsWith('@')) {
    return ctx.reply('*Usage:* `/addchannel @channelname`', { parse_mode: 'Markdown' });
  }

  try {
    const chat = await ctx.telegram.getChat(username);
    const exists = await Channel.findOne({ channelId: chat.id.toString() });
    
    if (exists) {
      return ctx.reply('❌ Channel already added!');
    }

    await new Channel({
      channelId: chat.id.toString(),
      username,
      title: chat.title
    }).save();
    
    ctx.reply(`✅ Channel ${username} added!`, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply('❌ Error! Make sure bot is admin in the channel.');
  }
});

// ADMIN: Remove Channel
bot.command('removechannel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const username = ctx.message.text.split(' ')[1];
  if (!username) {
    return ctx.reply('*Usage:* `/removechannel @channelname`', { parse_mode: 'Markdown' });
  }

  await Channel.deleteOne({ username });
  ctx.reply(`✅ Channel ${username} removed!`);
});

// ADMIN: List Channels
bot.command('listchannels', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const channels = await Channel.find();
  if (channels.length === 0) {
    return ctx.reply('📺 No channels added yet.');
  }

  const list = channels.map((ch, i) => 
    `${i + 1}. ${ch.username} - ${ch.title}`
  ).join('\n');
  
  ctx.reply(`📺 *Force Subscription Channels:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// ADMIN: Content Protection
bot.command('protect', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const arg = ctx.message.text.split(' ')[1];
  if (arg === 'on') {
    await setSetting('protect_content', true);
    ctx.reply('🛡 Content protection enabled!');
  } else if (arg === 'off') {
    await setSetting('protect_content', false);
    ctx.reply('🛡 Content protection disabled!');
  } else {
    ctx.reply('*Usage:* `/protect <on/off>`', { parse_mode: 'Markdown' });
  }
});

// ADMIN: Settings
bot.command('settings', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const domain = await getSetting('adlink_domain', 'Not set');
  const api = await getSetting('adlink_api', 'Not set');
  const autoDelete = await getSetting('auto_delete', 0);
  const protect = await getSetting('protect_content', false);
  const channels = await Channel.countDocuments();
  
  const settings = 
    `⚙️ *Bot Settings*\n\n` +
    `🔗 AdLinkFly Domain: ${domain}\n` +
    `🔑 API: ${api !== 'Not set' ? api.substr(0, 15) + '...' : 'Not set'}\n` +
    `⏱ Auto-Delete: ${autoDelete}s\n` +
    `🛡 Protection: ${protect ? 'ON' : 'OFF'}\n` +
    `📺 Channels: ${channels}`;
  
  ctx.reply(settings, { parse_mode: 'Markdown' });
});

// ADMIN: Statistics
bot.command('stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Admin only command.');
  
  const totalUsers = await User.countDocuments();
  const verifiedUsers = await User.countDocuments({ isVerified: true });
  const bannedUsers = await User.countDocuments({ isBanned: true });
  const totalFiles = await File.countDocuments({ isActive: true });
  const totalDownloads = await File.aggregate([
    { $group: { _id: null, total: { $sum: '$downloads' } } }
  ]);
  
  const stats = 
    `📊 *Bot Statistics*\n\n` +
    `👥 *Users:*\n` +
    `   Total: ${totalUsers}\n` +
    `   Verified: ${verifiedUsers}\n` +
    `   Banned: ${bannedUsers}\n\n` +
    `📁 *Files:*\n` +
    `   Total: ${totalFiles}\n` +
    `   Downloads: ${totalDownloads[0]?.total || 0}\n\n` +
    `📺 *Channels:* ${await Channel.countDocuments()}`;
  
  ctx.reply(stats, { parse_mode: 'Markdown' });
});

// Error Handler
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
});

// Connect to MongoDB and Start Bot
mongoose.connect(config.mongodb)
  .then(() => {
    console.log('✅ MongoDB Connected');
    
    // Initialize default settings
    (async () => {
      await setSetting('start_msg', await getSetting('start_msg', 
        '👋 *Welcome to File Store Bot!*\n\n' +
        '📤 Send me any file and I\'ll give you a shareable link.\n\n' +
        '💡 Share links with others to distribute your files easily!'
      ));
      
      await setSetting('help_msg', await getSetting('help_msg',
        '📚 *Help Menu*\n\n' +
        '1️⃣ Send file to bot\n' +
        '2️⃣ Get shareable link\n' +
        '3️⃣ Share with others\n' +
        '4️⃣ First-time users verify\n' +
        '5️⃣ Direct access after'
      ));
    })();
    
    bot.launch();
    console.log('✅ Bot Started Successfully!');
    console.log(`📱 Bot: @${config.botUsername}`);
    
    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  })
  .catch(err => {
    console.error('❌ MongoDB Connection Failed:', err);
    process.exit(1);
  });
