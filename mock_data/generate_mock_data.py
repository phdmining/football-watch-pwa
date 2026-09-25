"""
生成 Mock 样本数据，格式尽量贴近真实API返回结构：
- football-data.org v4:  /competitions/{code}/matches , /competitions/{code}/standings , /teams/{id}
- api-sports.io v3:       /fixtures/headtohead

运行一次即可生成 mock_data/ 下所有样本文件，供 mock_mode=true 时使用。
"""
import json
import random
from datetime import datetime, timedelta, timezone

random.seed(42)

# 球队数据：(name, city, lat, lon)  -- 城市坐标用于验证"同城德比"地理算法
TEAMS = {
    "PL": [
        ("Manchester United FC", "Manchester", 53.4631, -2.2913),
        ("Manchester City FC", "Manchester", 53.4831, -2.2004),
        ("Liverpool FC", "Liverpool", 53.4308, -2.9608),
        ("Everton FC", "Liverpool", 53.4388, -2.9662),
        ("Arsenal FC", "London", 51.5549, -0.1084),
        ("Tottenham Hotspur FC", "London", 51.6043, -0.0664),
        ("Chelsea FC", "London", 51.4816, -0.1909),
        ("Newcastle United FC", "Newcastle", 54.9756, -1.6217),
        ("Aston Villa FC", "Birmingham", 52.5092, -1.8848),
        ("Brighton & Hove Albion FC", "Brighton", 50.8617, -0.0837),
    ],
    "PD": [
        ("Real Madrid", "Madrid", 40.4531, -3.6883),
        ("Atlético de Madrid", "Madrid", 40.4362, -3.5995),
        ("FC Barcelona", "Barcelona", 41.3809, 2.1228),
        ("Sevilla FC", "Sevilla", 37.3841, -5.9709),
        ("Real Betis Balompié", "Sevilla", 37.3568, -5.9821),
        ("Valencia CF", "Valencia", 39.4747, -0.3583),
        ("Real Sociedad de Fútbol", "San Sebastian", 43.3017, -1.9736),
        ("Villarreal CF", "Villarreal", 39.9442, -0.1037),
    ],
    "SA": [
        ("Juventus FC", "Turin", 45.1096, 7.6413),
        ("Torino FC", "Turin", 45.0420, 7.6498),
        ("FC Internazionale Milano", "Milan", 45.4781, 9.1240),
        ("AC Milan", "Milan", 45.4781, 9.1240),
        ("AS Roma", "Rome", 41.9339, 12.4547),
        ("SS Lazio", "Rome", 41.9339, 12.4547),
        ("SSC Napoli", "Naples", 40.8280, 14.1930),
        ("ACF Fiorentina", "Florence", 43.7808, 11.2822),
    ],
    "BL1": [
        ("FC Bayern München", "Munich", 48.2188, 11.6247),
        ("Borussia Dortmund", "Dortmund", 51.4926, 7.4517),
        ("Bayer 04 Leverkusen", "Leverkusen", 51.0382, 7.0023),
        ("RB Leipzig", "Leipzig", 51.3458, 12.3483),
        ("Eintracht Frankfurt", "Frankfurt", 50.0686, 8.6455),
        ("VfB Stuttgart", "Stuttgart", 48.7928, 9.2320),
    ],
    "FL1": [
        ("Paris Saint-Germain FC", "Paris", 48.8414, 2.2530),
        ("Olympique de Marseille", "Marseille", 43.2698, 5.3958),
        ("AS Monaco FC", "Monaco", 43.7276, 7.4152),
        ("Olympique Lyonnais", "Lyon", 45.7653, 4.9822),
        ("LOSC Lille", "Lille", 50.6120, 3.1302),
    ],
    "CL": [],  # 欧冠球队从五大联赛里抽取跨国对阵，单独处理
}

COMP_NAMES = {
    "PL": "Premier League", "PD": "La Liga", "SA": "Serie A",
    "BL1": "Bundesliga", "FL1": "Ligue 1", "CL": "UEFA Champions League"
}

BASE_DATE = datetime(2026, 9, 24, tzinfo=timezone.utc)  # 今天之后开始排赛程
team_id_counter = 1000
team_ids = {}

def get_team_id(name):
    global team_id_counter
    if name not in team_ids:
        team_ids[name] = team_id_counter
        team_id_counter += 1
    return team_ids[name]

def build_team_obj(name, city, lat, lon):
    return {
        "id": get_team_id(name),
        "name": name,
        "shortName": name.split(" FC")[0].split(" CF")[0],
        "venue": f"{city} Stadium",
        "address": f"{city}",
        "city": city,
        "lat": lat,
        "lon": lon,
    }

