const domain = document.querySelector("#domain");
const fromDate = document.querySelector("#fromDate");
const toDate = document.querySelector("#toDate");
const searchStatus = document.querySelector("#searchStatus");
const restoreForm = document.querySelector("#restoreForm");
const restoreButton = document.querySelector("#restoreButton");
const appearance = document.querySelector("#appearance");
const chosenDate = document.querySelector("#chosenDate");
const chosenTimestamp = document.querySelector("#chosenTimestamp");
const previewLink = document.querySelector("#previewLink");
const progressPanel = document.querySelector("#progressPanel");
const statusText = document.querySelector("#statusText");
const stageHint = document.querySelector("#stageHint");
const counter = document.querySelector("#counter");
const elapsed = document.querySelector("#elapsed");
const liveDot = document.querySelector("#liveDot");
const progress = document.querySelector("#progress");
const logs = document.querySelector("#logs");
const cancel = document.querySelector("#cancel");
const openFolder = document.querySelector("#openFolder");
const vaultStatus = document.querySelector("#vaultStatus");
const copyLogs = document.querySelector("#copyLogs");
const clearLogs = document.querySelector("#clearLogs");
const logCount = document.querySelector("#logCount");
const metricDownloaded = document.querySelector("#metricDownloaded");
const metricCache = document.querySelector("#metricCache");
const metricCdn = document.querySelector("#metricCdn");
const metricErrors = document.querySelector("#metricErrors");
const projectBadge = document.querySelector("#projectBadge");
const projectsList = document.querySelector("#projectsList");
const projectsEmpty = document.querySelector("#projectsEmpty");
const projectsPath = document.querySelector("#projectsPath");
const refreshProjectsButton = document.querySelector("#refreshProjects");
const settingsForm = document.querySelector("#settingsForm");
const settingsStatus = document.querySelector("#settingsStatus");
const resolvedOutputRoot = document.querySelector("#resolvedOutputRoot");
const reportDialog = document.querySelector("#reportDialog");
const reportTitle = document.querySelector("#reportTitle");
const reportSummary = document.querySelector("#reportSummary");
const reportContent = document.querySelector("#reportContent");
const closeReport = document.querySelector("#closeReport");
const copyReport = document.querySelector("#copyReport");
const projectImportFile = document.querySelector("#projectImportFile");
const importProjectButton = document.querySelector("#importProject");
const libraryBadge = document.querySelector("#libraryBadge");
const librarySummary = document.querySelector("#librarySummary");
const libraryFamilies = document.querySelector("#libraryFamilies");
const libraryList = document.querySelector("#libraryList");
const libraryImportFile = document.querySelector("#libraryImportFile");
const importLibraryButton = document.querySelector("#importLibrary");
const refreshLibraryButton = document.querySelector("#refreshLibrary");
const syncLibraryButton = document.querySelector("#syncLibrary");
const pullLibraryButton = document.querySelector("#pullLibrary");
const librarySyncStatus = document.querySelector("#librarySyncStatus");
const chooseSyncFolderButton = document.querySelector("#chooseSyncFolder");
const testSyncFolderButton = document.querySelector("#testSyncFolder");
const openSyncFolderButton = document.querySelector("#openSyncFolder");
const syncSettingsStatus = document.querySelector("#syncSettingsStatus");
const librarySearch = document.querySelector("#librarySearch");
const libraryFamilyFilter = document.querySelector("#libraryFamilyFilter");
const libraryVisibleCount = document.querySelector("#libraryVisibleCount");

let jobId = null;
let timer = null;
let activityLines = [];
let knownServerLogs = new Set();
let clockTimer = null;
let operationStartedAt = 0;
let cachedLibraryItems = [];
document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelectorAll(".tab-page").forEach((page) => page.classList.toggle("active", page.id === button.dataset.tab));
    if (button.dataset.tab === "projectsTab") loadProjects();
    if (button.dataset.tab === "libraryTab") loadLibrary();
    if (button.dataset.tab === "settingsTab") loadSettings();
  });
});

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

