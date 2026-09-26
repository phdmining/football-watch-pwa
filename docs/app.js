/* ===================== 状态与持久化 ===================== */
const STORAGE_KEY = "football_watch_settings_v2";

function defaultSettings() {
  return { cityTz: null, leagues: null, watchedTeams: [], forceFavorite: true };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return Object.assign(defaultSettings(), JSON.parse(raw));
  } catch (e) {}
  return defaultSettings();
}
function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

let settings = loadSettings();   // 已生效的设置（渲染依据）
let draft = null;                // 设置面板里正在编辑、尚未确认的草稿
let scheduleData = null;
let cityList = [];

// 关注球队按优先级递减的独立加分（不稀释其他维度权重），超出档位数的都按最后一档算
const WATCH_BONUS_TIERS = [20, 14, 10, 6];

/* ===================== 时区工具 ===================== */
function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch (e) { return "UTC"; }
}
function effectiveTimezone(s) {
  return (s || settings).cityTz || deviceTimezone();
}
function partsInTz(utcDateStr, tz) {
  const d = new Date(utcDateStr);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = {};
  fmt.formatToParts(d).forEach(p => { if (p.type !== "literal") parts[p.type] = p.value; });
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hh: parts.hour, mm: parts.minute,
    timestamp: d.getTime(),
  };
}
function formatHHMM(utcDateStr, tz) {
  const p = partsInTz(utcDateStr, tz);
  return `${p.hh}:${p.mm}`;
}
function weekdayCn(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  const map = { Monday: "周一", Tuesday: "周二", Wednesday: "周三", Thursday: "周四", Friday: "周五", Saturday: "周六", Sunday: "周日" };
  return map[wd] || wd;
}

// 跟后端 export_schedule_json.py 的 season_key_for_date 保持一致：每年8月1日为赛季分界
function seasonKeyForDate(utcDateStr) {
  const d = new Date(utcDateStr);
  const y = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/* ===================== 打分：z-score标准化 + logistic压缩 + 关注球队加成 ===================== */
function logistic(x, k) {
  return 100 / (1 + Math.exp(-k * x));
}

function watchRankFor(match) {
  const list = settings.watchedTeams || [];
  for (let i = 0; i < list.length; i++) {
    if (match.homeTeam.name === list[i] || match.awayTeam.name === list[i]) return i;
  }
  return -1;
}

function scoreBase(breakdown, weights, dimensionStats) {
  let zTotal = 0;
  for (const dim in weights) {
    const st = (dimensionStats && dimensionStats[dim]) || { mean: 0.5, std: 0.2 };
    const std = st.std > 0.001 ? st.std : 0.2;
    const raw = breakdown[dim] !== undefined ? breakdown[dim] : 0.5;
    zTotal += (weights[dim] || 0) * ((raw - st.mean) / std);
  }
  return logistic(zTotal, 1.1);
}

function computeScore(match) {
  let total = scoreBase(match.breakdown, scheduleData.weights, scheduleData.dimensionStats);
  const rank = watchRankFor(match);
  if (rank >= 0) {
    const bonus = WATCH_BONUS_TIERS[Math.min(rank, WATCH_BONUS_TIERS.length - 1)];
    total = Math.min(100, total + bonus);
  }
  return { total: Math.round(total * 10) / 10, watchRank: rank };
}

/* ===================== 俱乐部影响力分层 ===================== */
function influenceTier(teamName) {
  const v = (scheduleData.clubInfluence && scheduleData.clubInfluence[teamName]) || 0.25;
  if (v >= 0.75) return "tier-gold";
  if (v >= 0.5) return "tier-silver";
  return "tier-normal";
}

function reasonTags(match, watchRank) {
  const tags = [];
  if (match.isTopDerby) tags.push({ cls: "derby", text: "⚔️ " + (match.derbyLabel || "顶级德比") });
  if (match.isBigClubClash) tags.push({ cls: "bigclub", text: "👑 豪门内战" });
  if (watchRank >= 0) tags.push({ cls: "fav", text: `⭐ 关注球队 #${watchRank + 1}` });
  return tags;
}

/* ===================== 带权区间调度（方案A/B），逻辑不变 ===================== */
function bestNonOverlapping(items) {
  if (items.length === 0) return { selected: [], score: 0 };
  const sorted = [...items].sort((a, b) => a.endTs - b.endTs);
  const n = sorted.length;
  const p = sorted.map((it, i) => {
    let lo = 0, hi = i - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].endTs <= it.startTs) { result = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return result;
  });
  const opt = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const idx = i - 1;
    const include = sorted[idx].score + (p[idx] >= 0 ? opt[p[idx] + 1] : 0);
    opt[i] = Math.max(include, opt[i - 1]);
  }
  const selected = [];
  let i = n;
  while (i > 0) {
    const idx = i - 1;
    const include = sorted[idx].score + (p[idx] >= 0 ? opt[p[idx] + 1] : 0);
    if (include >= opt[i - 1]) { selected.push(sorted[idx]); i = p[idx] + 1; }
    else { i -= 1; }
  }
  selected.sort((a, b) => a.startTs - b.startTs);
  return { selected, score: opt[n] };
}

