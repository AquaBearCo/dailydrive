# Daily Drive on Unraid

This container stores all user data in `/config`, which should map to your Unraid appdata path.

## Install

Use the included template at:

```text
https://raw.githubusercontent.com/AquaBearCo/dailydrive/main/unraid/dailydrive.xml
```

Or create a Docker container manually:

```text
Repository: ghcr.io/aquabearco/dailydrive:latest
Network: bridge
Appdata path: /mnt/user/appdata/dailydrive -> /config
Show UI port: 8911 -> 8911
Setup port: 8890 -> 8888
TZ: your timezone, for example America/Denver
SCHEDULE: comma-separated 24-hour times, for example 04:00,16:00
RUN_ON_START: false
ENABLE_WEB_UI: true
APPLY_PODCAST_SLOTS: true
SPOTIFY_SETUP_BIND_HOST: 0.0.0.0
```

The GitHub Actions workflow publishes the image to GitHub Container Registry after changes land on `main`. If the package is not visible yet, run the `Publish Docker image` workflow once from GitHub Actions.

## Configure

Start the container once. It creates this file:

```text
/mnt/user/appdata/dailydrive/config.yaml
```

Edit it with your Spotify client ID, client secret, playlist ID, initial podcasts, music settings, and schedule.

For first-time Spotify setup, your Spotify app redirect URI must match the URI in `config.yaml`. The default is:

```text
http://127.0.0.1:8888/callback
```

If you run setup from a different computer than the Unraid host, use an SSH tunnel so `127.0.0.1:8888` on your computer forwards to Unraid port `8890`:

```bash
ssh -L 8888:127.0.0.1:8890 root@YOUR_UNRAID_IP
```

## One-Time Spotify Login

Open the Unraid container console and run:

```bash
/app/docker-entrypoint.sh setup
```

Copy the printed Spotify authorization URL into your browser. After Spotify redirects back successfully, the container saves:

```text
/mnt/user/appdata/dailydrive/.spotify-token.json
```

## Show Organizer

After setup, open the container WebUI:

```text
http://YOUR_UNRAID_IP:8911
```

Click `Load shows`. The page lists saved Spotify shows that have at least one episode released in the last 30 days.

Assign each show to one of these slots:

```text
weekday_morning
weekday_afternoon
weekend_morning
weekend_afternoon
```

Click `Save slots`. The container writes:

```text
/mnt/user/appdata/dailydrive/podcast-slots.yaml
```

Before each manual or scheduled refresh, the container reads `podcast-slots.yaml`, picks the current slot using `TZ`, and updates the `podcasts` section in `config.yaml`. The first time it does this, it also saves a backup:

```text
/mnt/user/appdata/dailydrive/config.yaml.before-podcast-slots
```

Morning is before `AFTERNOON_START_HOUR`, which defaults to `12`. Set `PODCAST_SLOT` to force a slot for testing, for example `weekday_morning`.

## Run Manually

Refresh the playlist once:

```bash
/app/docker-entrypoint.sh once
```

Dry run without changing Spotify:

```bash
/app/docker-entrypoint.sh dry-run
```

Refresh podcasts only:

```bash
/app/docker-entrypoint.sh podcast-only
```

## Scheduler

The default container command is `scheduler`. It checks `SCHEDULE` every 30 seconds and runs at the matching local time using `TZ`.

Examples:

```text
SCHEDULE=04:00,16:00
SCHEDULE=06:30
RUN_ON_START=true
```

`state.json`, `.spotify-token.json`, `config.yaml`, `podcast-slots.yaml`, and optional `.env` files stay in appdata so container updates do not remove them.
