# ⚽ 球迷观赛助手（iPhone/iPad PWA）

网页App，添加到主屏幕后跟原生App体验基本一样。数据每天由GitHub Actions定时更新一次，
没有需要你持续维护的服务器。

## 一、整体是怎么运作的

```
GitHub Actions（每天定时）
   → 跑 scripts/export_schedule_json.py（复用之前验证过的打分逻辑）
   → 拉取赛程/排名/历史交锋，算好各维度分数
   → 生成 docs/schedule.json，自动提交回仓库
        ↓
GitHub Pages（免费静态网站托管，指向 docs/ 目录）
   → 直接把 docs/ 里的文件对外提供访问
        ↓
你的iPhone/iPad浏览器打开网址
   → 加载 schedule.json，本地做：筛选联赛、选主队加分、时区转换、方案A/B调度
   → 全部在手机本地算，不需要再请求任何服务器
```

打分用的"各维度原始分"存在 `schedule.json` 里，**主队加成是打开App后才在手机本地叠加的**
（因为服务器不知道你选了哪个主队），所以同一份数据，不同人在自己手机上设置不同主队，
看到的推荐结果会不一样，但都不需要重新请求服务器。

## 二、部署步骤

### 1. 建一个GitHub仓库，把这个文件夹传上去

```bash
cd football_watch_pwa
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/你的用户名/football-watch-pwa.git
git push -u origin main
```

（如果不熟悉git命令行，也可以直接在GitHub网页上新建仓库，然后把这个文件夹拖进网页上传界面）

### 2. 配置两个Secrets（跟之前Render的环境变量是一个概念）

仓库页面 → Settings → Secrets and variables → Actions → New repository secret，
分别添加：
- `FOOTBALL_DATA_API_KEY`：你的football-data.org token
- `API_FOOTBALL_KEY`：你的api-sports.io key

### 3. 开启GitHub Pages

仓库页面 → Settings → Pages → Source 选择 "Deploy from a branch"，
Branch 选 `main`，文件夹选 `/docs`，保存。

等一两分钟，页面顶部会出现你的网址，类似：
```
https://你的用户名.github.io/football-watch-pwa/
```

### 4. 手动触发一次数据生成（不用等到第二天定时任务）

仓库页面 → Actions → 左侧选 "Update Football Schedule" → 右侧 "Run workflow" 按钮，
点一下手动跑一次。跑完（一两分钟）`docs/schedule.json` 就会被自动更新并提交。

### 5. 手机上打开、添加到主屏幕

Safari打开第3步拿到的网址 → 点分享按钮 → "添加到主屏幕"，桌面就会出现一个App图标，
点开是全屏体验，没有浏览器地址栏。

## 三、日常使用

- 每天GitHub Actions会自动跑一次更新数据（默认UTC 06:00，可以在
  `.github/workflows/update_schedule.yml` 里改cron表达式调整时间）
- 打开App点右上角"设置"，可以选城市/自动检测时区/勾选关注的联赛/选主队
- 这些设置存在手机浏览器本地（localStorage），换手机或清缓存会重置，不会跨设备同步

## 四、本地测试（不部署也能在电脑上预览效果）

```bash
cd docs
python3 -m http.server 8000
```
然后浏览器打开 `http://localhost:8000`。默认读的是仓库里已有的 `docs/schedule.json`
（如果是mock数据生成的，就是mock效果；想看真实数据效果，先手动跑一次导出脚本）：

```bash
cd ..
MOCK_MODE=false FOOTBALL_DATA_API_KEY=你的key API_FOOTBALL_KEY=你的key \
  python3 scripts/export_schedule_json.py
```

## 五、目录说明

```
football_watch_pwa/
├── .github/workflows/update_schedule.yml   # 定时任务配置
├── scripts/                                 # 复用之前验证过的Python打分逻辑
│   ├── export_schedule_json.py             # 新增：把结果导出成JSON（而不是Markdown）
│   ├── fetch_fixtures.py / fetch_standings.py / fetch_h2h.py / fetch_teams.py
│   ├── recommend.py / derby.py / utils.py
├── data/derby_db.json                       # 德比清单+豪门名单（跟之前一样，可编辑）
├── mock_data/                                # 测试用样本数据
└── docs/                                     # GitHub Pages 直接对外提供这个目录
    ├── index.html / app.js / style.css       # PWA前端（打分重算+方案A/B调度都在这里用JS实现）
    ├── manifest.json / service-worker.js / icon.svg   # PWA配置
    ├── city_timezones.json                   # 内置城市→时区表，离线可用
    └── schedule.json                          # 定时任务每天自动生成/覆盖
```

## 六、已知限制

- 城市列表是内置的几十个主要城市，没覆盖到的城市可以用"自动检测"（跟随手机系统时区），
  或者告诉我要加哪些城市，我帮你扩充 `city_timezones.json`
- 数据一天更新一次，不是实时的（对赛程这种信息完全够用）
- 主队加成是固定加20分（封顶100分），不是加权平均的一部分，如果想让"是否主队"的权重
  也能像其他维度一样精细调节，告诉我，我可以改成可配置项
