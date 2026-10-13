# MindRush — real-time multiplayer trivia

MindRush is a responsive room-code party game built with Node.js, Express, and Socket.IO. The server is authoritative for rooms, round timers, answer validation, and scoring.

## Features
- 2–8 players, no accounts or installation
- Host-created room codes and shareable invite links
- Eight timed trivia rounds with speed bonuses
- Server-side scoring and duplicate-answer protection
- Shared lobby, round status, result reveal, and final leaderboard
- Mobile-responsive layout and reconnect-friendly Socket.IO client

## Run locally
Requires Node.js 18+.

```bash
npm install
npm start
```

Open http://localhost:3000. To test locally, open two separate browser profiles or devices on the same network. To access from another device on the same network, use the host computer's LAN IP and port 3000.

## Deploy publicly
A simple option is Render:
1. Push this folder to a GitHub repository.
2. In Render, create a **Web Service** connected to the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy, then open the generated HTTPS URL on two separate devices.
6. Verify room creation, joining, synchronized questions, answers, round transitions, and replay.

Socket.IO uses WebSocket where available and can fall back to long polling. Keep this as a single service instance unless you configure a shared adapter and sticky sessions. In-memory rooms reset when the server restarts or redeploys; this is fine for ephemeral party rooms but not for persistent records.

## Known MVP limitations
- Trivia is the only game mode in this first playable version.
- A browser refresh creates a new Socket.IO identity; users can rejoin from the lobby while the room remains in the lobby, but in-progress reconnect recovery is not yet implemented.
- Room state is in memory and is lost on server restart.
- The question set is bundled in `server.js`; replace/add questions there.
- Test the live deployment with real devices before submitting. Do not describe the game as deployed until the public URL has been verified.