def kickoff_hour():
    return random.choice([15, 16, 17, 18, 19, 20, 21])

# ---------- 1. 生成球队字典 mock_data/teams.json ----------
all_teams = {}
for comp, teams in TEAMS.items():
    for (name, city, lat, lon) in teams:
        all_teams[name] = build_team_obj(name, city, lat, lon)

with open("mock_data/teams.json", "w", encoding="utf-8") as f:
    json.dump(all_teams, f, ensure_ascii=False, indent=2)

# ---------- 2. 生成每个联赛的赛程 matches_{code}.json ----------
FORCED_FIXTURES = [
    # (competition, home, away, day_offset)  -- 手动插入知名德比/豪门内战，确保mock数据里能看到推荐效果
    ("PD", "Real Madrid", "FC Barcelona", 5),
    ("PL", "Manchester United FC", "Liverpool FC", 3),
    ("PL", "Manchester United FC", "Manchester City FC", 12),
    ("PL", "Arsenal FC", "Tottenham Hotspur FC", 8),
    ("SA", "Juventus FC", "FC Internazionale Milano", 10),
    ("SA", "FC Internazionale Milano", "AC Milan", 20),
    ("BL1", "FC Bayern München", "Borussia Dortmund", 6),
    ("FL1", "Paris Saint-Germain FC", "Olympique de Marseille", 15),
]

matches_by_comp = {c: [] for c in COMP_NAMES}
match_id_counter = 500000

def add_match(comp, home, away, day_offset, matchday, stage="REGULAR_SEASON"):
    global match_id_counter
    match_id_counter += 1
    dt = BASE_DATE + timedelta(days=day_offset, hours=kickoff_hour() - 0, minutes=random.choice([0, 30]))
    matches_by_comp[comp].append({
        "id": match_id_counter,
        "utcDate": dt.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "SCHEDULED",
        "matchday": matchday,
        "stage": stage,
        "competition": {"code": comp, "name": COMP_NAMES[comp]},
        "homeTeam": {"id": get_team_id(home), "name": home},
        "awayTeam": {"id": get_team_id(away), "name": away},
    })

# 插入强制德比赛程
for comp, home, away, offset in FORCED_FIXTURES:
    add_match(comp, home, away, offset, matchday=random.randint(5, 10))

