"""
定时任务入口：拉取赛程/排名/历史交锋，计算各维度打分（不含"主队加成"，
主队加成在浏览器端算），导出成一份 docs/schedule.json 供PWA前端读取。

用法：
    python3 scripts/export_schedule_json.py

环境变量（GitHub Actions里用Secrets注入）：
    MOCK_MODE=true/false
    FOOTBALL_DATA_API_KEY
    API_FOOTBALL_KEY
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone as dt_timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_fixtures import get_fixtures
from fetch_standings import get_standings
from fetch_h2h import get_h2h, get_skip_stats, get_team_extra_info
from fetch_teams import get_team_city_coords
from derby import evaluate_derby
from recommend import score_match, build_reason_text, get_club_influence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ---- 配置（也可以以后挪进一个yaml文件，这里先简单写死+支持环境变量覆盖） ----
COMPETITIONS = {
    "PL": "英超 Premier League",
    "PD": "西甲 La Liga",
    "SA": "意甲 Serie A",
    "BL1": "德甲 Bundesliga",
    "FL1": "法甲 Ligue 1",
    "CL": "欧冠 UEFA Champions League",
}
DAYS_AHEAD = 30
DERBY_DISTANCE_KM = 50
MATCH_DURATION_MINUTES = 120
WEIGHTS = {
    "form_ranking": 0.22,
    "h2h_history": 0.15,
    "derby": 0.08,
    "big_club_clash": 0.04,
    "title_relevance": 0.20,
    "third_party_impact": 0.08,
    "club_influence": 0.15,
    "stadium_scale": 0.08,
}
CACHE_TTL_DAYS = {"fixtures": 1, "standings": 1, "h2h": 90, "teams": 180}

DIMENSIONS = list(WEIGHTS.keys())
HALF_LIFE_DAYS = 60      # 遗忘因子半衰期：60天前的样本权重衰减到一半
COLD_START_MIN_SAMPLES = 200   # 少于这个样本数，用理论默认值兜底，不用不可靠的小样本统计


SEASON_START_MONTH = 8   # 每年8月1日作为赛季分界（可按需调整）


def season_key_for_date(utc_date_str: str) -> str:
    """把一个UTC时间字符串映射到所属赛季，如 '2026-27'"""
    d = datetime.fromisoformat(utc_date_str.replace("Z", "+00:00"))
    y = d.year if d.month >= SEASON_START_MONTH else d.year - 1
    return f"{y}-{str((y + 1) % 100).zfill(2)}"


def load_season_archive(history_dir: str, season: str) -> dict:
    path = os.path.join(history_dir, f"season_{season}.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_season_archive(history_dir: str, season: str, data: dict):
    path = os.path.join(history_dir, f"season_{season}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def update_season_archives(history_dir: str, matches_out: list) -> set:
    """
    把本次算出的比赛按赛季分组，以比赛ID为key去重更新进对应赛季归档文件
    （同一场比赛被多次扫到，只保留最新一次快照，避免重复计数）。
    返回本次涉及到的赛季集合。
    """
    by_season = defaultdict(dict)
    for m in matches_out:
        season = season_key_for_date(m["utcDate"])
        by_season[season][str(m["id"])] = {
            "utcDate": m["utcDate"],
            "competition": m["competition"]["code"],
            "breakdown": m["breakdown"],
        }

    touched_seasons = set()
    for season, new_entries in by_season.items():
        archive = load_season_archive(history_dir, season)
        archive.update(new_entries)   # 按比赛ID覆盖更新，新快照替换旧的
        save_season_archive(history_dir, season, archive)
        touched_seasons.add(season)
    return touched_seasons


def rebuild_history_index(history_dir: str):
    """扫描所有赛季归档文件，生成索引，供前端统计面板的赛季下拉列表使用"""
    seasons_info = []
    for fname in sorted(os.listdir(history_dir)):
        if not (fname.startswith("season_") and fname.endswith(".json")):
            continue
        season = fname[len("season_"):-len(".json")]
        try:
            with open(os.path.join(history_dir, fname), "r", encoding="utf-8") as f:
                archive = json.load(f)
        except Exception:
            continue
        if not archive:
            continue
        dates = [m["utcDate"][:10] for m in archive.values()]
        comps = sorted(set(m["competition"] for m in archive.values()))
        seasons_info.append({
            "season": season,
            "matchCount": len(archive),
            "dateFrom": min(dates),
            "dateTo": max(dates),
            "competitions": comps,
        })
    seasons_info.sort(key=lambda s: s["season"])

    with open(os.path.join(history_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"seasons": seasons_info}, f, ensure_ascii=False, indent=2)
    return seasons_info


def compute_dimension_stats(history_dir: str, today_str: str):
    """
    读取所有赛季归档文件，按"比赛日期距今天数"用指数遗忘因子加权，
    计算每个维度的加权均值/标准差，供前端做z-score标准化。
    返回 (dimension_stats, samples_used, cold_start)
    """
    import math
    today = datetime.strptime(today_str, "%Y-%m-%d")
    weighted_values = {d: [] for d in DIMENSIONS}
    total_samples = 0

    for fname in os.listdir(history_dir):
        if not (fname.startswith("season_") and fname.endswith(".json")):
            continue
        try:
            with open(os.path.join(history_dir, fname), "r", encoding="utf-8") as f:
                archive = json.load(f)
        except Exception:
            continue

        for m in archive.values():
            bd = m.get("breakdown", {})
            try:
                mdate = datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00")).replace(tzinfo=None)
            except Exception:
                continue
            age_days = max(0, (today - mdate).days)   # 未来的比赛(负数)按0天算，权重最高
            decay = 0.5 ** (age_days / HALF_LIFE_DAYS)

            total_samples += 1
            for d in DIMENSIONS:
                if d in bd:
                    weighted_values[d].append((bd[d], decay))

    cold_start = total_samples < COLD_START_MIN_SAMPLES
    stats = {}
    for d in DIMENSIONS:
        pairs = weighted_values[d]
        if cold_start or not pairs:
            stats[d] = {"mean": 0.5, "std": 0.2}
            continue
        wsum = sum(w for _, w in pairs)
        mean = sum(v * w for v, w in pairs) / wsum
        var = sum(w * (v - mean) ** 2 for v, w in pairs) / wsum
        std = math.sqrt(var)
        if std < 0.05:
            std = 0.05
        stats[d] = {"mean": round(mean, 4), "std": round(std, 4)}

    return stats, total_samples, cold_start


def main():
    mock_mode = os.environ.get("MOCK_MODE", "true").lower() == "true"
    fd_key = os.environ.get("FOOTBALL_DATA_API_KEY", "")
    af_key = os.environ.get("API_FOOTBALL_KEY", "")

    if not mock_mode and (not fd_key or not af_key):
        print("错误：MOCK_MODE=false 时必须设置 FOOTBALL_DATA_API_KEY / API_FOOTBALL_KEY 环境变量")
        sys.exit(1)

    print(f"[1/5] 拉取赛程（未来 {DAYS_AHEAD} 天，mock_mode={mock_mode}）...")
    fixtures = get_fixtures(COMPETITIONS, DAYS_AHEAD, mock_mode, fd_key,
                             cache_ttl_days=CACHE_TTL_DAYS["fixtures"])
    total_matches = sum(len(v) for v in fixtures.values())
    print(f"      -> 共 {total_matches} 场比赛")

    print("[2/5] 拉取积分榜...")
    standings = get_standings(COMPETITIONS, mock_mode, fd_key,
                               cache_ttl_days=CACHE_TTL_DAYS["standings"])

    print("[3/5] 逐场计算打分（不含主队加成，前端再叠加）...")
    matches_out = []
    teams_by_comp = defaultdict(set)
    team_logos = {}
    team_capacity = {}
    processed = 0

    for comp_code, matches in fixtures.items():
        comp_name = COMPETITIONS[comp_code]
        comp_standings = standings.get(comp_code, {})

        for match in matches:
            processed += 1
            home_name = match["homeTeam"]["name"]
            away_name = match["awayTeam"]["name"]
            home_id = match["homeTeam"]["id"]
            away_id = match["awayTeam"]["id"]

            if processed % 20 == 0 or processed == total_matches:
                print(f"      [{processed}/{total_matches}] ...")

            teams_by_comp[comp_code].add(home_name)
            teams_by_comp[comp_code].add(away_name)

            coords1 = get_team_city_coords(home_name, mock_mode)
            coords2 = get_team_city_coords(away_name, mock_mode)

            h2h_data = get_h2h(home_name, home_id, away_name, away_id,
                                mock_mode, af_key, ttl_days=CACHE_TTL_DAYS["h2h"])

            # 场馆容量+队徽：跟H2H查询共用同一次球队搜索调用，不额外消耗配额
            home_extra = get_team_extra_info(home_name, mock_mode, af_key)
            if home_extra.get("logo"):
                team_logos[home_name] = home_extra["logo"]
            if home_extra.get("capacity"):
                team_capacity[home_name] = home_extra["capacity"]

            result = score_match(match, comp_code, comp_standings, h2h_data,
                                  coords1, coords2, WEIGHTS, DERBY_DISTANCE_KM,
                                  home_capacity=home_extra.get("capacity"))
            reason = build_reason_text(match, result)

            matches_out.append({
                "id": match["id"],
                "utcDate": match["utcDate"],
                "competition": {"code": comp_code, "name": comp_name},
                "homeTeam": {"id": home_id, "name": home_name},
                "awayTeam": {"id": away_id, "name": away_name},
                "breakdown": result["breakdown"],       # 各维度0~1原始分，前端用来重新加权
                "baseScore": result["total_score"],       # 服务端按默认权重算出的基准分（不含主队加成）
                "derbyLabel": result["derby_info"]["derby_label"],
                "isTopDerby": result["derby_info"]["is_top_derby"],
                "isBigClubClash": result["derby_info"]["is_big_club_clash"],
                "reason": reason,
            })

    quota_exceeded, skipped = get_skip_stats()
    if quota_exceeded:
        print(f"      [提示] api-sports.io配额耗尽，{skipped}次调用被跳过（已用中性分兜底）")

    # 俱乐部影响力表（每支出现过的球队都给一个值，前端用来做视觉分档）
    all_team_names = set()
    for names in teams_by_comp.values():
        all_team_names.update(names)
    club_influence_map = {name: round(get_club_influence(name), 3) for name in all_team_names}

    print("[4/5] 归档本次打分结果（按赛季+比赛ID去重），计算统计量...")
    history_dir = os.path.join(ROOT, "docs", "history")
    os.makedirs(history_dir, exist_ok=True)
    today_str = datetime.now(dt_timezone.utc).strftime("%Y-%m-%d")

    touched_seasons = update_season_archives(history_dir, matches_out)
    seasons_info = rebuild_history_index(history_dir)
    print(f"      -> 更新了赛季归档: {', '.join(sorted(touched_seasons)) or '(无)'}；"
          f"当前共有 {len(seasons_info)} 个赛季有记录")

    dimension_stats, samples_used, cold_start = compute_dimension_stats(history_dir, today_str)
    if cold_start:
        print(f"      [提示] 历史样本仅 {samples_used} 场，数据积累中，"
              f"暂时用理论默认值(均值0.5/标准差0.2)做标准化，样本积累到一定量后会自动切换成真实统计值。")
    else:
        print(f"      -> 用了 {samples_used} 场历史样本（含遗忘因子加权）计算标准化统计量")

    current_season = season_key_for_date(datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT00:00:00Z"))

    print("[5/5] 写入 docs/schedule.json ...")
    output = {
        "generatedAt": datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "daysAhead": DAYS_AHEAD,
        "matchDurationMinutes": MATCH_DURATION_MINUTES,
        "weights": WEIGHTS,
        "competitions": COMPETITIONS,
        "teamsByCompetition": {k: sorted(v) for k, v in teams_by_comp.items()},
        "clubInfluence": club_influence_map,
        "teamLogos": team_logos,
        "teamCapacity": team_capacity,
        "dimensionStats": dimension_stats,   # {dim: {mean, std}}，前端用来做z-score标准化
        "statsColdStart": cold_start,
        "statsSampleCount": samples_used,
        "currentSeason": current_season,
        "matches": matches_out,
    }

    docs_dir = os.path.join(ROOT, "docs")
    os.makedirs(docs_dir, exist_ok=True)
    out_path = os.path.join(docs_dir, "schedule.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n完成！共 {len(matches_out)} 场比赛，写入 {out_path}")


if __name__ == "__main__":
    main()