function twoPlans(dayItems, forcedItem) {
  let planA;
  if (forcedItem) {
    const compatible = dayItems.filter(it =>
      it !== forcedItem && (it.endTs <= forcedItem.startTs || it.startTs >= forcedItem.endTs));
    const rest = bestNonOverlapping(compatible);
    const selected = [forcedItem, ...rest.selected].sort((a, b) => a.startTs - b.startTs);
    planA = { selected, score: forcedItem.score + rest.score };
  } else {
    planA = bestNonOverlapping(dayItems);
  }
  const usedSet = new Set(planA.selected);
  const remaining = dayItems.filter(it => !usedSet.has(it));
  const planB = bestNonOverlapping(remaining);
  return { planA, planB };
}

/* ===================== 数据准备 ===================== */
function selectedLeagueCodes(s) {
  const st = s || settings;
  if (st.leagues && st.leagues.length) return st.leagues;
  return Object.keys(scheduleData.competitions);
}

function buildDayGroups() {
  const tz = effectiveTimezone();
  const leagues = new Set(selectedLeagueCodes());
  const watched = new Set(settings.watchedTeams || []);
  const groups = {};

  for (const m of scheduleData.matches) {
    const inLeague = leagues.has(m.competition.code);
    const isWatchedTeamMatch = watched.has(m.homeTeam.name) || watched.has(m.awayTeam.name);
    if (!inLeague && !isWatchedTeamMatch) continue; // 关注球队的比赛即使联赛没勾选也照常显示

    const p = partsInTz(m.utcDate, tz);
    const { total, watchRank } = computeScore(m);
    const startTs = p.timestamp;
    const endTs = startTs + scheduleData.matchDurationMinutes * 60 * 1000;

    const item = {
      match: m, score: total, watchRank,
      startTs, endTs,
      startLabel: `${p.hh}:${p.mm}`,
      endLabel: formatHHMM(new Date(endTs).toISOString(), tz),
    };
    if (!groups[p.dateStr]) groups[p.dateStr] = [];
    groups[p.dateStr].push(item);
  }
  return groups;
}

/* ===================== 渲染：比赛卡片 ===================== */
function teamNameHtml(name) {
  const isWatched = (settings.watchedTeams || []).includes(name);
  const tier = isWatched ? "tier-watched" : influenceTier(name);
  const logo = scheduleData.teamLogos && scheduleData.teamLogos[name];
  const logoHtml = logo ? `<img class="team-crest" src="${logo}" alt="" width="16" height="16">` : "";
  const star = isWatched ? "★ " : "";
  return `${logoHtml}<span class="team-name ${tier}">${star}${name}</span>`;
}

function matchCardHtml(item) {
  const m = item.match;
  const tags = reasonTags(m, item.watchRank);
  const tagsHtml = tags.map(t => `<span class="tag ${t.cls}">${t.text}</span>`).join("");
  return `
    <div class="match-card">
      <div class="match-top-row">
        <span class="match-time">${item.startLabel}–${item.endLabel}</span>
        <span class="match-score">推荐指数 <b>${item.score}</b>/100</span>
      </div>
      <div class="match-teams">
        ${teamNameHtml(m.homeTeam.name)} vs ${teamNameHtml(m.awayTeam.name)}
      </div>
      <div class="match-meta">
        <span class="tag comp">${m.competition.name}</span>
        ${tagsHtml}
        <span class="tag reason">${m.reason}</span>
      </div>
    </div>`;
}

