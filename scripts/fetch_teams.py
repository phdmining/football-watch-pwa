"""
获取球队信息（主要是主场城市坐标，用于德比地理判定）
Mock模式：读 mock_data/teams.json（已含 lat/lon）
真实模式：football-data.org 的 /v4/teams/{id} 一般会返回 address，
         用geopy对地址/城市再做一次地理编码补全经纬度，并缓存。
"""
import json
import os

from utils import cache_get, cache_set, RateLimiter

MOCK_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mock_data")

# Nominatim(OpenStreetMap) 免费服务使用政策要求最多1请求/秒，这里限速保守一点
_geocode_rate_limiter = RateLimiter(min_interval_sec=1.1)
_geolocator = None

_mock_teams_cache = None


def _load_mock_teams():
    global _mock_teams_cache
    if _mock_teams_cache is None:
        with open(os.path.join(MOCK_DIR, "teams.json"), "r", encoding="utf-8") as f:
            _mock_teams_cache = json.load(f)
    return _mock_teams_cache


def get_team_city_coords(team_name: str, mock_mode: bool):
    """返回 (city, lat, lon) 或 (None, None, None)"""
    if mock_mode:
        teams = _load_mock_teams()
        t = teams.get(team_name)
        if t:
            return t.get("city"), t.get("lat"), t.get("lon")
        return None, None, None

    cached = cache_get("teams", f"coords_{team_name}", ttl_days=180)
    if cached is not None:
        return cached.get("city"), cached.get("lat"), cached.get("lon")

    try:
        from geopy.geocoders import Nominatim
        global _geolocator
        if _geolocator is None:
            _geolocator = Nominatim(user_agent="football_watch_tool")
        _geocode_rate_limiter.wait()
        location = _geolocator.geocode(team_name, language="en", timeout=10, addressdetails=True)
        if location is None:
            return None, None, None
        # 优先从结构化地址组件里取真正的城市/城镇名，避免拿到场馆/训练基地名称
        addr = location.raw.get("address", {}) if hasattr(location, "raw") else {}
        city = (
            addr.get("city") or addr.get("town") or addr.get("municipality")
            or addr.get("village") or addr.get("county")
            or location.address.split(",")[0]  # 兜底：结构化字段都没有时才退回旧逻辑
        )
        cache_set("teams", f"coords_{team_name}",
                   {"city": city, "lat": location.latitude, "lon": location.longitude})
        return city, location.latitude, location.longitude
    except Exception:
        return None, None, None
