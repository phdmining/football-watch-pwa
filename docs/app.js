/* ===================== 状态与持久化 ===================== */
const STORAGE_KEY = "football_watch_settings_v1";

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { cityTz: null, leagues: null, favoriteTeam: "", forceFavorite: true };
}
function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {}
}

let settings = loadSettings();
let scheduleData = null;
let cityList = [];

const FAVORITE_BONUS_POINTS = 20; // 主队比赛的独立加分（不稀释其他维度权重）

/* ===================== 时区工具 ===================== */
function deviceTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch (e) { return "UTC"; }
}

function effectiveTimezone() {
  return settings.cityTz || deviceTimezone();
}

// 把UTC时间字符串按目标时区拆成 {year, month, day, hour, minute}
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

function weekdayCn(dateStr, tz) {
  const d = new Date(dateStr + "T12:00:00Z"); // 用正午避免跨天误差
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
  const map = { Monday: "周一", Tuesday: "周二", Wednesday: "周三", Thursday: "周四", Friday: "周五", Saturday: "周六", Sunday: "周日" };
  return map[wd] || wd;
}

/* ===================== 打分重算（含主队加成） ===================== */
function computeScore(match) {
  const w = scheduleData.weights;
  const bd = match.breakdown;
  let base = 0;
  for (const k in w) { base += (w[k] || 0) * (bd[k] || 0); }
  base = base * 100;

  const isFavorite = settings.favoriteTeam &&
    (match.homeTeam.name === settings.favoriteTeam || match.awayTeam.name === settings.favoriteTeam);

  let total = base;
  if (isFavorite) total = Math.min(100, total + FAVORITE_BONUS_POINTS);

  return { total: Math.round(total * 10) / 10, isFavorite };
}

function reasonTags(match, isFavorite) {
  const tags = [];
  if (match.isTopDerby) tags.push({ cls: "derby", text: match.derbyLabel || "顶级德比" });
  if (match.isBigClubClash) tags.push({ cls: "derby", text: "豪门内战" });
  if (isFavorite) tags.push({ cls: "derby", text: "⭐ 我的主队" });
  return tags;
}

/* ===================== 带权区间调度（方案A/B） ===================== */
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

function twoPlans(dayItems, forcedFavoriteItem) {
  let planA;
  if (forcedFavoriteItem) {
    const compatible = dayItems.filter(it =>
      it !== forcedFavoriteItem && (it.endTs <= forcedFavoriteItem.startTs || it.startTs >= forcedFavoriteItem.endTs));
    const rest = bestNonOverlapping(compatible);
    const selected = [forcedFavoriteItem, ...rest.selected].sort((a, b) => a.startTs - b.startTs);
    planA = { selected, score: forcedFavoriteItem.score + rest.score };
  } else {
    planA = bestNonOverlapping(dayItems);
  }
  const usedSet = new Set(planA.selected);
  const remaining = dayItems.filter(it => !usedSet.has(it));
  const planB = bestNonOverlapping(remaining);
  return { planA, planB };
}

/* ===================== 数据准备 ===================== */
function selectedLeagueCodes() {
  if (settings.leagues && settings.leagues.length) return settings.leagues;
  return Object.keys(scheduleData.competitions);
}

function buildDayGroups() {
  const tz = effectiveTimezone();
  const leagues = new Set(selectedLeagueCodes());
  const groups = {}; // dateStr -> items[]

  for (const m of scheduleData.matches) {
    if (!leagues.has(m.competition.code)) continue;
    const p = partsInTz(m.utcDate, tz);
    const { total, isFavorite } = computeScore(m);
    const startTs = p.timestamp;
    const endTs = startTs + scheduleData.matchDurationMinutes * 60 * 1000;

    const item = {
      match: m, score: total, isFavorite,
      startTs, endTs,
      startLabel: `${p.hh}:${p.mm}`,
      endLabel: formatHHMM(new Date(endTs).toISOString(), tz),
    };
    if (!groups[p.dateStr]) groups[p.dateStr] = [];
    groups[p.dateStr].push(item);
  }
  return groups;
}