function blockHtml(cls, title, items, showScore) {
  if (!items.length) return "";
  const scoreHtml = showScore !== false
    ? ` <span class="score-total">合计 ${Math.round(items.reduce((s, i) => s + i.score, 0) * 10) / 10}</span>`
    : "";
  return `
    <div class="block ${cls}">
      <p class="block-title">${title}${scoreHtml}</p>
      ${items.map(matchCardHtml).join("")}
    </div>`;
}

function fullTableHtml(items) {
  const sorted = [...items].sort((a, b) => a.startTs - b.startTs);
  const rows = sorted.map(it => {
    const m = it.match;
    return `<tr>
      <td>${it.startLabel}</td><td>${it.endLabel}</td>
      <td>${m.competition.name}</td>
      <td class="teams">${teamNameHtml(m.homeTeam.name)} vs ${teamNameHtml(m.awayTeam.name)}</td>
      <td>${it.score}</td>
    </tr>`;
  }).join("");
  return `
    <details class="full-toggle">
      <summary>查看今日全部 ${items.length} 场比赛</summary>
      <table class="full-table">
        <thead><tr><th>开始</th><th>结束</th><th>赛事</th><th>对阵</th><th>指数</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
}

function dayOffset(dateStr, todayStr) {
  const a = new Date(todayStr + "T00:00:00Z");
  const b = new Date(dateStr + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

function dayRangeMatches(tabName, offset) {
  if (tabName === "today") return offset >= 0 && offset <= 1;
  if (tabName === "week") return offset >= 2 && offset <= 6;
  if (tabName === "month") return offset >= 7;
  return true;
}

function renderDaySection(dateStr, items) {
  const watchedItems = items.filter(i => i.watchRank >= 0)
    .sort((a, b) => a.startTs - b.startTs);
  const forced = (settings.forceFavorite && watchedItems.length)
    ? watchedItems.slice().sort((a, b) => a.watchRank - b.watchRank)[0]  // 冲突时仍优先"关注优先级最高"的那场强制进方案A
    : null;
  const { planA, planB } = twoPlans(items, forced);

  let html = `<section class="day-section">
    <h2 class="day-heading">${dateStr} <span class="weekday">${weekdayCn(dateStr)}</span></h2>`;
  if (watchedItems.length) {
    html += blockHtml("favorite", "⭐ 关注球队今日比赛", watchedItems, false);
  }
  html += blockHtml("plan-a", "🌟 推荐观赛方案 A（无冲突，总分最高）", planA.selected);
  if (planB.selected.length) {
    html += blockHtml("plan-b", "🔄 备选方案 B（无冲突，方案A之外的最佳组合）", planB.selected);
  }
  html += fullTableHtml(items);
  html += `</section>`;
  return html;
}

function renderScheduleTab(tabName, groups, todayStr) {
  const content = document.getElementById(`content-${tabName}`);
  if (!content) return;

  const dateStrs = Object.keys(groups).sort()
    .filter(d => dayRangeMatches(tabName, dayOffset(d, todayStr)));

  if (dateStrs.length === 0) {
    content.innerHTML = `<div class="empty-state">这个时间段内没有符合条件的比赛，试试在"设置"里勾选更多联赛。</div>`;
    return;
  }
  content.innerHTML = dateStrs.map(d => renderDaySection(d, groups[d])).join("");
}

function render() {
  if (!scheduleData) {
    ["today", "week", "month"].forEach(t => {
      const el = document.getElementById(`content-${t}`);
      if (el) el.innerHTML = `<div class="loading-state">正在加载赛程数据…</div>`;
    });
    return;
  }
  const tz = effectiveTimezone();
  const todayStr = partsInTz(new Date().toISOString(), tz).dateStr;
  const groups = buildDayGroups();

  if (Object.keys(groups).length === 0) {
    ["today", "week", "month"].forEach(t => {
      document.getElementById(`content-${t}`).innerHTML =
        `<div class="empty-state">选中的联赛在未来这段时间内暂无赛程，试试勾选更多联赛。</div>`;
    });
    return;
  }

  renderScheduleTab("today", groups, todayStr);
  renderScheduleTab("week", groups, todayStr);
  renderScheduleTab("month", groups, todayStr);

  const footer = document.getElementById("metaFooter");
  const genDate = new Date(scheduleData.generatedAt);
  const statsNote = scheduleData.statsColdStart
    ? "（打分标准化模型数据积累中，暂用理论默认值）"
    : `（打分标准化基于${scheduleData.statsSampleCount}场历史样本，含遗忘因子）`;
  footer.textContent = `数据更新于 ${genDate.toLocaleString("zh-CN", { timeZone: effectiveTimezone() })} · `
    + `比赛时长按${scheduleData.matchDurationMinutes}分钟估算 ${statsNote}`;
}

/* ===================== 设置面板：草稿 + 确认 ===================== */
function cloneSettings(s) { return JSON.parse(JSON.stringify(s)); }

function isDirty() {
  return JSON.stringify(draft) !== JSON.stringify(settings);
}

function refreshDirtyUI() {
  const hint = document.getElementById("dirtyHint");
  const btn = document.getElementById("confirmSettingsBtn");
  const dirty = isDirty();
  hint.textContent = dirty ? "● 有未保存的更改" : "";
  btn.disabled = !dirty;
}

function populateCitySelect() {
  const sel = document.getElementById("citySelect");
  sel.innerHTML = `<option value="">使用设备时区（自动）</option>` +
    cityList.map(c => `<option value="${c.tz}">${c.city} ${c.cityEn}</option>`).join("");
  sel.value = draft.cityTz || "";
}

function populateLeagueGrid() {
  const grid = document.getElementById("leagueGrid");
  const selected = new Set(selectedLeagueCodes(draft));
  grid.innerHTML = Object.entries(scheduleData.competitions).map(([code, name]) => `
    <label class="league-chip">
      <input type="checkbox" value="${code}" ${selected.has(code) ? "checked" : ""}>
      ${name.split(" ")[0]}
    </label>`).join("");
  grid.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => {
      draft.leagues = [...grid.querySelectorAll("input:checked")].map(x => x.value);
      refreshDirtyUI();
    });
  });
}

function allTeamsFlat() {
  const out = [];
  for (const [code, names] of Object.entries(scheduleData.teamsByCompetition)) {
    const compName = scheduleData.competitions[code];
    names.forEach(n => out.push({ name: n, comp: compName }));
  }
  return out;
}

function renderWatchedTeamList() {
  const box = document.getElementById("watchedTeamList");
  const list = draft.watchedTeams || [];
  box.innerHTML = list.map((name, i) => {
    const logo = scheduleData.teamLogos && scheduleData.teamLogos[name];
    const logoHtml = logo ? `<img src="${logo}" alt="">` : "";
    return `
      <div class="watched-team-row" data-idx="${i}">
        <span class="rank-badge">${i + 1}</span>
        ${logoHtml}
        <span class="name">${name}</span>
        <button data-action="up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button data-action="down" ${i === list.length - 1 ? "disabled" : ""}>↓</button>
        <button data-action="remove">✕</button>
      </div>`;
  }).join("");

  box.querySelectorAll(".watched-team-row").forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    row.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "up" && idx > 0) {
          [draft.watchedTeams[idx - 1], draft.watchedTeams[idx]] = [draft.watchedTeams[idx], draft.watchedTeams[idx - 1]];
        } else if (action === "down" && idx < draft.watchedTeams.length - 1) {
          [draft.watchedTeams[idx + 1], draft.watchedTeams[idx]] = [draft.watchedTeams[idx], draft.watchedTeams[idx + 1]];
        } else if (action === "remove") {
          draft.watchedTeams.splice(idx, 1);
        }
        renderWatchedTeamList();
        refreshDirtyUI();
      });
    });
  });
}

function bindTeamSearch() {
  const input = document.getElementById("teamSearchInput");
  const results = document.getElementById("teamSearchResults");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.innerHTML = ""; return; }
    const all = allTeamsFlat().filter(t => t.name.toLowerCase().includes(q));
    const already = new Set(draft.watchedTeams || []);
    results.innerHTML = all.slice(0, 8).map(t => {
      const logo = scheduleData.teamLogos && scheduleData.teamLogos[t.name];
      const logoHtml = logo ? `<img src="${logo}" alt="">` : "";
      const disabled = already.has(t.name);
      return `<div class="team-result-row" data-name="${t.name}" style="${disabled ? 'opacity:.4' : ''}">
        ${logoHtml}<span>${t.name}</span><span class="team-comp-tag">${t.comp.split(" ")[0]}${disabled ? " · 已关注" : ""}</span>
      </div>`;
    }).join("");
    results.querySelectorAll(".team-result-row").forEach(row => {
      row.addEventListener("click", () => {
        const name = row.dataset.name;
        if (!draft.watchedTeams) draft.watchedTeams = [];
        if (!draft.watchedTeams.includes(name)) draft.watchedTeams.push(name);
        input.value = "";
        results.innerHTML = "";
        renderWatchedTeamList();
        refreshDirtyUI();
      });
    });
  });
}

function updateTzHint() {
  document.getElementById("currentTzHint").textContent = `当前使用时区：${effectiveTimezone(draft)}`;
}

function openSettingsPanel() {
  draft = cloneSettings(settings);
  populateCitySelect();
  populateLeagueGrid();
  renderWatchedTeamList();
  document.getElementById("forceFavoriteCheckbox").checked = draft.forceFavorite !== false;
  updateTzHint();
  refreshDirtyUI();
}

function bindSettingsEvents() {
  document.getElementById("citySelect").addEventListener("change", (e) => {
    draft.cityTz = e.target.value || null;
    updateTzHint();
    refreshDirtyUI();
  });

  document.getElementById("autoLocateBtn").addEventListener("click", () => {
    draft.cityTz = null;
    document.getElementById("citySelect").value = "";
    updateTzHint();
    refreshDirtyUI();
  });

  document.getElementById("forceFavoriteCheckbox").addEventListener("change", (e) => {
    draft.forceFavorite = e.target.checked;
    refreshDirtyUI();
  });

  bindTeamSearch();

  document.getElementById("confirmSettingsBtn").addEventListener("click", () => {
    settings = cloneSettings(draft);
    saveSettings(settings);
    refreshDirtyUI();
    render();
    switchTab("today");
  });
}

/* ===================== 统计面板 ===================== */
let statsLeagues = null;          // null = 未初始化，会在打开面板时取settings.leagues
let historyIndexCache = null;     // docs/history/index.json 缓存
const seasonArchiveCache = {};    // season -> {matchId: {...}}

async function fetchHistoryIndex() {
  if (historyIndexCache) return historyIndexCache;
  try {
    const res = await fetch("history/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("no index");
    historyIndexCache = await res.json();
  } catch (e) {
    historyIndexCache = { seasons: [] };
  }
  return historyIndexCache;
}

async function fetchSeasonArchive(season) {
  if (seasonArchiveCache[season]) return seasonArchiveCache[season];
  try {
    const res = await fetch(`history/season_${season}.json`, { cache: "no-cache" });
    if (!res.ok) throw new Error("not found");
    const data = await res.json();
    seasonArchiveCache[season] = data;
    return data;
  } catch (e) {
    seasonArchiveCache[season] = {};
    return {};
  }
}

function populateStatsLeagueGrid() {
  const grid = document.getElementById("statsLeagueGrid");
  const selected = new Set(statsLeagues || selectedLeagueCodes());
  grid.innerHTML = Object.entries(scheduleData.competitions).map(([code, name]) => `
    <label class="league-chip">
      <input type="checkbox" value="${code}" ${selected.has(code) ? "checked" : ""}>
      ${name.split(" ")[0]}
    </label>`).join("");
  grid.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => {
      statsLeagues = [...grid.querySelectorAll("input:checked")].map(x => x.value);
    });
  });
}

async function openStatsPanel() {
  if (!statsLeagues) statsLeagues = selectedLeagueCodes();
  populateStatsLeagueGrid();

  // 清掉上次动态插入的具体赛季选项，重新拉取最新索引插入
  const sel = document.getElementById("statsRangeSelect");
  sel.querySelectorAll('option[data-dynamic="1"]').forEach(o => o.remove());

  const index = await fetchHistoryIndex();
  const currentSeason = scheduleData.currentSeason;
  const pastSeasons = index.seasons.filter(s => s.season !== currentSeason).sort((a, b) => b.season.localeCompare(a.season));
  const allOpt = sel.querySelector('option[value="all"]');
  pastSeasons.forEach(s => {
    const opt = document.createElement("option");
    opt.value = `season:${s.season}`;
    opt.textContent = `${s.season} 赛季（${s.matchCount}场）`;
    opt.dataset.dynamic = "1";
    sel.insertBefore(opt, allOpt);
  });
}

/**
 * 把 "matches" 数组（可能来自 scheduleData.matches 或赛季归档）统一成
 * {id, utcDate, competitionCode, breakdown} 的形状，方便后续合并去重。
 */
function normalizeFromSchedule(matches) {
  return matches.map(m => ({
    id: String(m.id), utcDate: m.utcDate,
    competitionCode: m.competition.code, breakdown: m.breakdown,
  }));
}
function normalizeFromArchive(archiveObj) {
  return Object.entries(archiveObj).map(([id, m]) => ({
    id, utcDate: m.utcDate, competitionCode: m.competition, breakdown: m.breakdown,
  }));
}

function mergeDedupe(...lists) {
  const map = new Map();
  // 后面的list优先覆盖前面的（scheduleData.matches最新鲜，放最后）
  for (const list of lists) {
    for (const item of list) map.set(item.id, item);
  }
  return [...map.values()];
}

async function gatherMatchesForRange(range, customFrom, customTo) {
  const liveNormalized = normalizeFromSchedule(scheduleData.matches);

  if (range === "future30") {
    return liveNormalized;
  }

  if (range === "currentSeason") {
    const season = scheduleData.currentSeason;
    const archive = await fetchSeasonArchive(season);
    return mergeDedupe(normalizeFromArchive(archive), liveNormalized);
  }

  if (range === "all") {
    const index = await fetchHistoryIndex();
    const lists = [];
    for (const s of index.seasons) {
      const archive = await fetchSeasonArchive(s.season);
      lists.push(normalizeFromArchive(archive));
    }
    lists.push(liveNormalized);
    return mergeDedupe(...lists);
  }

  if (range.startsWith("season:")) {
    const season = range.slice("season:".length);
    const archive = await fetchSeasonArchive(season);
    const archived = normalizeFromArchive(archive);
    // 如果选中的正好是本赛季，把最新鲜的live数据也合并进来
    return season === scheduleData.currentSeason ? mergeDedupe(archived, liveNormalized) : archived;
  }

  if (range === "custom") {
    const index = await fetchHistoryIndex();
    const from = customFrom, to = customTo;
    const lists = [];
    for (const s of index.seasons) {
      // 只拉取时间范围有重叠的赛季文件，节省流量
      if (to && s.dateFrom > to) continue;
      if (from && s.dateTo < from) continue;
      const archive = await fetchSeasonArchive(s.season);
      lists.push(normalizeFromArchive(archive));
    }
    lists.push(liveNormalized);
    let merged = mergeDedupe(...lists);
    merged = merged.filter(m => {
      const d = m.utcDate.slice(0, 10);
      if (from && d < from) return false;
      if (to && d > to) return false;
      return true;
    });
    return merged;
  }

  return liveNormalized;
}

function renderHistogramSvg(counts, binLabels) {
  const W = 600, H = 220, padL = 30, padB = 24, padT = 10, padR = 10;
  const maxCount = Math.max(1, ...counts);
  const barAreaW = W - padL - padR;
  const barW = barAreaW / counts.length;
  const scaleY = (H - padT - padB) / maxCount;

  let bars = "";
  counts.forEach((c, i) => {
    const barH = c * scaleY;
    const x = padL + i * barW + barW * 0.12;
    const w = barW * 0.76;
    const y = H - padB - barH;
    bars += `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${barH.toFixed(1)}" rx="2"></rect>`;
    if (c > 0) {
      bars += `<text class="count-label" x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${c}</text>`;
    }
    bars += `<text class="bar-label" x="${(x + w / 2).toFixed(1)}" y="${H - padB + 14}" text-anchor="middle">${binLabels[i]}</text>`;
  });

  return `<svg class="histogram-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <line class="axis-line" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"></line>
    ${bars}
  </svg>`;
}