# 为五大联赛随机补充常规赛程，凑够未来30天、每天若干场
for comp, teams in TEAMS.items():
    if comp == "CL":
        continue
    names = [t[0] for t in teams]
    used_pairs = set()
    for offset in range(0, 30):
        # 每隔几天安排若干场常规比赛
        if offset % 3 != 0:
            continue
        random.shuffle(names)
        for i in range(0, len(names) - 1, 2):
            home, away = names[i], names[i + 1]
            pair = tuple(sorted([home, away]))
            if pair in used_pairs:
                continue
            used_pairs.add(pair)
            add_match(comp, home, away, offset, matchday=(offset // 7) + 1)

# 欧冠：跨联赛抽取球队组成小组赛/淘汰赛阶段的对阵（增加"第三方/名次决定性"场景）
cl_pool = [
    ("Real Madrid", "PD"), ("FC Barcelona", "PD"),
    ("Manchester City FC", "PL"), ("Liverpool FC", "PL"), ("Arsenal FC", "PL"),
    ("FC Bayern München", "BL1"), ("Borussia Dortmund", "BL1"),
    ("FC Internazionale Milano", "SA"), ("Juventus FC", "SA"),
    ("Paris Saint-Germain FC", "FL1"),
]
cl_fixtures = [
    ("Real Madrid", "Manchester City FC", 4, "LEAGUE_STAGE"),
    ("FC Bayern München", "FC Barcelona", 9, "LEAGUE_STAGE"),
    ("Liverpool FC", "Paris Saint-Germain FC", 14, "LEAGUE_STAGE"),
    ("Arsenal FC", "FC Internazionale Milano", 18, "LEAGUE_STAGE"),
    ("Juventus FC", "Borussia Dortmund", 22, "LEAGUE_STAGE"),
    ("Manchester City FC", "FC Bayern München", 27, "LEAGUE_STAGE"),
]
for home, away, offset, stage in cl_fixtures:
    add_match("CL", home, away, offset, matchday=4, stage=stage)

for comp, matches in matches_by_comp.items():
    matches.sort(key=lambda m: m["utcDate"])
    with open(f"mock_data/matches_{comp}.json", "w", encoding="utf-8") as f:
        json.dump({"matches": matches}, f, ensure_ascii=False, indent=2)

# ---------- 3. 生成积分榜 standings_{code}.json ----------
for comp, teams in TEAMS.items():
    if comp == "CL":
        # 欧冠单独做一个简化联赛阶段积分榜
        table = []
        pool_names = [n for n, c in cl_pool]
        random.shuffle(pool_names)
        for pos, name in enumerate(pool_names, start=1):
            played = random.randint(2, 4)
            won = random.randint(0, played)
            draw = random.randint(0, played - won)
            lost = played - won - draw
            table.append({
                "position": pos,
                "team": {"id": get_team_id(name), "name": name},
                "playedGames": played,
                "won": won, "draw": draw, "lost": lost,
                "points": won * 3 + draw,
                "form": "".join(random.choices(["W", "D", "L"], k=min(5, played))) or "-",
            })
        table.sort(key=lambda r: -r["points"])
        for i, r in enumerate(table, start=1):
            r["position"] = i
        with open("mock_data/standings_CL.json", "w", encoding="utf-8") as f:
            json.dump({"standings": [{"type": "LEAGUE_STAGE", "table": table}]}, f, ensure_ascii=False, indent=2)
        continue

    names = [t[0] for t in teams]
    total = len(names)
    table = []
    for pos, name in enumerate(names, start=1):
        played = random.randint(5, 8)
        won = random.randint(0, played)
        draw = random.randint(0, played - won)
        lost = played - won - draw
        table.append({
            "position": pos,
            "team": {"id": get_team_id(name), "name": name},
            "playedGames": played,
            "won": won, "draw": draw, "lost": lost,
            "points": won * 3 + draw,
            "form": "".join(random.choices(["W", "D", "L"], k=5)),
        })
    table.sort(key=lambda r: -r["points"])
    for i, r in enumerate(table, start=1):
        r["position"] = i
    with open(f"mock_data/standings_{comp}.json", "w", encoding="utf-8") as f:
        json.dump({"standings": [{"type": "TOTAL", "table": table}]}, f, ensure_ascii=False, indent=2)

# ---------- 4. 生成历史交锋 h2h ----------
# key格式: "teamA_id-teamB_id" (排序后), 模拟 api-sports.io fixtures/headtohead 返回结构
h2h_pairs = [pair for pair in [
    ("Real Madrid", "FC Barcelona"),
    ("Manchester United FC", "Liverpool FC"),
    ("Manchester United FC", "Manchester City FC"),
    ("Arsenal FC", "Tottenham Hotspur FC"),
    ("Juventus FC", "FC Internazionale Milano"),
    ("FC Internazionale Milano", "AC Milan"),
    ("FC Bayern München", "Borussia Dortmund"),
    ("Paris Saint-Germain FC", "Olympique de Marseille"),
    ("Real Madrid", "Manchester City FC"),
    ("FC Bayern München", "FC Barcelona"),
    ("Liverpool FC", "Paris Saint-Germain FC"),
    ("Arsenal FC", "FC Internazionale Milano"),
    ("Juventus FC", "Borussia Dortmund"),
    ("Manchester City FC", "FC Bayern München"),
]]

h2h_data = {}
for home, away in h2h_pairs:
    id1, id2 = get_team_id(home), get_team_id(away)
    key = f"{min(id1,id2)}-{max(id1,id2)}"
    n_games = random.randint(8, 24)
    w1 = random.randint(0, n_games)
    w2 = random.randint(0, n_games - w1)
    draws = n_games - w1 - w2
    games = []
    for i in range(min(n_games, 10)):  # 只存最近10场明细，够用于展示
        d = BASE_DATE - timedelta(days=30 * (i + 1) * random.randint(3, 9))
        winner = random.choice(["home", "away", "draw"])
        hs = random.randint(0, 4)
        aws = random.randint(0, 4) if winner != "home" else random.randint(0, hs)
        games.append({
            "date": d.strftime("%Y-%m-%d"),
            "home": home, "away": away,
            "homeScore": hs, "awayScore": aws,
        })
    h2h_data[key] = {
        "team1": home, "team2": away,
        "summary": {"team1Wins": w1, "team2Wins": w2, "draws": draws, "totalGames": n_games},
        "games": games,
    }

with open("mock_data/h2h.json", "w", encoding="utf-8") as f:
    json.dump(h2h_data, f, ensure_ascii=False, indent=2)

print("Mock数据生成完成：")
print(" - teams.json:", len(all_teams), "支球队")
for comp in COMP_NAMES:
    print(f" - matches_{comp}.json:", len(matches_by_comp[comp]), "场")
print(" - h2h.json:", len(h2h_data), "对阵组合")
