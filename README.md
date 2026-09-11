# Telegram Impostor Bot

A Telegram bot for playing Impostor in a group chat. Everyone gets the same secret word except the Impostor, who gets a related hint.

Roles appear privately inside the group through Telegram's ephemeral messages, so players do not need to message the bot first. If a role message does not arrive, **Reveal my role** shows it again.

## What it does

- `/newgame` opens a lobby. Players join, leave, and start the round with buttons.
- Roles and open ballots stay private. Group admins can let the bot send roles automatically; everyone can also use **Reveal my role**.
- Tied votes lead to one more clue from each tied player and another ballot.
- Players can start another round with the same group or reopen the lobby.
- Games survive restarts in a local JSON file or Upstash Redis on Vercel.
- The repo includes a sample bank of 175 words and hints. You can replace it with your own.

## Set up the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`, follow the prompts, and copy the token.
3. Add the new bot to your group.
4. Optional: make the bot a group administrator so it can send roles automatically. Without admin access, players can use **Reveal my role** instead.

Keep BotFather's default **Privacy Mode** enabled. Commands and inline-button taps still work, and the bot does not need to read the group's normal conversation.

## Run locally

Requirements: Node.js 22.9 or newer. The project has no third-party packages, so there is no install step.

```powershell
Copy-Item .env.example .env
notepad .env
npm.cmd start
```

Replace the placeholder in `.env` with the real token before starting. When the terminal says the bot is running, send `/newgame` in the Telegram group.

Only one running process should use a bot token at a time. This app uses long polling and automatically removes an old webhook without discarding pending updates.

## Deploy on Vercel

On Vercel, Telegram sends updates to `/api/telegram`. Upstash Redis stores game state because Vercel Functions cannot keep a polling loop or local state alive.

