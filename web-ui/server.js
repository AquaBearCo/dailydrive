#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const path = require("path");
const yaml = require("js-yaml");
const SpotifyWebApi = require("spotify-web-api-node");

const HOST = process.env.WEB_HOST || "0.0.0.0";
const PORT = Number(process.env.WEB_PORT || "8911");
const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const TOKEN_FILE = path.join(CONFIG_DIR, ".spotify-token.json");
const SLOTS_FILE = path.join(CONFIG_DIR, "podcast-slots.yaml");
const PUBLIC_DIR = path.join(__dirname, "public");
const DAYS = Number(process.env.SHOW_RECENT_DAYS || "30");
const MARKET = process.env.SPOTIFY_MARKET || "US";

function send(res, status, body, type = "text/plain") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), "application/json");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error("/config/config.yaml not found");
  return yaml.load(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) throw new Error("/config/.spotify-token.json not found. Run setup first.");
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

async function getSpotifyApi() {
  const config = loadConfig();
  const token = loadToken();
  const spotifyApi = new SpotifyWebApi({
    clientId: config.spotify.client_id,
    clientSecret: config.spotify.client_secret,
    redirectUri: config.spotify.redirect_uri,
  });
  spotifyApi.setAccessToken(token.access_token);
  spotifyApi.setRefreshToken(token.refresh_token);

  if (Date.now() > token.expires_at - 5 * 60 * 1000) {
    const data = await spotifyApi.refreshAccessToken();
    token.access_token = data.body.access_token;
    token.expires_at = Date.now() + data.body.expires_in * 1000;
    if (data.body.refresh_token) token.refresh_token = data.body.refresh_token;
    saveToken(token);
    spotifyApi.setAccessToken(token.access_token);
  }

  return spotifyApi;
}

async function spotifyFetch(accessToken, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Spotify API ${res.status}: ${await res.text()}`);
  return res.json();
}

function parseReleaseDate(value) {
  if (!value) return null;
  const parts = value.split("-").map(Number);
  if (parts.length === 1) return new Date(parts[0], 0, 1);
  if (parts.length === 2) return new Date(parts[0], parts[1] - 1, 1);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function inferSlot(show, episodes) {
  const text = `${show.name} ${show.publisher || ""} ${episodes.map((e) => e.name).join(" ")}`.toLowerCase();
  const avgDuration = episodes.reduce((sum, ep) => sum + (ep.duration_ms || 0), 0) / Math.max(episodes.length, 1);
  const time = /\b(morning|am|a\.m\.|brief|briefing|news|headlines|daily|today|up first)\b/.test(text) || avgDuration <= 20 * 60 * 1000 ? "morning" : "afternoon";
  return `weekday_${time}`;
}

function readSlots() {
  if (!fs.existsSync(SLOTS_FILE)) {
    return { weekday_morning: [], weekday_afternoon: [], weekend_morning: [], weekend_afternoon: [] };
  }
  const parsed = yaml.load(fs.readFileSync(SLOTS_FILE, "utf8")) || {};
  return {
    weekday_morning: parsed.weekday_morning || [],
    weekday_afternoon: parsed.weekday_afternoon || [],
    weekend_morning: parsed.weekend_morning || [],
    weekend_afternoon: parsed.weekend_afternoon || [],
  };
}

function currentAssignments() {
  const assignments = {};
  for (const [slot, shows] of Object.entries(readSlots())) {
    for (const show of shows || []) assignments[show.id] = slot;
  }
  return assignments;
}

function saveSlots(assignments, showsById) {
  const slots = { weekday_morning: [], weekday_afternoon: [], weekend_morning: [], weekend_afternoon: [] };
  for (const [showId, slot] of Object.entries(assignments || {})) {
    if (!slots[slot]) continue;
    const show = showsById[showId] || { id: showId, name: showId };
    slots[slot].push({
      name: show.name,
      id: show.id,
      episodes: 1,
      latest_episode: show.latest_episode?.name || "",
      latest_release_date: show.latest_episode?.release_date || "",
    });
  }
  for (const key of Object.keys(slots)) slots[key].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(SLOTS_FILE, yaml.dump(slots, { lineWidth: 120, noRefs: true }));
  return slots;
}

async function getShows() {
  const spotifyApi = await getSpotifyApi();
  const accessToken = spotifyApi.getAccessToken();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);
  cutoff.setHours(0, 0, 0, 0);

  const savedShows = [];
  let url = "https://api.spotify.com/v1/me/shows?limit=50";
  while (url) {
    const page = await spotifyFetch(accessToken, url);
    for (const item of page.items || []) if (item.show) savedShows.push(item.show);
    url = page.next;
  }

  const assignments = currentAssignments();
  const shows = [];
  for (const show of savedShows) {
    const episodeUrl = `https://api.spotify.com/v1/shows/${show.id}/episodes?market=${encodeURIComponent(MARKET)}&limit=20`;
    const page = await spotifyFetch(accessToken, episodeUrl);
    const recentEpisodes = (page.items || [])
      .map((episode) => ({
        id: episode.id,
        name: episode.name,
        release_date: episode.release_date,
        releaseDateValue: parseReleaseDate(episode.release_date),
        duration_ms: episode.duration_ms,
        url: episode.external_urls?.spotify || "",
      }))
      .filter((episode) => episode.releaseDateValue && episode.releaseDateValue >= cutoff);

    if (!recentEpisodes.length) continue;
    const latest = [...recentEpisodes].sort((a, b) => b.releaseDateValue - a.releaseDateValue)[0];
    const suggested = inferSlot(show, recentEpisodes);
    shows.push({
      id: show.id,
      name: show.name,
      publisher: show.publisher || "",
      image: show.images?.[0]?.url || "",
      url: show.external_urls?.spotify || "",
      suggested_slot: suggested,
      assigned_slot: assignments[show.id] || suggested,
      recent_episode_count: recentEpisodes.length,
      latest_episode: { name: latest.name, release_date: latest.release_date, duration_ms: latest.duration_ms },
    });
  }

  shows.sort((a, b) => a.name.localeCompare(b.name));
  return { cutoff_date: cutoff.toISOString().slice(0, 10), market: MARKET, shows };
}

function serveStatic(res, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(requestPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  if (!fs.existsSync(filePath)) return send(res, 404, "Not found");
  const ext = path.extname(filePath);
  const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
  return send(res, 200, fs.readFileSync(filePath), type);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/shows") return sendJson(res, 200, await getShows());
    if (url.pathname === "/api/slots" && req.method === "GET") {
      const content = fs.existsSync(SLOTS_FILE) ? fs.readFileSync(SLOTS_FILE, "utf8") : yaml.dump(readSlots());
      return sendJson(res, 200, { yaml: content, slots: readSlots() });
    }
    if (url.pathname === "/api/slots" && req.method === "POST") {
      const body = await readBody(req);
      saveSlots(body.assignments || {}, body.showsById || {});
      return sendJson(res, 200, { yaml: fs.readFileSync(SLOTS_FILE, "utf8"), slots: readSlots() });
    }
    return serveStatic(res, url.pathname);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`DailyDrive show UI listening on http://${HOST}:${PORT}`);
  console.log(`Assignments save to ${SLOTS_FILE}`);
});
