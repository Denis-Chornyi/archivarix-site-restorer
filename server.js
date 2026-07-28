"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4321);
const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, "public");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "restored-sites");
const SETTINGS_FILE = path.join(ROOT, "settings.json");
let appSettings = loadSettingsFile();
const currentDeviceFingerprint = crypto.createHash("sha256")
  .update(`${os.hostname()}|${os.platform()}|${os.homedir()}`)
  .digest("hex").slice(0, 24);
if (!appSettings.deviceId || appSettings.deviceFingerprint !== currentDeviceFingerprint) {
  appSettings.deviceId = crypto.randomUUID();
  appSettings.deviceFingerprint = currentDeviceFingerprint;
  appSettings.syncDeviceName = os.hostname();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), "utf8");
}
let OUTPUT_ROOT = resolveOutputRoot(appSettings.outputRoot);
if (!directoryWritable(OUTPUT_ROOT)) OUTPUT_ROOT = DEFAULT_OUTPUT_ROOT;
const ASSET_CACHE_ROOT = path.join(ROOT, "asset-vault");
const ASSET_CACHE_INDEX = path.join(ASSET_CACHE_ROOT, "index.json");
const jobs = new Map();
let assetCacheIndex = null;
let librarySyncTimer = null;
let librarySyncState = {
  status: "idle",
  lastSyncAt: null,
  lastError: null,
  uploaded: 0,
  downloaded: 0,
};

function loadSettingsFile() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
  } catch {
    return defaultSettings();
  }
}

function defaultSettings() {
  return {
    outputRoot: "",
    completeness: "maximum",
    limit: 2000,
    concurrency: 3,
    createZip: true,
    useAssetCache: true,
    allowCdnFallback: true,
    librarySyncFolder: "",
    syncDeviceName: os.hostname(),
    syncOnStart: false,
    syncAfterRestore: false,
    syncIntervalMinutes: 0,
    syncDirection: "both",
    deviceId: "",
    deviceFingerprint: "",
  };
}

function resolveOutputRoot(configured) {
  const value = String(configured || "").trim();
  return value ? path.resolve(value) : DEFAULT_OUTPUT_ROOT;
}