1. Import this repository into Vercel. If it is already connected, pull the latest version and redeploy.
2. Add an Upstash Redis integration from the [Vercel Marketplace](https://vercel.com/marketplace) and connect it to the project. Vercel adds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` for you.
3. In **Project settings**, open **Environment Variables** and add:
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather.
   - `TELEGRAM_WEBHOOK_SECRET`: a long random value containing only letters, numbers, underscores, or hyphens. Keep a copy for the registration step.
   - Any optional game settings you want from the configuration table below.
4. Redeploy production after adding the integration and variables.
5. Copy `.env.example` to `.env` on your computer. Add the same bot token and webhook secret, followed by the production endpoint:

   ```dotenv
   TELEGRAM_WEBHOOK_URL=https://your-project.vercel.app/api/telegram
   ```

6. Register that endpoint with Telegram:

   ```powershell
   npm.cmd run webhook:set
   ```

This also updates the bot's command menu and reports Telegram's pending update count or latest delivery error. Open `https://your-project.vercel.app/api/telegram` to check the JSON health response.

Do not run `npm.cmd start` with the production token while Vercel is using it. Local startup removes the webhook and switches Telegram back to long polling. Do not register preview deployments with the production token either.

Webhook requests may run for up to 120 seconds. Telegram uses one connection and Redis processes updates one at a time, which keeps concurrent Function instances from overwriting game state.

## Run with Docker

```powershell
docker build -t telegram-impostor .
docker run -d --name telegram-impostor --restart unless-stopped --env-file .env -v impostor-data:/app/.data telegram-impostor
```

The named volume preserves active games across container replacements. The process must stay online for Telegram to deliver commands and button taps.

## Commands

| Command | Purpose |
| --- | --- |
| `/newgame` | Open a lobby and join it |
| `/status` | Repost a fresh, working copy of the current game panel |
| `/rules` | Explain how to play |
| `/endgame` | Skip voting and reveal the word and Impostor for an active round |
| `/cancelgame` | Cancel a lobby you created; group admins can reset any stuck game |
| `/help` | Show bot help |

## Game flow

1. Send `/newgame`, then have everyone tap **Join**.
2. Once at least three players have joined, tap **Start game**. The person who starts is joined automatically.
3. Check your private role and give a related clue when your name comes up.
4. Talk it over, then tap **Start voting**. Votes stay hidden while the ballot is open.
5. Voting ends when everyone has voted, or a player can close it early with **Finish voting**.
6. If the vote is tied, each tied player gives one new public clue before the tie-break ballot. Another tie repeats the process.
7. The result shows the tally, secret word, hint, and Impostor.
8. Start another round with the same players or reopen the lobby.

**Reveal answer** and `/endgame` remain available before voting starts as a fallback for ending a round without a ballot.

## Configuration

All settings are environment variables. Defaults are shown in `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | Secret token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Vercel only | Random secret Telegram sends with every webhook request |
| `TELEGRAM_WEBHOOK_URL` | setup command only | Production URL ending in `/api/telegram` |
| `UPSTASH_REDIS_REST_URL` | Vercel only | Upstash REST endpoint, normally injected by the integration |
| `UPSTASH_REDIS_REST_TOKEN` | Vercel only | Upstash REST token, normally injected by the integration |
| `IMPOSTOR_REDIS_PREFIX` | `impostor:<VERCEL_ENV>` | Optional namespace for Redis keys |
| `MIN_PLAYERS` | `3` | Players required to start |
| `MAX_PLAYERS` | `12` | Maximum lobby size |
| `DATA_FILE` | `.data/state.json` | Persistent state location for local/Docker mode only |
| `WORDS_FILE` | bundled file | Optional custom JSON word bank |
| `AUTO_SEND_ROLES_IF_ADMIN` | `true` | Push roles at round start when the bot is an admin |
| `POLL_TIMEOUT_SECONDS` | `25` | Telegram long-poll duration |
| `TELEGRAM_API_BASE_URL` | official API | Override only for testing/local Bot API servers |

### Custom words and hints

Set `WORDS_FILE` to a JSON file containing at least three unique entries:

```json
[
  {
    "word": "Telescope",
    "hint": "Galileo",
    "category": "Object"
  },
  {
    "word": "Pizza",
    "hint": "Cardboard",
    "category": "Food"
  },
  {
    "word": "Penguin",
    "hint": "Toboggan",
    "category": "Animal"
  }
]
```

Hints must be one word, use letters only, and be no longer than 60 characters. Pick something useful without making the answer obvious. A hint cannot contain the answer or part of it; for example, `Island` cannot use `land`. The bot checks custom files on startup and avoids repeats during rematches while unused entries remain.

## Privacy

Telegram bots normally cannot start a private chat with a group member, so this bot keeps the game in the group.

Telegram Bot API 10.2 added ephemeral group messages in July 2026. An admin bot can send one to any non-bot member. A non-admin bot can send one for up to 15 seconds after that person taps a button. Delivery is not guaranteed, especially while someone is offline, so **Reveal my role** also shows the role in a private popup.

Button data contains only a game ID, revision, action, and candidate index. Words, hints, roles, and open ballots stay on the server. The public panel shows how many people have voted, but not their choices. The tally appears after voting closes.

The persistent store contains Telegram user IDs and display names, role assignments, words, and ballots. Keep `.data/state.json` and the Redis database private. Git ignores `.data/` and `.env`; see [SECURITY.md](SECURITY.md) for reporting and credential guidance.

The Bot API does not provide a general list of every group member, so players must opt in by pressing **Join**. One active lobby or game is supported per group.

Official references: [Telegram ephemeral messages](https://core.telegram.org/bots/api#ephemeral-messages-and-commands), [Bot API `sendMessage`](https://core.telegram.org/bots/api#sendmessage), and [callback query answers](https://core.telegram.org/bots/api#answercallbackquery).

## Tests

```powershell
npm.cmd test
```

The tests check the game rules, private roles and votes, storage, and webhook handling.

Webhook deployment references: [Vercel Functions](https://vercel.com/docs/functions), [Vercel Redis integrations](https://vercel.com/docs/redis), [Upstash's Vercel integration](https://upstash.com/docs/redis/howto/vercelintegration), and [Telegram `setWebhook`](https://core.telegram.org/bots/api#setwebhook).
