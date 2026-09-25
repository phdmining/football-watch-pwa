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
from fetch_h2h import get_h2h, get_skip_stats
from fetch_teams import get_team_city_coords
from derby import evaluate_derby
from recommend import score_match, build_reason_text

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
    "form_ranking": 0.30,
    "h2h_history": 0.20,
    "derby": 0.10,
    "big_club_clash": 0.05,
    "title_relevance": 0.25,
    "third_party_impact": 0.10,
}
CACHE_TTL_DAYS = {"fixtures": 1, "standings": 1, "h2h": 90, "teams": 180}


def main():
    mock_mode = os.environ.get("MOCK_MODE", "true").lower() == "true"
    fd_key = os.environ.get("FOOTBALL_DATA_API_KEY", "")
    af_key = os.environ.get("API_FOOTBALL_KEY", "")

    if not mock_mode and (not fd_key or not af_key):
        print("错误：MOCK_MODE=false 时必须设置 FOOTBALL_DATA_API_KEY / API_FOOTBALL_KEY 环境变量")
        sys.exit(1)

    print(f"[1/4] 拉取赛程（未来 {DAYS_AHEAD} 天，mock_mode={mock_mode}）...")
    fixtures = get_fixtures(COMPETITIONS, DAYS_AHEAD, mock_mode, fd_key,
                             cache_ttl_days=CACHE_TTL_DAYS["fixtures"])
    total_matches = sum(len(v) for v in fixtures.values())
    print(f"      -> 共 {total_matches} 场比赛")

    print("[2/4] 拉取积分榜...")
    standings = get_standings(COMPETITIONS, mock_mode, fd_key,
                               cache_ttl_days=CACHE_TTL_DAYS["standings"])

    print("[3/4] 逐场计算打分（不含主队加成，前端再叠加）...")
    matches_out = []
    teams_by_comp = defaultdict(set)
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

            result = score_match(match, comp_code, comp_standings, h2h_data,
                                  coords1, coords2, WEIGHTS, DERBY_DISTANCE_KM)
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

    print("[4/4] 写入 docs/schedule.json ...")
    output = {
        "generatedAt": datetime.now(dt_timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "daysAhead": DAYS_AHEAD,
        "matchDurationMinutes": MATCH_DURATION_MINUTES,
        "weights": WEIGHTS,
        "competitions": COMPETITIONS,
        "teamsByCompetition": {k: sorted(v) for k, v in teams_by_comp.items()},
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
