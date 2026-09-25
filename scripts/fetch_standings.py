"""
获取积分榜（football-data.org: /v4/competitions/{code}/standings）
返回统一格式: { comp_code: { team_name: {position, playedGames, points, form, total_teams} } }
"""
import json
import os

from utils import cache_get, cache_set, http_get_json, RateLimiter

MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mock_data")

_rate_limiter = RateLimiter(min_interval_sec=6.5)


def _load_mock_standings(comp_code: str):
    path = os.path.join(MOCK_DIR, f"standings_{comp_code}.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["standings"]


def _fetch_real_standings(comp_code: str, api_key: str):
    _rate_limiter.wait()
    url = f"https://api.football-data.org/v4/competitions/{comp_code}/standings"
    headers = {"X-Auth-Token": api_key}
    data = http_get_json(url, headers=headers)
    return data.get("standings", [])


def get_standings(competitions: dict, mock_mode: bool, api_key: str, cache_ttl_days: int = 1):
    result = {}
    for comp_code in competitions:
        if mock_mode:
            standings_raw = _load_mock_standings(comp_code)
        else:
            cached = cache_get("standings", comp_code, cache_ttl_days)
            if cached is not None:
                standings_raw = cached
            else:
                standings_raw = _fetch_real_standings(comp_code, api_key)
                cache_set("standings", comp_code, standings_raw)

        # 取第一个 TOTAL / LEAGUE_STAGE 类型的表
        table = []
        for block in standings_raw:
            if block.get("type") in ("TOTAL", "LEAGUE_STAGE") or not table:
                table = block.get("table", [])
                if block.get("type") in ("TOTAL", "LEAGUE_STAGE"):
                    break

        total_teams = len(table)
        team_map = {}
        for row in table:
            name = row["team"]["name"]
            team_map[name] = {
                "position": row["position"],
                "playedGames": row.get("playedGames", 0),
                "points": row.get("points", 0),
                "won": row.get("won", 0),
                "draw": row.get("draw", 0),
                "lost": row.get("lost", 0),
                "form": row.get("form") or "",
                "total_teams": total_teams,
            }
        result[comp_code] = team_map

    return result