function renderStatsResult(matches) {
  const box = document.getElementById("statsResult");
  if (!matches.length) {
    box.innerHTML = `<div class="stats-empty">这个范围内没有符合条件的比赛数据。</div>`;
    return;
  }

  const scores = matches.map(m => scoreBase(m.breakdown, scheduleData.weights, scheduleData.dimensionStats));
  scores.sort((a, b) => a - b);
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0 ? (scores[n / 2 - 1] + scores[n / 2]) / 2 : scores[(n - 1) / 2];
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);

  const bins = new Array(10).fill(0);
  const labels = [];
  for (let i = 0; i < 10; i++) labels.push(`${i * 10}`);
  scores.forEach(s => {
    const idx = Math.min(9, Math.floor(s / 10));
    bins[idx]++;
  });

  box.innerHTML = `
    <div class="stats-summary">
      <span>样本 <b>${n}</b> 场</span>
      <span>平均分 <b>${mean.toFixed(1)}</b></span>
      <span>中位数 <b>${median.toFixed(1)}</b></span>
      <span>标准差 <b>${std.toFixed(1)}</b></span>
    </div>
    ${renderHistogramSvg(bins, labels)}
  `;
}

function bindStatsEvents() {
  document.getElementById("statsRangeSelect").addEventListener("change", (e) => {
    document.getElementById("customRangeRow").style.display =
      e.target.value === "custom" ? "flex" : "none";
  });

  document.getElementById("generateStatsBtn").addEventListener("click", async () => {
    const btn = document.getElementById("generateStatsBtn");
    const range = document.getElementById("statsRangeSelect").value;
    const from = document.getElementById("statsDateFrom").value;
    const to = document.getElementById("statsDateTo").value;

    btn.disabled = true;
    document.getElementById("statsHint").textContent = "正在计算…";
    document.getElementById("statsResult").innerHTML = "";

    try {
      let matches = await gatherMatchesForRange(range, from, to);
      const leagues = new Set(statsLeagues && statsLeagues.length ? statsLeagues : Object.keys(scheduleData.competitions));
      matches = matches.filter(m => leagues.has(m.competitionCode));
      renderStatsResult(matches);
      document.getElementById("statsHint").textContent = "";
    } catch (e) {
      document.getElementById("statsResult").innerHTML =
        `<div class="stats-empty">统计失败：${e.message}</div>`;
      document.getElementById("statsHint").textContent = "";
    }
    btn.disabled = false;
  });
}

