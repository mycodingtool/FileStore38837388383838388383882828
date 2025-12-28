# Telegram File Store Bot

A powerful Telegram bot for file storage and sharing with AdLinkFly integration.

## Features
- Auto-generate shareable links
- AdLinkFly verification system
- One-time user verification
- Multiple admin support
- Force subscription channels
- Auto-delete messages
- Content protection
- Activity logging

## Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/telegram-filestore-bot.git
cd telegram-filestore-bot
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables (copy from .env.example):
```bash
cp .env.example .env
```

4. Edit `.env` with your credentials

5. Run the bot:
```bash
npm start
```

## Environment Variables

- `BOT_TOKEN` - Get from @BotFather
- `BOT_USERNAME` - Your bot username (without @)
- `ADLINKFLY_DOMAIN` - Your AdLinkFly domain
- `ADLINKFLY_API` - Your AdLinkFly API key
- `LOG_CHANNEL` - Channel ID for logging (e.g., -1001234567890)
- `ADMIN_IDS` - Comma-separated admin user IDs

## Admin Commands

- `/setadlink <domain> <api>` - Configure AdLinkFly
- `/setstart <text>` - Set custom start message
- `/sethelp <text>` - Set custom help message
- `/autodelete <seconds>` - Set auto-delete timer
- `/addchannel @username` - Add force subscription channel
- `/removechannel @username` - Remove channel
- `/listchannels` - List all channels
- `/protect <on/off>` - Enable/disable content protection
- `/settings` - View current settings
- `/stats` - View bot statistics

## Deployment on Render

1. Push code to GitHub
2. Connect repository to Render
3. Add environment variables
4. Enable persistent disk for database storage
5. Deploy

## License
MIT
