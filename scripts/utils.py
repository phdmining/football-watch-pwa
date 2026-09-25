"""
通用工具：
- 本地JSON缓存的读写（带TTL过期判断）
- 简单的限速HTTP GET封装（真实API模式下使用）
"""
import json
import os
import time
from datetime import datetime, timedelta

CACHE_ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cache")


def cache_path(subdir: str, key: str) -> str:
    safe_key = key.replace("/", "_").replace(" ", "_")
    d = os.path.join(CACHE_ROOT, subdir)
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, f"{safe_key}.json")


def cache_get(subdir: str, key: str, ttl_days: int):
    path = cache_path(subdir, key)
    if not os.path.exists(path):
        return None
    mtime = datetime.fromtimestamp(os.path.getmtime(path))
    if datetime.now() - mtime > timedelta(days=ttl_days):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def cache_set(subdir: str, key: str, data):
    path = cache_path(subdir, key)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


class RateLimiter:
    """简单限速器：确保两次调用之间至少间隔 min_interval 秒"""

    def __init__(self, min_interval_sec: float):
        self.min_interval = min_interval_sec
        self._last_call = 0.0

    def wait(self):
        elapsed = time.time() - self._last_call
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_call = time.time()


def http_get_json(url: str, headers: dict = None, params: dict = None, timeout: int = 15):
    import requests
    resp = requests.get(url, headers=headers or {}, params=params or {}, timeout=timeout)
    resp.raise_for_status()
    return resp.json()
