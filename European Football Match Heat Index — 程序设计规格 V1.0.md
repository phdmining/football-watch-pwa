# European Football Match Heat Index
## 欧洲足球比赛热度指数——程序设计规格 V1.0

### 1. 项目目标

建立一个可持续自动更新的欧洲足球比赛热度评分系统（Match Heat Index, MHI）。

核心目标：

1. 计算每场比赛的**客观/可观测热度**。
2. 区分：
   - Global Match Heat：全局比赛热度
   - Fan Match Heat：针对特定球迷的个性化热度
3. 优先使用**可靠、免费、可程序化获取**的数据。
4. 不依赖“知道每个球迷真实主队”这一难以获得的数据，而使用行为数据或用户主动设置进行替代。
5. 所有原始数据保留来源、更新时间和可信度。

---

# 2. 核心对象模型

## 2.1 Match

```text
Match
├── match_id
├── competition_id
├── season
├── match_date
├── home_team_id
├── away_team_id
├── venue
├── competition_stage
├── status
├── score
└── importance_score
```

## 2.2 Team

```text
Team
├── team_id
├── name
├── country
├── league
├── league_level
├── historical_strength
├── current_strength
├── popularity_score
└── star_power_score
```

## 2.3 Player

```text
Player
├── player_id
├── name
├── team_id
├── position
├── nationality
├── current_strength
└── popularity_score
```

## 2.4 Fan

用户层不要强制要求知道真实“主队”。

```text
Fan
├── user_id
├── favorite_team_id       # 用户主动设置，可为空
├── followed_teams[]
├── followed_players[]
└── behavior_profile
```

---

# 3. 球迷关系模型

比赛热度必须考虑：

```text
Favorite Team
    ↓
Followed Teams
    ↓
Followed Players
    ↓
Match
```

### 3.1 Favorite Team

用户主动指定的主队。

建议：

```text
favorite_weight = 1.00
```

### 3.2 Followed Team

用户关注但不是主队的球队。

建议：

```text
follow_weight = 0.60
```

### 3.3 Followed Player

用户关注球星，而该球星参加比赛。

建议：

```text
player_interest_weight = 0.40
```

### 3.4 行为推断

如果以后能够获得用户行为数据，可以计算：

```text
Team Affinity Score
```

行为示例：

| 行为 | 建议权重 |
|---|---:|
| 用户主动设置 Favorite | 100 |
| 关注球队 | 70 |
| 连续观看比赛 | 60 |
| 收藏比赛 | 50 |
| 主动搜索球队 | 40 |
| 浏览球队新闻 | 20 |
| 偶尔查看比赛 | 10 |

注意：

**推断出来的是 Affinity，不应直接称为“主队”。**

---

# 4. Global Match Heat 指标

第一版采用 6 个核心维度：

```text
MHI =
    20% Competition Importance
  + 20% Team Popularity
  + 15% Star Power
  + 15% Search Interest
  + 15% Social / Media Interest
  + 15% Match Context / Drama
```

所有指标标准化到：

```text
0 – 100
```

最终：

```text
MHI = 0 – 100
```

---

# 5. Dimension A：比赛重要性

## Competition Importance Score

建议：

```text
欧冠决赛                 100
欧冠半决赛                95
欧冠1/4决赛               90
欧冠淘汰赛                85
欧冠联赛阶段               70
欧联杯淘汰赛               65
顶级联赛关键比赛           60
普通顶级联赛               40
```

不要永久固定数值。

程序应该支持：

```text
competition_weight.json
```

以后调整。

同时加入：

- 冠军争夺
- 欧冠资格
- 欧联资格
- 保级
- 晋级
- 德比
- 淘汰赛

形成：

```text
Match Importance Score
```

---

# 6. Dimension B：球队热度

计算：

```text
Team Popularity
```

建议数据：

### 可获得

- 社交媒体粉丝
- Google Trends
- Wikipedia访问量
- YouTube频道数据
- 新闻数量
- 历史成绩
- 欧战成绩

### 计算

```text
TeamPopularity =
    30% Search
  + 25% Social
  + 20% Media
  + 15% Historical Strength
  + 10% Recent Performance
```

比赛球队部分：

```text
TeamHeat =
    average(
        HomeTeamPopularity,
        AwayTeamPopularity
    )
```