async function openProjectFolder(id) {
  try {
    const response = await fetch("/api/open-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: id }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не вдалося відкрити папку");
    appendActivity(`Відкрито папку: ${result.path}`, "success");
  } catch (error) {
    appendActivity(`Не вдалося відкрити результат: ${error.message}`, "error");
    alert(`Не вдалося відкрити папку.\n\n${error.message}`);
  }
}

async function showProjectReport(id, domainName) {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  const report = await response.json();
  if (!response.ok) return alert(report.error || "Не вдалося прочитати звіт.");
  reportTitle.textContent = `Звіт: ${domainName}`;
  reportSummary.innerHTML = `
    <div><small>Файлів</small><strong>${report.total || 0}</strong></div>
    <div><small>З архіву</small><strong>${report.statusCounts?.archived ?? report.recoveredFromArchive ?? 0}</strong></div>
    <div><small>Повторити пізніше</small><strong>${report.statusCounts?.retry_later || 0}</strong></div>
    <div><small>Реконструйовані</small><strong>${report.statusCounts?.reconstructable || 0}</strong></div>`;
  const statusNames = {
    retry_later: "ПОВТОРИТИ ПІЗНІШЕ",
    not_archived: "НЕМАЄ В АРХІВІ",
    reconstructable: "МОЖНА РЕКОНСТРУЮВАТИ",
  };
  const errors = (report.files || []).filter((item) => !["ok", "downloaded", "archived"].includes(item.status))
    .map((item) => `[${statusNames[item.status] || item.status}]\n${item.original}\n  ${item.error || "Без додаткового опису"}`);
  const broken = (report.audit?.broken || []).map((item) => `${item.source} → ${item.reference}`);
  reportContent.textContent = [...errors, ...broken].join("\n\n") || "Помилок не зафіксовано.";
  reportDialog.showModal();
}

async function deleteProject(id, domainName) {
  if (!confirm(`Видалити проєкт ${domainName}?\n\nБуде видалено папку відновлення, ZIP і звіт. Спільний склад ресурсів залишиться.`)) return;
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) return alert(result.error || "Не вдалося видалити проєкт.");
  appendActivity(
    result.alreadyDeleted
      ? `Проєкт уже був видалений з диска. Застарілий запис прибрано зі списку: ${result.path}`
      : `Проєкт фізично видалено: ${result.path} (${formatBytes(result.bytesRemoved || 0)})`,
    "success"
  );
  await loadProjects();
}

