"""
德比 / 豪门内战 判定模块
"""
import json
import os
from math import radians, sin, cos, sqrt, atan2

DATA_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "derby_db.json")

with open(DATA_PATH, "r", encoding="utf-8") as f:
    _DERBY_DB = json.load(f)

TOP_DERBIES = _DERBY_DB["top_derbies"]
BIG_CLUBS = _DERBY_DB["big_clubs"]


def _names_match(a: str, b: str) -> bool:
    """简单模糊匹配，兼容全名/简称"""
    a, b = a.strip().lower(), b.strip().lower()
    return a == b or a in b or b in a


def is_in_derby_list(comp_code: str, team1: str, team2: str) -> tuple:
    """命中国家德比清单 -> (True, label)；否则 (False, None)"""
    for entry in TOP_DERBIES:
        if entry["competition"] != comp_code:
            continue
        t1, t2 = entry["teams"]
        if (_names_match(team1, t1) and _names_match(team2, t2)) or \
           (_names_match(team1, t2) and _names_match(team2, t1)):
            return True, entry["label"]
    return False, None


def haversine_km(lat1, lon1, lat2, lon2) -> float:
    R = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return R * 2 * atan2(sqrt(a), sqrt(1 - a))


def is_same_city_derby(coords1, coords2, distance_km_threshold: float) -> bool:
    """coords1/coords2: (city, lat, lon)"""
    _, lat1, lon1 = coords1
    _, lat2, lon2 = coords2
    if lat1 is None or lat2 is None:
        return False
    dist = haversine_km(lat1, lon1, lat2, lon2)
    return dist <= distance_km_threshold


def is_big_club_clash(comp_code: str, team1: str, team2: str) -> bool:
    big_list = BIG_CLUBS.get(comp_code, [])
    t1_in = any(_names_match(team1, t) for t in big_list)
    t2_in = any(_names_match(team2, t) for t in big_list)
    return t1_in and t2_in


def evaluate_derby(comp_code: str, team1: str, team2: str, coords1, coords2, distance_threshold_km: float):
    """
    返回 dict: {
        "is_top_derby": bool, "derby_label": str|None,
        "is_big_club_clash": bool
    }
    """
    in_list, label = is_in_derby_list(comp_code, team1, team2)
    same_city = is_same_city_derby(coords1, coords2, distance_threshold_km)

    is_top_derby = in_list or same_city
    if in_list:
        derby_label = label
    elif same_city:
        derby_label = f"同城德比 ({coords1[0]} vs {coords2[0]})"
    else:
        derby_label = None

    return {
        "is_top_derby": is_top_derby,
        "derby_label": derby_label,
        "is_big_club_clash": is_big_club_clash(comp_code, team1, team2),
    }