/* ===================== 渲染 ===================== */
function matchCardHtml(item) {
  const m = item.match;
  const homeCls = item.isFavorite && m.homeTeam.name === settings.favoriteTeam ? "fav" : "";
  const awayCls = item.isFavorite && m.awayTeam.name === settings.favoriteTeam ? "fav" : "";
  const tags = reasonTags(m, item.isFavorite);
  const tagsHtml = tags.map(t => `<span class="tag ${t.cls}">${t.text}</span>`).join("");
  return `
    <div class="match-card">
      <div class="match-top-row">
        <span class="match-time">${item.startLabel}–${item.endLabel}</span>
        <span class="match-score">推荐指数 <b>${item.score}</b>/100</span>
      </div>
      <div class="match-teams">
        <span class="${homeCls}">${m.homeTeam.name}</span> vs <span class="${awayCls}">${m.awayTeam.name}</span>
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
    const homeCls = it.isFavorite && m.homeTeam.name === settings.favoriteTeam ? "fav" : "";
    const awayCls = it.isFavorite && m.awayTeam.name === settings.favoriteTeam ? "fav" : "";
    return `<tr>
      <td>${it.startLabel}</td><td>${it.endLabel}</td>
      <td>${m.competition.name}</td>
      <td class="teams"><span class="${homeCls}">${m.homeTeam.name}</span> vs <span class="${awayCls}">${m.awayTeam.name}</span></td>
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

function render() {
  const content = document.getElementById("content");
  if (!scheduleData) {
    content.innerHTML = `<div class="loading-state">正在加载赛程数据…</div>`;
    return;
  }
  const groups = buildDayGroups();
  const dateStrs = Object.keys(groups).sort();

  if (dateStrs.length === 0) {
    content.innerHTML = `<div class="empty-state">选中的联赛在未来这段时间内暂无赛程，试试勾选更多联赛。</div>`;
    return;
  }

  let html = "";
  for (const dateStr of dateStrs) {
    const items = groups[dateStr];
    const favItems = items.filter(i => i.isFavorite);
    const forced = (settings.forceFavorite && favItems.length) ? favItems[0] : null;
    const { planA, planB } = twoPlans(items, forced);

    html += `<section class="day-section">
      <h2 class="day-heading">${dateStr} <span class="weekday">${weekdayCn(dateStr)}</span></h2>`;

    if (favItems.length) {
      html += blockHtml("favorite", "⭐ 我的主队今日比赛", favItems, false);
    }
    html += blockHtml("plan-a", "🌟 推荐观赛方案 A（无冲突，总分最高）", planA.selected);
    if (planB.selected.length) {
      html += blockHtml("plan-b", "🔄 备选方案 B（无冲突，方案A之外的最佳组合）", planB.selected);
    }
    html += fullTableHtml(items);
    html += `</section>`;
  }
  content.innerHTML = html;

  const footer = document.getElementById("metaFooter");
  const genDate = new Date(scheduleData.generatedAt);
  footer.textContent = `数据更新于 ${genDate.toLocaleString("zh-CN", { timeZone: effectiveTimezone() })} · 比赛时长按${scheduleData.matchDurationMinutes}分钟估算`;
}

/* ===================== 设置面板交互 ===================== */
function populateCitySelect() {
  const sel = document.getElementById("citySelect");
  sel.innerHTML = `<option value="">使用设备时区（自动）</option>` +
    cityList.map(c => `<option value="${c.tz}">${c.city} ${c.cityEn}</option>`).join("");
  sel.value = settings.cityTz || "";
}

function populateLeagueGrid() {
  const grid = document.getElementById("leagueGrid");
  const selected = new Set(selectedLeagueCodes());
  grid.innerHTML = Object.entries(scheduleData.competitions).map(([code, name]) => `
    <label class="league-chip">
      <input type="checkbox" value="${code}" ${selected.has(code) ? "checked" : ""}>
      ${name.split(" ")[0]}
    </label>`).join("");
  grid.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => {
      const checked = [...grid.querySelectorAll("input:checked")].map(x => x.value);
      settings.leagues = checked;
      saveSettings(settings);
      populateFavoriteTeamSelect();
      render();
    });
  });
}

function populateFavoriteTeamSelect() {
  const sel = document.getElementById("favoriteTeamSelect");
  const leagues = selectedLeagueCodes();
  const teams = new Set();
  leagues.forEach(code => (scheduleData.teamsByCompetition[code] || []).forEach(t => teams.add(t)));
  const sortedTeams = [...teams].sort();
  sel.innerHTML = `<option value="">不设置</option>` +
    sortedTeams.map(t => `<option value="${t}" ${t === settings.favoriteTeam ? "selected" : ""}>${t}</option>`).join("");
}

function updateTzHint() {
  document.getElementById("currentTzHint").textContent = `当前使用时区：${effectiveTimezone()}`;
}

function bindSettingsEvents() {
  document.getElementById("settingsToggle").addEventListener("click", () => {
    document.getElementById("settingsPanel").classList.toggle("open");
  });

  document.getElementById("citySelect").addEventListener("change", (e) => {
    settings.cityTz = e.target.value || null;
    saveSettings(settings);
    updateTzHint();
    render();
  });

  document.getElementById("autoLocateBtn").addEventListener("click", () => {
    settings.cityTz = null; // null 代表跟随设备时区
    saveSettings(settings);
    document.getElementById("citySelect").value = "";
    updateTzHint();
    render();
  });

  document.getElementById("favoriteTeamSelect").addEventListener("change", (e) => {
    settings.favoriteTeam = e.target.value;
    saveSettings(settings);
    render();
  });

  document.getElementById("forceFavoriteCheckbox").addEventListener("change", (e) => {
    settings.forceFavorite = e.target.checked;
    saveSettings(settings);
    render();
  });
}

/* ===================== 启动 ===================== */
async function init() {
  bindSettingsEvents();
  document.getElementById("forceFavoriteCheckbox").checked = settings.forceFavorite !== false;

  try {
    const [scheduleRes, cityRes] = await Promise.all([
      fetch("schedule.json", { cache: "no-cache" }),
      fetch("city_timezones.json", { cache: "no-cache" }),
    ]);
    scheduleData = await scheduleRes.json();
    cityList = await cityRes.json();
  } catch (e) {
    document.getElementById("content").innerHTML =
      `<div class="empty-state">赛程数据加载失败，检查一下网络，或者稍后重试。</div>`;
    return;
  }

  populateCitySelect();
  populateLeagueGrid();
  populateFavoriteTeamSelect();
  updateTzHint();
  render();
}

init();
