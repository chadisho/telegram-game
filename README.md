# Mench: Telegram Mini App

A single-file game (`index.html`). No build step, no server code. It runs as a Telegram Mini App and also works in any normal browser.

## What is inside

- Mensch ärgere Dich nicht for 2 to 4 players, with human and computer seats
- Persian and English, switchable in the app (Persian is chosen automatically for Telegram users whose language is Persian; the board stays left-to-right)
- Telegram integration: full-height view, header color, haptic feedback, a native "Roll the dice" bottom button, swipe-down-to-close disabled while playing
- The game is saved on the device after every turn and resumes when the app is reopened
- Optional "Invite a friend" button (see step 4)

## 1. Host the file over HTTPS

This repository is already set up for **GitHub Pages**. The game is live at `https://chadisho.github.io/telegram-game/` (use this address in step 2). Any change pushed to `main` goes live within a minute or two.

Other options, if you ever move it:

Telegram only opens Mini Apps from an `https://` address with a valid certificate. Any static host works:

- **Cloudflare Pages**: create a project, upload the folder, done. You get `https://yourname.pages.dev`.
- **GitHub Pages**: put `index.html` in a repository, turn on Pages in the repository settings.
- **Netlify**: drag the folder onto app.netlify.com/drop.
- **Your own server**: copy `index.html` to the web root of nginx or Caddy with a Let's Encrypt certificate.

Open the address in a normal browser first and check that the game loads.

## 2. Register it with @BotFather

1. In Telegram, open **@BotFather**.
2. If you do not have a bot yet, send `/newbot` and follow the questions.
3. Send `/newapp` and choose your bot.
4. Answer the questions: title (for example `Mench`), short description, a 640x360 picture, an optional demo GIF (send `/empty` to skip), then the **HTTPS address from step 1**, then a short name (for example `mench`).
5. BotFather replies with the direct link, for example `https://t.me/YourBot/mench`. Share this link anywhere; it opens the game.

Optional: to also open the game from the bot's menu button, send `/setmenubutton`, pick the bot, and give the same HTTPS address and a button label.

## 3. Test it

Open the direct link on your phone and check:

- the game fills the screen and the board is square
- the yellow "ROLL THE DICE" bottom button appears on your turn
- close the app in the middle of a game and reopen it: the game should continue
- tap the language button and check the Persian text

## 4. Invite button

The "Invite a friend" button is already set to `https://t.me/See_Earth_bot/Mench`. To change it, edit the `SHARE_URL` line near the top of the script in `index.html`.

## Notes

- **Fonts.** The page loads fonts from Google Fonts. If those are blocked for some of your players, the game still works and falls back to the phone's own fonts. To make the look identical everywhere, download the Fredoka, Nunito and Vazirmatn font files, put them next to `index.html`, and replace the Google Fonts `<link>` with `@font-face` rules.
- **Players take turns on one phone.** Seats set to "Player" share the same device. There is no online multiplayer; it would need a server to relay moves.
- **No tracking.** The page stores only the saved game and the chosen language on the device (`localStorage`), and shows the Telegram first name on the first human player's card.