/* ===================== Tab切换 ===================== */
let currentTab = "today";
const tabInitialized = new Set();

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll(".tab-page").forEach(el => {
    el.classList.toggle("active", el.dataset.tabPage === tabName);
  });
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  const footer = document.getElementById("metaFooter");
  footer.style.display = ["today", "week", "month"].includes(tabName) ? "" : "none";

  if (!tabInitialized.has(tabName)) {
    tabInitialized.add(tabName);
    if (tabName === "settings") openSettingsPanel();
    if (tabName === "stats") openStatsPanel();
  }
}

function bindTabBar() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

/* ===================== 启动 ===================== */
async function init() {
  bindTabBar();
  bindSettingsEvents();
  bindStatsEvents();

  try {
    const [scheduleRes, cityRes] = await Promise.all([
      fetch("schedule.json", { cache: "no-cache" }),
      fetch("city_timezones.json", { cache: "no-cache" }),
    ]);
    scheduleData = await scheduleRes.json();
    cityList = await cityRes.json();
  } catch (e) {
    document.getElementById("content-today").innerHTML =
      `<div class="empty-state">赛程数据加载失败，检查一下网络，或者稍后重试。</div>`;
    switchTab("today");
    return;
  }

  const seasonOpt = document.querySelector('#statsRangeSelect option[value="currentSeason"]');
  if (seasonOpt && scheduleData.currentSeason) {
    seasonOpt.textContent = `本赛季（${scheduleData.currentSeason}）`;
  }

  try {
    render();
  } catch (e) {
    document.getElementById("content-today").innerHTML =
      `<div class="empty-state">页面渲染出错了：${e.message}<br>试试强制刷新页面（下拉刷新，或者关掉标签页重新打开）。</div>`;
    console.error(e);
  }

  switchTab("today");
}

init();