async function repairProject(id, domainName, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Ремонтую…";
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/repair`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не вдалося виконати ремонт.");
    appendActivity(
      `Проєкт ${domainName}: відновлено legacy-слайдер на ${result.repairedPages} сторінках; ZIP Archivarix перевипущено.`,
      "success"
    );
    alert(`Ремонт завершено.\n\nСторінок зі слайдером: ${result.repairedPages}\nБитих локальних посилань: ${result.brokenReferences}\nZIP Archivarix оновлено.`);
    await loadProjects();
  } catch (error) {
    alert(`Не вдалося відремонтувати проєкт.\n\n${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function loadProjects() {
  projectsList.innerHTML = '<div class="empty-state">Завантажую список…</div>';
  try {
    const response = await fetch("/api/projects");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    projectsPath.textContent = `Папка: ${result.outputRoot}`;
    projectBadge.textContent = String(result.items.length);
    projectsEmpty.hidden = result.items.length > 0;
    projectsList.innerHTML = "";
    for (const project of result.items) {
      const card = document.createElement("article");
      card.className = "project-card";
      const health = project.failed || project.broken ? "warning" : "success";
      card.innerHTML = `
        <div class="project-main">
          <span class="health ${health}"></span>
          <div><h3>${project.domain}</h3><p>${project.timestamp || "дата невідома"} · ${new Date(project.completedAt).toLocaleString("uk-UA")}</p></div>
        </div>
        <div class="project-stats"><span>${project.downloaded}/${project.total} файлів</span><span>${formatBytes(project.size)}</span><span>${project.failed} помилок</span></div>
        <div class="project-actions"></div>`;
      const actions = card.querySelector(".project-actions");
      const open = document.createElement("button");
      open.type = "button"; open.textContent = "Відкрити"; open.addEventListener("click", () => openProjectFolder(project.id));
      const report = document.createElement("button");
      report.type = "button"; report.className = "ghost"; report.textContent = "Звіт і помилки";
      report.disabled = !project.hasReport; report.addEventListener("click", () => showProjectReport(project.id, project.domain));
      const repair = document.createElement("button");
      repair.type = "button"; repair.className = "ghost"; repair.textContent = "Відновити JS/CSS";
      repair.disabled = !project.hasReport;
      repair.addEventListener("click", () => repairProject(project.id, project.domain, repair));
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "danger"; remove.textContent = "Видалити";
      remove.addEventListener("click", () => deleteProject(project.id, project.domain));
      const archivarixLink = document.createElement("a");
      archivarixLink.className = "button-link";
      archivarixLink.textContent = "Нативний ZIP Archivarix";
      archivarixLink.title = "Пакет зі structure.db для звичайного імпортера Archivarix CMS";
      archivarixLink.href = `/api/projects/${encodeURIComponent(project.id)}/archivarix`;
      const exportLink = document.createElement("a");
      exportLink.className = "button-link ghost";
      exportLink.textContent = "Експорт проєкту";
      exportLink.title = "Повний проєкт для перенесення в цю програму; не для Archivarix CMS";
      exportLink.href = `/api/projects/${encodeURIComponent(project.id)}/export`;
      const more = document.createElement("details");
      more.className = "action-menu";
      const moreSummary = document.createElement("summary");
      moreSummary.textContent = "Інші дії";
      const morePanel = document.createElement("div");
      morePanel.className = "action-menu-panel";
      morePanel.append(report, repair, exportLink, remove);
      more.append(moreSummary, morePanel);
      actions.append(open, archivarixLink, more);
      projectsList.appendChild(card);
    }
  } catch (error) {
    projectsList.innerHTML = `<div class="empty-state error">${error.message}</div>`;
  }
}

async function importZip(input, endpoint) {
  const file = input.files[0];
  if (!file) return;
  const response = await fetch(`${endpoint}?name=${encodeURIComponent(file.name.replace(/\.zip$/i, ""))}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  const result = await response.json();
  input.value = "";
  if (!response.ok) throw new Error(result.error || "Імпорт не виконано.");
  return result;
}

async function loadLibrary() {
  libraryList.innerHTML = '<div class="empty-state">Завантажую бібліотеку…</div>';
  try {
    const response = await fetch("/api/library");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    libraryBadge.textContent = String(result.stats.files);
    librarySummary.textContent = `${result.stats.files} файлів · ${formatBytes(result.stats.bytes)} · ${result.stats.urls} URL · ${result.stats.portableSignatures || 0} міжсайтових сигнатур`;
    await loadLibrarySyncStatus();
    libraryFamilies.innerHTML = Object.entries(result.stats.families || {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `<span>${name} <b>${count}</b></span>`).join("");
    cachedLibraryItems = result.items || [];
    libraryFamilyFilter.innerHTML = '<option value="">Усі типи</option>' + Object.keys(result.stats.families || {})
      .sort((a, b) => a.localeCompare(b))
      .map((name) => `<option value="${name.replace(/"/g, "&quot;")}">${name}</option>`).join("");
    renderLibraryItems();
    if (!result.items.length) libraryList.innerHTML = '<div class="empty-state">Бібліотека порожня. Вона наповниться автоматично під час відновлення.</div>';
  } catch (error) {
    libraryList.innerHTML = `<div class="empty-state error">${error.message}</div>`;
  }
}

