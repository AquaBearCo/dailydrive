#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const TOKEN_FILE = path.join(CONFIG_DIR, ".spotify-token.json");
const OUTPUT_FILE = path.join(CONFIG_DIR, "profile-playlists.json");

function isPlaceholder(value) {
  return !value || /^your-.*playlist-id/.test(value);
}

function playlistName(profile, key) {
  return profile.playlist_name || profile.name || key;
}

async function main() {
  const config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
  const token = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));

  if (!config.profiles) {
    console.error("No profiles found in config.yaml.");
    process.exit(1);
  }

  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    const api = new SpotifyWebApi({
      clientId: config.spotify.client_id,
      clientSecret: config.spotify.client_secret,
      redirectUri: config.spotify.redirect_uri,
    });
    api.setRefreshToken(token.refresh_token);
    const data = await api.refreshAccessToken();
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;
    if (data.body.refresh_token) token.refresh_token = data.body.refresh_token;
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
  }

  async function spotifyFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  const existing = [];
  let next = "https://api.spotify.com/v1/me/playlists?limit=50";
  while (next) {
    const page = await spotifyFetch(next);
    existing.push(...(page.items || []));
    next = page.next;
  }

  const wired = {};
  for (const [key, profile] of Object.entries(config.profiles)) {
    if (!isPlaceholder(profile.playlist_id)) {
      wired[key] = profile.playlist_id;
      console.log(`already_wired ${key}: ${profile.playlist_id}`);
      continue;
    }

    const name = playlistName(profile, key);
    const found = existing.find((playlist) => playlist.name === name);
    if (found) {
      profile.playlist_id = found.id;
      wired[key] = found.id;
      console.log(`reused ${key}: ${found.id}`);
      continue;
    }

    const created = await spotifyFetch("https://api.spotify.com/v1/me/playlists", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: profile.description || "Managed by Daily Drive",
        public: false,
      }),
    });
    profile.playlist_id = created.id;
    wired[key] = created.id;
    console.log(`created ${key}: ${created.id}`);
  }

  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(wired, null, 2));
  console.log(`saved=${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