function directoryWritable(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    const probe = path.join(directory, `.archivarix-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function configuredOutputRoot() {
  return resolveOutputRoot(appSettings.outputRoot);
}

function storageRoots() {
  return [...new Set([configuredOutputRoot(), OUTPUT_ROOT, DEFAULT_OUTPUT_ROOT].map((root) => path.resolve(root)))];
}

function saveSettings(next) {
  const normalized = {
    outputRoot: String(next.outputRoot || "").trim(),
    completeness: ["quick", "balanced", "maximum"].includes(next.completeness) ? next.completeness : "maximum",
    limit: Math.max(10, Math.min(10000, Number(next.limit) || 2000)),
    concurrency: Math.max(1, Math.min(6, Number(next.concurrency) || 3)),
    createZip: next.createZip !== false,
    useAssetCache: next.useAssetCache !== false,
    allowCdnFallback: next.allowCdnFallback !== false,
    librarySyncFolder: String(next.librarySyncFolder || "").trim(),
    syncDeviceName: String(next.syncDeviceName || os.hostname()).trim().slice(0, 80) || os.hostname(),
    syncOnStart: next.syncOnStart === true,
    syncAfterRestore: next.syncAfterRestore === true,
    syncIntervalMinutes: Math.max(0, Math.min(1440, Number(next.syncIntervalMinutes) || 0)),
    syncDirection: ["both", "pull", "push"].includes(next.syncDirection) ? next.syncDirection : "both",
    deviceId: String(appSettings.deviceId || next.deviceId || crypto.randomUUID()),
    deviceFingerprint: currentDeviceFingerprint,
  };
  const resolved = resolveOutputRoot(normalized.outputRoot);
  if (path.resolve(path.parse(resolved).root) === path.resolve(resolved)) {
    throw new Error("Не можна зберігати проєкти безпосередньо в корені диска. Оберіть окрему папку.");
  }
  if (!directoryWritable(resolved)) throw new Error(`Немає дозволу на запис у папку: ${resolved}`);
  if (normalized.librarySyncFolder) validateLibrarySyncFolder(normalized.librarySyncFolder);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(normalized, null, 2), "utf8");
  appSettings = normalized;
  OUTPUT_ROOT = resolved;
  scheduleLibrarySync();
  return { ...appSettings, resolvedOutputRoot: OUTPUT_ROOT };
}

function folderSize(root) {
  let total = 0;
  if (!fs.existsSync(root)) return total;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) total += folderSize(target);
    else {
      try { total += fs.statSync(target).size; } catch {}
    }
  }
  return total;
}

function reportPathFor(directory) {
  const modern = path.join(directory, "reports", "restore-manifest.json");
  const legacy = path.join(directory, "restore-manifest.json");
  return fs.existsSync(modern) ? modern : legacy;
}

function projectDirectories(root) {
  const projects = [];
  if (!fs.existsSync(root)) return projects;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const first = path.join(root, entry.name);
    const firstReport = reportPathFor(first);
    const firstIsProject = fs.existsSync(firstReport)
      || fs.existsSync(path.join(first, "site"))
      || fs.existsSync(path.join(first, "packages"));
    if (firstIsProject) {
      projects.push(first);
      continue;
    }
    for (const child of fs.readdirSync(first, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const second = path.join(first, child.name);
      if (fs.existsSync(reportPathFor(second)) || fs.existsSync(path.join(second, "site")) || fs.existsSync(path.join(second, "packages"))) {
        projects.push(second);
      }
    }
  }
  return projects;
}

function projectId(root, directory) {
  return path.relative(root, directory).split(path.sep).join("/");
}

function zipFiles(directory) {
  const locations = [directory, path.join(directory, "packages")];
  return locations.flatMap((location) => {
    if (!fs.existsSync(location)) return [];
    return fs.readdirSync(location, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
      .map((entry) => path.join(location, entry.name));
  });
}

function listProjects() {
  const items = [];
  const seen = new Set();
  for (const root of storageRoots()) {
    try { fs.mkdirSync(root, { recursive: true }); } catch { continue; }
    for (const directory of projectDirectories(root)) {
      const id = projectId(root, directory);
      if (seen.has(id)) continue;
      seen.add(id);
      const manifestPath = reportPathFor(directory);
      let report = null;
      try { report = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch {}
      const stat = fs.statSync(directory);
      const manifestBytes = report?.files?.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0) || 0;
      const zips = zipFiles(directory);
      const zipBytes = zips.reduce((sum, file) => {
        try { return sum + fs.statSync(file).size; } catch { return sum; }
      }, 0);
      items.push({
        id,
        domain: report?.domain || id.split("/")[0].split("-")[0],
        timestamp: report?.requestedTimestamp || "",
        completedAt: report?.completedAt || stat.mtime.toISOString(),
        total: report?.total || 0,
        downloaded: report?.downloaded || 0,
        failed: report?.failed || 0,
        broken: report?.audit?.brokenCount || 0,
        size: report ? manifestBytes + zipBytes : folderSize(directory),
        hasReport: Boolean(report),
        hasZip: zips.length > 0,
        storageRoot: root,
      });
    }
  }
  return items.sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
}

function projectPath(id) {
  const value = String(id || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = value.split("/");
  if (!value || segments.length > 3 || segments.some((segment) => !segment || segment === "." || segment === ".." || path.basename(segment) !== segment)) {
    throw new Error("Некоректний проєкт.");
  }
  for (const root of storageRoots()) {
    const target = path.resolve(root, ...segments);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
    if (fs.existsSync(target)) return target;
  }
  const target = path.resolve(OUTPUT_ROOT, ...segments);
  if (!target.startsWith(`${path.resolve(OUTPUT_ROOT)}${path.sep}`)) throw new Error("Некоректний проєкт.");
  return target;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function normalizeTarget(value) {
  let raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  let url = new URL(raw);
  let requestedTimestamp = "";
  if (/^(?:www\.)?web\.archive\.org$/i.test(url.hostname)) {
    const match = url.pathname.match(/^\/web\/(\d{8,14})(?:[a-z_]+)?\/(https?:\/\/.+)$/i);
    if (!match) throw new Error("Посилання Wayback не містить коректної адреси відновлюваного сайту.");
    requestedTimestamp = match[1];
    url = new URL(`${match[2]}${url.search}`);
  }
  if (!url.hostname.includes(".")) throw new Error("Вкажіть коректний домен.");
  return { hostname: url.hostname.toLowerCase().replace(/^www\./, ""), url, requestedTimestamp };
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "site";
}

function timestampFolder(timestamp) {
  const value = String(timestamp || "").padEnd(14, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}_${value.slice(8, 10)}-${value.slice(10, 12)}-${value.slice(12, 14)}`;
}

function loadAssetCache() {
  if (assetCacheIndex) return assetCacheIndex;
  try {
    assetCacheIndex = JSON.parse(fs.readFileSync(ASSET_CACHE_INDEX, "utf8"));
  } catch {
    assetCacheIndex = { version: 2, urls: {}, signatures: {}, assets: {} };
  }
  assetCacheIndex.urls ||= {};
  assetCacheIndex.signatures ||= {};
  assetCacheIndex.assets ||= {};
  assetCacheIndex.version = 2;
  for (const [key, asset] of Object.entries(assetCacheIndex.assets)) {
    const signature = portableAssetSignature(asset.firstUrl);
    if (signature && !assetCacheIndex.signatures[signature]) assetCacheIndex.signatures[signature] = key;
    const detectedFamily = classifyAsset(asset.firstUrl);
    if ((!asset.family || asset.family === "Other") && detectedFamily !== "Other") asset.family = detectedFamily;
  }
  return assetCacheIndex;
}

function cacheUrlKey(original, includeSearch = true) {
  try {
    const url = new URL(original);
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname}${includeSearch ? url.search : ""}`;
  } catch {
    return String(original);
  }
}

function cacheDigestKey(digest, data = null) {
  const cleaned = String(digest || "").replace(/[^a-z0-9_-]/gi, "");
  return cleaned || (data ? crypto.createHash("sha256").update(data).digest("hex") : "");
}

function classifyAsset(original) {
  const value = String(original || "").toLowerCase();
  const patterns = [
    ["jQuery", /(?:^|[/_.-])jquery(?:[-.]|$)/],
    ["Bootstrap", /(?:^|[/_.-])bootstrap(?:[-.]|$)/],
    ["Joomla core", /\/(?:media\/system|media\/jui|administrator|components\/com_[^/]+\/assets)\//],
    ["WordPress core", /\/wp-(?:includes|admin)\//],
    ["Elementor", /\/(?:elementor|elementor-pro)\//],
    ["WooCommerce", /\/woocommerce\//],
    ["Contact Form 7", /\/contact-form-7\//],
    ["Slider Revolution", /\/(?:revslider|revolution)\//],
    ["Slick Slider", /(?:^|[/_.-])slick(?:[-.]|$)/],
    ["Swiper", /(?:^|[/_.-])swiper(?:[-.]|$)/],
    ["Font Awesome", /font-?awesome|\/fa-(?:solid|regular|brands)/],
    ["Google Fonts", /fonts\.(?:googleapis|gstatic)\.com/],
    ["Modernizr", /modernizr/],
    ["Lodash", /(?:^|[/_.-])lodash(?:[-.]|$)/],
    ["Underscore", /(?:^|[/_.-])underscore(?:[-.]|$)/],
    ["React", /(?:^|[/_.-])react(?:[-.]|$)/],
    ["Vue", /(?:^|[/_.-])vue(?:[-.]|$)/],
    ["Angular", /(?:^|[/_.-])angular(?:[-.]|$)/],
    ["Drupal core", /\/(?:core\/assets|core\/misc|sites\/all\/modules|modules\/contrib)\//],
    ["Laravel / Vite", /\/(?:build\/assets|mix-manifest\.json|vendor\/laravel)\//],
    ["Magento", /\/(?:static\/version\d+|pub\/static|skin\/frontend)\//],
    ["PrestaShop", /\/(?:themes\/[^/]+\/assets|modules\/[^/]+\/views)\//],
    ["OpenCart", /\/catalog\/view\/(?:javascript|theme)\//],
    ["TYPO3", /\/typo3conf\/ext\/|\/_assets\//],
    ["Next.js", /\/_next\/static\//],
    ["Nuxt", /\/_nuxt\//],
  ];
  return patterns.find(([, pattern]) => pattern.test(value))?.[0] || "Other";
}

function portableAssetSignature(original) {
  try {
    const url = new URL(original);
    if (!/\.(?:css|m?js)(?:$)/i.test(url.pathname)) return null;
    const family = classifyAsset(original);
    const file = path.posix.basename(url.pathname).toLowerCase();
    const parameterVersion = ["ver", "version", "v"].map((name) => url.searchParams.get(name))
      .find((value) => /^\d+(?:\.\d+){1,3}(?:[-+._a-z0-9]*)?$/i.test(value || ""));
    const pathVersion = url.pathname.match(/(?:@|[/_.-])v?(\d+\.\d+(?:\.\d+)?(?:[-+._a-z0-9]*)?)(?:[/_.-]|$)/i)?.[1];
    const contentHash = file.match(/[._-]([a-f0-9]{8,64})(?=\.(?:css|m?js)$)/i)?.[1];
    const queryHash = family !== "Other" ? url.search.match(/^\?([a-f0-9]{8,64})$/i)?.[1] : null;
    const version = parameterVersion || pathVersion || contentHash || queryHash;
    if (!version) return null;
    const cmsFamily = /core|Joomla|Drupal|Laravel|Magento|PrestaShop|OpenCart|TYPO3|Next|Nuxt/i.test(family);
    if (family === "Other" && !contentHash) return null;
    const identity = cmsFamily ? url.pathname.toLowerCase() : `${family.toLowerCase()}/${file}`;
    return crypto.createHash("sha256").update(`${identity}|${version}`).digest("hex");
  } catch {
    return null;
  }
}

function assetCacheLookup(original, digest) {
  const index = loadAssetCache();
  const signature = portableAssetSignature(original);
  const candidates = [...new Set([
    cacheDigestKey(digest),
    index.urls[cacheUrlKey(original)],
    index.urls[cacheUrlKey(original, false)],
    signature ? index.signatures[signature] : null,
  ].filter(Boolean))];
  for (const key of candidates) {
    const file = path.join(ASSET_CACHE_ROOT, `${key}.bin`);
    if (fs.existsSync(file)) return { data: fs.readFileSync(file), key, meta: index.assets[key] || {} };
  }
  return null;
}

function normalizedAssetName(original) {
  try {
    const file = path.posix.basename(new URL(original).pathname).toLowerCase();
    return file
      .replace(/\.(?:css|m?js)$/i, "")
      .replace(/\.min$/i, "")
      .replace(/[._-](?:v?\d+(?:\.\d+){1,3}|[a-f0-9]{8,64})$/i, "")
      .replace(/[^a-z0-9]+/g, "");
  } catch {
    return "";
  }
}

function nameSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const pairs = (value) => {
    const result = new Map();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) || 0) + 1);
    }
    return result;
  };
  const a = pairs(left);
  const b = pairs(right);
  let overlap = 0;
  for (const [pair, count] of a) overlap += Math.min(count, b.get(pair) || 0);
  return (2 * overlap) / Math.max(1, left.length + right.length - 2);
}

// Conservative last-resort lookup inspired by wayback-recover's local KB.
// It is intentionally limited to CSS/JS and a known library family: a visually
// similar filename alone is not enough to silently replace a site's own code.
function assetCacheFuzzyLookup(original) {
  let target;
  try { target = new URL(original); } catch { return null; }
  const extension = path.posix.extname(target.pathname).toLowerCase();
  if (![".css", ".js", ".mjs"].includes(extension)) return null;
  const family = classifyAsset(original);
  if (family === "Other") return null;
  const targetName = normalizedAssetName(original);
  if (!targetName) return null;
  const index = loadAssetCache();
  let best = null;
  for (const [key, meta] of Object.entries(index.assets || {})) {
    if (!meta?.firstUrl || meta.family !== family) continue;
    let candidate;
    try { candidate = new URL(meta.firstUrl); } catch { continue; }
    if (path.posix.extname(candidate.pathname).toLowerCase() !== extension) continue;
    const score = nameSimilarity(targetName, normalizedAssetName(meta.firstUrl));
    if (score < 0.9 || (best && score <= best.score)) continue;
    const file = path.join(ASSET_CACHE_ROOT, `${key}.bin`);
    if (fs.existsSync(file)) best = { data: fs.readFileSync(file), key, meta, score, matchType: "family-name" };
  }
  return best;
}

function assetCacheStore(original, digest, data, mime) {
  fs.mkdirSync(ASSET_CACHE_ROOT, { recursive: true });
  const index = loadAssetCache();
  const key = cacheDigestKey(digest, data);
  const file = path.join(ASSET_CACHE_ROOT, `${key}.bin`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data);
  index.urls[cacheUrlKey(original)] = key;
  const querylessKey = cacheUrlKey(original, false);
  if (!index.urls[querylessKey]) index.urls[querylessKey] = key;
  const signature = portableAssetSignature(original);
  if (signature) index.signatures[signature] = key;
  const previous = index.assets[key] || {};
  index.assets[key] = {
    bytes: data.length,
    mime: mime || previous.mime || "application/octet-stream",
    family: classifyAsset(original),
    firstUrl: previous.firstUrl || original,
    lastUsedAt: new Date().toISOString(),
  };
  const temp = `${ASSET_CACHE_INDEX}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(temp, ASSET_CACHE_INDEX);
  return key;
}

function assetCacheStats() {
  const index = loadAssetCache();
  const assets = Object.values(index.assets);
  const families = {};
  for (const asset of assets) families[asset.family || "Other"] = (families[asset.family || "Other"] || 0) + 1;
  return {
    files: assets.length,
    bytes: assets.reduce((sum, asset) => sum + (Number(asset.bytes) || 0), 0),
    urls: Object.keys(index.urls).length,
    portableSignatures: Object.keys(index.signatures || {}).length,
    families,
  };
}

function assetCacheItems() {
  const index = loadAssetCache();
  return Object.entries(index.assets).map(([key, asset]) => ({
    key, ...asset,
    urls: Object.values(index.urls).filter((value) => value === key).length,
  })).sort((a, b) => String(a.family).localeCompare(String(b.family)) || String(a.firstUrl).localeCompare(String(b.firstUrl)));
}

function saveAssetIndex(index) {
  fs.mkdirSync(ASSET_CACHE_ROOT, { recursive: true });
  fs.writeFileSync(ASSET_CACHE_INDEX, JSON.stringify(index, null, 2), "utf8");
  assetCacheIndex = index;
}

function validateLibrarySyncFolder(configured) {
  const folder = path.resolve(String(configured || "").trim());
  if (!configured) throw new Error("Вкажіть папку синхронізації.");
  if (folder === path.parse(folder).root) throw new Error("Не можна використовувати корінь диска для синхронізації.");
  if (folder === path.resolve(ASSET_CACHE_ROOT)
    || folder.startsWith(`${path.resolve(ASSET_CACHE_ROOT)}${path.sep}`)
    || path.resolve(ASSET_CACHE_ROOT).startsWith(`${folder}${path.sep}`)) {
    throw new Error("Папка синхронізації має бути окремою від локальної бібліотеки.");
  }
  if (!directoryWritable(folder)) throw new Error(`Немає доступу до папки синхронізації: ${folder}`);
  return folder;
}

function copyIfMissing(source, destination) {
  if (fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.copyFileSync(source, temporary);
  try {
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(destination)) throw error;
    return false;
  }
  return true;
}

function validSharedIndex(value) {
  return value && typeof value === "object"
    && value.assets && typeof value.assets === "object"
    && value.urls && typeof value.urls === "object";
}

function syncLibrary(action = "both") {
  if (!["push", "pull", "both"].includes(action)) throw new Error("Невідома дія синхронізації.");
  const configuredFolder = appSettings.librarySyncFolder;
  if (!configuredFolder) throw new Error("Спочатку виберіть папку Google Drive у налаштуваннях.");
  const syncFolder = validateLibrarySyncFolder(configuredFolder);
  const sharedRoot = path.join(syncFolder, "773-asset-library-v1");
  const sharedObjects = path.join(sharedRoot, "objects");
  const sharedDevices = path.join(sharedRoot, "devices");
  fs.mkdirSync(sharedObjects, { recursive: true });
  fs.mkdirSync(sharedDevices, { recursive: true });
  librarySyncState = { ...librarySyncState, status: "syncing", lastError: null, uploaded: 0, downloaded: 0 };

  try {
    const local = loadAssetCache();
    let uploaded = 0;
    let downloaded = 0;
    if (action === "push" || action === "both") {
      for (const key of Object.keys(local.assets || {})) {
        if (!/^[a-z0-9_-]{8,160}$/i.test(key)) continue;
        const source = path.join(ASSET_CACHE_ROOT, `${key}.bin`);
        const destination = path.join(sharedObjects, key.slice(0, 2), `${key}.bin`);
        if (fs.existsSync(source) && copyIfMissing(source, destination)) uploaded += 1;
      }
      const deviceManifest = {
        version: 2,
        deviceId: appSettings.deviceId,
        deviceName: appSettings.syncDeviceName || os.hostname(),
        updatedAt: new Date().toISOString(),
        urls: local.urls || {},
        signatures: local.signatures || {},
        assets: local.assets || {},
      };
      const manifestPath = path.join(sharedDevices, `${safeName(appSettings.deviceId)}.json`);
      const manifestTemp = `${manifestPath}.${process.pid}.tmp`;
      fs.writeFileSync(manifestTemp, JSON.stringify(deviceManifest, null, 2), "utf8");
      fs.copyFileSync(manifestTemp, manifestPath);
      fs.rmSync(manifestTemp, { force: true });
    }

    if (action === "pull" || action === "both") {
      const merged = {
        version: 2,
        urls: { ...(local.urls || {}) },
        signatures: { ...(local.signatures || {}) },
        assets: { ...(local.assets || {}) },
      };
      for (const entry of fs.readdirSync(sharedDevices, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        let remote;
        try { remote = JSON.parse(fs.readFileSync(path.join(sharedDevices, entry.name), "utf8")); }
        catch { continue; }
        if (!validSharedIndex(remote)) continue;
        for (const [key, meta] of Object.entries(remote.assets)) {
          if (!/^[a-z0-9_-]{8,160}$/i.test(key)) continue;
          const existing = merged.assets[key];
          if (!existing || String(meta.lastUsedAt || "") > String(existing.lastUsedAt || "")) {
            merged.assets[key] = { ...existing, ...meta };
          }
          const source = path.join(sharedObjects, key.slice(0, 2), `${key}.bin`);
          const destination = path.join(ASSET_CACHE_ROOT, `${key}.bin`);
          if (fs.existsSync(source) && copyIfMissing(source, destination)) downloaded += 1;
        }
        for (const [url, key] of Object.entries(remote.urls)) {
          if (!merged.urls[url] && merged.assets[key]) merged.urls[url] = key;
        }
        for (const [signature, key] of Object.entries(remote.signatures || {})) {
          if (!merged.signatures[signature] && merged.assets[key]) merged.signatures[signature] = key;
        }
      }
      saveAssetIndex(merged);
    }

    librarySyncState = {
      status: "idle",
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      uploaded,
      downloaded,
      sharedFolder: sharedRoot,
      deviceId: appSettings.deviceId,
      deviceName: appSettings.syncDeviceName || os.hostname(),
    };
    return { ok: true, ...librarySyncState, stats: assetCacheStats() };
  } catch (error) {
    librarySyncState = { ...librarySyncState, status: "error", lastError: error.message };
    throw error;
  }
}

function testLibrarySyncFolder(configuredFolder = appSettings.librarySyncFolder) {
  const folder = validateLibrarySyncFolder(configuredFolder);
  const sharedRoot = path.join(folder, "773-asset-library-v1");
  fs.mkdirSync(path.join(sharedRoot, "objects"), { recursive: true });
  fs.mkdirSync(path.join(sharedRoot, "devices"), { recursive: true });
  const devices = fs.readdirSync(path.join(sharedRoot, "devices"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  let freeBytes = null;
  try { freeBytes = Number(fs.statfsSync(folder).bavail) * Number(fs.statfsSync(folder).bsize); } catch {}
  return {
    ok: true,
    folder,
    sharedFolder: sharedRoot,
    writable: true,
    devices,
    freeBytes,
    deviceId: appSettings.deviceId,
    deviceName: appSettings.syncDeviceName || os.hostname(),
  };
}

function scheduleLibrarySync() {
  if (librarySyncTimer) clearInterval(librarySyncTimer);
  librarySyncTimer = null;
  const minutes = Number(appSettings.syncIntervalMinutes) || 0;
  if (!appSettings.librarySyncFolder || minutes <= 0) return;
  librarySyncTimer = setInterval(() => {
    try { syncLibrary(appSettings.syncDirection || "both"); }
    catch (error) { console.error(`Періодична синхронізація бібліотеки: ${error.message}`); }
  }, minutes * 60 * 1000);
  librarySyncTimer.unref?.();
}

function selectSyncFolder() {
  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Оберіть спільну папку Google Drive для бібліотеки 773'",
      "$dialog.ShowNewFolderButton = $true",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { encoding: "utf8", windowsHide: true });
    return String(result.stdout || "").trim();
  }
  if (process.platform === "darwin") {
    const result = spawnSync("osascript", ["-e", 'POSIX path of (choose folder with prompt "Оберіть спільну папку Google Drive для бібліотеки 773")'], { encoding: "utf8" });
    return String(result.stdout || "").trim();
  }
  const result = spawnSync("zenity", ["--file-selection", "--directory", "--title=Оберіть спільну папку Google Drive"], { encoding: "utf8" });
  return String(result.stdout || "").trim();
}

function trustedVersionedCdn(original) {
  try {
    const url = new URL(original);
    const trusted = /^(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)$/i.test(url.hostname);
    const versioned = /(?:@|\/)(?:v)?\d+\.\d+(?:\.\d+)?(?:[/-]|$)/i.test(url.pathname);
    return trusted && versioned ? url.href : null;
  } catch {
    return null;
  }
}

function log(job, message) {
  job.logs.push(`${new Date().toLocaleTimeString("uk-UA")} — ${message}`);
  if (job.logs.length > 500) job.logs.shift();
}

const SUCCESS_RESOURCE_STATUSES = new Set(["ok", "downloaded", "archived"]);

function isSuccessfulResource(item) {
  return SUCCESS_RESOURCE_STATUSES.has(item?.status);
}

function isNetworkError(error) {
  const detail = [
    error?.name,
    error?.code,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].filter(Boolean).join(" ");
  return /ECONNREFUSED|ECONNABORTED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|AbortError|fetch failed|timeout|timed out|operation was aborted/i.test(detail);
}

function httpFailure(response) {
  const error = new Error(`HTTP ${response.status}`);
  error.httpStatus = response.status;
  error.temporary = response.status === 429 || response.status >= 500;
  return error;
}

function isReconstructableCmsResource(original) {
  try {
    const pathname = new URL(original).pathname;
    return [
      /^\/(?:media\/system\/|media\/jui\/|templates\/|components\/com_[^/]+\/assets\/)/i,
      /^\/wp-(?:includes|admin)\//i,
      /^\/wp-content\/(?:plugins|themes)\/[^/]+\/(?:assets|css|js|dist|build)\//i,
      /^\/(?:core\/assets|core\/misc|modules\/contrib|sites\/all\/modules)\//i,
      /^\/(?:build\/assets|vendor\/laravel|css\/app\.[a-f0-9]+\.css|js\/app\.[a-f0-9]+\.js)/i,
      /^\/(?:static\/version\d+|pub\/static|skin\/frontend)\//i,
      /^\/(?:themes\/[^/]+\/assets|modules\/[^/]+\/views)\//i,
      /^\/catalog\/view\/(?:javascript|theme)\//i,
      /^\/(?:typo3conf\/ext|_assets)\//i,
      /^\/(?:_next\/static|_nuxt)\//i,
    ].some((pattern) => pattern.test(pathname));
  } catch {
    return false;
  }
}

const isReconstructableJoomla = isReconstructableCmsResource;

function classifyResourceFailure(original, errors) {
  if (isReconstructableCmsResource(original)) return "reconstructable";
  if (errors.some((error) => error?.networkRelated || error?.temporary || isNetworkError(error))) return "retry_later";
  return "not_archived";
}

function waybackRetryDelay(retryIndex) {
  return [1000, 2000, 4000, 8000, 16000][retryIndex] ?? 16000;
}

async function fetchRetry(url, options = {}, retries = 5, timeoutMs = 45000) {
  let last;
  let service = "віддаленим сервером";
  let internetArchive = false;
  try {
    const hostname = new URL(url).hostname;
    internetArchive = /archive\.org$/i.test(hostname);
    service = internetArchive ? "Internet Archive" : hostname;
  } catch {}
  const { onRetry, onSuccess, onExhausted, retryBudget, ...fetchOptions } = options;
  const allowedByBudget = retryBudget ? Math.max(0, Number(retryBudget.remaining) || 0) : 5;
  const maximumRetries = internetArchive ? Math.min(5, allowedByBudget) : Math.max(0, Number(retries) || 0);
  for (let attempt = 0; attempt <= maximumRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers: { "User-Agent": "773SiteRestorer/1.0 local tool", ...(fetchOptions.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      onSuccess?.(response);
      return response;
    } catch (error) {
      last = error;
      if (!isNetworkError(error)) throw error;
      if (attempt < maximumRetries) {
        const delay = waybackRetryDelay(attempt);
        if (retryBudget) retryBudget.remaining = Math.max(0, retryBudget.remaining - 1);
        onRetry?.({ retry: attempt + 1, maximumRetries, delay, error });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  const detail = last?.cause?.code || last?.cause?.message || last?.message || "невідома мережева помилка";
  const failure = new Error(`Не вдалося з’єднатися з ${service} після ${maximumRetries + 1} спроб (${detail})`);
  failure.networkRelated = true;
  failure.code = last?.cause?.code || last?.code || "NETWORK_RETRY_EXHAUSTED";
  onExhausted?.(failure);
  throw failure;
}

async function cdx(query) {
  const response = await fetchRetry(`https://web.archive.org/cdx/search/cdx?${query}`, {}, 2, 20000);
  if (!response.ok) throw new Error(`CDX API повернув HTTP ${response.status}`);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Некоректна відповідь CDX API: ${text.slice(0, 100)}`);
  }
}

async function cdxQuick(query, fetchOptions = {}) {
  const response = await fetchRetry(`https://web.archive.org/cdx/search/cdx?${query}`, fetchOptions, 5, 12000);
  if (!response.ok) throw new Error(`CDX API повернув HTTP ${response.status}`);
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new Error("CDX API повернув некоректну відповідь"); }
}

async function findSnapshots(domain, allowLocalFallback = true) {
  const { hostname, requestedTimestamp } = normalizeTarget(domain);
  if (requestedTimestamp) {
    return [{
      timestamp: requestedTimestamp,
      original: `https://www.${hostname}/`,
      date: `${requestedTimestamp.slice(0, 4)}-${requestedTimestamp.slice(4, 6)}-${requestedTimestamp.slice(6, 8)}`,
      source: "wayback-url",
    }];
  }
  const patterns = [hostname, `www.${hostname}`];
  const requests = await Promise.allSettled(patterns.map((url) => cdx(new URLSearchParams({
      url,
      output: "json",
      fl: "timestamp,original,statuscode,digest",
      filter: "statuscode:200",
      collapse: "digest",
    }))));
  const responses = requests.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!responses.length) {
    const fallback = await findSnapshotFallback(hostname);
    if (fallback.length) return fallback;
    if (allowLocalFallback) {
      const local = findLocalSnapshots(hostname);
      if (local.length) return local;
    }
    throw requests[0].reason;
  }
  const unique = new Map();
  for (const row of responses.flatMap((response) => response.slice(1))) {
    if (!unique.has(row[0])) unique.set(row[0], row);
  }
  return [...unique.values()].map(([timestamp, original]) => ({
    timestamp,
    original,
    date: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
  })).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 250);
}

function findLocalSnapshots(hostname) {
  const found = new Map();
  for (const root of storageRoots()) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const directory of projectDirectories(root)) {
        const manifestPath = reportPathFor(directory);
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const report = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (report.domain !== hostname || !report.requestedTimestamp) continue;
          found.set(report.requestedTimestamp, {
            timestamp: report.requestedTimestamp,
            original: `https://www.${hostname}/`,
            date: `${report.requestedTimestamp.slice(0, 4)}-${report.requestedTimestamp.slice(4, 6)}-${report.requestedTimestamp.slice(6, 8)}`,
            source: "local-project",
          });
        } catch {}
      }
    } catch {}
  }
  return [...found.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function findSnapshotFallback(hostname) {
  try {
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const response = await fetchRetry(
      `https://archive.org/wayback/available?url=${encodeURIComponent(hostname)}&timestamp=${timestamp}`,
      {}, 1, 15000
    );
    if (response.ok) {
      const data = await response.json();
      const closest = data?.archived_snapshots?.closest;
      if (closest?.available && closest.timestamp) {
        return [{
          timestamp: closest.timestamp,
          original: closest.url?.replace(/^https?:\/\/web\.archive\.org\/web\/\d+\/?/i, "") || `https://${hostname}/`,
          date: `${closest.timestamp.slice(0, 4)}-${closest.timestamp.slice(4, 6)}-${closest.timestamp.slice(6, 8)}`,
          source: "availability-api",
        }];
      }
    }
  } catch {}
  return [];
}

function chooseClosest(rows, requested) {
  if (!rows.length) return [];
  return rows.map((row) => ({
    row,
    distance: Math.abs(Number(row[0]) - Number(requested)),
  })).sort((a, b) => a.distance - b.distance);
}

async function inventory(domain, timestamp, includeSubdomains, limit, windowYears = 1, period = {}) {
  const year = Number(timestamp.slice(0, 4));
  const periodFrom = String(period.from || "").replace(/\D/g, "");
  const periodTo = String(period.to || "").replace(/\D/g, "");
  const patterns = includeSubdomains ? [`*.${domain}/*`] : [`${domain}/*`, `www.${domain}/*`];
  const requests = await Promise.allSettled(patterns.map((urlPattern) => cdx(new URLSearchParams({
      url: urlPattern,
      output: "json",
      fl: "timestamp,original,mimetype,statuscode,digest,length",
      filter: "statuscode:200",
      from: periodFrom || String(Math.max(1996, year - windowYears)),
      to: periodTo || String(year + windowYears),
      limit: String(Math.min(50000, limit * 8)),
      collapse: "digest",
    }))));
  const responses = requests.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!responses.length) throw requests[0].reason;
  const rows = responses.flatMap((response) => response.slice(1));
  if (!rows.length) {
    throw new Error(`Wayback Machine не повернув файлів у межах ±${windowYears} р. від обраної дати.`);
  }
  return rows;
}

