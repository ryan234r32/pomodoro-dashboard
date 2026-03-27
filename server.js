import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const PORT = 8787;
const DIR = import.meta.dir;
const DATA_FILE = join(DIR, "data.json");
console.log("Data file:", DATA_FILE);
const BACKUP_DIR = join(DIR, "backups");

// Ensure backup directory exists
if (!existsSync(BACKUP_DIR)) {
  require("fs").mkdirSync(BACKUP_DIR, { recursive: true });
}

// Load existing data or create empty
function loadData() {
  try {
    if (existsSync(DATA_FILE)) {
      return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to read data.json:", e.message);
  }
  return { days: {}, matrix: {}, settings: {} };
}

// Re-split checkins by actual timestamp date (UTC+8)
function normalizeByDate(data) {
  const allCheckins = [];
  const allNotes = [];
  const dayMeta = {}; // preserve priority, tasks, etc.

  for (const [dayKey, day] of Object.entries(data.days || {})) {
    // Save metadata keyed by day
    dayMeta[dayKey] = { ...day };
    delete dayMeta[dayKey].checkins;
    delete dayMeta[dayKey].notes;

    for (const c of (day.checkins || [])) {
      const ts = c.timestamp;
      if (ts) {
        const d = new Date(ts);
        const localDate = new Date(d.getTime() + 8 * 3600000); // UTC+8
        const dateKey = localDate.toISOString().split('T')[0];
        allCheckins.push({ ...c, _dateKey: dateKey });
      } else {
        allCheckins.push({ ...c, _dateKey: dayKey });
      }
    }
    for (const n of (day.notes || [])) {
      const ts = n.timestamp;
      if (ts) {
        const d = new Date(ts);
        const localDate = new Date(d.getTime() + 8 * 3600000);
        const dateKey = localDate.toISOString().split('T')[0];
        allNotes.push({ ...n, _dateKey: dateKey });
      } else {
        allNotes.push({ ...n, _dateKey: dayKey });
      }
    }
  }

  // Rebuild days with unique checkins by timestamp
  const newDays = {};
  const seenCheckins = new Set();
  for (const c of allCheckins) {
    const key = c.timestamp || `${c._dateKey}-${c.time}-${c.text?.slice(0,20)}`;
    if (seenCheckins.has(key)) continue;
    seenCheckins.add(key);
    const dk = c._dateKey;
    if (!newDays[dk]) newDays[dk] = { priority:'', workStart:'09:00', workEnd:'23:59', tasks:[], keyNumbers:[], checkins:[], notes:[], plan:null, startedAt:null, timerLeft:900, timerRunning:false };
    const { _dateKey, ...clean } = c;
    newDays[dk].checkins.push(clean);
  }

  const seenNotes = new Set();
  for (const n of allNotes) {
    const key = n.timestamp || `${n._dateKey}-${n.time}-${n.text?.slice(0,20)}`;
    if (seenNotes.has(key)) continue;
    seenNotes.add(key);
    const dk = n._dateKey;
    if (!newDays[dk]) newDays[dk] = { priority:'', workStart:'09:00', workEnd:'23:59', tasks:[], keyNumbers:[], checkins:[], notes:[], plan:null, startedAt:null, timerLeft:900, timerRunning:false };
    const { _dateKey, ...clean } = n;
    newDays[dk].notes.push(clean);
  }

  // Restore metadata
  for (const [dk, meta] of Object.entries(dayMeta)) {
    if (newDays[dk]) {
      for (const [k, v] of Object.entries(meta)) {
        if (v && !['checkins','notes'].includes(k)) newDays[dk][k] = v;
      }
    }
  }

  data.days = newDays;
  return data;
}

// Save data with automatic daily backup
function saveData(data) {
  data = normalizeByDate(data);
  const json = JSON.stringify(data, null, 2);
  writeFileSync(DATA_FILE, json);

  // Daily backup
  const today = new Date().toISOString().split("T")[0];
  const backupFile = join(BACKUP_DIR, `data-${today}.json`);
  writeFileSync(backupFile, json);

  // Keep only last 30 days of backups
  try {
    const files = require("fs").readdirSync(BACKUP_DIR).sort();
    while (files.length > 30) {
      require("fs").unlinkSync(join(BACKUP_DIR, files.shift()));
    }
  } catch (_) {}
}

// Migrate from localStorage export if provided
function migrateIfNeeded(incomingData) {
  const existing = loadData();
  let merged = false;

  // Merge days
  if (incomingData.days) {
    for (const [key, val] of Object.entries(incomingData.days)) {
      if (!existing.days[key] || (val.checkins && val.checkins.length > (existing.days[key].checkins?.length || 0))) {
        existing.days[key] = val;
        merged = true;
      }
    }
  }

  // Merge matrix (keep whichever has more tasks)
  if (incomingData.matrix) {
    const incomingCount = Object.values(incomingData.matrix).reduce((s, q) => s + (q?.length || 0), 0);
    const existingCount = Object.values(existing.matrix || {}).reduce((s, q) => s + (q?.length || 0), 0);
    if (incomingCount > existingCount) {
      existing.matrix = incomingData.matrix;
      merged = true;
    }
  }

  // Merge settings
  if (incomingData.settings?.geminiKey && !existing.settings?.geminiKey) {
    existing.settings = incomingData.settings;
    merged = true;
  }

  if (merged) {
    saveData(existing);
    console.log("Migrated data from localStorage");
  }
  return existing;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers for file:// migration
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // API: GET data
    if (url.pathname === "/api/data" && req.method === "GET") {
      const data = loadData();
      return Response.json(data, { headers: corsHeaders });
    }

    // API: POST save data (merge + auto-split by date)
    if (url.pathname === "/api/data" && req.method === "POST") {
      try {
        const incoming = await req.json();
        const existing = loadData();

        // Merge all days from both sources
        const merged = { ...existing };
        if (incoming.days) {
          for (const [key, val] of Object.entries(incoming.days)) {
            if (!merged.days[key]) {
              merged.days[key] = val;
            } else {
              // Union checkins by timestamp
              const existingTs = new Set((merged.days[key].checkins || []).map(c => c.timestamp).filter(Boolean));
              for (const c of (val.checkins || [])) {
                if (c.timestamp && !existingTs.has(c.timestamp)) {
                  merged.days[key].checkins.push(c);
                }
              }
              const existingNoteTs = new Set((merged.days[key].notes || []).map(n => n.timestamp).filter(Boolean));
              for (const n of (val.notes || [])) {
                if (n.timestamp && !existingNoteTs.has(n.timestamp)) {
                  merged.days[key].notes.push(n);
                }
              }
              // Update metadata if newer
              if (val.lastSaveTime > (merged.days[key].lastSaveTime || '')) {
                for (const f of ['priority','workStart','workEnd','tasks','keyNumbers','plan','timerLeft','timerRunning','startedAt','lastSaveTime']) {
                  if (val[f] !== undefined) merged.days[key][f] = val[f];
                }
              }
            }
          }
        }
        if (incoming.matrix) merged.matrix = incoming.matrix;
        if (incoming.settings) merged.settings = incoming.settings;

        // saveData will normalizeByDate (auto-split + dedup)
        saveData(merged);
        return Response.json({ ok: true }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400, headers: corsHeaders });
      }
    }

    // API: POST migrate (merge localStorage data into file)
    if (url.pathname === "/api/migrate" && req.method === "POST") {
      try {
        const incoming = await req.json();
        const merged = migrateIfNeeded(incoming);
        return Response.json({ ok: true, data: merged }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 400, headers: corsHeaders });
      }
    }

    // API: GET list backups
    if (url.pathname === "/api/backups") {
      try {
        const files = require("fs").readdirSync(BACKUP_DIR).sort().reverse();
        return Response.json(files, { headers: corsHeaders });
      } catch (_) {
        return Response.json([], { headers: corsHeaders });
      }
    }

    // API: GET restore from backup
    if (url.pathname.startsWith("/api/backups/") && req.method === "GET") {
      const filename = url.pathname.split("/").pop();
      const file = join(BACKUP_DIR, filename);
      if (existsSync(file)) {
        return new Response(readFileSync(file), { headers: corsHeaders });
      }
      return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders });
    }

    // Static files
    let path = url.pathname === "/" ? "/dashboard.html" : url.pathname;
    const filePath = resolve(DIR + path);
    // Security: ensure file is within DIR
    if (!filePath.startsWith(DIR)) {
      return new Response("Forbidden", { status: 403 });
    }
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Pomodoro Dashboard running at http://localhost:${PORT}`);
