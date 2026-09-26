"""
综合打分模块
八个维度，各自归一化到 0~1，再按 config.weights 加权求和 -> 0~100 的推荐指数
"""
import json
import math
import os
from derby import evaluate_derby

_INFLUENCE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "club_influence.json")
with open(_INFLUENCE_PATH, "r", encoding="utf-8") as f:
    _INFLUENCE_DB = json.load(f)

_INFLUENCE_MAP = _INFLUENCE_DB["clubs"]
_INFLUENCE_BASELINE = _INFLUENCE_DB["_baseline"]

_MAX_KNOWN_CAPACITY = 100000  # 用于场馆规模对数归一化的参照上限（诺坎普量级）


def _form_score(form_str: str) -> float:
    """近期战绩字符串（如 'WWDLW'）-> 0~1，胜=1分 平=0.5分 负=0分 取平均"""
    if not form_str:
        return 0.5
    pts = {"W": 1.0, "D": 0.5, "L": 0.0}
    vals = [pts.get(c, 0.5) for c in form_str]
    return sum(vals) / len(vals)


def _position_score(position: int, total_teams: int) -> float:
    """排名越靠前分越高，0~1"""
    if total_teams <= 1:
        return 0.5
    return 1 - (position - 1) / (total_teams - 1)


def get_club_influence(team_name: str) -> float:
    if team_name in _INFLUENCE_MAP:
        return _INFLUENCE_MAP[team_name]
    # 精确匹配不到时，退回模糊匹配（应对football-data.org官方名字跟静态表用词不完全一致，
    # 比如 "Real Madrid CF" vs 静态表里的 "Real Madrid"）
    tn = team_name.strip().lower()
    for key, value in _INFLUENCE_MAP.items():
        k = key.strip().lower()
        if tn == k or k in tn or tn in k:
            return value
    return _INFLUENCE_BASELINE


def score_club_influence(home_name: str, away_name: str) -> float:
    """双方俱乐部影响力均值，0~1"""
    return (get_club_influence(home_name) + get_club_influence(away_name)) / 2


def score_stadium_scale(home_capacity, away_capacity) -> float:
    """
    场馆规模评分，0~1。用对数压缩，避免容量数字直接线性主导。
    这里用主队场馆容量（比赛实际在主队场馆进行），客队容量目前不参与计算，
    保留参数是为了以后可能需要双方对比时扩展。
    """
    if not home_capacity or home_capacity <= 0:
        return 0.3  # 拿不到容量数据时给中性偏低分，不武断给0
    ratio = math.log(home_capacity) / math.log(_MAX_KNOWN_CAPACITY)
    return max(0.0, min(1.0, ratio))


def score_form_ranking(team1_standing: dict, team2_standing: dict) -> float:
    if not team1_standing or not team2_standing:
        return 0.5
    p1 = _position_score(team1_standing["position"], team1_standing["total_teams"])
    p2 = _position_score(team2_standing["position"], team2_standing["total_teams"])
    f1 = _form_score(team1_standing.get("form", ""))
    f2 = _form_score(team2_standing.get("form", ""))
    return 0.5 * (p1 + p2) / 2 + 0.5 * (f1 + f2) / 2


def score_h2h(h2h_data) -> float:
    """历史交锋越多、越势均力敌 -> 分越高；没有数据给中性分0.4"""
    if not h2h_data:
        return 0.3
    summary = h2h_data["summary"]
    total = summary["totalGames"]
    if total == 0:
        return 0.3
    richness = min(total / 15.0, 1.0)  # 15场以上封顶
    diff = abs(summary["team1Wins"] - summary["team2Wins"])
    competitiveness = 1 - min(diff / total, 1.0)
    return 0.5 * richness + 0.5 * competitiveness


def score_title_relevance(team1_standing: dict, team2_standing: dict) -> float:
    """
    简化估算：
    - 双方位置都在争冠区(前3)或欧战区(前6)或降级区(后3) -> 加分
    - 双方分差越小 -> 加分
    - 赛季进行度越深（已赛轮次占比越高）-> 加分（临近关键期含金量更高）
    """
    if not team1_standing or not team2_standing:
        return 0.4

    total = team1_standing["total_teams"]
    p1, p2 = team1_standing["position"], team2_standing["position"]

    def zone_bonus(pos):
        if pos <= 3:
            return 1.0  # 争冠区
        if pos <= max(6, round(total * 0.35)):
            return 0.6  # 欧战区
        if pos >= total - 2:
            return 0.8  # 降级区，关注度也很高
        return 0.2

    zone = (zone_bonus(p1) + zone_bonus(p2)) / 2

    pts_gap = abs(team1_standing["points"] - team2_standing["points"])
    closeness = max(0, 1 - pts_gap / 15.0)

    est_total_rounds = max(2 * (total - 1), 1)
    played_avg = (team1_standing["playedGames"] + team2_standing["playedGames"]) / 2
    season_progress = min(played_avg / est_total_rounds, 1.0)

    return 0.5 * zone + 0.3 * closeness + 0.2 * season_progress


