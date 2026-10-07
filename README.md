# flipradar

Telegram alerts for new Vinted UK listings, with how each price compares to similar listings.
Private beta. Design: `docs/superpowers/specs/2026-10-07-flipradar-beta-design.md`.

## Setup

1. Create a bot: message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Find your Telegram user ID: message [@userinfobot](https://t.me/userinfobot).
3. Configure:
   ```bash
   cp .env.example .env
   # set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID
   ```
4. Install and check:
   ```bash
   npm install
   npm test
   npm run probe     # live check that Vinted pages still parse
   ```

## Run

```bash
npm start          # foreground
npm run start:mac  # same, but keeps the Mac from idle-sleeping (caffeinate)
```

Message your bot `/start`. You become the admin automatically.

### Inviting testers

- `/invite 3` creates three one-time invite links. Send one to each tester.
- Anyone who messages the bot without an invite joins the waitlist; see it with `/waitlist`.
- `/stats` and `/health` show how the engine is doing.

### Keep it running on a Mac

The Mac must stay plugged in; closing the lid still sleeps it. To start at login and restart after crashes, save this as `~/Library/LaunchAgents/com.flipradar.bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.flipradar.bot</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>cd ~/flipradar &amp;&amp; npm run start:mac</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/flipradar.log</string>
  <key>StandardErrorPath</key><string>/tmp/flipradar.err.log</string>
</dict>
</plist>
```

Then: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.flipradar.bot.plist`
(stop with `launchctl bootout gui/$(id -u)/com.flipradar.bot`).

## Moving to a server

```bash
docker compose up -d --build
```

The database lives on the `flipradar-data` volume; `.env` is passed in by compose.

Before paying for a server, check whether Vinted serves data-centre IPs: GitHub → Actions →
"Vinted probe (data-centre IP)" → Run workflow. A green run means a cloud server should work.

## Privacy

Stored: testers' Telegram IDs, usernames and searches; anonymous listing prices. Never stored:
Vinted seller usernames or IDs. `/deleteme` erases a tester's data.