function renderLibraryItems() {
  const query = librarySearch.value.trim().toLowerCase();
  const family = libraryFamilyFilter.value;
  const filtered = cachedLibraryItems.filter((asset) => {
    if (family && asset.family !== family) return false;
    return !query || `${asset.family || ""} ${asset.firstUrl || ""} ${asset.key || ""}`.toLowerCase().includes(query);
  });
  libraryVisibleCount.textContent = `${filtered.length} із ${cachedLibraryItems.length}`;
  libraryList.innerHTML = "";
  for (const asset of filtered.slice(0, 300)) {
      const row = document.createElement("article");
      row.className = "library-item";
      row.innerHTML = `<div><strong>${asset.family || "Other"}</strong><p>${asset.firstUrl || asset.key}</p></div><div class="asset-meta"><span>${formatBytes(asset.bytes || 0)}</span><span>${asset.urls || 0} URL</span></div>`;
      const remove = document.createElement("button");
      remove.className = "danger mini"; remove.type = "button"; remove.textContent = "Видалити";
      remove.addEventListener("click", async () => {
        if (!confirm(`Видалити ресурс із бібліотеки?\n${asset.firstUrl || asset.key}`)) return;
        await fetch(`/api/library/${encodeURIComponent(asset.key)}`, { method: "DELETE" });
        loadLibrary();
      });
      row.appendChild(remove);
      libraryList.appendChild(row);
  }
  if (!filtered.length && cachedLibraryItems.length) {
    libraryList.innerHTML = '<div class="empty-state">За цим фільтром нічого не знайдено.</div>';
  }
}

function showLibrarySyncStatus(result) {
  librarySyncStatus.className = "sync-status";
  if (!result.configured && !result.sharedFolder) {
    librarySyncStatus.textContent = "Синхронізацію не налаштовано. Виберіть спільну папку Google Drive у налаштуваннях.";
    return;
  }
  if (result.status === "error" || result.error) {
    librarySyncStatus.classList.add("error");
    librarySyncStatus.textContent = `Помилка синхронізації: ${result.lastError || result.error}`;
    return;
  }
  if (result.status === "syncing") {
    librarySyncStatus.classList.add("busy");
    librarySyncStatus.textContent = "Синхронізація бібліотеки…";
    return;
  }
  librarySyncStatus.classList.add("success");
  const time = result.lastSyncAt ? new Date(result.lastSyncAt).toLocaleString("uk-UA") : "ще не виконувалась";
  librarySyncStatus.textContent = `${result.deviceName || "Цей ПК"} · остання синхронізація: ${time} · передано ${result.uploaded || 0}, отримано ${result.downloaded || 0}`;
}

async function loadLibrarySyncStatus() {
  try {
    const response = await fetch("/api/library/sync");
    const result = await response.json();
    showLibrarySyncStatus(result);
  } catch (error) {
    showLibrarySyncStatus({ status: "error", error: error.message });
  }
}

async function runLibrarySync(action, button) {
  const originalText = button.textContent;
  syncLibraryButton.disabled = true;
  pullLibraryButton.disabled = true;
  button.textContent = "Синхронізую…";
  showLibrarySyncStatus({ configured: true, status: "syncing" });
  try {
    const response = await fetch("/api/library/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Синхронізація не виконана.");
    showLibrarySyncStatus(result);
    appendActivity(`Бібліотеку синхронізовано: передано ${result.uploaded}, отримано ${result.downloaded} файлів.`, "success");
    await loadLibrary();
  } catch (error) {
    showLibrarySyncStatus({ status: "error", error: error.message });
  } finally {
    syncLibraryButton.disabled = false;
    pullLibraryButton.disabled = false;
    button.textContent = originalText;
  }
}