def score_third_party_impact(team1_standing: dict, team2_standing: dict, all_standings: dict) -> float:
    """
    简化启发式（非精确概率模型）：
    看这两队周围排名的"拥挤程度"——如果比赛结果会让紧邻的第三方球队排名产生连锁变化
    （即双方前后名次点数差都很小），就认为对第三方影响较大。
    """
    if not team1_standing or not team2_standing or not all_standings:
        return 0.3

    def crowdedness(standing, team_map):
        pos = standing["position"]
        pts = standing["points"]
        neighbors_gap = []
        for other in team_map.values():
            if other is standing:
                continue
            if abs(other["position"] - pos) == 1:
                neighbors_gap.append(abs(other["points"] - pts))
        if not neighbors_gap:
            return 0.3
        avg_gap = sum(neighbors_gap) / len(neighbors_gap)
        return max(0, 1 - avg_gap / 6.0)

    # 需要调用方传入本联赛的完整 team_map 才能算邻居，这里简化为直接用传入的 standing 自带信息
    return 0.3  # 占位，实际由 recommend_matches 中结合完整表计算，见下方 wrapper


def _crowdedness_for_team(standing: dict, comp_team_map: dict) -> float:
    pos = standing["position"]
    pts = standing["points"]
    gaps = []
    for other in comp_team_map.values():
        if other is standing:
            continue
        if abs(other["position"] - pos) == 1:
            gaps.append(abs(other["points"] - pts))
    if not gaps:
        return 0.3
    avg_gap = sum(gaps) / len(gaps)
    return max(0.0, 1 - avg_gap / 6.0)


def score_third_party_impact_v2(team1_standing, team2_standing, comp_team_map) -> float:
    if not team1_standing or not team2_standing or not comp_team_map:
        return 0.3
    c1 = _crowdedness_for_team(team1_standing, comp_team_map)
    c2 = _crowdedness_for_team(team2_standing, comp_team_map)
    return (c1 + c2) / 2


def score_match(match: dict, comp_code: str, standings: dict, h2h_data,
                 coords1, coords2, weights: dict, derby_distance_km: float,
                 home_capacity=None) -> dict:
    """
    match: {"homeTeam": {"name":...}, "awayTeam": {"name":...}, ...}
    standings: 本联赛 team_map（get_standings返回结果里对应comp_code的部分）
    home_capacity: 主队场馆容量（可选，拿不到时场馆规模维度给中性分）
    返回: {"total_score": 0~100, "breakdown": {...}, "derby_info": {...}}
    """
    home_name = match["homeTeam"]["name"]
    away_name = match["awayTeam"]["name"]

    s1 = standings.get(home_name)
    s2 = standings.get(away_name)

    derby_info = evaluate_derby(comp_code, home_name, away_name, coords1, coords2, derby_distance_km)

    scores = {
        "form_ranking": score_form_ranking(s1, s2),
        "h2h_history": score_h2h(h2h_data),
        "derby": 1.0 if derby_info["is_top_derby"] else 0.0,
        "big_club_clash": 1.0 if derby_info["is_big_club_clash"] else 0.0,
        "title_relevance": score_title_relevance(s1, s2),
        "third_party_impact": score_third_party_impact_v2(s1, s2, standings),
        "club_influence": score_club_influence(home_name, away_name),
        "stadium_scale": score_stadium_scale(home_capacity, None),
    }

    total = sum(scores[k] * weights.get(k, 0) for k in scores)
    total_100 = round(total * 100, 1)

    return {
        "total_score": total_100,
        "breakdown": scores,
        "derby_info": derby_info,
        "home_standing": s1,
        "away_standing": s2,
    }


def build_reason_text(match: dict, result: dict) -> str:
    """生成一句简短的推荐理由"""
    parts = []
    derby_info = result["derby_info"]
    if derby_info["is_top_derby"]:
        parts.append(derby_info["derby_label"])
    if derby_info["is_big_club_clash"] and not derby_info["is_top_derby"]:
        parts.append("豪门内战")
    elif derby_info["is_big_club_clash"] and derby_info["is_top_derby"]:
        parts.append("豪门内战")

    bd = result["breakdown"]
    if bd["title_relevance"] >= 0.65:
        parts.append("名次含金量高")
    if bd["h2h_history"] >= 0.6:
        parts.append("历史交锋势均力敌")
    if bd["form_ranking"] >= 0.7:
        parts.append("双方状态火热")
    if bd["third_party_impact"] >= 0.6:
        parts.append("牵动周边排名")
    if bd["club_influence"] >= 0.75:
        parts.append("豪门底蕴深厚")
    if bd["stadium_scale"] >= 0.85:
        parts.append("大球场氛围")

    if not parts:
        parts.append("常规联赛焦点战")

    return " · ".join(parts)
