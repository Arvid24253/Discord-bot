# Discord Swap Bot

Boilerplate Node.js Discord bot with two slash commands:

- `/setswap nummer:<text>` — saves a per-user value (in memory)
- `/swap` — shows the saved value back to the user

## Setup

1. Set the following in Replit Secrets:
   - `TOKEN` — your Discord bot token
   - `CLIENT_ID` — the application (client) ID of your bot
   - `GUILD_ID` *(optional)* — register commands instantly in one server (recommended for development)
2. Install deps: `cd bot && npm install`
3. Register slash commands once: `npm run register`
4. Run the bot: `npm start`

The "Discord Bot" workflow runs `npm start` automatically.

## Notes

Storage is an in-memory `Map` and resets on restart. Swap it for a database
(e.g. Replit DB or Postgres) if you need persistence.
