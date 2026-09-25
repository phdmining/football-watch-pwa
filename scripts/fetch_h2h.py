"""
获取历史交锋 (api-sports.io: /fixtures/headtohead)

真实模式下，api-sports.io 的球队ID体系跟 football-data.org 不同，
需要先按球队名搜索拿到 api-sports.io 的 team id（结果会缓存，一个赛季基本不变），
再调用 headtohead 端点。

Mock模式下直接读 mock_data/h2h.json（用的是 football-data.org 风格的 team_id，
因为mock数据本身就是自洽生成的，不需要跨系统映射）。
"""
import json
import os

import requests

from utils import cache_get, cache_set, http_get_json, RateLimiter

MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mock_data")

# api-sports.io 免费层 100次/天，这里限速保守一点，避免短时间内打满
_rate_limiter = RateLimiter(min_interval_sec=1.0)

# 一旦遇到429（配额耗尽），本次运行内不再发起新请求，直接返回None，
# 让程序继续跑完剩下的比赛（用None代表"本次没查到H2H"，打分时会给中性分）。
_quota_exceeded = False
_skipped_count = 0

_mock_h2h_cache = None


def _load_mock_h2h():
    global _mock_h2h_cache
    if _mock_h2h_cache is None:
        with open(os.path.join(MOCK_DIR, "h2h.json"), "r", encoding="utf-8") as f:
            _mock_h2h_cache = json.load(f)
    return _mock_h2h_cache


def _pair_key(id1, id2):
    return f"{min(id1, id2)}-{max(id1, id2)}"


def _search_api_football_team_id(team_name: str, api_key: str):
    global _quota_exceeded, _skipped_count
    cached = cache_get("teams", f"af_id_{team_name}", ttl_days=180)
    if cached is not None:
        return cached.get("id")

    if _quota_exceeded:
        _skipped_count += 1
        return None

    _rate_limiter.wait()
    url = "https://v3.football.api-sports.io/teams"
    headers = {"x-apisports-key": api_key}
    try:
        data = http_get_json(url, headers=headers, params={"search": team_name})
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            print("      [提示] api-sports.io 今日免费配额已用完，后续历史交锋数据将跳过，"
                  "报告仍会正常生成（缺H2H的场次打分给中性分）。明天重跑会自动继续补全（有缓存）。")
            _quota_exceeded = True
        else:
            print(f"      [警告] 查询球队ID失败（{team_name}）：{e}，本场跳过H2H数据。")
        _skipped_count += 1
        return None
    except requests.exceptions.RequestException as e:
        print(f"      [警告] 网络请求失败（{team_name}）：{e}，本场跳过H2H数据。")
        _skipped_count += 1
        return None

    results = data.get("response", [])
    if not results:
        cache_set("teams", f"af_id_{team_name}", {"id": None})
        return None
    team_id = results[0]["team"]["id"]
    logo = results[0]["team"].get("logo")
    venue = results[0].get("venue") or {}
    capacity = venue.get("capacity")
    cache_set("teams", f"af_id_{team_name}", {"id": team_id, "logo": logo, "capacity": capacity})
    return team_id


def get_team_extra_info(team_name: str, mock_mode: bool, api_key: str):
    """返回 {"logo": str|None, "capacity": int|None}，跟球队ID查询共用同一次API调用和缓存"""
    if mock_mode:
        try:
            with open(os.path.join(MOCK_DIR, "teams.json"), "r", encoding="utf-8") as f:
                teams = json.load(f)
            t = teams.get(team_name, {})
            return {"logo": None, "capacity": t.get("capacity")}
        except Exception:
            return {"logo": None, "capacity": None}

    cached = cache_get("teams", f"af_id_{team_name}", ttl_days=180)
    if cached is not None:
        return {"logo": cached.get("logo"), "capacity": cached.get("capacity")}
    # 触发一次查询（会顺带写入缓存）
    _search_api_football_team_id(team_name, api_key)
    cached = cache_get("teams", f"af_id_{team_name}", ttl_days=180)
    if cached is not None:
        return {"logo": cached.get("logo"), "capacity": cached.get("capacity")}
    return {"logo": None, "capacity": None}


def _fetch_real_h2h(id1: int, id2: int, api_key: str):
    global _quota_exceeded, _skipped_count
    if _quota_exceeded:
        _skipped_count += 1
        return None

    _rate_limiter.wait()
    url = "https://v3.football.api-sports.io/fixtures/headtohead"
    headers = {"x-apisports-key": api_key}
    try:
        data = http_get_json(url, headers=headers, params={"h2h": f"{id1}-{id2}"})
    except requests.exceptions.HTTPError as e:
        if e.response is not None and e.response.status_code == 429:
            print("      [提示] api-sports.io 今日免费配额已用完，后续历史交锋数据将跳过。")
            _quota_exceeded = True
        else:
            print(f"      [警告] 查询历史交锋失败（id {id1}-{id2}）：{e}，跳过。")
        _skipped_count += 1
        return None
    except requests.exceptions.RequestException as e:
        print(f"      [警告] 网络请求失败（id {id1}-{id2}）：{e}，跳过。")
        _skipped_count += 1
        return None

    fixtures = data.get("response", [])

    team1_wins = team2_wins = draws = 0
    games = []
    for fx in fixtures:
        home_id = fx["teams"]["home"]["id"]
        away_id = fx["teams"]["away"]["id"]
        hs = fx["goals"]["home"]
        aws = fx["goals"]["away"]
        if hs is None or aws is None:
            continue
        if hs == aws:
            draws += 1
        elif (hs > aws and home_id == id1) or (aws > hs and away_id == id1):
            team1_wins += 1
        else:
            team2_wins += 1
        games.append({
            "date": fx["fixture"]["date"][:10],
            "home": fx["teams"]["home"]["name"],
            "away": fx["teams"]["away"]["name"],
            "homeScore": hs, "awayScore": aws,
        })

    return {
        "summary": {
            "team1Wins": team1_wins, "team2Wins": team2_wins,
            "draws": draws, "totalGames": len(games),
        },
        "games": games,
    }


def get_skip_stats():
    """返回 (是否触发过配额限制, 因限流/错误跳过的调用次数)"""
    return _quota_exceeded, _skipped_count


def get_h2h(team1_name: str, team1_id: int, team2_name: str, team2_id: int,
            mock_mode: bool, api_key: str, ttl_days: int = 90):
    """
    team1_id/team2_id: football-data.org 的内部ID，仅用于本地缓存key和mock查找；
    真实模式下内部会重新解析成 api-sports.io 的team id。
    返回: {"summary": {...}, "games": [...]}  或 None（查不到数据）
    """
    if mock_mode:
        h2h_db = _load_mock_h2h()
        key = _pair_key(team1_id, team2_id)
        entry = h2h_db.get(key)
        if entry is None:
            return None
        return {"summary": entry["summary"], "games": entry["games"]}

    cache_key = f"h2h_{_pair_key(team1_id, team2_id)}"
    cached = cache_get("h2h", cache_key, ttl_days)
    if cached is not None:
        return cached

    af_id1 = _search_api_football_team_id(team1_name, api_key)
    af_id2 = _search_api_football_team_id(team2_name, api_key)
    if af_id1 is None or af_id2 is None:
        return None

    result = _fetch_real_h2h(af_id1, af_id2, api_key)
    cache_set("h2h", cache_key, result)
    return result
