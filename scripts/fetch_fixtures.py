"""
获取未来N天的赛程（football-data.org: /v4/competitions/{code}/matches）
"""
import json
import os
from datetime import datetime, timedelta, timezone

from utils import cache_get, cache_set, http_get_json, RateLimiter

MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mock_data")

_rate_limiter = RateLimiter(min_interval_sec=6.5)  # football-data.org 免费层 10次/分钟 -> 留余量


def _load_mock_matches(comp_code: str):
    path = os.path.join(MOCK_DIR, f"matches_{comp_code}.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["matches"]


def _fetch_real_matches(comp_code: str, api_key: str, date_from: str, date_to: str):
    _rate_limiter.wait()
    url = f"https://api.football-data.org/v4/competitions/{comp_code}/matches"
    headers = {"X-Auth-Token": api_key}
    params = {"dateFrom": date_from, "dateTo": date_to}
    data = http_get_json(url, headers=headers, params=params)
    matches = data.get("matches", [])

    # 诊断日志：确认API实际返回了多少场、时间跨度是多少，
    # 方便排查"某段时间内完全没有比赛"是API本身没数据、还是被过滤逻辑漏掉了
    if matches:
        dates = sorted(m["utcDate"][:10] for m in matches)
        print(f"      [诊断] {comp_code}: API返回 {len(matches)} 场原始数据，"
              f"日期范围 {dates[0]} ~ {dates[-1]}（请求范围 {date_from} ~ {date_to}）")
    else:
        print(f"      [诊断] {comp_code}: API返回 0 场比赛"
              f"（请求范围 {date_from} ~ {date_to}），检查该赛事是否在免费层范围内、"
              f"或该时间段是否恰好是国际比赛日空窗期")

    return matches


def get_recent_finished_matches(competitions: dict, lookback_days: int, mock_mode: bool, api_key: str):
    """
    额外拉取"最近几天已结束"的比赛（不进入schedule.json的赛程列表，只用于Drama Score归档）。
    因为常规的未来窗口查询（今天~未来N天）一旦比赛打完、日期滚出窗口，就再也看不到这场比赛了，
    这个函数专门补上"刚打完还没来得及被归档"的这一小段。
    """
    if mock_mode:
        return {}  # mock模式下没有真实赛果，跳过

    today = datetime.now(timezone.utc).date()
    date_from = (today - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    date_to = today.strftime("%Y-%m-%d")

    result = {}
    for comp_code in competitions:
        matches = _fetch_real_matches(comp_code, api_key, date_from, date_to)
        finished = [m for m in matches if m.get("status") == "FINISHED"]
        result[comp_code] = finished
    return result


def get_fixtures(competitions: dict, days_ahead: int, mock_mode: bool, api_key: str, cache_ttl_days: int = 1):
    """
    返回: { comp_code: [match, ...] }
    """
    today = datetime.now(timezone.utc).date()
    date_from = today.strftime("%Y-%m-%d")
    date_to = (today + timedelta(days=days_ahead)).strftime("%Y-%m-%d")

    result = {}
    for comp_code in competitions:
        if mock_mode:
            matches = _load_mock_matches(comp_code)
        else:
            cache_key = f"{comp_code}_{date_from}_{date_to}"
            cached = cache_get("fixtures", cache_key, cache_ttl_days)
            if cached is not None:
                matches = cached
            else:
                matches = _fetch_real_matches(comp_code, api_key, date_from, date_to)
                cache_set("fixtures", cache_key, matches)

        # 只保留时间范围内、未开始的比赛
        filtered = []
        for m in matches:
            utc_date = m["utcDate"]
            m_date = datetime.fromisoformat(utc_date.replace("Z", "+00:00")).date()
            if today <= m_date <= today + timedelta(days=days_ahead):
                filtered.append(m)
        result[comp_code] = filtered

    return result