function inventoryFromLocal(domain, timestamp, limit) {
  const rows = [];
  const seen = new Set();
  const index = loadAssetCache();
  for (const [key, asset] of Object.entries(index.assets)) {
    const original = asset.firstUrl;
    if (!original) continue;
    try {
      const host = new URL(original).hostname.replace(/^www\./, "");
      if (host !== domain) continue;
    } catch { continue; }
    const identity = cacheUrlKey(original);
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push([timestamp, original, asset.mime || "", "200", key, String(asset.bytes || 0)]);
    if (rows.length >= limit) break;
  }
  if (rows.length < limit) {
    for (const root of storageRoots()) {
      if (!fs.existsSync(root)) continue;
      try {
        for (const directory of projectDirectories(root)) {
          const reportPath = reportPathFor(directory);
          if (!fs.existsSync(reportPath)) continue;
          const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
          if (report.domain !== domain) continue;
          for (const file of report.files || []) {
            if (!isSuccessfulResource(file) || !file.original || seen.has(cacheUrlKey(file.original))) continue;
            seen.add(cacheUrlKey(file.original));
            rows.push([file.timestamp || timestamp, file.original, file.mime || "", "200", file.digest || "", String(file.bytes || 0)]);
            if (rows.length >= limit) return rows;
          }
        }
      } catch {}
    }
  }
  return rows;
}

function outputPathFor(original, mime, mainDomain) {
  const url = new URL(original);
  let pathname = decodeURIComponent(url.pathname || "/").replace(/\\/g, "/");
  pathname = pathname.split("/").filter((part) => part && part !== "." && part !== "..").join("/");
  const ext = path.posix.extname(pathname);
  const html = /text\/html|application\/xhtml/i.test(mime);
  if (!pathname) pathname = "index.html";
  else if (html && !ext) pathname = `${pathname.replace(/\/$/, "")}/index.html`;
  else if (pathname.endsWith("/")) pathname += "index.html";
  if (url.search) {
    const suffix = crypto.createHash("sha1").update(url.search).digest("hex").slice(0, 8);
    const parsed = path.posix.parse(pathname);
    pathname = path.posix.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext || (html ? ".html" : "")}`);
  }
  const hostPrefix = url.hostname.replace(/^www\./, "") === mainDomain ? "" : `_hosts/${safeName(url.hostname)}/`;
  return hostPrefix + pathname;
}

function relativeLink(fromFile, toFile) {
  let value = path.posix.relative(path.posix.dirname(fromFile), toFile);
  if (!value.startsWith(".")) value = `./${value}`;
  return value;
}

function buildUrlIndexes(urlMap) {
  const exact = new Map();
  const hostPath = new Map();
  for (const [original, local] of urlMap) {
    exact.set(original, local);
    try {
      const parsed = new URL(original);
      hostPath.set(`${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}${parsed.search}`, local);
    } catch {}
  }
  return { exact, hostPath };
}

function resolveLocalReference(raw, sourceUrl, indexes) {
  const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
  if (!value || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return null;
  try {
    const absolute = new URL(value, sourceUrl).href;
    const direct = indexes.exact.get(absolute);
    if (direct) return direct;
    const parsed = new URL(absolute);
    return indexes.hostPath.get(`${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}${parsed.search}`)
      || indexes.hostPath.get(`${parsed.hostname.replace(/^www\./, "")}${parsed.pathname}`);
  } catch {
    return null;
  }
}

function rewriteText(content, currentFile, sourceUrl, indexes, mime) {
  let result = content
    .replace(/https?:\/\/web\.archive\.org\/web\/\d+(?:id_|im_|js_|cs_)?\/(https?:\/\/[^"'()\s<>]+)/gi, "$1")
    .replace(/(?:https?:)?\/\/web\.archive\.org\/web\/\d+(?:id_|im_|js_|cs_)?\/(https?:\/\/[^"'()\s<>]+)/gi, "$1")
    .replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT[\s\S]*?END WAYBACK TOOLBAR INSERT\s*-->/gi, "")
    .replace(/<script[^>]+src=["'][^"']*web-static\.archive\.org[^"']*["'][^>]*><\/script>/gi, "");

  if (/html|xhtml|xml|svg/i.test(mime)) {
    result = result
      .replace(/<!--\s*FILE ARCHIVED ON[\s\S]*?-->/gi, "")
      .replace(/<(?:script|link)\b[^>]*(?:web-static\.archive\.org|\/_static\/|wombat\.js|bundle-playback\.js|archive_analytics|ruffle\.js|banner-styles\.css|iconochive\.css)[^>]*>(?:[\s\S]*?<\/script>)?/gi, "")
      .replace(/<script\b[^>]*>[\s\S]*?(?:__wm\.(?:init|bt)|archive_analytics)[\s\S]*?<\/script>/gi, "")
      .replace(/<(?:div|section)\b[^>]*\bid=["']wm-ipp(?:-base)?["'][^>]*>[\s\S]*?<\/(?:div|section)>/gi, "");
  }

  const replaceReference = (raw) => {
    const local = resolveLocalReference(raw, sourceUrl, indexes);
    return local ? relativeLink(currentFile, local) : raw;
  };

  if (/css/i.test(mime)) {
    result = result.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (all, quote, value) => {
      const rewritten = replaceReference(value);
      return `url(${quote}${rewritten}${quote})`;
    });
    result = result.replace(/(@import\s+(?:url\(\s*)?)(['"])([^'"]+)\2/gi, (all, prefix, quote, value) =>
      `${prefix}${quote}${replaceReference(value)}${quote}`);
  } else if (/html|xhtml|xml|svg/i.test(mime)) {
    result = result.replace(/\b(xlink:href|src|href|poster|action|data-src|data-lazy-src|data-original|data-url|data-bg|data-background|data-background-image)\s*=\s*(["'])(.*?)\2/gi,
      (all, attr, quote, value) => `${attr}=${quote}${replaceReference(value)}${quote}`);
    result = result.replace(/(<object\b[^>]*\bdata\s*=\s*)(["'])(.*?)\2/gi,
      (all, prefix, quote, value) => `${prefix}${quote}${replaceReference(value)}${quote}`);
    result = result.replace(/(<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image)["'][^>]*\bcontent\s*=\s*)(["'])(.*?)\2/gi,
      (all, prefix, quote, value) => `${prefix}${quote}${replaceReference(value)}${quote}`);
    result = result.replace(/\b(srcset|data-srcset|data-lazy-srcset|data-bgset)\s*=\s*(["'])(.*?)\2/gi, (all, attr, quote, value) => {
      const entries = value.split(",").map((part) => {
        const pieces = part.trim().split(/\s+/);
        pieces[0] = replaceReference(pieces[0]);
        return pieces.join(" ");
      });
      return `${attr}=${quote}${entries.join(", ")}${quote}`;
    });
    result = result.replace(/style\s*=\s*(["'])(.*?)\1/gi, (all, quote, value) =>
      `style=${quote}${value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (match, innerQuote, url) => `url(${innerQuote}${replaceReference(url)}${innerQuote})`)}${quote}`);
    result = result.replace(/<(img|source|iframe)\b[^>]*>/gi, (tag) => {
      const lazySrc = tag.match(/\b(?:data-src|data-lazy-src|data-original|data-url)\s*=\s*(["'])(.*?)\1/i);
      const lazySrcset = tag.match(/\b(?:data-srcset|data-lazy-srcset)\s*=\s*(["'])(.*?)\1/i);
      const src = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
      const srcset = tag.match(/\bsrcset\s*=\s*(["'])(.*?)\1/i);
      const placeholder = !src || /^(?:data:image\/|about:blank|#|)$/i.test(src[2].trim());
      if (lazySrc && placeholder) {
        tag = src
          ? tag.replace(src[0], `src=${src[1]}${lazySrc[2]}${src[1]}`)
          : tag.replace(/\s*\/?>$/, (ending) => ` src="${lazySrc[2]}"${ending}`);
      }
      if (lazySrcset && !srcset) {
        tag = tag.replace(/\s*\/?>$/, (ending) => ` srcset="${lazySrcset[2]}"${ending}`);
      }
      return tag;
    });
    result = result.replace(/<([a-z][\w:-]*)\b[^>]*\b(?:data-bg|data-background|data-background-image)\s*=\s*(["'])(.*?)\2[^>]*>/gi,
      (tag, element, quote, background) => {
        if (/\bstyle\s*=/i.test(tag)) {
          return tag.replace(/\bstyle\s*=\s*(["'])(.*?)\1/i,
            (all, styleQuote, style) => /background(?:-image)?\s*:/i.test(style)
              ? all
              : `style=${styleQuote}${style}${style.trim().endsWith(";") || !style.trim() ? "" : ";"}background-image:url('${background}')${styleQuote}`);
        }
        return tag.replace(/\s*\/?>$/, (ending) => ` style="background-image:url('${background}')"${ending}`);
      });
  } else if (/javascript|json/i.test(mime)) {
    result = result.replace(/(["'])(https?:\/\/[^"'\\\s]+|\/\/[^"'\\\s]+)\1/gi, (all, quote, value) => {
      const rewritten = replaceReference(value);
      return `${quote}${rewritten}${quote}`;
    });
  }
  result = result.replace(/<base\b[^>]*>/gi, "");
  return result;
}

function textEncoding(contentType, data) {
  const headerMatch = String(contentType || "").match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  if (headerMatch) return headerMatch[1].toLowerCase();
  const prefix = data.subarray(0, Math.min(data.length, 4096)).toString("latin1");
  const metaMatch = prefix.match(/charset\s*=\s*["']?\s*([a-z0-9._-]+)/i)
    || prefix.match(/content\s*=\s*["'][^"']*charset=([a-z0-9._-]+)/i);
  return metaMatch ? metaMatch[1].toLowerCase() : "utf-8";
}

function decodeText(data, contentType) {
  const aliases = {
    "windows-1251": "windows-1251",
    "cp1251": "windows-1251",
    "windows-1252": "windows-1252",
    "cp1252": "windows-1252",
    "iso-8859-1": "windows-1252",
    "latin1": "windows-1252",
    "koi8-r": "koi8-r",
  };
  const declared = textEncoding(contentType, data);
  try {
    return new TextDecoder(aliases[declared] || declared).decode(data);
  } catch {
    return new TextDecoder("utf-8").decode(data);
  }
}

function resourcePriority(mime, original) {
  const value = `${mime || ""} ${original || ""}`.toLowerCase();
  if (/text\/html|xhtml|\.html?(?:[?#]|$)/.test(value)) return 0;
  if (/image|svg|webp|png|jpe?g|gif|ico/.test(value)) return 1;
  if (/text\/css|\.css(?:[?#]|$)/.test(value)) return 2;
  if (/javascript|ecmascript|\.m?js(?:[?#]|$)/.test(value)) return 3;
  return 4;
}

function extractDependencies(content, sourceUrl) {
  const found = new Set();
  const patterns = [
    { pattern: /\b(?:xlink:href|src|href|poster|data-src|data-lazy-src|data-original|data-url|data-bg|data-background|data-background-image)\s*=\s*["']([^"']+)["']/gi },
    { pattern: /<object\b[^>]*\bdata\s*=\s*["']([^"']+)["']/gi },
    { pattern: /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image(?::url|:secure_url)?|twitter:image)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/gi },
    { pattern: /\b(?:srcset|data-srcset|data-lazy-srcset|data-bgset)\s*=\s*["']([^"']+)["']/gi, srcset: true },
    { pattern: /url\(\s*["']?([^"')]+)["']?\s*\)/gi },
    { pattern: /@import\s+(?:url\(\s*)?["']([^"']+)["']/gi },
    { pattern: /\b(?:import|fetch)\s*\(\s*["']([^"']+)["']/gi },
    { pattern: /\bimport\s+[^"']*?from\s*["']([^"']+)["']/gi },
  ];
  let sourceHost = "";
  try { sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch {}
  for (const { pattern, srcset = false } of patterns) {
    for (const match of content.matchAll(pattern)) {
      const captured = String(match[1] || "").replace(/&amp;/gi, "&").trim();
      const values = srcset
        ? captured.split(",").map((entry) => entry.trim().split(/\s+/)[0])
        : [captured];
      for (const raw of values) {
        if (!raw || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw)) continue;
        if (/^\+|\\?['"]?\+|\+\s*$|(?:getImageData|settings\.|\.ImageSrc|\.ThumbSrc|(?:^|\/)[a-z]\.src$)/i.test(raw)) continue;
        try {
          const absolute = new URL(raw, sourceUrl);
          if (!/^https?:$/.test(absolute.protocol)) continue;
          if (/\/(?:[a-z]|g\.src)$/i.test(absolute.pathname)) continue;
          const sameSite = absolute.hostname.replace(/^www\./, "") === sourceHost;
          const looksLikeAsset = /\.(?:css|m?js|json|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|pdf)(?:[?#]|$)/i.test(absolute.href);
          if (sameSite || looksLikeAsset) found.add(absolute.href);
        } catch {}
      }
    }
  }
  return [...found];
}

async function exactCandidates(original, timestamp, windowYears, alternatives, period = {}, fetchOptions = {}) {
  const year = Number(timestamp.slice(0, 4));
  const periodFrom = String(period.from || "").replace(/\D/g, "");
  const periodTo = String(period.to || "").replace(/\D/g, "");
  const collected = [];
  const seen = new Set();
  let lastError = null;
  const usefulVariants = replayUrlVariants(original)
    .filter((variant, index, all) => {
      try {
        const url = new URL(variant);
        const key = `${url.protocol}//${url.hostname}${url.pathname}`;
        return all.findIndex((item) => {
          const candidate = new URL(item);
          return `${candidate.protocol}//${candidate.hostname}${candidate.pathname}` === key;
        }) === index;
      } catch { return true; }
    })
    .slice(0, 4);
  for (const variant of usefulVariants) {
    const params = new URLSearchParams({
      url: variant,
      output: "json",
      fl: "timestamp,original,mimetype,statuscode,digest,length",
      filter: "statuscode:200",
      from: periodFrom || String(Math.max(1996, year - windowYears)),
      to: periodTo || String(year + windowYears),
      collapse: "digest",
      limit: "100",
    });
    try {
      for (const row of (await cdxQuick(params, fetchOptions)).slice(1)) {
        const key = `${row[0]}|${row[1]}|${row[4]}`;
        if (!seen.has(key)) { seen.add(key); collected.push(row); }
      }
      if (collected.length >= alternatives) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!collected.length && lastError) throw lastError;
  return chooseClosest(collected, timestamp).slice(0, alternatives).map((item) => item.row);
}

