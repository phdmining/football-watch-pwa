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

/* ===================== 打分：z-score标准化 + logistic压缩 + 关注球队加成 ===================== */
function zscore(raw, dim) {
  const st = scheduleData.dimensionStats[dim] || { mean: 0.5, std: 0.2 };
  const std = st.std > 0.001 ? st.std : 0.2;
  return (raw - st.mean) / std;
}

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

function computeScore(match) {
  const w = scheduleData.weights;
  const bd = match.breakdown;
  let zTotal = 0;
  for (const dim in w) {
    zTotal += (w[dim] || 0) * zscore(bd[dim] || 0.5, dim);
  }
  // k=1.1 是经验取值：让 z_total 在约±2.5个标准差时贴近 0/100 两端，中段分布类似正态曲线的S形映射
  let total = logistic(zTotal, 1.1);

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
  const tier = influenceTier(name);
  const logo = scheduleData.teamLogos && scheduleData.teamLogos[name];
  const logoHtml = logo ? `<img class="team-crest" src="${logo}" alt="" width="16" height="16">` : "";
  return `${logoHtml}<span class="team-name ${tier}">${name}</span>`;
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
    const watchedItems = items.filter(i => i.watchRank >= 0)
      .sort((a, b) => a.watchRank - b.watchRank || a.startTs - b.startTs);
    const forced = (settings.forceFavorite && watchedItems.length) ? watchedItems[0] : null;
    const { planA, planB } = twoPlans(items, forced);

    html += `<section class="day-section">
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
  }
  content.innerHTML = html;

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
  document.getElementById("settingsPanel").classList.add("open");
}

function bindSettingsEvents() {
  document.getElementById("settingsToggle").addEventListener("click", () => {
    const panel = document.getElementById("settingsPanel");
    if (panel.classList.contains("open")) { panel.classList.remove("open"); }
    else { openSettingsPanel(); }
  });

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
  });
}

/* ===================== 启动 ===================== */
async function init() {
  bindSettingsEvents();

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

  try {
    render();
  } catch (e) {
    document.getElementById("content").innerHTML =
      `<div class="empty-state">页面渲染出错了：${e.message}<br>试试强制刷新页面（下拉刷新，或者关掉标签页重新打开）。</div>`;
    console.error(e);
  }
}

init();
