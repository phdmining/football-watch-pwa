"""
获取球队历史主场平均上座率
数据来源：football-data.org 已结束比赛的 attendance 字段（官方文档确认存在此字段，
但只在比赛状态为 FINISHED 后才会有值——比赛没打完，自然不知道来了多少人）。

用"最近N场主场比赛的平均上座率"作为代理指标，估计这支球队球迷的现场支持热度，
不是"这场未来比赛的精确上座率"（那个在赛前是不可能知道的）。
"""
import json
import os

from utils import cache_get, cache_set, http_get_json, RateLimiter

MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mock_data")

# 跟fetch_fixtures.py共用football-data.org的10次/分钟限速额度
_rate_limiter = RateLimiter(min_interval_sec=6.5)

_mock_teams_cache = None


def _load_mock_teams():
    global _mock_teams_cache
    if _mock_teams_cache is None:
        with open(os.path.join(MOCK_DIR, "teams.json"), "r", encoding="utf-8") as f:
            _mock_teams_cache = json.load(f)
    return _mock_teams_cache


def _fetch_real_recent_home_attendance(team_id: int, api_key: str, limit: int = 10):
    _rate_limiter.wait()
    url = f"https://api.football-data.org/v4/teams/{team_id}/matches"
    headers = {"X-Auth-Token": api_key}
    params = {"status": "FINISHED", "limit": 20}  # 多拉一点，因为要在客户端再筛"主场"
    data = http_get_json(url, headers=headers, params=params)
    matches = data.get("matches", [])

    home_matches = [m for m in matches if m.get("homeTeam", {}).get("id") == team_id]
    home_matches.sort(key=lambda m: m.get("utcDate", ""), reverse=True)

    attendances = []
    for m in home_matches[:limit]:
        att = m.get("attendance")
        if att and att > 0:
            attendances.append(att)
    return attendances


def get_team_home_occupancy(team_id: int, capacity, mock_mode: bool, api_key: str, ttl_days: int = 60):
    """
    返回 0~1 的历史主场平均上座率，或 None（数据不可用时，比如新升班马、拿不到attendance数据）。
    capacity: 场馆容量，缺失时直接返回None（算不出比率）
    """
    if not capacity or capacity <= 0:
        return None

    if mock_mode:
        teams = _load_mock_teams()
        for t in teams.values():
            if t.get("id") == team_id:
                avg_att = t.get("mock_avg_home_attendance")
                if avg_att:
                    return min(1.0, avg_att / capacity)
        return None

    cache_key = f"occupancy_{team_id}"
    cached = cache_get("teams", cache_key, ttl_days)
    if cached is not None:
        avg_att = cached.get("avgAttendance")
        return min(1.0, avg_att / capacity) if avg_att else None

    try:
        attendances = _fetch_real_recent_home_attendance(team_id, api_key)
    except Exception as e:
        print(f"      [警告] 查询历史上座率失败（team_id={team_id}）：{e}，该维度用中性分兜底。")
        cache_set("teams", cache_key, {"avgAttendance": None})
        return None

    if not attendances:
        cache_set("teams", cache_key, {"avgAttendance": None})
        return None

    avg_att = sum(attendances) / len(attendances)
    cache_set("teams", cache_key, {"avgAttendance": avg_att, "sampleSize": len(attendances)})
    return min(1.0, avg_att / capacity)