function replayUrlVariants(original) {
  const variants = new Set();
  try {
    const url = new URL(original);
    const hosts = new Set([url.hostname]);
    if (url.hostname.startsWith("www.")) hosts.add(url.hostname.slice(4));
    else hosts.add(`www.${url.hostname}`);
    const searches = new Set([url.search, ""]);
    for (const protocol of ["https:", "http:"]) {
      for (const host of hosts) {
        for (const search of searches) {
          const candidate = new URL(url.href);
          candidate.protocol = protocol;
          candidate.hostname = host;
          candidate.search = search;
          variants.add(candidate.href);
        }
      }
    }
  } catch {
    variants.add(original);
  }
  return [...variants];
}

function detectSiteProfile(rows = []) {
  const corpus = rows.map((row) => String(row?.[1] || "")).join("\n").toLowerCase();
  const profiles = [
    ["xara", /(?:xr_main\.css|xr_text\.css|xr_fonts\.css|index_htm_files\/|\/roe\.js|\/ani\.css)/],
    ["webplus", /\/(?:wpimages|wpscripts)\/|\/wpstyles\.css/],
    ["joomla", /\/(?:media\/system|media\/jui|components\/com_|templates\/system)\//],
    ["wordpress", /\/wp-(?:content|includes|admin)\//],
    ["quickcart", /\/(?:templates\/[^/]+|core\/common|database\/config)\.(?:php|js|css)|quick\.cart/],
    ["opencart", /\/catalog\/view\/(?:javascript|theme)\//],
    ["prestashop", /\/(?:themes\/[^/]+\/assets|modules\/[^/]+\/views)\//],
  ];
  return profiles.find(([, pattern]) => pattern.test(corpus))?.[0] || "generic";
}

function cmsAlternativeUrls(original, profile, hostname) {
  let parsed;
  try { parsed = new URL(original); } catch { return []; }
  const basename = path.posix.basename(parsed.pathname);
  const directory = path.posix.dirname(parsed.pathname);
  const paths = new Set([parsed.pathname]);
  if (profile === "xara") {
    for (const candidate of [
      `/${basename}`,
      `/index_htm_files/${basename}`,
      `${directory}/index_htm_files/${basename}`,
      `${directory.replace(/\/index_htm_files$/i, "")}/${basename}`,
      `/assets/${basename}`,
    ]) paths.add(candidate.replace(/\/+/g, "/"));
  } else if (profile === "joomla") {
    for (const base of ["/media/system/css", "/media/system/js", "/media/jui/css", "/media/jui/js", "/templates/system/css"]) {
      paths.add(`${base}/${basename}`);
    }
  } else if (profile === "wordpress") {
    for (const base of ["/wp-includes/css", "/wp-includes/js", "/wp-content/themes", "/wp-content/plugins"]) {
      paths.add(`${base}/${basename}`);
    }
  } else if (profile === "opencart") {
    paths.add(`/catalog/view/javascript/${basename}`);
  }
  const result = new Set();
  for (const pathname of paths) {
    for (const protocol of ["https:", "http:"]) {
      for (const host of [parsed.hostname, hostname, `www.${hostname}`]) {
        const candidate = new URL(parsed.href);
        candidate.protocol = protocol;
        candidate.hostname = host;
        candidate.pathname = pathname;
        candidate.search = "";
        result.add(candidate.href);
      }
    }
  }
  return [...result];
}

function buildFilenameSnapshotIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    try {
      const name = path.posix.basename(new URL(row[1]).pathname).toLowerCase();
      if (!name) continue;
      if (!index.has(name)) index.set(name, []);
      index.get(name).push(row);
    } catch {}
  }
  return index;
}

function filenameSnapshotCandidates(original, filenameIndex, timestamp, maximum = 10) {
  try {
    const name = path.posix.basename(new URL(original).pathname).toLowerCase();
    return chooseClosest(filenameIndex.get(name) || [], timestamp).slice(0, maximum).map((item) => item.row);
  } catch {
    return [];
  }
}

async function searchFilenameAcrossDomain(original, hostname, timestamp, maximum = 20, fetchOptions = {}) {
  let filename;
  try { filename = path.posix.basename(new URL(original).pathname); } catch { return []; }
  if (!filename) return [];
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = [];
  const seen = new Set();
  for (const host of [hostname, `www.${hostname}`]) {
    const params = new URLSearchParams({
      url: host,
      matchType: "domain",
      output: "json",
      fl: "timestamp,original,mimetype,statuscode,digest,length",
      collapse: "digest",
      limit: String(Math.max(20, maximum * 5)),
    });
    params.append("filter", "statuscode:200");
    params.append("filter", `original:.*\\/${escaped}(?:\\?.*)?$`);
    try {
      for (const row of (await cdxQuick(params, fetchOptions)).slice(1)) {
        const key = `${row[0]}|${row[1]}|${row[4]}`;
        if (!seen.has(key)) { seen.add(key); rows.push(row); }
      }
    } catch {}
  }
  return chooseClosest(rows, timestamp).slice(0, maximum).map((item) => item.row);
}

function failureDiagnostics(errors = [], strategies = []) {
  const network = errors.some((error) => error?.networkRelated || error?.temporary || isNetworkError(error));
  const statuses = errors.map((error) => Number(error?.httpStatus)).filter(Boolean);
  let reason = "all recovery strategies exhausted";
  if (network) reason = "Wayback timeout or temporary network failure";
  else if (!errors.length) reason = "no CDX snapshot";
  else if (statuses.length && statuses.every((status) => status === 404)) reason = "not archived";
  else if (strategies.includes("filename-domain") && !strategies.includes("filename-domain-hit")) reason = "filename not found";
  return {
    reason,
    strategiesTried: [...new Set(strategies)],
    errors: errors.slice(-20).map((error) => error?.message || String(error)),
  };
}

async function fetchDirectReplay(original, timestamp, options = {}) {
  const errors = [];
  for (const variant of replayUrlVariants(original)) {
    try {
      const response = await fetchRetry(`https://web.archive.org/web/${timestamp}id_/${variant}`, options, 5, 25000);
      if (!response.ok) throw httpFailure(response);
      return { response, variant };
    } catch (error) {
      errors.push(error);
    }
  }
  const failure = new Error(errors.map((error) => error.message).join("; ") || "прямий replay не знайшов копію");
  failure.networkRelated = errors.some((error) => error.networkRelated || isNetworkError(error));
  failure.temporary = errors.some((error) => error.temporary);
  throw failure;
}

function auditOutput(root, manifest) {
  const broken = [];
  const external = new Set();
  const textFiles = manifest.filter((item) => isSuccessfulResource(item) && /html|css|javascript|json|xml|svg|text/i.test(item.mime));
  for (const item of textFiles) {
    const file = path.join(root, ...item.local.split("/"));
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    const referencePattern = /css/i.test(item.mime)
      ? /(?:url\(\s*["']?([^"')]+)|@import\s+(?:url\(\s*)?["']([^"']+))/gi
      : /html|xhtml|xml|svg/i.test(item.mime)
        ? /\b(?:src|href|poster|data-src|data-lazy-src|data-original|data-url|data-bg|data-background|data-background-image|srcset|data-srcset|data-lazy-srcset|data-bgset)\s*=\s*["']([^"']+)["']/gi
        : /(["'])(https?:\/\/[^"'\\\s]+|\/\/[^"'\\\s]+)\1/gi;
    for (const match of content.matchAll(referencePattern)) {
      const reference = (/javascript|json/i.test(item.mime) ? match[2] : (match[1] || match[2] || "")).trim();
      if (!reference || /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(reference)) continue;
      if (/^(?:https?:)?\/\//i.test(reference)) {
        external.add(reference);
        continue;
      }
      const references = /\bsrcset|data-srcset|data-lazy-srcset|data-bgset/i.test(match[0])
        ? reference.split(",").map((entry) => entry.trim().split(/\s+/)[0])
        : [reference];
      for (const candidateReference of references) {
        const clean = candidateReference.split(/[?#]/)[0];
        if (!clean) continue;
        const target = clean.startsWith("/")
          ? path.resolve(root, clean.replace(/^[/\\]+/, ""))
          : path.resolve(path.dirname(file), clean);
        if (!target.startsWith(path.resolve(root))) continue;
        const alternatives = [target, path.join(target, "index.html"), `${target}.html`];
        if (!alternatives.some((candidate) => fs.existsSync(candidate))) {
          broken.push({ source: item.local, reference: candidateReference });
        }
      }
    }
  }
  return { broken: broken.slice(0, 2000), brokenCount: broken.length, external: [...external].slice(0, 2000) };
}

const LEGACY_SLIDER_JS = `"use strict";
(function () {
  function imageSource(image) {
    return image.getAttribute("data-src") ||
      image.getAttribute("data-lazy-src") ||
      image.getAttribute("data-original") ||
      image.getAttribute("title") || "";
  }

  function initialize(root) {
    if (root.dataset.restorerSlider === "ready") return;
    const slides = Array.from(root.querySelectorAll(".tc-slides > .tc-slide"));
    if (!slides.length) return;
    const descriptions = Array.from(root.querySelectorAll(".tc-slide-desc"));
    const tabs = Array.from(root.querySelectorAll(".tc-tab"));
    let current = 0;
    let timer = 0;
    let playing = true;
    const delay = Math.max(2500, Number(root.dataset.delay) || 5000);

    slides.forEach(function (slide) {
      const image = slide.querySelector("img.tc-image, img");
      if (image && !image.getAttribute("src")) {
        const source = imageSource(image);
        if (source) image.setAttribute("src", source);
      }
    });

    function show(index) {
      current = (index + slides.length) % slides.length;
      slides.forEach(function (slide, position) {
        const active = position === current;
        slide.classList.toggle("restorer-slide-active", active);
        slide.setAttribute("aria-hidden", active ? "false" : "true");
      });
      descriptions.forEach(function (description, position) {
        description.classList.toggle("restorer-slide-active", position === current);
      });
      tabs.forEach(function (tab, position) {
        tab.classList.toggle("tc-tab-active", position === current);
        tab.setAttribute("aria-current", position === current ? "true" : "false");
      });
    }

    function stop() {
      if (timer) window.clearInterval(timer);
      timer = 0;
    }
    function start() {
      stop();
      if (playing && slides.length > 1) timer = window.setInterval(function () { show(current + 1); }, delay);
    }
    function bind(selector, handler) {
      const control = root.querySelector(selector);
      if (control) control.addEventListener("click", function (event) {
        event.preventDefault();
        handler();
      });
    }

    tabs.forEach(function (tab, index) {
      tab.addEventListener("click", function (event) {
        event.preventDefault();
        show(index);
        start();
      });
    });
    bind(".tc-prev", function () { show(current - 1); start(); });
    bind(".tc-next", function () { show(current + 1); start(); });
    bind(".tc-pause", function () { playing = false; stop(); });
    bind(".tc-play", function () { playing = true; start(); });
    root.addEventListener("mouseenter", stop);
    root.addEventListener("mouseleave", start);
    root.dataset.restorerSlider = "ready";
    root.classList.add("restorer-slider-ready");
    show(0);
    start();
  }

  function boot() {
    document.querySelectorAll("#tc-tabber, .tc-tabber").forEach(initialize);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
`;

const LEGACY_SLIDER_CSS = `/* 773 deterministic fallback for legacy TCImageTabber sliders */
.restorer-slider-ready .tc-slides > .tc-slide {
  display: block !important;
  visibility: hidden;
  opacity: 0;
  z-index: 0;
  transition: opacity .7s ease;
}
.restorer-slider-ready .tc-slides > .tc-slide.restorer-slide-active {
  visibility: visible;
  opacity: 1;
  z-index: 2;
}
.restorer-slider-ready .tc-slide-desc {
  display: none;
  z-index: 6;
}
.restorer-slider-ready .tc-slide-desc.restorer-slide-active {
  display: block;
}
.restorer-slider-ready img.tc-image {
  display: block;
  max-width: 100%;
}
@media (max-width: 900px) {
  #tc-tabber.restorer-slider-ready .tc-tabber-in {
    width: 100% !important;
    height: auto !important;
    aspect-ratio: 3 / 1;
  }
  #tc-tabber.restorer-slider-ready .tc-slides {
    margin-left: 0 !important;
  }
  #tc-tabber.restorer-slider-ready .tc-tabs,
  #tc-tabber.restorer-slider-ready .tc-tab-indicator {
    display: none !important;
  }
}
`;

function repairLegacyWidgets(root, manifest = []) {
  const htmlItems = manifest.filter((item) =>
    isSuccessfulResource(item) && item.local && /html|xhtml/i.test(item.mime || "")
  );
  let repairedPages = 0;
  for (const item of htmlItems) {
    const file = path.join(root, ...item.local.split("/"));
    if (!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, "utf8");
    if (!/(?:id=["']tc-tabber["']|class=["'][^"']*\btc-tabber\b)/i.test(content)) continue;

    content = content.replace(/<img\b([^>]*\bclass=["'][^"']*\btc-image\b[^>]*)>/gi, (tag, attributes) => {
      if (/\bsrc\s*=/i.test(attributes)) return tag;
      const lazy = attributes.match(/\b(?:data-src|data-lazy-src|data-original|title)\s*=\s*(["'])(.*?)\1/i);
      return lazy && lazy[2] ? tag.replace(/<img\b/i, `<img src="${lazy[2].replace(/"/g, "&quot;")}"`) : tag;
    });

    const cssLink = relativeLink(item.local, "_773/legacy-slider.css");
    const jsLink = relativeLink(item.local, "_773/legacy-slider.js");
    if (!content.includes("legacy-slider.css")) {
      content = content.replace(/<\/head\s*>/i, `<link rel="stylesheet" href="${cssLink}" data-restorer="773-slider" />\n</head>`);
    }
    if (!content.includes("legacy-slider.js")) {
      content = content.replace(/<\/body\s*>/i, `<script src="${jsLink}" defer data-restorer="773-slider"></script>\n</body>`);
    }
    fs.writeFileSync(file, content, "utf8");
    repairedPages += 1;
  }
  if (!repairedPages) return { repairedPages: 0, generated: [] };

  const assetDir = path.join(root, "_773");
  fs.mkdirSync(assetDir, { recursive: true });
  let generatedOrigin = "https://restored.local";
  const sourceItem = manifest.find((item) => /^https?:\/\//i.test(item.original || ""));
  if (sourceItem) {
    try { generatedOrigin = new URL(sourceItem.original).origin; } catch {}
  }
  const generated = [
    { local: "_773/legacy-slider.js", mime: "application/javascript", data: LEGACY_SLIDER_JS },
    { local: "_773/legacy-slider.css", mime: "text/css", data: LEGACY_SLIDER_CSS },
  ];
  for (const asset of generated) fs.writeFileSync(path.join(root, ...asset.local.split("/")), asset.data, "utf8");
  return {
    repairedPages,
    generated: generated.map((asset) => ({
      original: `${generatedOrigin}/${asset.local}`,
      timestamp: "",
      mime: asset.mime,
      local: asset.local,
      bytes: Buffer.byteLength(asset.data),
      source: "773-deterministic-repair",
      family: "773 legacy widget fallback",
      status: "downloaded",
    })),
  };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function repairMissingTextImages(root) {
  let repairedImages = 0;
  let repairedPages = 0;
  let fallbackImages = 0;
  const repairedReferences = [];
  let hasFallbacks = false;
  const htmlFiles = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.html?$/i.test(entry.name)) htmlFiles.push(target);
    }
  };
  visit(root);
  for (const file of htmlFiles) {
    let content = fs.readFileSync(file, "utf8");
    let changed = false;
    if (content.includes("restorer-missing-text-image")) {
      hasFallbacks = true;
      fallbackImages += content.match(/\bclass=["'][^"']*restorer-missing-text-image/gi)?.length || 0;
      const normalized = content.replace(
        /(<span\b[^>]*\bclass=["'][^"']*restorer-missing-text-image[^"']*["'][^>]*>)([\s\S]*?)(<\/span>)/gi,
        (all, opening, text, closing) => `${opening}${text.replace(/&amp;amp;/gi, "&amp;")}${closing}`
      );
      if (normalized !== content) { content = normalized; changed = true; }
    }
    content = content.replace(/<img\b[^>]*>/gi, (tag) => {
      const source = tag.match(/\bsrc\s*=\s*(["'])(.*?)\1/i)?.[2];
      const alt = tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2];
      if (!source || !alt || /^(?:data:|https?:|\/\/)/i.test(source)) return tag;
      const target = path.resolve(path.dirname(file), source.split(/[?#]/)[0].replace(/\//g, path.sep));
      if (!target.startsWith(path.resolve(root)) || fs.existsSync(target)) return tag;
      const style = tag.match(/\bstyle\s*=\s*(["'])(.*?)\1/i)?.[2] || "";
      changed = true;
      hasFallbacks = true;
      repairedImages += 1;
      fallbackImages += 1;
      repairedReferences.push(source);
      return `<span class="restorer-missing-text-image" style="${escapeHtml(style)}" role="img" aria-label="${escapeHtml(alt)}">${escapeHtml(alt)}</span>`;
    });
    if (!changed) continue;
    if (!content.includes("missing-assets.css")) {
      content = content.replace(/<\/head\s*>/i,
        `<link rel="stylesheet" href="${relativeLink(path.relative(root, file).replace(/\\/g, "/"), "_773/missing-assets.css")}" data-restorer="773-missing-assets" />\n</head>`);
    }
    fs.writeFileSync(file, content, "utf8");
    repairedPages += 1;
  }
  if (hasFallbacks) {
    const assetDir = path.join(root, "_773");
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, "missing-assets.css"), [
      "/* 773 deterministic fallback for archived text rendered as missing images */",
      ".restorer-missing-text-image{box-sizing:border-box;display:flex;align-items:center;justify-content:center;",
      "font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1;color:#202020;",
      "text-align:center;white-space:nowrap;overflow:hidden}",
    ].join(""), "utf8");
  }
  return { repairedImages, repairedPages, fallbackImages, repairedReferences };
}

function repairCompletedProject(target) {
  const modernSite = path.join(target, "site");
  const siteRoot = fs.existsSync(modernSite) ? modernSite : target;
  const reportFile = reportPathFor(target);
  if (!fs.existsSync(reportFile)) throw new Error("Звіт завершеного проєкту не знайдено.");
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const manifest = Array.isArray(report.files) ? report.files : [];
  const result = repairLegacyWidgets(siteRoot, manifest);
  const missingTextRepair = repairMissingTextImages(siteRoot);
  const generatedLocals = new Set(result.generated.map((item) => item.local));
  report.files = manifest.filter((item) => !generatedLocals.has(item.local)).concat(result.generated);
  report.total = report.files.length;
  report.downloaded = report.files.filter(isSuccessfulResource).length;
  report.failed = report.files.filter((item) => !isSuccessfulResource(item)).length;
  report.audit = auditOutput(siteRoot, report.files);
  report.lastRepair = {
    completedAt: new Date().toISOString(),
    repairedLegacySliderPages: result.repairedPages,
    repairedMissingTextImages: missingTextRepair.fallbackImages,
    repairedMissingTextPages: missingTextRepair.repairedPages,
    engine: "773 deterministic legacy widget and missing text-image repair",
  };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

  const reportsDir = fs.existsSync(modernSite) ? path.join(target, "reports") : target;
  fs.writeFileSync(path.join(reportsDir, "errors.json"), JSON.stringify({
    failed: report.files.filter((item) => !isSuccessfulResource(item)),
    broken: report.audit.broken,
    external: report.audit.external,
  }, null, 2), "utf8");

  const packagesDir = fs.existsSync(modernSite) ? path.join(target, "packages") : target;
  fs.mkdirSync(packagesDir, { recursive: true });
  const domain = report.domain || path.basename(path.dirname(target));
  createZip(siteRoot, path.join(packagesDir, `${safeName(domain)}-${report.requestedTimestamp || "restored"}-site.zip`));
  const nativeZip = path.join(packagesDir, `${safeName(domain)}-archivarix-native-v4.zip`);
  const nativeResult = createNativeArchivarixPackage(siteRoot, reportFile, nativeZip, domain);
  return {
    ok: true,
    repairedPages: result.repairedPages,
    repairedMissingTextImages: missingTextRepair.fallbackImages,
    brokenReferences: report.audit.brokenCount,
    generatedFiles: result.generated.map((item) => item.local),
    package: nativeZip,
    validation: nativeResult.validation,
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(root, destination, options = {}) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (path.resolve(full) !== path.resolve(destination) && !options.exclude?.(full)) files.push(full);
    }
  };
  walk(root);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const full of files) {
    const name = path.relative(root, full).replace(/\\/g, "/");
    const nameBuf = Buffer.from(name);
    const data = fs.readFileSync(full);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(destination, Buffer.concat([...localParts, ...centralParts, end]));
}

function extractStoredZip(buffer, destination) {
  let offset = 0;
  let files = 0;
  fs.mkdirSync(destination, { recursive: true });
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (method !== 0) throw new Error("Підтримуються лише ZIP-пакети, створені цією програмою.");
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8").replace(/\\/g, "/");
    const target = path.resolve(destination, ...name.split("/"));
    if (!name || path.isAbsolute(name) || !target.startsWith(`${path.resolve(destination)}${path.sep}`)) {
      throw new Error("ZIP містить небезпечний шлях.");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer.subarray(dataStart, dataStart + compressedSize));
    files += 1;
    offset = dataStart + compressedSize;
  }
  if (!files) throw new Error("ZIP не містить підтримуваних файлів.");
  return files;
}

function readRequestBuffer(req, maximum = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(new Error("Файл завеликий."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function runJob(job, options) {
  job.status = "running";
  const { hostname } = normalizeTarget(options.domain);
  const timestamp = String(options.timestamp || "").replace(/\D/g, "");
  if (!/^\d{8,14}$/.test(timestamp)) throw new Error("Спочатку виберіть дату снапшота.");
  const limit = Math.max(10, Math.min(10000, Number(options.limit) || 2000));
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 3));
  const completeness = ["quick", "balanced", "maximum"].includes(options.completeness)
    ? options.completeness : "maximum";
  const useAssetCache = options.useAssetCache !== false;
  const allowCdnFallback = options.allowCdnFallback !== false;
  const windowYears = completeness === "quick" ? 0 : completeness === "balanced" ? 1 : 5;
  const alternatives = completeness === "quick" ? 3 : completeness === "balanced" ? 5 : 10;
  const period = { from: options.fromDate || "", to: options.toDate || "" };
  const domainFolder = safeName(hostname);
  const runFolder = `${timestampFolder(timestamp)}_${String(Date.now()).slice(-6)}`;
  const folder = `${domainFolder}/${runFolder}`;
  const preferredRoot = configuredOutputRoot();
  let activeRoot = preferredRoot;
  let projectDir = path.join(activeRoot, domainFolder, runFolder);
  let outputDir = path.join(projectDir, "site");
  try {
    if (!directoryWritable(activeRoot)) {
      const unavailable = new Error(`Немає доступу на запис до ${activeRoot}`);
      unavailable.code = "OUTPUT_ROOT_UNAVAILABLE";
      throw unavailable;
    }
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (error) {
    if (path.resolve(activeRoot) === path.resolve(DEFAULT_OUTPUT_ROOT)) throw error;
    activeRoot = DEFAULT_OUTPUT_ROOT;
    projectDir = path.join(activeRoot, domainFolder, runFolder);
    outputDir = path.join(projectDir, "site");
    fs.mkdirSync(outputDir, { recursive: true });
    log(job, `Папка ${OUTPUT_ROOT} недоступна (${error.code || error.message}); використовую стандартну: ${DEFAULT_OUTPUT_ROOT}`);
  }
  OUTPUT_ROOT = activeRoot;
  job.outputFolder = folder;
  job.outputRoot = activeRoot;
  job.outputPath = projectDir;
  log(job, `Папка проєкту: ${projectDir}`);
  log(job, `Файли сайту: ${outputDir}`);
  job.phase = "inventory";
  log(job, `Отримую перелік файлів для ${hostname} на ${timestamp}`);
  let rows = [];
  if (options.snapshotSource === "local-library" || options.snapshotSource === "local-project") {
    rows = inventoryFromLocal(hostname, timestamp, limit);
    log(job, `Локальний запуск без CDX: ${rows.length} ресурсів із бібліотеки та попередніх звітів`);
  } else {
    try {
      rows = await inventory(hostname, timestamp, Boolean(options.includeSubdomains), limit, windowYears, period);
    } catch (error) {
      log(job, `CDX недоступний: ${error.message}`);
      rows = inventoryFromLocal(hostname, timestamp, limit);
      if (rows.length) log(job, `Резервний режим: використовую ${rows.length} ресурсів із локальної бібліотеки та попередніх звітів`);
      else throw error;
    }
  }
  if (!rows.length && windowYears < 5) {
    log(job, "Розширюю часовий діапазон пошуку до ±5 років");
    rows = await inventory(hostname, timestamp, Boolean(options.includeSubdomains), limit, 5, period);
  }
  if (!rows.length) throw new Error("На цю дату файлів не знайдено. Оберіть інший снапшот.");
  const siteProfile = detectSiteProfile(rows);
  const filenameIndex = buildFilenameSnapshotIndex(rows);
  job.siteProfile = siteProfile;
  log(job, `Профіль відновлення: ${siteProfile}; індекс імен: ${filenameIndex.size}`);
  const selected = new Map();
  for (const item of chooseClosest(rows, timestamp)) {
    const [, original, mime] = item.row;
    const key = original.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!selected.has(key)) selected.set(key, []);
    const candidates = selected.get(key);
    if (candidates.length < alternatives) candidates.push(item.row);
  }
  const files = [...selected.values()].map((candidates) => ({ primary: candidates[0], candidates }))
    .sort((a, b) => resourcePriority(a.primary[2], a.primary[1]) - resourcePriority(b.primary[2], b.primary[1]))
    .slice(0, limit);
  job.total = files.length;
  log(job, `Знайдено ${files.length} унікальних ресурсів`);
  const urlMap = new Map();
  for (const file of files) {
    const [, original, mime] = file.primary;
    const local = outputPathFor(original, mime, hostname);
    for (const [, candidateUrl] of file.candidates) urlMap.set(candidateUrl, local);
  }
  const urlIndexes = buildUrlIndexes(urlMap);
  const typeCounts = files.reduce((counts, file) => {
    const mime = file.primary[2] || "unknown";
    const type = /css/i.test(mime) ? "css" : /javascript/i.test(mime) ? "js" : /html/i.test(mime) ? "html" : "asset";
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
  log(job, `Склад: HTML ${typeCounts.html || 0}, CSS ${typeCounts.css || 0}, JS ${typeCounts.js || 0}, інші ${typeCounts.asset || 0}`);
  let cursor = 0;
  job.phase = "download";
  const manifest = [];
  const discoveredDependencies = new Set();
  const worker = async () => {
    while (!job.cancelled) {
      const index = cursor++;
      if (index >= files.length) break;
      const file = files[index];
      const [stamp, original, mime, status, digest, length] = file.primary;
      const local = urlMap.get(original);
      job.currentFile = original;
      const retryBudget = { remaining: 5 };
      const retryOptions = {
        retryBudget,
        onRetry: ({ retry, maximumRetries, delay, error }) =>
          log(job, `Мережева помилка; повтор ${retry}/${maximumRetries} через ${delay / 1000} с: ${original} (${error.cause?.code || error.code || error.message})`),
      };
      try {
        let response = null;
        let used = null;
        let rawData = null;
        let source = "wayback";
        const attemptErrors = [];
        const archiveErrors = [];
        for (const candidate of file.candidates) {
          const [candidateStamp, candidateUrl, candidateMime, , candidateDigest] = candidate;
          const replayVariants = replayUrlVariants(candidateUrl).slice(0, 4);
          for (const replayVariant of replayVariants) {
            try {
              const cached = useAssetCache ? assetCacheLookup(replayVariant, candidateDigest) : null;
              if (cached) {
                rawData = cached.data;
                used = [...candidate];
                used[1] = replayVariant;
                source = "asset-vault";
                job.cacheHits += 1;
                break;
              }
              const candidateResponse = await fetchRetry(`https://web.archive.org/web/${candidateStamp}id_/${replayVariant}`, retryOptions, 5);
              if (!candidateResponse.ok) throw httpFailure(candidateResponse);
              response = candidateResponse;
              used = [...candidate];
              used[1] = replayVariant;
              rawData = Buffer.from(await response.arrayBuffer());
              if (useAssetCache) assetCacheStore(replayVariant, candidateDigest, rawData, candidateMime);
              break;
            } catch (candidateError) {
              archiveErrors.push(candidateError);
              attemptErrors.push(`${candidateStamp} ${replayVariant}: ${candidateError.message}`);
            }
          }
          if (rawData) break;
        }
        if (!rawData && useAssetCache) {
          const fuzzyCached = assetCacheFuzzyLookup(original);
          if (fuzzyCached) {
            rawData = fuzzyCached.data;
            used = file.primary;
            source = "knowledge-base-fuzzy";
            job.cacheHits += 1;
          }
        }
        const cdnUrl = allowCdnFallback ? trustedVersionedCdn(original) : null;
        if (!rawData && cdnUrl) {
          try {
            const cdnResponse = await fetchRetry(cdnUrl, {}, 2, 20000);
            if (!cdnResponse.ok) throw httpFailure(cdnResponse);
            rawData = Buffer.from(await cdnResponse.arrayBuffer());
            response = cdnResponse;
            used = file.primary;
            source = "trusted-cdn";
            job.cdnHits += 1;
            log(job, `CDN fallback: ${original}`);
            if (useAssetCache) assetCacheStore(original, digest, rawData, mime);
          } catch (cdnError) {
            attemptErrors.push(`CDN: ${cdnError.message}`);
          }
        }
        if (!rawData || !used) {
          const failure = new Error(attemptErrors.join("; ") || "усі копії недоступні");
          failure.recoveryStatus = classifyResourceFailure(original, archiveErrors);
          failure.diagnostics = failureDiagnostics(archiveErrors, [
            "knowledge-base-exact", "direct-wayback", "cdx-inventory",
            "nearest-snapshot", "other-timestamps", "http-https", "queryless",
            "knowledge-base-fuzzy", "shared-library", "trusted-cdn",
          ]);
          throw failure;
        }
        let data = rawData;
        const [usedStamp, usedOriginal, usedMime] = used;
        if (/html|css|javascript|json|xml|svg|text/i.test(mime)) {
          const contentType = response?.headers.get("content-type") || usedMime || mime;
          const decoded = decodeText(data, contentType);
          for (const dependency of extractDependencies(decoded, usedOriginal)) discoveredDependencies.add(dependency);
          data = Buffer.from(rewriteText(decoded, local, usedOriginal, urlIndexes, usedMime || mime), "utf8");
        }
        const destination = path.join(outputDir, ...local.split("/"));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, data);
        manifest.push({
          original, timestamp: usedStamp, requestedTimestamp: stamp, mime, local,
          bytes: data.length,
          alternativesTried: Math.max(1, file.candidates.findIndex((candidate) => candidate[0] === usedStamp) + 1),
          source,
          family: classifyAsset(original),
          status: /^wayback/.test(source) ? "archived" : "downloaded",
        });
      } catch (error) {
        const recoveryStatus = error.recoveryStatus || classifyResourceFailure(original, [error]);
        const diagnostics = error.diagnostics || failureDiagnostics([error], []);
        manifest.push({
          original, timestamp: stamp, mime, local, bytes: Number(length) || 0,
          status: recoveryStatus, error: error.message,
          failureReason: diagnostics.reason,
          strategiesTried: diagnostics.strategiesTried,
          strategyErrors: diagnostics.errors,
        });
        job.failed += 1;
        const label = {
          retry_later: "Internet Archive тимчасово недоступний — повторити пізніше",
          not_archived: "Архів підтвердив відсутність копії",
          reconstructable: "Стандартний ресурс CMS/фреймворку можна реконструювати",
        }[recoveryStatus] || "Ресурс недоступний";
        log(job, `${label}: ${original} (${error.message})`);
      }
      job.completed += 1;
      if (job.completed % 10 === 0 || job.completed === job.total) {
        log(job, `Завантажено ${job.completed} / ${job.total}; склад: ${job.cacheHits}; CDN: ${job.cdnHits}; помилки: ${job.failed}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  // Continue until the dynamically growing queue is empty. `limit` remains a
  // user-controlled safety ceiling; it is not a fixed number of crawl passes.
  const dependencyLimit = limit;
  const successfulResourceKeys = new Set(
    manifest.filter(isSuccessfulResource).map((item) => cacheUrlKey(item.original))
  );
  const dependencyQueue = [...discoveredDependencies]
    .filter((url) => !successfulResourceKeys.has(cacheUrlKey(url)))
    .sort((a, b) => resourcePriority("", a) - resourcePriority("", b))
    .slice(0, dependencyLimit);
  const dependencySeen = new Set(dependencyQueue);
  if (dependencyQueue.length && !job.cancelled) {
    log(job, `Другий прохід: знайдено ${dependencyQueue.length} додаткових залежностей`);
    log(job, "Стратегія: локальний склад → прямий Wayback replay → CDX без query/http/www → версіонований CDN");
    job.total += dependencyQueue.length;
    let dependencyCursor = 0;
    const archiveHealth = { consecutiveFailures: 0, openUntil: 0 };
    const dependencyWorker = async () => {
      while (!job.cancelled) {
        const dependencyIndex = dependencyCursor++;
        if (dependencyIndex >= dependencyQueue.length) break;
        const original = dependencyQueue[dependencyIndex];
        job.currentFile = original;
        job.phase = "dependencies";
        job.currentStep = dependencyIndex + 1;
        job.currentStepTotal = dependencyQueue.length;
        let candidates = [];
        let cached = useAssetCache ? assetCacheLookup(original, null) : null;
        if (!cached && useAssetCache) {
          cached = assetCacheFuzzyLookup(original);
          if (cached) log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] Бібліотека: сумісний ${cached.meta.family} (${Math.round(cached.score * 100)}%): ${original}`);
        }
        const dependencyErrors = [];
        const strategiesTried = ["knowledge-base-exact"];
        const retryBudget = { remaining: 5 };
        const retryOptions = {
          retryBudget,
          onSuccess: () => {
            archiveHealth.consecutiveFailures = 0;
            archiveHealth.openUntil = 0;
          },
          onExhausted: () => {
            archiveHealth.consecutiveFailures += 1;
            if (archiveHealth.consecutiveFailures >= 3) archiveHealth.openUntil = Date.now() + 120000;
          },
          onRetry: ({ retry, maximumRetries, delay, error }) =>
            log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] Мережева помилка; повтор ${retry}/${maximumRetries} через ${delay / 1000} с (${error.cause?.code || error.code || error.message})`),
        };
        try {
          let rawData = cached?.data || null;
          let mime = cached?.meta?.mime || "";
          let usedStamp = "cache";
          let digest = "";
          let source = cached ? (cached.matchType ? "knowledge-base-fuzzy" : "knowledge-base-exact") : "wayback";
          if (cached) {
            job.cacheHits += 1;
            log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] Склад: ${original}`);
          }
          if (!rawData) {
            strategiesTried.push("direct-wayback", "http-https", "queryless");
            if (archiveHealth.openUntil > Date.now()) {
              const circuitError = new Error("Internet Archive тимчасово недоступний; залежність відкладено без повторного очікування");
              circuitError.networkRelated = true;
              circuitError.recoveryStatus = "retry_later";
              throw circuitError;
            }
            try {
              const direct = await fetchDirectReplay(original, timestamp, retryOptions);
              rawData = Buffer.from(await direct.response.arrayBuffer());
              mime = direct.response.headers.get("content-type") || "";
              usedStamp = timestamp;
              source = "wayback-direct";
              if (useAssetCache) assetCacheStore(direct.variant, "", rawData, mime);
              log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] Прямий replay: ${direct.variant}`);
            } catch (directError) {
              dependencyErrors.push(directError);
              log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] Прямий replay не спрацював; перевіряю CDX: ${original}`);
            }
          }
          if (!rawData) {
            strategiesTried.push("cdx-exact", "nearest-snapshot", "other-timestamps");
            if (archiveHealth.openUntil > Date.now()) {
              const circuitError = new Error("Internet Archive не відповідає; CDX-пошук відкладено");
              circuitError.networkRelated = true;
              circuitError.recoveryStatus = "retry_later";
              throw circuitError;
            }
            try { candidates = await exactCandidates(original, timestamp, windowYears || 5, alternatives, period, retryOptions); }
            catch (candidateLookupError) { dependencyErrors.push(candidateLookupError); }
          }
          for (const candidate of candidates) {
            if (rawData) break;
            const [candidateStamp, candidateUrl, candidateMime, , candidateDigest] = candidate;
            try {
              const response = await fetchRetry(`https://web.archive.org/web/${candidateStamp}id_/${candidateUrl}`, retryOptions, 5);
              if (!response.ok) {
                dependencyErrors.push(httpFailure(response));
                continue;
              }
              rawData = Buffer.from(await response.arrayBuffer());
              mime = candidateMime || response.headers.get("content-type") || "";
              usedStamp = candidateStamp;
              digest = candidateDigest;
              if (useAssetCache) assetCacheStore(candidateUrl, candidateDigest, rawData, mime);
              log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] CDX ${candidateStamp}: ${candidateUrl}`);
            } catch (candidateError) { dependencyErrors.push(candidateError); }
          }
          if (!rawData) {
            strategiesTried.push(`cms-${siteProfile}`, "alternative-locations");
            for (const alternativeUrl of cmsAlternativeUrls(original, siteProfile, hostname)) {
              let alternativeCandidates = [];
              try {
                alternativeCandidates = await exactCandidates(alternativeUrl, timestamp, 10, alternatives, period, retryOptions);
              } catch (alternativeError) {
                dependencyErrors.push(alternativeError);
              }
              for (const candidate of alternativeCandidates) {
                if (rawData) break;
                const [candidateStamp, candidateUrl, candidateMime, , candidateDigest] = candidate;
                try {
                  const response = await fetchRetry(`https://web.archive.org/web/${candidateStamp}id_/${candidateUrl}`, retryOptions, 5);
                  if (!response.ok) throw httpFailure(response);
                  rawData = Buffer.from(await response.arrayBuffer());
                  mime = candidateMime || response.headers.get("content-type") || "";
                  usedStamp = candidateStamp;
                  digest = candidateDigest;
                  source = `wayback-${siteProfile}-alternative`;
                  if (useAssetCache) assetCacheStore(original, candidateDigest, rawData, mime);
                  break;
                } catch (alternativeFetchError) {
                  dependencyErrors.push(alternativeFetchError);
                }
              }
              if (rawData) break;
            }
          }
          if (!rawData) {
            strategiesTried.push("filename-domain");
            const localFilenameCandidates = filenameSnapshotCandidates(original, filenameIndex, timestamp, alternatives * 2);
            const remoteFilenameCandidates = await searchFilenameAcrossDomain(
              original, hostname, timestamp, alternatives * 2, retryOptions
            );
            const filenameCandidates = [...localFilenameCandidates, ...remoteFilenameCandidates]
              .filter((row, index, all) => all.findIndex((item) =>
                item[0] === row[0] && item[1] === row[1] && item[4] === row[4]) === index);
            if (filenameCandidates.length) strategiesTried.push("filename-domain-hit");
            for (const candidate of filenameCandidates) {
              const [candidateStamp, candidateUrl, candidateMime, , candidateDigest] = candidate;
              try {
                const response = await fetchRetry(`https://web.archive.org/web/${candidateStamp}id_/${candidateUrl}`, retryOptions, 5);
                if (!response.ok) throw httpFailure(response);
                rawData = Buffer.from(await response.arrayBuffer());
                mime = candidateMime || response.headers.get("content-type") || "";
                usedStamp = candidateStamp;
                digest = candidateDigest;
                source = "wayback-filename-domain";
                if (useAssetCache) assetCacheStore(original, candidateDigest, rawData, mime);
                break;
              } catch (filenameError) {
                dependencyErrors.push(filenameError);
              }
            }
          }
          if (!rawData && useAssetCache && !cached) {
            strategiesTried.push("knowledge-base-fuzzy", "shared-library");
            cached = assetCacheFuzzyLookup(original);
            if (cached) {
              rawData = cached.data;
              mime = cached.meta?.mime || "";
              source = "knowledge-base-fuzzy";
              job.cacheHits += 1;
            }
          }
          const cdnUrl = allowCdnFallback ? trustedVersionedCdn(original) : null;
          if (!rawData && cdnUrl) {
            const response = await fetchRetry(cdnUrl, {}, 2, 20000);
            if (response.ok) {
              rawData = Buffer.from(await response.arrayBuffer());
              mime = response.headers.get("content-type") || "";
              usedStamp = "live";
              source = "trusted-cdn";
              job.cdnHits += 1;
              if (useAssetCache) assetCacheStore(original, "", rawData, mime);
              log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] CDN: ${cdnUrl}`);
            }
          }
          if (!rawData) {
            const failure = new Error("архівної копії залежності не знайдено");
            failure.recoveryStatus = classifyResourceFailure(original, dependencyErrors);
            failure.diagnostics = failureDiagnostics(dependencyErrors, strategiesTried);
            throw failure;
          }
          const local = outputPathFor(original, mime, hostname);
          urlMap.set(original, local);
          const destination = path.join(outputDir, ...local.split("/"));
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          if (/html|css|javascript|json|xml|svg|text/i.test(mime)) {
            const decoded = decodeText(rawData, mime);
            rawData = Buffer.from(decoded, "utf8");
            for (const nested of extractDependencies(decoded, original)) {
              if (dependencyQueue.length >= dependencyLimit || dependencySeen.has(nested) || urlMap.has(nested)) continue;
              dependencySeen.add(nested);
              dependencyQueue.push(nested);
              job.total += 1;
              job.currentStepTotal = dependencyQueue.length;
              log(job, `Знайдено вкладену залежність: ${nested}`);
            }
          }
          fs.writeFileSync(destination, rawData);
          manifest.push({
            original, timestamp: usedStamp, requestedTimestamp: timestamp, mime, local,
            bytes: rawData.length, source, family: classifyAsset(original), digest,
            status: /^wayback/.test(source) ? "archived" : "downloaded",
          });
        } catch (error) {
          job.failed += 1;
          const recoveryStatus = error.recoveryStatus || classifyResourceFailure(original, dependencyErrors.concat(error));
          const diagnostics = error.diagnostics || failureDiagnostics(dependencyErrors.concat(error), strategiesTried);
          manifest.push({
            original, timestamp, mime: "", local: "", bytes: 0, status: recoveryStatus, error: error.message,
            failureReason: diagnostics.reason,
            strategiesTried: diagnostics.strategiesTried,
            strategyErrors: diagnostics.errors,
          });
          log(job, `[${dependencyIndex + 1}/${dependencyQueue.length}] ${recoveryStatus}: ${original} — ${error.message}`);
        }
        job.completed += 1;
        if (job.completed % 10 === 0 || job.completed === job.total) {
          log(job, `Дозавантаження: ${job.completed} / ${job.total}; помилки: ${job.failed}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, dependencyQueue.length) }, dependencyWorker));
    log(job, "Повторно локалізую посилання після дозавантаження залежностей");
    const expandedIndexes = buildUrlIndexes(urlMap);
    for (const item of manifest) {
      if (!isSuccessfulResource(item) || !item.local || !/html|css|javascript|json|xml|svg|text/i.test(item.mime)) continue;
      const filePath = path.join(outputDir, ...item.local.split("/"));
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      fs.writeFileSync(filePath, rewriteText(content, item.local, item.original, expandedIndexes, item.mime), "utf8");
    }
  }
  const consolidated = new Map();
  for (const item of manifest) {
    const key = cacheUrlKey(item.original);
    const previous = consolidated.get(key);
    if (!previous || isSuccessfulResource(item) || !isSuccessfulResource(previous)) consolidated.set(key, item);
  }
  const finalManifest = [...consolidated.values()];
  const widgetRepair = repairLegacyWidgets(outputDir, finalManifest);
  if (widgetRepair.repairedPages) {
    finalManifest.push(...widgetRepair.generated);
    log(job, `773: відновлено legacy-слайдер на ${widgetRepair.repairedPages} сторінках; додано автономний JS/CSS fallback`);
  }
  const textImageRepair = repairMissingTextImages(outputDir);
  if (textImageRepair.repairedImages) {
    const repairedNames = new Set(textImageRepair.repairedReferences.map((reference) =>
      path.posix.basename(reference.split(/[?#]/)[0]).toLowerCase()));
    for (const item of finalManifest) {
      if (isSuccessfulResource(item)) continue;
      let name = "";
      try { name = path.posix.basename(new URL(item.original).pathname).toLowerCase(); } catch {}
      if (!repairedNames.has(name)) continue;
      item.status = "downloaded";
      item.source = "773-webplus-text-fallback";
      item.mime = item.mime || "image/png";
      item.bytes = 0;
      item.reconstructed = true;
      delete item.failureReason;
      delete item.error;
    }
    const fallbackCss = path.join(outputDir, "_773", "missing-assets.css");
    finalManifest.push({
      original: `https://${hostname}/_773/missing-assets.css`,
      timestamp: "",
      mime: "text/css",
      local: "_773/missing-assets.css",
      bytes: fs.statSync(fallbackCss).size,
      source: "773-webplus-text-fallback",
      family: "773 WebPlus deterministic fallback",
      status: "downloaded",
    });
    log(job, `773: автоматично реконструйовано ${textImageRepair.repairedImages} WebPlus text-image елементів на ${textImageRepair.repairedPages} сторінках`);
  }
  job.failed = finalManifest.filter((item) => !isSuccessfulResource(item)).length;
  job.criticalFailed = finalManifest.filter((item) =>
    !isSuccessfulResource(item) && item.status !== "reconstructable"
      && /css|javascript|ecmascript/i.test(`${item.mime || ""} ${item.original || ""}`)
  ).length;
  const recoveredCount = manifest.filter((item) => !isSuccessfulResource(item)).length
    - finalManifest.filter((item) => !isSuccessfulResource(item)).length;
  if (recoveredCount > 0) log(job, `Повторний прохід відновив ${recoveredCount} раніше недоступних ресурсів`);
  log(job, "Перевіряю локальні посилання, CSS, шрифти та зображення");
  job.phase = "audit";
  const audit = auditOutput(outputDir, finalManifest);
  job.brokenReferences = audit.brokenCount;
  if (audit.brokenCount) log(job, `Аудит: ${audit.brokenCount} локальних залежностей відсутні в архіві`);
  if (audit.external.length) log(job, `Аудит: ${audit.external.length} зовнішніх ресурсів залишено як зовнішні URL`);
  const groups = {
    downloaded: finalManifest.filter((item) => item.status === "downloaded"),
    archived: finalManifest.filter((item) => item.status === "archived" || item.status === "ok"),
    retry_later: finalManifest.filter((item) => item.status === "retry_later"),
    not_archived: finalManifest.filter((item) => item.status === "not_archived"),
    reconstructable: finalManifest.filter((item) => item.status === "reconstructable"),
  };
  const successfulFiles = finalManifest.filter(isSuccessfulResource);
  const failedFiles = finalManifest.filter((item) => !isSuccessfulResource(item));
  const missingByType = { css: [], js: [], images: [], fonts: [], other: [] };
  for (const item of failedFiles) {
    const value = `${item.mime || ""} ${item.original || ""}`.toLowerCase();
    const type = /css|\.css(?:[?#]|$)/.test(value) ? "css"
      : /javascript|ecmascript|\.m?js(?:[?#]|$)/.test(value) ? "js"
      : /font|woff2?|ttf|otf|eot/.test(value) ? "fonts"
      : /image|svg|webp|avif|png|jpe?g|gif|ico/.test(value) ? "images"
      : "other";
    missingByType[type].push(item);
  }
  const recoverySources = successfulFiles.reduce((counts, item) => {
    const source = item.source || "unknown";
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, {});
  const report = {
    generator: "773™ Site Restorer for Archivarix 1.0",
    source: "Internet Archive CDX API",
    domain: hostname,
    siteProfile,
    requestedTimestamp: timestamp,
    completedAt: new Date().toISOString(),
    total: finalManifest.length,
    downloaded: groups.downloaded.length + groups.archived.length,
    recoveredFromArchive: groups.archived.length,
    failed: job.failed,
    recoveryPercentage: finalManifest.length
      ? Number(((successfulFiles.length / finalManifest.length) * 100).toFixed(2))
      : 100,
    recoveredFiles: successfulFiles,
    failedFiles,
    recoverySources,
    missingByType,
    missingCounts: Object.fromEntries(Object.entries(missingByType).map(([type, items]) => [type, items.length])),
    dependencyDiscovery: {
      discovered: dependencySeen.size,
      processed: dependencyQueue.length,
      safetyLimit: dependencyLimit,
      truncated: dependencySeen.size >= dependencyLimit,
    },
    criticalCssJsFailed: job.criticalFailed,
    cacheHits: job.cacheHits,
    trustedCdnHits: job.cdnHits,
    resourceTypes: typeCounts,
    audit,
    recoveredOnRetry: Math.max(0, recoveredCount),
    attempts: manifest.length,
    groups,
    statusCounts: Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, items.length])),
    files: finalManifest,
  };
  const reportsDir = path.join(projectDir, "reports");
  const packagesDir = path.join(projectDir, "packages");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(packagesDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, "restore-manifest.json"), JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(path.join(reportsDir, "restore.log"), job.logs.join("\r\n") + "\r\n", "utf8");
  fs.writeFileSync(path.join(reportsDir, "errors.json"), JSON.stringify({
    retry_later: groups.retry_later,
    not_archived: groups.not_archived,
    reconstructable: groups.reconstructable,
    broken: audit.broken,
    external: audit.external,
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(reportsDir, "recovery-report.txt"), [
    `773™ — звіт відновлення ${hostname}`,
    `Дата архіву: ${timestamp}`,
    `Завершено: ${report.completedAt}`,
    "",
    `Завантажено з локального складу/CDN: ${groups.downloaded.length}`,
    ...groups.downloaded.map((item) => `  + ${item.original}`),
    "",
    `Відновлено з Internet Archive: ${groups.archived.length}`,
    ...groups.archived.map((item) => `  + ${item.original}`),
    "",
    `Повторити пізніше: ${groups.retry_later.length}`,
    ...groups.retry_later.map((item) => `  ~ ${item.original} — ${item.error || ""}`),
    "",
    `Не збережено в архіві: ${groups.not_archived.length}`,
    ...groups.not_archived.map((item) => `  - ${item.original}`),
    "",
    `Можна реконструювати з відповідної CMS/фреймворку: ${groups.reconstructable.length}`,
    ...groups.reconstructable.map((item) => `  * ${item.original}`),
  ].join("\r\n"), "utf8");
  fs.writeFileSync(path.join(projectDir, "README.txt"), [
    "Відновлена статична копія сайту.",
    "site — готові файли сайту.",
    "reports — звіт відновлення та перелік помилок.",
    "packages — ZIP для перенесення або імпорту.",
    "Для Archivarix CMS: увімкніть Expert mode → Import sites → Static website import.",
    `Джерело: Wayback Machine, домен ${hostname}, дата ${timestamp}.`,
  ].join("\r\n"), "utf8");
  if (!job.cancelled && options.createZip !== false) {
    log(job, "Створюю звичайний ZIP статичного сайту");
    createZip(outputDir, path.join(packagesDir, `${safeName(hostname)}-${timestamp}-site.zip`));
    try {
      log(job, "Створюю нативний ZIP Archivarix зі structure.db");
      const nativeZip = path.join(packagesDir, `${safeName(hostname)}-archivarix-native-v4.zip`);
      const nativeResult = createNativeArchivarixPackage(
        outputDir,
        path.join(reportsDir, "restore-manifest.json"),
        nativeZip,
        hostname
      );
      job.archivarixPackage = nativeZip;
      log(job, `Нативний пакет Archivarix готовий: ${nativeResult.files || report.downloaded} файлів`);
      log(job, `Перевірка пакета: головна сторінка ${nativeResult.validation.homepages.length}, CSS ${nativeResult.validation.css.length}, відсутніх payload 0, помилок розміру 0`);
    } catch (error) {
      log(job, `Не вдалося автоматично створити нативний пакет Archivarix: ${error.message}`);
    }
  }
  if (!job.cancelled && appSettings.syncAfterRestore && appSettings.librarySyncFolder) {
    try {
      const sync = syncLibrary(appSettings.syncDirection || "both");
      log(job, `Синхронізація бібліотеки: передано ${sync.uploaded}, отримано ${sync.downloaded} файлів`);
    } catch (error) {
      log(job, `Синхронізація бібліотеки не виконана: ${error.message}`);
    }
  }
  job.status = job.cancelled ? "cancelled" : "done";
  job.phase = job.status;
  log(job, job.cancelled ? "Зупинено користувачем" : `Готово. Унікальних файлів: ${report.total}, відновлено: ${report.downloaded}, помилок: ${report.failed}`);
  fs.writeFileSync(path.join(reportsDir, "restore.log"), job.logs.join("\r\n") + "\r\n", "utf8");
}

function openFolder(folder) {
  return new Promise((resolve, reject) => {
    const target = /^https?:\/\//i.test(String(folder)) ? String(folder) : path.resolve(folder);
    const command = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")
      : process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [target], {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}

function findPhpExecutable() {
  const candidates = [
    process.env.ARCHIVARIX_PHP,
    "G:\\OSPaneln\\modules\\PHP-8.2\\php.exe",
    "G:\\OSPanel\\modules\\PHP-8.2\\php.exe",
    "php",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const check = spawnSync(candidate, ["-r", "exit(extension_loaded('pdo_sqlite') && extension_loaded('zip') ? 0 : 1);"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10000,
    });
    if (!check.error && check.status === 0) return candidate;
  }
  return null;
}

function createNativeArchivarixPackage(siteRoot, manifestPath, destination, domain) {
  const php = findPhpExecutable();
  if (!php) {
    throw new Error("Для нативного пакета Archivarix потрібен PHP з розширеннями pdo_sqlite і zip. Вкажіть шлях у ARCHIVARIX_PHP.");
  }
  const script = path.join(ROOT, "tools", "build-archivarix-native.php");
  const result = spawnSync(php, [script, siteRoot, manifestPath, destination, domain], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(destination)) {
    throw new Error((result.stderr || result.stdout || "Не вдалося створити нативний пакет Archivarix.").trim());
  }
  let generated;
  try { generated = JSON.parse(result.stdout); }
  catch { generated = { ok: true, output: destination }; }
  const validationScript = path.join(ROOT, "tools", "validate-archivarix-native.php");
  const validation = spawnSync(php, [validationScript, destination], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (validation.error) throw validation.error;
  if (validation.status !== 0) {
    fs.rmSync(destination, { force: true });
    throw new Error((validation.stderr || validation.stdout || "Пакет не пройшов перевірку Archivarix.").trim());
  }
  let checked;
  try { checked = JSON.parse(validation.stdout); }
  catch {
    fs.rmSync(destination, { force: true });
    throw new Error("Валідатор Archivarix повернув некоректний результат.");
  }
  if (!checked.valid || !checked.homepages?.length || checked.missingPayloads !== 0 || checked.mismatchedPayloads !== 0) {
    fs.rmSync(destination, { force: true });
    throw new Error(
      `Пакет Archivarix неповний: головних сторінок ${checked.homepages?.length || 0}, `
      + `відсутніх файлів ${checked.missingPayloads || 0}, невірних розмірів ${checked.mismatchedPayloads || 0}.`
    );
  }
  return { ...generated, validation: checked };
}

function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(PUBLIC_ROOT, relative);
  if (!file.startsWith(path.resolve(PUBLIC_ROOT)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("Not found"); return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === "GET" && parsed.pathname === "/api/snapshots") {
    findSnapshots(parsed.searchParams.get("domain"), parsed.searchParams.get("forceRemote") !== "1").then((items) => sendJson(res, 200, { items }))
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }
  if (req.method === "GET" && parsed.pathname === "/api/cache/stats") {
    return sendJson(res, 200, assetCacheStats());
  }
  if (req.method === "GET" && parsed.pathname === "/api/settings") {
    return sendJson(res, 200, { ...appSettings, resolvedOutputRoot: OUTPUT_ROOT });
  }
  if (req.method === "GET" && parsed.pathname === "/api/manual") {
    const manual = path.join(ROOT, "USER-MANUAL.md");
    if (!fs.existsSync(manual)) return sendJson(res, 404, { error: "Посібник не знайдено." });
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'inline; filename="773-user-manual-uk.md"',
      "Content-Length": fs.statSync(manual).size,
    });
    fs.createReadStream(manual).pipe(res);
    return;
  }
  if (req.method === "POST" && parsed.pathname === "/api/settings") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { sendJson(res, 200, saveSettings(JSON.parse(body))); }
      catch (error) { sendJson(res, 400, { error: error.message }); }
    });
    return;
  }
  if (req.method === "GET" && parsed.pathname === "/api/projects") {
    try { return sendJson(res, 200, { outputRoot: OUTPUT_ROOT, items: listProjects() }); }
    catch (error) { return sendJson(res, 500, { error: error.message }); }
  }
  if (req.method === "POST" && parsed.pathname === "/api/projects/import") {
    readRequestBuffer(req).then((buffer) => {
      const requested = safeName(parsed.searchParams.get("name") || "imported-project");
      const id = `_imports/${requested}-imported-${Date.now()}`;
      const target = projectPath(id);
      try {
        extractStoredZip(buffer, target);
        sendJson(res, 200, { ok: true, id });
      } catch (error) {
        fs.rmSync(target, { recursive: true, force: true });
        sendJson(res, 400, { error: error.message });
      }
    }).catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }
  const archivarixExportMatch = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/archivarix$/);
  if (archivarixExportMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(archivarixExportMatch[1]);
      const target = projectPath(id);
      if (!fs.existsSync(target)) throw new Error("Проєкт не знайдено.");
      const modernSite = path.join(target, "site");
      const siteRoot = fs.existsSync(modernSite) ? modernSite : target;
      const reportPath = reportPathFor(target);
      if (!fs.existsSync(reportPath)) throw new Error("Немає завершеного звіту відновлення.");
      let domain = id.split("/")[0];
      try { domain = JSON.parse(fs.readFileSync(reportPath, "utf8")).domain || domain; } catch {}
      const packages = fs.existsSync(modernSite) ? path.join(target, "packages") : target;
      fs.mkdirSync(packages, { recursive: true });
      const zip = path.join(packages, `${safeName(domain)}-archivarix-native-v4.zip`);
      createNativeArchivarixPackage(siteRoot, reportPath, zip, domain);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName(domain)}-archivarix-native-v4.zip"`,
        "Content-Length": fs.statSync(zip).size,
      });
      fs.createReadStream(zip).pipe(res);
    } catch (error) { sendJson(res, 404, { error: error.message }); }
    return;
  }
  const projectExportMatch = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
  if (projectExportMatch && req.method === "GET") {
    try {
      const id = decodeURIComponent(projectExportMatch[1]);
      const target = projectPath(id);
      if (!fs.existsSync(target)) throw new Error("Проєкт не знайдено.");
      const packages = path.join(target, "packages");
      fs.mkdirSync(packages, { recursive: true });
      const zip = path.join(packages, `${safeName(id)}-project-export.zip`);
      createZip(target, zip);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeName(id)}.zip"`,
        "Content-Length": fs.statSync(zip).size,
      });
      fs.createReadStream(zip).pipe(res);
    } catch (error) { sendJson(res, 404, { error: error.message }); }
    return;
  }
  const projectRepairMatch = parsed.pathname.match(/^\/api\/projects\/([^/]+)\/repair$/);
  if (projectRepairMatch && req.method === "POST") {
    try {
      const id = decodeURIComponent(projectRepairMatch[1]);
      const target = projectPath(id);
      if (!fs.existsSync(target)) throw new Error("Проєкт не знайдено.");
      return sendJson(res, 200, repairCompletedProject(target));
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  const projectMatch = parsed.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && req.method === "GET") {
    try {
      const target = projectPath(decodeURIComponent(projectMatch[1]));
      const reportPath = reportPathFor(target);
      if (!fs.existsSync(reportPath)) throw new Error("Звіт цього проєкту ще не створено.");
      return sendJson(res, 200, JSON.parse(fs.readFileSync(reportPath, "utf8")));
    } catch (error) { return sendJson(res, 404, { error: error.message }); }
  }
  if (projectMatch && req.method === "DELETE") {
    try {
      const projectId = decodeURIComponent(projectMatch[1]);
      const active = [...jobs.values()].some((job) => job.outputFolder === projectId && !["done", "cancelled", "error"].includes(job.status));
      if (active) throw new Error("Неможливо видалити проєкт, поки триває відновлення.");
      const target = projectPath(projectId);
      if (!fs.existsSync(target)) {
        jobs.forEach((job, id) => {
          if (job.outputFolder === projectId && ["done", "cancelled", "error"].includes(job.status)) jobs.delete(id);
        });
        return sendJson(res, 200, {
          ok: true,
          physicallyDeleted: true,
          alreadyDeleted: true,
          path: target,
          bytesRemoved: 0,
        });
      }
      const bytesRemoved = folderSize(target);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      if (fs.existsSync(target)) {
        throw new Error(`Папку не вдалося фізично видалити: ${target}. Закрийте відкриті файли або Провідник і повторіть.`);
      }
      const parent = path.dirname(target);
      if (storageRoots().some((root) => parent.startsWith(`${root}${path.sep}`))
        && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmSync(parent, { force: true });
      }
      jobs.forEach((job, id) => {
        if (job.outputFolder === projectId && ["done", "cancelled", "error"].includes(job.status)) jobs.delete(id);
      });
      return sendJson(res, 200, { ok: true, physicallyDeleted: true, path: target, bytesRemoved });
    } catch (error) { return sendJson(res, 400, { error: error.message }); }
  }
  if (req.method === "GET" && parsed.pathname === "/api/library") {
    return sendJson(res, 200, { stats: assetCacheStats(), items: assetCacheItems(), sync: librarySyncState });
  }
  if (req.method === "GET" && parsed.pathname === "/api/library/sync") {
    return sendJson(res, 200, {
      ...librarySyncState,
      configured: Boolean(appSettings.librarySyncFolder),
      autoSync: Boolean(appSettings.syncOnStart || appSettings.syncAfterRestore || appSettings.syncIntervalMinutes),
      folder: appSettings.librarySyncFolder || "",
      deviceId: appSettings.deviceId,
      deviceName: appSettings.syncDeviceName || os.hostname(),
    });
  }
  if (req.method === "POST" && parsed.pathname === "/api/library/sync/test") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const folder = body ? JSON.parse(body).folder : appSettings.librarySyncFolder;
        sendJson(res, 200, testLibrarySyncFolder(folder));
      } catch (error) { sendJson(res, 400, { error: error.message }); }
    });
    return;
  }
  if (req.method === "POST" && parsed.pathname === "/api/library/select-folder") {
    try {
      const folder = selectSyncFolder();
      return sendJson(res, 200, { ok: true, cancelled: !folder, folder });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && parsed.pathname === "/api/library/open-sync-folder") {
    if (!appSettings.librarySyncFolder) return sendJson(res, 400, { error: "Папку синхронізації не налаштовано." });
    openFolder(appSettings.librarySyncFolder)
      .then(() => sendJson(res, 200, { ok: true, folder: appSettings.librarySyncFolder }))
      .catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }
  if (req.method === "POST" && parsed.pathname === "/api/library/sync") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const action = body ? JSON.parse(body).action : "both";
        sendJson(res, 200, syncLibrary(action || "both"));
      } catch (error) {
        sendJson(res, 400, { error: error.message, sync: librarySyncState });
      }
    });
    return;
  }
  if (req.method === "GET" && parsed.pathname === "/api/library/export") {
    try {
      fs.mkdirSync(ASSET_CACHE_ROOT, { recursive: true });
      const zip = path.join(ASSET_CACHE_ROOT, "asset-vault-export.zip");
      createZip(ASSET_CACHE_ROOT, zip);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="archivarix-asset-vault.zip"',
        "Content-Length": fs.statSync(zip).size,
      });
      fs.createReadStream(zip).pipe(res);
    } catch (error) { sendJson(res, 500, { error: error.message }); }
    return;
  }
  if (req.method === "POST" && parsed.pathname === "/api/library/import") {
    readRequestBuffer(req).then((buffer) => {
      const temporary = path.join(ROOT, `.asset-import-${Date.now()}`);
      try {
        extractStoredZip(buffer, temporary);
        const importedIndex = JSON.parse(fs.readFileSync(path.join(temporary, "index.json"), "utf8"));
        const current = loadAssetCache();
        fs.mkdirSync(ASSET_CACHE_ROOT, { recursive: true });
        for (const entry of fs.readdirSync(temporary)) {
          if (!entry.endsWith(".bin")) continue;
          fs.copyFileSync(path.join(temporary, entry), path.join(ASSET_CACHE_ROOT, entry));
        }
        saveAssetIndex({
          version: 2,
          urls: { ...current.urls, ...(importedIndex.urls || {}) },
          signatures: { ...(current.signatures || {}), ...(importedIndex.signatures || {}) },
          assets: { ...current.assets, ...(importedIndex.assets || {}) },
        });
        sendJson(res, 200, { ok: true, stats: assetCacheStats() });
      } catch (error) { sendJson(res, 400, { error: error.message }); }
      finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }).catch((error) => sendJson(res, 400, { error: error.message }));
    return;
  }
  const libraryItemMatch = parsed.pathname.match(/^\/api\/library\/([a-z0-9_-]+)$/i);
  if (libraryItemMatch && req.method === "DELETE") {
    const index = loadAssetCache();
    const key = libraryItemMatch[1];
    delete index.assets[key];
    for (const [url, value] of Object.entries(index.urls)) if (value === key) delete index.urls[url];
    fs.rmSync(path.join(ASSET_CACHE_ROOT, `${key}.bin`), { force: true });
    saveAssetIndex(index);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && parsed.pathname === "/api/jobs") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on("end", () => {
      try {
        const options = JSON.parse(body);
        const id = crypto.randomUUID();
        const job = {
          id, status: "queued", total: 0, completed: 0, failed: 0,
          criticalFailed: 0, brokenReferences: 0, cacheHits: 0, cdnHits: 0,
          logs: [], outputFolder: null, currentFile: null, phase: "queued",
          currentStep: 0, currentStepTotal: 0, cancelled: false, error: null,
        };
        jobs.set(id, job);
        runJob(job, options).catch((error) => { job.status = "error"; job.error = error.message; log(job, `Помилка: ${error.message}`); });
        sendJson(res, 202, { id });
      } catch (error) { sendJson(res, 400, { error: error.message }); }
    });
    return;
  }
  const match = parsed.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (match && req.method === "GET") return jobs.has(match[1]) ? sendJson(res, 200, jobs.get(match[1])) : sendJson(res, 404, { error: "Не знайдено" });
  if (match && req.method === "DELETE") {
    const job = jobs.get(match[1]); if (job) job.cancelled = true;
    return sendJson(res, job ? 200 : 404, { ok: Boolean(job) });
  }
  if (req.method === "POST" && parsed.pathname === "/api/open-folder") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const folder = String(JSON.parse(body).folder || "");
        const target = projectPath(folder);
        if (!fs.existsSync(target)) throw new Error("Папку не знайдено");
        await openFolder(target);
        sendJson(res, 200, { ok: true, path: target });
      } catch (error) { sendJson(res, 400, { error: error.message }); }
    });
    return;
  }
  serveStatic(req, res);
});

fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
if (require.main === module) {
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.log(`Програма вже працює: http://${HOST}:${PORT}`);
      if (process.env.NO_OPEN !== "1") void openFolder(`http://127.0.0.1:${PORT}`).catch(() => {});
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
  server.listen(PORT, HOST, () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`773™ Site Restorer for Archivarix: ${url}`);
    scheduleLibrarySync();
    if (appSettings.syncOnStart && appSettings.librarySyncFolder) {
      setTimeout(() => {
        try { syncLibrary(appSettings.syncDirection || "both"); }
        catch (error) { console.error(`Синхронізація бібліотеки: ${error.message}`); }
      }, 1500);
    }
    if (process.env.NO_OPEN !== "1") void openFolder(url).catch((error) => console.error(`Не вдалося відкрити браузер: ${error.message}`));
  });
}

module.exports = {
  auditOutput,
  assetCacheLookup,
  assetCacheFuzzyLookup,
  assetCacheStats,
  assetCacheStore,
  buildUrlIndexes,
  buildFilenameSnapshotIndex,
  classifyAsset,
  classifyResourceFailure,
  cmsAlternativeUrls,
  chooseClosest,
  createZip,
  decodeText,
  detectSiteProfile,
  exactCandidates,
  extractStoredZip,
  extractDependencies,
  findSnapshots,
  filenameSnapshotCandidates,
  failureDiagnostics,
  isNetworkError,
  isReconstructableCmsResource,
  isReconstructableJoomla,
  normalizeTarget,
  normalizedAssetName,
  outputPathFor,
  portableAssetSignature,
  projectDirectories,
  projectId,
  reportPathFor,
  repairCompletedProject,
  repairLegacyWidgets,
  repairMissingTextImages,
  relativeLink,
  resolveLocalReference,
  resourcePriority,
  replayUrlVariants,
  searchFilenameAcrossDomain,
  rewriteText,
  server,
  trustedVersionedCdn,
  timestampFolder,
  syncLibrary,
  validateLibrarySyncFolder,
  waybackRetryDelay,
};