同时加入：

```text
max(HomeTeamPopularity, AwayTeamPopularity)
```

防止“一支超级球队 + 一支普通球队”被平均值严重拉低。

---

# 7. Dimension C：球星热度

如果比赛中存在高关注球员：

```text
StarPower =
    max(player_popularity)
```

而不是简单平均所有球员。

可使用：

- Google Trends
- Wikipedia
- YouTube
- 社交媒体公开数据
- 球员市场价值（可作为辅助，不等于热度）

注意：

**市场价值 ≠ 球迷热度。**

---

# 8. Dimension D：搜索热度

首选：

### Google Trends

查询：

```text
"<Home Team> vs <Away Team>"
"<Home Team>"
"<Away Team>"
```

获取：

- Search Interest
- Search Trend
- Match-day peak
- Pre-match interest
- Post-match interest

建立：

```text
SearchScore = 0–100
```

建议保存：

```text
search_pre_match
search_live
search_post_match
```

因此可以形成：

```text
Pre-Match Heat
Live Heat
Post-Match Heat
```

---

# 9. Dimension E：社交/媒体热度

第一版不要试图接入所有社交平台。

优先：

### YouTube

可记录：

```text
video_views
likes
comments
published_count
```

### 新闻

统计：

```text
news_article_count
news_mentions
```

### Reddit（可选）

统计：

```text
post_count
comment_count
engagement
```

如果未来获得合法API，再增加：

- X
- TikTok
- Instagram

不要把无法稳定获得的数据作为核心指标。

---

# 10. Dimension F：比赛实际热度 / Drama

比赛结束后加入：

```text
DramaScore
```

建议因素：

```text
goal_count
late_goals
comeback
red_cards
penalties
extra_time
penalty_shootout
score_margin
```

示例：

```text
最后15分钟进球       +20
逆转                  +25
加时                  +15
点球大战              +25
红牌                  +10
一球决胜              +10
```

设置上限：

```text
DramaScore <= 100
```

---

# 11. 现场热度

如果能获得可靠数据，增加：

```text
AttendanceScore
```

核心：

```text
attendance
stadium_capacity
attendance_rate
```

计算：

```text
AttendanceRate =
    attendance / stadium_capacity
```

注意：

**上座率比绝对人数更适合跨球场比较。**

football-data.org 的比赛数据中可以获得部分比赛的 `attendance` 和 `venue` 等字段。

---

# 12. Fan Match Heat

这是与 Global Match Heat 完全不同的指标。

对于用户 U：

```text
FanMatchHeat(U, Match)
```

建议：

```text
Favorite Team involved       +50
Followed Team involved       +30
Followed Player involved     +20
High Global Match Heat       +10
```

归一化：

```text
0 – 100
```

例如：

```text
用户主队 = Liverpool

Liverpool vs Chelsea
FanMatchHeat = 95

Real Madrid vs Bayern
FanMatchHeat = 55

PSG vs Marseille
FanMatchHeat = 20
```

这里的数值只是计算模型示例，不代表实际评分。

---

# 13. 两个最终指标必须分开

## Global Match Heat

回答：

> “这场比赛整体有多热门？”

## Personal Match Heat

回答：

> “这场比赛对这个球迷有多重要/值得关注？”

不要把二者合成一个指标。

---

# 14. 数据源优先级

## Tier 1：核心免费数据

### football-data.org

用途：

- 比赛
- 联赛
- 球队
- 赛程
- 排名
- 比分
- 部分比赛详细数据

提供免费计划，当前免费层包含12个赛事、赛果/赛程/积分榜，并限制请求频率。

官方：

