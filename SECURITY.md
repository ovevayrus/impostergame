# Security

Please report security problems privately. Do not put credentials, chat data, or details that expose a player's role or vote in a public issue.

## Reporting a problem

Use GitHub's private vulnerability reporting for this repository when it is available. Otherwise, contact the repository owner privately before opening an issue.

Include the affected commit, a short description of the impact, and enough steps to reproduce the problem. Remove real tokens, user IDs, names, and chat contents from screenshots and logs.

## Credentials and game data

Treat these values as secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Keep them in a local `.env` file or in your deployment provider's environment variables. Do not commit them. Only point `TELEGRAM_API_BASE_URL` at Telegram or a Bot API server you trust.

The persistent store contains Telegram user IDs and display names, current roles and words, and private ballots. Do not publish `.data/state.json`, Redis exports, or logs containing that data.

If a credential is exposed, revoke or rotate it first. Deleting it from the latest commit is not enough because older commits may still contain it.

Security fixes target the current default branch.