async function loadSettings() {
  try {
    const response = await fetch("/api/settings");
    const settings = await response.json();
    for (const name of ["outputRoot", "librarySyncFolder", "syncDeviceName", "syncDirection", "syncIntervalMinutes", "completeness", "limit", "concurrency"]) {
      settingsForm.elements[name].value = settings[name] ?? "";
    }
    for (const name of ["createZip", "useAssetCache", "allowCdnFallback", "syncOnStart", "syncAfterRestore"]) {
      settingsForm.elements[name].checked = Boolean(settings[name]);
    }
    resolvedOutputRoot.textContent = `Поточна папка: ${settings.resolvedOutputRoot}`;
    restoreForm.elements.completeness.value = settings.completeness;
    restoreForm.elements.limit.value = settings.limit;
    restoreForm.elements.concurrency.value = settings.concurrency;
    restoreForm.elements.createZip.checked = settings.createZip;
    restoreForm.elements.useAssetCache.checked = settings.useAssetCache;
    restoreForm.elements.allowCdnFallback.checked = settings.allowCdnFallback;
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(settingsForm));
  for (const name of ["createZip", "useAssetCache", "allowCdnFallback", "syncOnStart", "syncAfterRestore"]) {
    values[name] = settingsForm.elements[name].checked;
  }
  const response = await fetch("/api/settings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
  });
  const result = await response.json();
  settingsStatus.textContent = response.ok ? "Налаштування збережено." : `Помилка: ${result.error}`;
  if (response.ok) {
    resolvedOutputRoot.textContent = `Поточна папка: ${result.resolvedOutputRoot}`;
    await loadSettings();
    await loadProjects();
  }
});

chooseSyncFolderButton.addEventListener("click", async () => {
  syncSettingsStatus.textContent = "Відкриваю вибір папки…";
  const response = await fetch("/api/library/select-folder", { method: "POST" });
  const result = await response.json();
  if (!response.ok) return void (syncSettingsStatus.textContent = `Помилка: ${result.error}`);
  if (result.folder) {
    settingsForm.elements.librarySyncFolder.value = result.folder;
    syncSettingsStatus.textContent = "Папку обрано. Натисніть «Перевірити підключення», потім збережіть налаштування.";
  } else {
    syncSettingsStatus.textContent = "Вибір папки скасовано.";
  }
});

testSyncFolderButton.addEventListener("click", async () => {
  syncSettingsStatus.textContent = "Перевіряю доступ до спільної папки…";
  const response = await fetch("/api/library/sync/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folder: settingsForm.elements.librarySyncFolder.value }),
  });
  const result = await response.json();
  if (!response.ok) return void (syncSettingsStatus.textContent = `Помилка: ${result.error}`);
  const free = result.freeBytes == null ? "невідомо" : formatBytes(result.freeBytes);
  syncSettingsStatus.textContent = `Підключення працює · доступний запис · комп’ютерів у бібліотеці: ${result.devices} · вільно: ${free}`;
});

openSyncFolderButton.addEventListener("click", async () => {
  const response = await fetch("/api/library/open-sync-folder", { method: "POST" });
  const result = await response.json();
  syncSettingsStatus.textContent = response.ok ? `Відкрито: ${result.folder}` : `Помилка: ${result.error}`;
});

refreshProjectsButton.addEventListener("click", loadProjects);
importProjectButton.addEventListener("click", () => projectImportFile.click());
projectImportFile.addEventListener("change", async () => {
  try { await importZip(projectImportFile, "/api/projects/import"); await loadProjects(); }
  catch (error) { alert(error.message); }
});
refreshLibraryButton.addEventListener("click", loadLibrary);
librarySearch.addEventListener("input", renderLibraryItems);
libraryFamilyFilter.addEventListener("change", renderLibraryItems);
syncLibraryButton.addEventListener("click", () => runLibrarySync("both", syncLibraryButton));
pullLibraryButton.addEventListener("click", () => runLibrarySync("pull", pullLibraryButton));
importLibraryButton.addEventListener("click", () => libraryImportFile.click());
libraryImportFile.addEventListener("change", async () => {
  try { await importZip(libraryImportFile, "/api/library/import"); await loadLibrary(); }
  catch (error) { alert(error.message); }
});
closeReport.addEventListener("click", () => reportDialog.close());
copyReport.addEventListener("click", () => navigator.clipboard.writeText(reportContent.textContent));