[football-data.org API Documentation](https://www.football-data.org/documentation/quickstart?utm_source=chatgpt.com)

---

## Tier 1：历史数据

### openfootball

GitHub：

[openfootball Europe database](https://github.com/openfootball/europe?utm_source=chatgpt.com)

特点：

- 欧洲多个国家联赛
- 比赛
- 赛程
- 结果
- CSV / TXT等结构化数据
- CC0 / public domain

适合：

```text
历史数据库
训练模型
离线分析
```

该项目明确提供欧洲多个国家联赛的公开足球数据，并采用CC0许可。

---

# 15. Google Trends

用途：

```text
SearchScore
TeamPopularity
PlayerPopularity
MatchInterest
```

方法：

```text
Google Trends
    ↓
team / player / match keywords
    ↓
relative search interest
    ↓
0–100 normalization
```

建议不要直接依赖第三方非官方API作为核心生产数据。

优先：

- Google Trends网页
- 官方/稳定的数据导出能力
- 必要时再考虑第三方封装

---

# 16. 数据库设计

建议 PostgreSQL。

核心表：

```text
competitions
seasons
teams
players
matches
match_events
team_popularity
player_popularity
search_trends
social_metrics
news_metrics
fan_profiles
fan_team_affinity
match_heat_scores
data_sources
```

---

# 17. 每个数据字段必须记录来源

所有外部数据建议统一：

```text
source
source_url
retrieved_at
data_timestamp
confidence
```

例如：

```json
{
  "metric": "attendance",
  "value": 73084,
  "source": "football-data.org",
  "retrieved_at": "2026-09-26T10:00:00Z",
  "confidence": 0.95
}
```

这样以后才能追踪：

> 这个热度分数到底是怎么计算出来的？

---

# 18. 数据可靠性等级

```text
A = 官方机构 / 官方API
B = 稳定的专业数据服务
C = 公开平台数据
D = 爬虫/非官方接口
E = 推断数据
```

核心模型尽量：

```text
A + B + C
```

E只能作为辅助。

---

# 19. 推荐MVP

第一阶段不要做得过重。

只实现：

```text
football-data.org
        +
openfootball
        +
Google Trends
        +
YouTube
        +
基础新闻数量
        +
比赛事件
```

得到：

```text
Competition Score
Team Score
Star Score
Search Score
Media Score
Drama Score
Attendance Score
        ↓
Global Match Heat
```

再加入：

```text
Favorite Team
Followed Teams
Followed Players
        ↓
Personal Match Heat
```

---

# 20. 推荐技术架构

```text
                Data Sources
                     │
        ┌────────────┼────────────┐
        ↓            ↓            ↓
   Football API   Search       Media
        │            │            │
        └────────────┼────────────┘
                     ↓
              Data Collector
                     ↓
              Raw Data Store
                     ↓
             Normalization
                     ↓
             Feature Engine
                     ↓
             Heat Score Engine
                     ↓
              PostgreSQL
                     ↓
             REST API / App
```

推荐：

```text
Python
FastAPI
PostgreSQL
Pandas
SQLAlchemy
APScheduler / Celery
Docker
```

---

# 21. 最重要的设计原则

### 原则1
**先保证数据能拿到，再追求指标完美。**

### 原则2
**Global Heat 和 Personal Heat 分开。**

### 原则3
**Favorite ≠ Followed ≠ Temporary Interest。**

### 原则4
**Observed Data 和 Inferred Data 分开。**

### 原则5
每一个评分都必须可以追溯到：

```text
Raw Data
→ Feature
→ Weight
→ Score
```

### 原则6
不要一开始追求100个指标。

先把：

```text
10–20个可靠指标
```

做稳定，再逐步增加数据源。

---

# 22. 第一版核心公式

最终建议：

```text
Global Match Heat

= 0.20 × Competition Importance
+ 0.20 × Team Popularity
+ 0.15 × Star Power
+ 0.15 × Search Interest
+ 0.15 × Media/Social Interest
+ 0.15 × Match Drama
```

如果有可靠上座率：

```text
重新分配权重
```

例如：

```text
Competition       15%
Team Popularity   20%
Star Power        15%
Search            15%
Media/Social      15%
Drama             10%
Attendance        10%
```

所有输入：

```text
0–100
```

输出：

```text
MHI = 0–100
```

---

# 23. 未来版本

V2：

```text
TV Audience
Streaming Audience
International Audience
Social Platform APIs
```

V3：

```text
User behavior
Personalized recommendation
Real-time Match Heat
AI prediction of post-match attention
```

V4：

```text
Fan graph
Team graph
Player graph
Competition graph
```

最终形成：

```text
Fan
 ↓
Team
 ↓
Player
 ↓
Match
 ↓
Competition
 ↓
Media/Social
```

的足球兴趣知识图谱。