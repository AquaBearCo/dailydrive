# Daily Drive Local Unraid Workflow

This repo is public. Keep Spotify secrets, OAuth tokens, app state, and optional AI API keys in Unraid appdata, not in Git.

## Local Paths

- Project source: `/mnt/user/dev-compose/dailydrive`
- Container config: `/mnt/user/appdata/dailydrive`
- In-container config: `/config`

From the `unraid-devui` management container, the same source tree may be mounted at:

```bash
/workspace/dev-compose/dailydrive
```

## First Deploy

```bash
cd /mnt/user/dev-compose/dailydrive
cp .env.example .env
docker compose up -d --build dailydrive
```

The first start creates:

```text
/mnt/user/appdata/dailydrive/config.yaml
```

Edit that file with:

- Spotify client ID
- Spotify client secret
- Spotify playlist ID
- Podcast show IDs
- Music preferences

Do not copy real credentials into tracked repo files.

## Spotify OAuth Setup

Spotify redirect URI in the Developer Dashboard and in `config.yaml` should be:

```text
http://127.0.0.1:8888/callback
```

From a workstation, use an SSH tunnel to Unraid:

```bash
ssh -L 8888:127.0.0.1:8890 root@YOUR_UNRAID_IP
```

Then run setup from Unraid or the management container:

```bash
docker exec -it dailydrive /app/docker-entrypoint.sh setup
```

Open the printed Spotify authorization URL in the workstation browser that has the tunnel open. The token is saved to:

```text
/mnt/user/appdata/dailydrive/.spotify-token.json
```

## Daily Commands

```bash
docker compose ps
docker compose logs -f dailydrive
docker exec -it dailydrive /app/docker-entrypoint.sh dry-run
docker exec -it dailydrive /app/docker-entrypoint.sh dry-run --profile weekday_morning
docker exec -it dailydrive /app/docker-entrypoint.sh dry-run --all-profiles
docker exec -it dailydrive /app/docker-entrypoint.sh once
docker exec -it dailydrive /app/docker-entrypoint.sh podcast-only
```

Web UI:

```text
http://YOUR_UNRAID_IP:8911
```

Profile commands:

```bash
docker exec -it dailydrive /app/docker-entrypoint.sh dry-run --profile weekday_morning
docker exec -it dailydrive /app/docker-entrypoint.sh once --profile podcast_explorer
docker exec -it dailydrive /app/docker-entrypoint.sh once --all-profiles
```

If `RUN_ON_START=true`, the container uses `RUN_ON_START_ARGS`, which defaults to `--all-profiles`, so restarts refresh every configured profile that has a real playlist ID.

## Optional Taste Profile API Keys

Put optional API keys in appdata:

```text
/mnt/user/appdata/dailydrive/.env
```

Examples:

```bash
DEMETERICS_API_KEY=...
GOOGLE_API_KEY=...
```

## Git Safety

Before committing:

```bash
git status --short
git diff --cached --name-only
```

Never commit:

- `config.yaml`
- `.spotify-token.json`
- `.env`
- `state.json`
- files containing credentials, tokens, or secrets
