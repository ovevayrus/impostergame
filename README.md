# Telegram Impostor Bot

A ready-to-run Telegram group bot for the Impostor word game. Most players receive the same secret word; one randomly selected Impostor receives only a related hint.

The bot uses Telegram's **ephemeral group messages**, so a role can appear inside the group while remaining visible only to its intended player and the bot. Players do not need to open a private chat.

## What it does

- Any group member can open a lobby with `/newgame`.
- Players join or leave using inline buttons; the creator is joined automatically.
- Any member who presses **Start game** is automatically joined, then the bot securely randomizes the word, Impostor, and clue order.
- If the bot is a group admin, it automatically tries to send each role as a rate-limited, user-only group message.
- With or without admin access, every player can press **Reveal my role**. The bot sends a user-only group message and also shows a private popup fallback.
- After the clues and discussion, the group starts a private in-game poll. Each player votes for who they think is the Impostor.
- If two or more players tie for the most votes, those tied players each give one new clue word before a tie-break ballot.
- When voting ends, the bot announces whether the Impostor was caught and posts the final tally, word, hint, actual Impostor, and category.
- A player can then tap **Start new round** to play again with the same joined-player roster, or reopen the lobby; the result message remains in the chat history.
- Active games survive restarts in a local JSON file or, on Vercel, Upstash Redis.
- The included word bank has 175 curated English word/hint pairs with distinct, deliberately indirect one-word clues, and can be replaced.

## Set up the Telegram bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`, follow the prompts, and copy the token.
3. Add the new bot to your group.
4. Optional but recommended: make the bot a group administrator. This lets it begin pushing user-only roles when a round starts. Deliveries are deliberately spaced to respect Telegram's group rate limits. No admin access is needed for the tap-to-reveal flow.

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

Vercel runs this bot as a Telegram webhook at `/api/telegram`. Because a Vercel Function cannot keep a polling loop alive or persist changes to its local filesystem, the deployment uses Upstash Redis for game state and a short-lived update lock.

1. Import this GitHub repository into Vercel, or redeploy the existing Vercel project after pulling this version.
2. In the [Vercel Marketplace](https://vercel.com/marketplace), add an Upstash Redis integration and connect the database to this project. It should inject `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` into the project.
3. In **Project settings**, open **Environment Variables** and add:
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather.
   - `TELEGRAM_WEBHOOK_SECRET`: a long random value containing only letters, numbers, underscores, or hyphens. Keep a copy for the registration step.
   - Any optional game settings you want from the configuration table below.
4. Redeploy the production deployment so the integration and environment variables are included.
5. Copy `.env.example` to `.env` on your computer. Put the same bot token and webhook secret in it, then add the stable production endpoint:

   ```dotenv
   TELEGRAM_WEBHOOK_URL=https://your-project.vercel.app/api/telegram
   ```

6. Register that endpoint with Telegram:

   ```powershell
   npm.cmd run webhook:set
   ```

The command also installs the bot's command menu and reports Telegram's pending update count or latest delivery error. Opening `https://your-project.vercel.app/api/telegram` in a browser should return a small JSON health response.

Do not run `npm.cmd start` with the same token while using Vercel. The local process deliberately removes the webhook so it can switch Telegram back to long polling. Preview deployments also should not register the production bot token; use the stable production URL.

Vercel is configured to allow up to 120 seconds for a webhook request. Telegram is registered with one connection, and Redis serializes deliveries, so lobby changes and role delivery cannot overwrite each other when Vercel creates multiple Function instances.

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

1. Someone sends `/newgame`.
2. Everyone who wants to play taps **Join**.
3. Anyone taps **Start game** once at least three players are present.
4. Each player reads the private role delivered inside the group, or taps **Reveal my role** to retrieve it again.
5. Players give one related word or short phrase in the order displayed by the bot.
6. The group discusses and guesses the Impostor. The Impostor tries to identify the secret word.
7. A player taps **Start voting**. Every player privately selects one name, and the public panel shows only how many votes have been cast while the ballot is open.
8. Voting closes automatically when every joined player has voted. A player can tap **Finish voting** to close a partial ballot early. If the top vote is tied, each tied player gives one fresh clue word aloud in the displayed order. This is a new public clue, not the player's private assigned word or hint.
9. After those extra clues, tap **Start tie-break vote** and vote among the tied players. Further ties repeat the extra-clue and tie-break process.
10. When a ballot has one winner, the bot says whether the group caught the Impostor, shows who the group selected and the final tally, then reveals the word, hint, actual Impostor, and category.
11. Tap **Start new round** to post a new-round panel and privately distribute a fresh set of roles to the same roster.

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

Every hint must be exactly one word containing letters only, with a maximum of 60 characters. It should be broad enough to help the Impostor without giving away the answer. The bundled hints favor secondary associations, cultural references, and less-obvious facts instead of definitions. They cannot reuse the answer or a meaningful part of it: for example, `Island` cannot use `land` as its hint. The bot validates custom files on startup and avoids recently used words during rematches while unused entries remain.

## Privacy and Telegram constraints

Telegram bots cannot normally initiate an ordinary private chat with a group member. This bot therefore does not rely on direct messages.

Telegram Bot API 10.2 introduced ephemeral group messages in July 2026. A group-admin bot can send one to any non-bot member; a non-admin bot can send one for up to 15 seconds after that user taps a callback button. Telegram notes that delivery is not guaranteed, especially while a user is offline, and ephemeral messages may disappear after some time or an app restart. **Reveal my role** is therefore always available and its private popup repeats the role as a fallback.

Only the game ID, revision, action, and a candidate index are placed in button callback data. Words, hints, player roles, and in-progress ballot choices remain server-side. The public voting panel shows participation progress but not who voted for whom; the tally appears only when voting is finished. Private role messages use content protection, while the public game panel never contains an active round's secret. The persistent state does contain the current word and ballot choices and should be kept private; `.data/` and `.env` are excluded from Git.

The Bot API does not provide a general list of every group member, so players must opt in by pressing **Join**. One active lobby or game is supported per group.

Official references: [Telegram ephemeral messages](https://core.telegram.org/bots/api#ephemeral-messages-and-commands), [Bot API `sendMessage`](https://core.telegram.org/bots/api#sendmessage), and [callback query answers](https://core.telegram.org/bots/api#answercallbackquery).

## Tests

```powershell
npm.cmd test
```

The tests cover assignment secrecy, exactly one Impostor, lobby rules, private voting and tie-breaks, rematches, callback validation, private recipient targeting, public-message leakage, automatic admin delivery, and persistent state.

Webhook deployment references: [Vercel Functions](https://vercel.com/docs/functions), [Vercel Redis integrations](https://vercel.com/docs/redis), [Upstash's Vercel integration](https://upstash.com/docs/redis/howto/vercelintegration), and [Telegram `setWebhook`](https://core.telegram.org/bots/api#setwebhook).
