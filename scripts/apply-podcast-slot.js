#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yaml");
const SLOTS_FILE = path.join(CONFIG_DIR, "podcast-slots.yaml");
const BACKUP_FILE = path.join(CONFIG_DIR, "config.yaml.before-podcast-slots");

function currentSlot() {
  if (process.env.PODCAST_SLOT) return process.env.PODCAST_SLOT;

  const now = new Date();
  const day = now.getDay();
  const dayType = day === 0 || day === 6 ? "weekend" : "weekday";
  const hour = now.getHours();
  const afternoonStart = Number(process.env.AFTERNOON_START_HOUR || "12");
  const timeType = hour < afternoonStart ? "morning" : "afternoon";
  return `${dayType}_${timeType}`;
}

function main() {
  if (!fs.existsSync(CONFIG_FILE) || !fs.existsSync(SLOTS_FILE)) return;

  const config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  const slots = yaml.load(fs.readFileSync(SLOTS_FILE, "utf8")) || {};
  const slot = currentSlot();
  const podcasts = slots[slot] || [];

  if (!podcasts.length) {
    console.log(`No podcast slot entries found for ${slot}; leaving config.yaml podcasts unchanged.`);
    return;
  }

  if (!fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(CONFIG_FILE, BACKUP_FILE);
  }

  config.podcasts = podcasts.map((podcast) => ({
    name: podcast.name,
    id: podcast.id,
    episodes: podcast.episodes || 1,
    ...(podcast.position ? { position: podcast.position } : {}),
  }));

  fs.writeFileSync(CONFIG_FILE, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  console.log(`Applied podcast slot ${slot} to config.yaml (${config.podcasts.length} show(s)).`);
}

main();
