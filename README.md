# Mench: Telegram Mini App

Mensch ärgere Dich nicht (Mench) for 2 to 4 players, as a Telegram Mini App.

- `index.html` is the whole game (works alone for play on one phone, or with the server for online play)
- `server/` is the online game server (Node.js). It also serves `index.html`, so one domain is enough.

## What the game does

- Play on one phone against the computer or friends, or **online with friends** through a room link
- Persian and English (chosen from the Telegram language, switchable in the app)
- Telegram features: full-height view, haptic feedback, a native "Roll the dice" bottom button, invite button
- Local games are saved after every turn and resume when the app is reopened

## How online play works

1. A player taps **Play online** and then **Create a room**. They get a 5-letter room code.
2. They tap **Invite friends**. Telegram's share screen opens with a link like `https://t.me/See_Earth_bot/Mench?startapp=K7QWZ`.
3. Friends tap the link, the Mini App opens and they are put straight into the room.
4. The host can add computer players to empty seats, then taps **Start game**.

The server rolls the dice and checks every move, so nobody can cheat. If a player closes the app, they can come back and continue. A player who disconnects, or does not move for 40 seconds, is played for by the computer for that turn. A player who leaves in the middle of a game is replaced by a computer.

## Put the game server on your VPS (Ubuntu)

You need a domain or subdomain (for example `game.example.com`) with an **A record** pointing to the VPS address. Telegram only opens Mini Apps over HTTPS.

**1. Install the tools**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx
```

**2. Get the game and install it**

```bash
sudo git clone https://github.com/chadisho/telegram-game /opt/mench
cd /opt/mench/server
sudo npm install --omit=dev
sudo chown -R www-data:www-data /opt/mench
```

**3. Run it as a service**

Create `/etc/systemd/system/mench.service`:

```ini
[Unit]
Description=Mench game server
After=network.target

[Service]
WorkingDirectory=/opt/mench/server
ExecStart=/usr/bin/node server.js
Environment=PORT=8080
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mench
curl http://127.0.0.1:8080/health      # should print {"ok":true,"rooms":0}
```

**4. Put HTTPS in front of it**

Create `/etc/nginx/sites-available/mench` (use your own domain):

```nginx
server {
    listen 80;
    server_name game.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/mench /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d game.example.com
```

Open `https://game.example.com/` in a browser. The game should load, and **Play online** should work.

**5. Point the Mini App at it**

In @BotFather send `/myapps`, choose your bot and the app, and use **Edit Web App URL** to set `https://game.example.com/`. The game and the server are then on the same address, so nothing else needs changing.

## Updating later

```bash
cd /opt/mench && sudo git pull && sudo systemctl restart mench
```

Rooms live in the server's memory, so a restart ends games that are in progress. Do updates when few people are playing.

## Using GitHub Pages for the page instead (optional)

You can keep the page on GitHub Pages and use the VPS only as the game server. Open `index.html` and set the server address near the top of the script:

```js
const SERVER_URL='wss://game.example.com';
```

Without `SERVER_URL` the Pages version has no **Play online** button (it still plays on one phone). Serving everything from the VPS, as above, is simpler.

## Settings

| Where | Setting | Meaning |
|---|---|---|
| `index.html` | `SHARE_URL` | Your Mini App link. Used for invite links. |
| `index.html` | `SERVER_URL` | Game server address. Leave empty when the VPS serves the page. |
| server environment | `PORT` | Port to listen on (default 8080) |
| server environment | `MENCH_TURN_MS` | Time before an idle player is played for (default 40000) |
| server environment | `MENCH_MAX_ROOMS` | Most rooms at once (default 500) |

## Notes

- **Fonts.** The page loads fonts from Google Fonts. If Google is blocked for some players, the game falls back to the phone's own fonts and still works.
- **Names are not verified.** The name shown to friends comes from Telegram but the server does not check Telegram's signature. That is fine for a casual game. Seats are tied to a random token kept on the player's phone, not to the name.
- **No database.** Nothing is stored on the server except open rooms, and they are deleted 15 minutes after the last player leaves.
