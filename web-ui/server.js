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
  const time = /\b(morning|am|a\.m\.|brief|briefing|news|headlines|daily|today|up first)\b/.test(text) || avgDuration <= 20 * 60 * 1000
    ? "morning"
    : "afternoon";
  return `weekday_${time}`;
}

function readSlots() {
  if (!fs.existsSync(SLOTS_FILE)) {
    return {
      weekday_morning: [],
      weekday_afternoon: [],
      weekend_morning: [],
      weekend_afternoon: [],
    };
  }
  const parsed = yaml.load(fs.readFileSync(SLOTS_FILE, "utf8")) || {};
  return {
    weekday_morning: parsed.weekday_morning || [],
    weekday_afternoon: parsed.weekday_afternoon || [],
    weekend_morning: parsed.weekend_morning || [],
    weekend_afternoon: parsed.weekend_afternoon || [],
  };
}

function saveSlots(assignments, showsById) {
  const slots = {
    weekday_morning: [],
    weekday_afternoon: [],
    weekend_morning: [],
    weekend_afternoon: [],
  };

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

  for (const key of Object.keys(slots)) {
    slots[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  const output = yaml.dump(slots, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(SLOTS_FILE, output);
  return slots;
}

function currentAssignments() {
  const slots = readSlots();
  const assignments = {};
  for (const [slot, shows] of Object.entries(slots)) {
    for (const show of shows || []) assignments[show.id] = slot;
  }
  return assignments;
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
      latest_episode: {
        name: latest.name,
        release_date: latest.release_date,
        duration_ms: latest.duration_ms,
      },
    });
  }

  shows.sort((a, b) => a.name.localeCompare(b.name));
  return { cutoff_date: cutoff.toISOString().slice(0, 10), market: MARKET, shows };
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DailyDrive Shows</title>
<style>
:root{--bg:#f7f8fa;--panel:#fff;--border:#d9dee7;--text:#171b22;--muted:#626b79;--accent:#1f7a4d;--accent2:#155f3a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Arial,Helvetica,sans-serif}.shell{width:min(1500px,calc(100vw - 32px));margin:0 auto;padding:24px 0 40px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:16px}h1,h2,p{margin:0}h1{font-size:28px}h2{font-size:16px}p,.meta{color:var(--muted)}button,select{font:inherit;min-height:36px;border-radius:6px}button{border:1px solid var(--accent2);background:var(--accent);color:white;padding:8px 12px;cursor:pointer}.layout{display:grid;grid-template-columns:minmax(320px,420px) 1fr;gap:14px;align-items:start}.panel,.slot,.export{background:var(--panel);border:1px solid var(--border);border-radius:8px}.panel{max-height:calc(100vh - 150px);overflow:auto}.head,.slot h2,.export h2{padding:12px 14px;border-bottom:1px solid var(--border)}.show{display:grid;grid-template-columns:52px 1fr;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border)}img{width:52px;height:52px;object-fit:cover;border-radius:6px;background:#eef1f5}.title{font-weight:700;margin-bottom:4px}.meta{font-size:12px;line-height:1.35}.show select{width:100%;margin-top:8px;border:1px solid var(--border);padding:0 8px;background:#fff}.slots{display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:14px}.slotBody{min-height:170px;padding:10px}.item{border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;background:#fbfcfd}.item strong{display:block;margin-bottom:4px}.notice{min-height:24px;margin:8px 0 12px;color:#8a5300}textarea{width:100%;min-height:260px;border:0;padding:14px;resize:vertical;background:#101418;color:#eef3f7;border-radius:0 0 8px 8px}@media(max-width:900px){.top,.layout{display:block}.panel{max-height:none;margin-bottom:14px}.slots{grid-template-columns:1fr}}
</style>
</head>
<body>
<main class="shell">
  <section class="top"><div><h1>DailyDrive Shows</h1><p id="summary">Load your Spotify shows, assign slots, save /config/podcast-slots.yaml.</p></div><div><button id="load">Load shows</button> <button id="save">Save slots</button></div></section>
  <div id="notice" class="notice"></div>
  <section class="layout">
    <aside class="panel"><div class="head"><h2>Recent Saved Shows <span id="count">0</span></h2></div><div id="shows"></div></aside>
    <section class="slots">
      <div class="slot" data-slot="weekday_morning"><h2>Weekday Morning</h2><div class="slotBody"></div></div>
      <div class="slot" data-slot="weekday_afternoon"><h2>Weekday Afternoon</h2><div class="slotBody"></div></div>
      <div class="slot" data-slot="weekend_morning"><h2>Weekend Morning</h2><div class="slotBody"></div></div>
      <div class="slot" data-slot="weekend_afternoon"><h2>Weekend Afternoon</h2><div class="slotBody"></div></div>
    </section>
  </section>
  <section class="export"><h2>Saved YAML</h2><textarea id="yaml" spellcheck="false"></textarea></section>
</main>
<script>
const labels={weekday_morning:'Weekday Morning',weekday_afternoon:'Weekday Afternoon',weekend_morning:'Weekend Morning',weekend_afternoon:'Weekend Afternoon'};
let shows=[];let assignments={};
const notice=document.getElementById('notice');
function esc(v){return String(v||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')}
function mins(ms){return Math.round((ms||0)/60000)+' min'}
async function api(path,opts={}){const res=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});if(!res.ok){const err=await res.json().catch(()=>({error:res.statusText}));throw new Error(err.error||res.statusText)}return res.headers.get('content-type')?.includes('json')?res.json():res.text()}
function renderShows(){document.getElementById('count').textContent=shows.length;document.getElementById('shows').innerHTML=shows.map(s=>{const slot=assignments[s.id]||s.assigned_slot||s.suggested_slot;return `<article class="show"><img src="${esc(s.image)}" alt=""><div><div class="title">${esc(s.name)}</div><div class="meta">${esc(s.publisher)} · ${s.recent_episode_count} recent episode(s)</div><div class="meta">${esc(s.latest_episode.name)} · ${esc(s.latest_episode.release_date)} · ${mins(s.latest_episode.duration_ms)}</div><select data-id="${esc(s.id)}">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${k===slot?'selected':''}>${v}</option>`).join('')}</select></div></article>`}).join('');for(const el of document.querySelectorAll('select[data-id]'))el.onchange=()=>{assignments[el.dataset.id]=el.value;renderSlots()}}
function renderSlots(){for(const slotEl of document.querySelectorAll('.slot')){const slot=slotEl.dataset.slot;const items=shows.filter(s=>(assignments[s.id]||s.assigned_slot||s.suggested_slot)===slot);slotEl.querySelector('.slotBody').innerHTML=items.length?items.map(s=>`<div class="item"><strong>${esc(s.name)}</strong><div class="meta">${esc(s.id)}</div><div class="meta">${esc(s.latest_episode.release_date)} · ${esc(s.latest_episode.name)}</div></div>`).join(''):'<div class="meta">No shows assigned</div>'}}
async function loadShows(){notice.textContent='Loading saved shows from Spotify...';const data=await api('/api/shows');shows=data.shows;assignments=Object.fromEntries(shows.map(s=>[s.id,s.assigned_slot||s.suggested_slot]));renderShows();renderSlots();notice.textContent=`Loaded ${shows.length} shows released since ${data.cutoff_date}.`}
async function save(){notice.textContent='Saving /config/podcast-slots.yaml...';const showsById=Object.fromEntries(shows.map(s=>[s.id,s]));const data=await api('/api/slots',{method:'POST',body:JSON.stringify({assignments,showsById})});document.getElementById('yaml').value=data.yaml;notice.textContent='Saved /config/podcast-slots.yaml.'}
document.getElementById('load').onclick=()=>loadShows().catch(e=>notice.textContent=e.message);
document.getElementById('save').onclick=()=>save().catch(e=>notice.textContent=e.message);
</script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/") return send(res, 200, page(), "text/html");
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
    return sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`DailyDrive show UI listening on http://${HOST}:${PORT}`);
  console.log(`Assignments save to ${SLOTS_FILE}`);
});