function startClock() {
  clearInterval(clockTimer);
  operationStartedAt = Date.now();
  liveDot.classList.add("active");
  const update = () => {
    const seconds = Math.floor((Date.now() - operationStartedAt) / 1000);
    elapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };
  update();
  clockTimer = setInterval(update, 1000);
}

function stopClock() {
  clearInterval(clockTimer);
  liveDot.classList.remove("active");
}

function revealActivity(title, hint) {
  progressPanel.hidden = false;
  statusText.textContent = title;
  stageHint.textContent = hint;
  progressPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function detectLogType(message, requested = "") {
  if (requested) return requested;
  if (/помил|критич|недоступ|failed|broken/i.test(message)) return "error";
  if (/готов|знайден|успіш|обран|відновлено|збережено/i.test(message)) return "success";
  if (/поперед|залишено|відсутн|зупинен/i.test(message)) return "warning";
  return "info";
}

function appendActivity(message, type = "") {
  activityLines.push({
    time: new Date().toLocaleTimeString("uk-UA"),
    message: String(message),
    type: detectLogType(message, type),
  });
  if (activityLines.length > 600) activityLines.shift();
  const fragment = document.createDocumentFragment();
  for (const line of activityLines) {
    const row = document.createElement("div");
    row.className = `log-line ${line.type}`;
    const time = document.createElement("time");
    time.textContent = line.time;
    const mark = document.createElement("span");
    mark.className = "log-mark";
    mark.textContent = line.type === "error" ? "×" : line.type === "success" ? "✓" : line.type === "warning" ? "!" : "•";
    const text = document.createElement("span");
    text.textContent = line.message.replace(/^\d{1,2}:\d{2}:\d{2}\s+—\s+/, "");
    row.append(time, mark, text);
    fragment.appendChild(row);
  }
  logs.replaceChildren(fragment);
  logCount.textContent = `${activityLines.length} повідомлень`;
  logs.scrollTop = logs.scrollHeight;
}

function resetProgress() {
  metricDownloaded.textContent = "0";
  metricCache.textContent = "0";
  metricCdn.textContent = "0";
  metricErrors.textContent = "0";
  counter.textContent = "0 / 0";
  progress.max = 1;
  progress.value = 0;
  knownServerLogs = new Set();
}

function selectAutomaticSnapshot(items, periodFrom, periodTo) {
  if (!items.length) return null;
  const from = periodFrom ? Date.parse(`${periodFrom}T00:00:00Z`) : -Infinity;
  const to = periodTo ? Date.parse(`${periodTo}T23:59:59Z`) : Infinity;
  const inPeriod = items.filter((item) => {
    const time = Date.parse(`${item.date}T00:00:00Z`);
    return time >= from && time <= to;
  });
  return inPeriod[0] || null;
}

function archiveTimestampFromInput(value) {
  const match = String(value || "").match(/web\.archive\.org\/web\/(\d{8,14})/i);
  return match ? match[1] : "";
}

fetch("/api/cache/stats").then((response) => response.json()).then((stats) => {
  vaultStatus.textContent = `Локальний склад: ${stats.files} файлів, ${(stats.bytes / 1024 / 1024).toFixed(1)} МБ, ${stats.urls} URL`;
}).catch(() => {
  vaultStatus.textContent = "Локальний склад буде наповнений під час першого відновлення.";
});
loadProjects();
loadLibrary();
loadSettings();

restoreForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(timer);
  startClock();
  restoreButton.disabled = true;
  openFolder.hidden = true;
  cancel.hidden = false;
  appearance.hidden = true;
  resetProgress();
  revealActivity("Аналізую сайт…", "Автоматично підбираю архівне джерело, потрібне лише для відновлення вигляду.");
  appendActivity(`Починаю повне відновлення ${domain.value}`);
  searchStatus.textContent = "Шукаю найкраще архівне джерело…";

  try {
    const forceRemote = fromDate.value || toDate.value ? "&forceRemote=1" : "";
    const snapshotResponse = await fetch(`/api/snapshots?domain=${encodeURIComponent(domain.value)}${forceRemote}`);
    const snapshotResult = await snapshotResponse.json();
    if (!snapshotResponse.ok) throw new Error(snapshotResult.error);
    const requestedArchiveTimestamp = archiveTimestampFromInput(domain.value);
    const requestedDate = requestedArchiveTimestamp
      ? `${requestedArchiveTimestamp.slice(0, 4)}-${requestedArchiveTimestamp.slice(4, 6)}-${requestedArchiveTimestamp.slice(6, 8)}`
      : "";
    if (requestedDate) {
      fromDate.value = requestedDate;
      toDate.value = requestedDate;
    }
    if (fromDate.value && toDate.value && fromDate.value > toDate.value) {
      throw new Error("Початок періоду не може бути пізніше його завершення.");
    }
    let selected = selectAutomaticSnapshot(snapshotResult.items, fromDate.value, toDate.value);
    if (!selected) throw new Error("У вказаному періоді немає архівних копій. Розширте період або залиште його порожнім.");
    if (requestedArchiveTimestamp) {
      selected = {
        ...selected,
        timestamp: requestedArchiveTimestamp,
        date: requestedDate,
      };
    }
    if (!selected) throw new Error("Internet Archive не містить придатної копії головної сторінки.");

    chosenDate.textContent = selected.date;
    chosenTimestamp.textContent = selected.timestamp;
    previewLink.href = `https://web.archive.org/web/${selected.timestamp}/${selected.original}`;
    appearance.hidden = false;
    searchStatus.textContent = `Автоматично обрано архівну дату ${selected.date}.`;
    const sourceLabels = { "availability-api": "Availability API", "local-project": "локальний попередній проєкт", "local-library": "локальна бібліотека без мережі", "wayback-url": "дата з Wayback URL" };
    appendActivity(`Архівне джерело вигляду: ${selected.date} (${selected.timestamp})${selected.source ? ` · ${sourceLabels[selected.source] || selected.source}` : ""}`, "success");

    const values = Object.fromEntries(new FormData(restoreForm));
    values.timestamp = selected.timestamp;
    values.snapshotSource = selected.source || "cdx";
    values.includeSubdomains = restoreForm.elements.includeSubdomains.checked;
    values.useAssetCache = restoreForm.elements.useAssetCache.checked;
    values.allowCdnFallback = restoreForm.elements.allowCdnFallback.checked;
    values.createZip = restoreForm.elements.createZip.checked;
    revealActivity("Готую список файлів…", "Шукаю HTML, CSS, JavaScript, шрифти, зображення та файли плагінів.");
    appendActivity(`Режим: ${restoreForm.elements.completeness.selectedOptions[0].textContent}`);

    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    jobId = result.id;
    appendActivity(`Завдання створено: ${jobId.slice(0, 8)}`);
    poll();
  } catch (error) {
    statusText.textContent = "Відновлення не розпочалося";
    stageHint.textContent = "Причина показана в журналі нижче.";
    searchStatus.textContent = `Помилка: ${error.message}`;
    appendActivity(error.message, "error");
    restoreButton.disabled = false;
    cancel.hidden = true;
    stopClock();
  }
});

