# pain-prompt

A small Discord bot for coming back from an injury. It asks for a 0–10 pain
score at the right moments and saves each answer as a note in Intervals.icu.
After each run it also asks for RPE and feel, and saves them in the run's own
fields.

| When | Question | Where the answer goes |
|---|---|---|
| 07:10 every day | Pain this morning? | Note on the latest run from yesterday or today. On a rest day, a calendar note called "Pain check" |
| As soon as a new run appears in Intervals.icu | Pain during the run? | Note on that run |
| Same time, as a separate message | RPE (1–10) and feel (Strong … Weak)? | The run's **Perceived exertion** and **Feel** fields |
| 4 h after the run ended (configurable) | Pain right now? | Note on that run |

You answer with one tap: green buttons for 0–2, blue for 3–4, red for 5+.
After answering, an **Add comment** button lets you write a sentence, which is
saved the same way. A prompt you haven't answered gets one reminder after
45 min. After 20 h its buttons are removed, and a new morning prompt replaces
the previous one.

RPE and feel are saved as soon as you tap each one. If your watch's
self-evaluation already filled in a field (Garmin writes it into the FIT file
when you save the run), the bot doesn't ask for it, and if both are filled in
there's no message at all. Enter self-evaluation on the watch, not later in
Garmin Connect: edits made in Garmin Connect don't reach Intervals.icu.

Notes always use the same format, so you can read them easily and a script
(or Claude) can parse them:

```
[pain] morning=1/10
[pain] during=0/10
[pain] after=2/10
[pain] morning comment: stiff on the stairs, fine after 5 min
[effort] comment: legs heavy from yesterday
```

## Setup

### 1. Discord bot

1. Go to https://discord.com/developers/applications → **New Application** → **Bot**.
   Copy the token. No privileged intents are needed.
2. **OAuth2 → URL Generator**: select the scope `bot` and the permissions
   *View Channel*, *Send Messages* and *Read Message History*. Open the URL
   and add the bot to your server.
3. In Discord, turn on **Settings → Advanced → Developer Mode**. Then
   right-click the channel and choose *Copy Channel ID*, and right-click
   yourself and choose *Copy User ID*.

Every prompt @-mentions you, so you get a push notification on your phone
even if the channel is muted for normal messages.

### 2. Install on the server (Linux, Node 22+)

```bash
git clone <this repo> ~/pain-prompt   # or rsync the folder over
cd ~/pain-prompt
npm ci
npm run build
cp .env.example .env && chmod 600 .env   # fill it in
npm run check                            # validates config + reads your recent runs
```

There are no native dependencies, and all times use `PAIN_TZ`, so the
server's own timezone doesn't matter.

### 3. Run it as a service

```bash
mkdir -p ~/.config/systemd/user
cp deploy/pain-prompt.service ~/.config/systemd/user/
# Edit ExecStart if `command -v node` isn't /usr/bin/node
systemctl --user daemon-reload
systemctl --user enable --now pain-prompt
sudo loginctl enable-linger "$USER"      # keep running after you log out / across reboots
journalctl --user -u pain-prompt -f      # logs
```

To send a morning prompt immediately (useful for testing):

```bash
systemctl --user kill -s USR1 pain-prompt
```

## Behaviour notes

- **First start:** runs that already exist are recorded without prompting,
  so you won't get a burst of questions about old runs.
- **Late uploads:** a run that ended more than `PAIN_MAX_RUN_AGE_HOURS` ago
  when it first appears is not prompted.
- **Failures:** if Intervals.icu is down when you tap a score, nothing is
  marked as saved and the buttons stay, so you can tap again. If Discord is
  down when a prompt is due, it's retried every minute.
- **State:** stored in `data/state.json`. Writes are atomic, and old entries
  are pruned after 14 days.
- **Strava:** Intervals.icu doesn't let the API edit activities imported from
  Strava, so RPE and feel can only be saved on runs that come in directly
  (e.g. from Garmin). Turn the effort prompt off with `PAIN_PROMPT_EFFORT=false`.
- **Activity types:** only Intervals.icu types in `PAIN_ACTIVITY_TYPES`
  count (default `Run,TrailRun,VirtualRun`).

## Development

```bash
npm test          # vitest; Discord and Intervals.icu are faked
npm run typecheck
npm run dev       # run from source with tsx
```

Layout: `src/service.ts` decides when to ask and where answers go.
`src/discord/discordjs.ts` is the only file that uses discord.js.
`src/intervals.ts` is the REST client.