async function poll() {
  clearTimeout(timer);
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error);
    counter.textContent = `${job.completed} / ${job.total}`;
    progress.max = Math.max(1, job.total);
    progress.value = job.completed;
    for (const line of job.logs || []) {
      if (knownServerLogs.has(line)) continue;
      knownServerLogs.add(line);
      appendActivity(line.replace(/^\d{1,2}:\d{2}:\d{2}\s+—\s+/, ""));
    }
    metricDownloaded.textContent = String(Math.max(0, job.completed - (job.failed || 0)));
    metricCache.textContent = String(job.cacheHits || 0);
    metricCdn.textContent = String(job.cdnHits || 0);
    metricErrors.textContent = String(job.failed || 0);
    const labels = {
      queued: "У черзі…",
      running: "Відновлюю сайт…",
      done: "Сайт відновлено",
      cancelled: "Зупинено",
      error: "Помилка",
    };
    statusText.textContent = job.error ? `${labels[job.status]}: ${job.error}` : labels[job.status];
    const phaseLabels = {
      inventory: "Формую повний перелік архівних файлів",
      download: "Завантажую основні файли",
      dependencies: `Дозавантажую залежності ${job.currentStep || 0}/${job.currentStepTotal || 0}`,
      audit: "Перевіряю CSS, JS, зображення та биті посилання",
    };
    stageHint.textContent = job.status === "running"
      ? `${phaseLabels[job.phase] || "Працюю"}: ${job.currentFile ? job.currentFile.replace(/^https?:\/\//, "") : "підготовка"}`
      : job.status === "done"
        ? "Результат, ZIP та manifest готові. Натисніть «Відкрити результат»."
        : job.status === "error"
          ? "Причина записана в журналі; уже завантажені файли не видалено."
          : stageHint.textContent;
    if (job.status === "done" && (job.criticalFailed || job.brokenReferences)) {
      statusText.textContent += ` — CSS/JS: ${job.criticalFailed || 0}, биті залежності: ${job.brokenReferences || 0}`;
    }
    if (job.status === "done" && (job.cacheHits || job.cdnHits)) {
      statusText.textContent += `; склад: ${job.cacheHits || 0}, CDN: ${job.cdnHits || 0}`;
    }
    if (["done", "cancelled", "error"].includes(job.status)) {
      restoreButton.disabled = false;
      cancel.hidden = true;
      if (job.outputFolder) {
        openFolder.hidden = false;
        openFolder.dataset.folder = job.outputFolder;
      }
      appendActivity(
        job.status === "done" ? "Відновлення завершено" : `Завдання завершилося: ${labels[job.status]}`,
        job.status === "done" ? "success" : "warning"
      );
      loadProjects();
      loadLibrary();
      stopClock();
      return;
    }
    timer = setTimeout(poll, 1000);
  } catch (error) {
    statusText.textContent = "Втрачено з’єднання";
    stageHint.textContent = "Перезапустіть програму та повторіть завдання.";
    appendActivity(`Локальна програма не відповідає: ${error.message}`, "error");
    restoreButton.disabled = false;
    cancel.hidden = true;
    stopClock();
  }
}

cancel.addEventListener("click", () => {
  if (!jobId) return;
  appendActivity("Надіслано запит на зупинку", "warning");
  fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
});

openFolder.addEventListener("click", () => openProjectFolder(openFolder.dataset.folder));

copyLogs.addEventListener("click", async () => {
  const text = activityLines.map((line) => `${line.time} — ${line.message}`).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copyLogs.textContent = "Скопійовано";
    setTimeout(() => { copyLogs.textContent = "Копіювати журнал"; }, 1500);
  } catch {
    appendActivity("Браузер не дозволив скопіювати журнал", "warning");
  }
});

clearLogs.addEventListener("click", () => {
  activityLines = [];
  logs.replaceChildren();
  logCount.textContent = "0 повідомлень";
  appendActivity("Журнал очищено");
});
