from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List
import httpx
import sqlite3
import json
import os
from datetime import datetime
from contextlib import asynccontextmanager
from apscheduler.schedulers.asyncio import AsyncIOScheduler

WEATHERSTACK_API_KEY = os.getenv("WEATHERSTACK_API_KEY", "YOUR_API_KEY_HERE")
DB_PATH = "skywatcher.db"

scheduler = AsyncIOScheduler()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            query TEXT NOT NULL,
            is_current INTEGER DEFAULT 0,
            lat REAL,
            lon REAL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            location_id INTEGER,
            conditions TEXT NOT NULL,
            thresholds TEXT NOT NULL,
            advance_hours REAL DEFAULT 1.0,
            browser_notify INTEGER DEFAULT 1,
            is_active INTEGER DEFAULT 1,
            last_triggered TEXT,
            status TEXT DEFAULT 'monitoring',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (location_id) REFERENCES locations(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER,
            alert_name TEXT,
            message TEXT,
            conditions_met TEXT,
            location_name TEXT,
            is_read INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (alert_id) REFERENCES alerts(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS weather_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            location_query TEXT UNIQUE,
            data TEXT,
            fetched_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.commit()
    conn.close()


async def fetch_weather(location_query: str) -> dict:
    url = "http://api.weatherstack.com/current"
    params = {
        "access_key": WEATHERSTACK_API_KEY,
        "query": location_query,
        "units": "f"
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params=params)
        data = resp.json()
        if "error" in data:
            raise HTTPException(status_code=400, detail=data["error"].get("info", "Weatherstack error"))
        return data


async def fetch_forecast(location_query: str) -> dict:
    url = "http://api.weatherstack.com/forecast"
    params = {
        "access_key": WEATHERSTACK_API_KEY,
        "query": location_query,
        "units": "f",
        "forecast_days": 1,
        "hourly": 1,
        "interval": 3
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params=params)
        data = resp.json()
        return data


def check_conditions(weather_data: dict, conditions: list, thresholds: dict) -> list:
    triggered = []
    current = weather_data.get("current", {})
    desc = " ".join(current.get("weather_descriptions", [])).lower()
    weather_code = current.get("weather_code", 0)

    for condition in conditions:
        if condition == "rain":
            precip = current.get("precip", 0)
            threshold = thresholds.get("rain_mm", 0.5)
            if precip >= threshold or "rain" in desc or "drizzle" in desc or "shower" in desc:
                triggered.append(f"Rain detected ({precip}mm)")
        elif condition == "snow":
            if "snow" in desc or "blizzard" in desc or weather_code in [227, 230, 323, 326, 329, 332, 335, 338, 371, 374, 377]:
                triggered.append("Snow conditions detected")
        elif condition == "high_temp":
            temp = current.get("temperature", 0)
            threshold = thresholds.get("high_temp_f", 90)
            if temp >= threshold:
                triggered.append(f"High temp: {temp}°F (threshold: {threshold}°F)")
        elif condition == "low_temp":
            temp = current.get("temperature", 0)
            threshold = thresholds.get("low_temp_f", 32)
            if temp <= threshold:
                triggered.append(f"Low temp: {temp}°F (threshold: {threshold}°F)")
        elif condition == "high_wind":
            wind = current.get("wind_speed", 0)
            threshold = thresholds.get("wind_mph", 25)
            if wind >= threshold:
                triggered.append(f"High wind: {wind}mph (threshold: {threshold}mph)")
        elif condition == "thunderstorm":
            if "thunder" in desc or weather_code in [386, 389, 392, 395]:
                triggered.append("Thunderstorm conditions detected")
        elif condition == "fog":
            if "fog" in desc or "mist" in desc or weather_code in [143, 248, 260]:
                triggered.append("Fog/mist conditions detected")
        elif condition == "uv":
            uv = current.get("uv_index", 0)
            threshold = thresholds.get("uv_index", 7)
            if uv >= threshold:
                triggered.append(f"UV index: {uv} (threshold: {threshold})")
        elif condition == "humidity":
            humidity = current.get("humidity", 0)
            threshold = thresholds.get("humidity_pct", 85)
            if humidity >= threshold:
                triggered.append(f"Humidity: {humidity}% (threshold: {threshold}%)")

    return triggered


async def poll_alerts():
    conn = get_db()
    alerts = conn.execute("""
        SELECT a.*, l.name as location_name, l.query as location_query
        FROM alerts a
        JOIN locations l ON a.location_id = l.id
        WHERE a.is_active = 1
    """).fetchall()

    for alert in alerts:
        try:
            weather = await fetch_weather(alert["location_query"])
            conditions = json.loads(alert["conditions"])
            thresholds = json.loads(alert["thresholds"])
            triggered = check_conditions(weather, conditions, thresholds)

            if triggered:
                last = alert["last_triggered"]
                now = datetime.utcnow()
                should_notify = True
                if last:
                    last_dt = datetime.fromisoformat(last)
                    hours_since = (now - last_dt).total_seconds() / 3600
                    if hours_since < 1:
                        should_notify = False

                if should_notify:
                    message = f"Weather alert for {alert['location_name']}: {', '.join(triggered)}"
                    conn.execute("""
                        INSERT INTO notifications (alert_id, alert_name, message, conditions_met, location_name)
                        VALUES (?, ?, ?, ?, ?)
                    """, (alert["id"], alert["name"], message, json.dumps(triggered), alert["location_name"]))
                    conn.execute("UPDATE alerts SET last_triggered = ?, status = 'triggered' WHERE id = ?",
                                 (now.isoformat(), alert["id"]))
                else:
                    conn.execute("UPDATE alerts SET status = 'triggered' WHERE id = ?", (alert["id"],))
            else:
                conn.execute("UPDATE alerts SET status = 'monitoring' WHERE id = ?", (alert["id"],))

            conn.commit()
        except Exception as e:
            print(f"Error polling alert {alert['id']}: {e}")

    conn.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    scheduler.add_job(poll_alerts, "interval", minutes=15, id="poll_alerts")
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Skywatcher", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Models ──────────────────────────────────────────────────────────────────

class LocationCreate(BaseModel):
    name: str
    query: str
    lat: Optional[float] = None
    lon: Optional[float] = None
    is_current: bool = False

class AlertCreate(BaseModel):
    name: str
    location_id: int
    conditions: List[str]
    thresholds: dict
    advance_hours: float = 1.0
    browser_notify: bool = True

class AlertUpdate(BaseModel):
    is_active: Optional[bool] = None
    name: Optional[str] = None
    conditions: Optional[List[str]] = None
    thresholds: Optional[dict] = None
    advance_hours: Optional[float] = None


# ── Frontend ─────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    with open("templates/index.html") as f:
        return f.read()


# ── Locations ────────────────────────────────────────────────────────────────

@app.get("/api/locations")
async def list_locations():
    conn = get_db()
    rows = conn.execute("SELECT * FROM locations ORDER BY is_current DESC, created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/locations")
async def create_location(loc: LocationCreate):
    conn = get_db()
    if loc.is_current:
        conn.execute("UPDATE locations SET is_current = 0")
    conn.execute("""
        INSERT INTO locations (name, query, is_current, lat, lon)
        VALUES (?, ?, ?, ?, ?)
    """, (loc.name, loc.query, 1 if loc.is_current else 0, loc.lat, loc.lon))
    conn.commit()
    id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    row = conn.execute("SELECT * FROM locations WHERE id = ?", (id,)).fetchone()
    conn.close()
    return dict(row)

@app.delete("/api/locations/{location_id}")
async def delete_location(location_id: int):
    conn = get_db()
    conn.execute("DELETE FROM locations WHERE id = ?", (location_id,))
    conn.execute("DELETE FROM alerts WHERE location_id = ?", (location_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.patch("/api/locations/{location_id}/set-current")
async def set_current_location(location_id: int):
    conn = get_db()
    conn.execute("UPDATE locations SET is_current = 0")
    conn.execute("UPDATE locations SET is_current = 1 WHERE id = ?", (location_id,))
    conn.commit()
    conn.close()
    return {"ok": True}


# ── Weather ──────────────────────────────────────────────────────────────────

@app.get("/api/weather/{location_id}")
async def get_weather(location_id: int):
    conn = get_db()
    loc = conn.execute("SELECT * FROM locations WHERE id = ?", (location_id,)).fetchone()
    conn.close()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    data = await fetch_weather(loc["query"])
    return data

@app.get("/api/weather-by-query")
async def get_weather_by_query(q: str):
    data = await fetch_weather(q)
    return data


# ── Alerts ───────────────────────────────────────────────────────────────────

@app.get("/api/alerts")
async def list_alerts():
    conn = get_db()
    rows = conn.execute("""
        SELECT a.*, l.name as location_name, l.query as location_query
        FROM alerts a
        JOIN locations l ON a.location_id = l.id
        ORDER BY a.created_at DESC
    """).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["conditions"] = json.loads(d["conditions"])
        d["thresholds"] = json.loads(d["thresholds"])
        result.append(d)
    return result

@app.post("/api/alerts")
async def create_alert(alert: AlertCreate):
    conn = get_db()
    loc = conn.execute("SELECT * FROM locations WHERE id = ?", (alert.location_id,)).fetchone()
    if not loc:
        raise HTTPException(status_code=404, detail="Location not found")
    conn.execute("""
        INSERT INTO alerts (name, location_id, conditions, thresholds, advance_hours, browser_notify)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (alert.name, alert.location_id, json.dumps(alert.conditions),
          json.dumps(alert.thresholds), alert.advance_hours, 1 if alert.browser_notify else 0))
    conn.commit()
    id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    row = conn.execute("""
        SELECT a.*, l.name as location_name FROM alerts a
        JOIN locations l ON a.location_id = l.id WHERE a.id = ?
    """, (id,)).fetchone()
    conn.close()
    d = dict(row)
    d["conditions"] = json.loads(d["conditions"])
    d["thresholds"] = json.loads(d["thresholds"])
    return d

@app.patch("/api/alerts/{alert_id}")
async def update_alert(alert_id: int, update: AlertUpdate):
    conn = get_db()
    if update.is_active is not None:
        conn.execute("UPDATE alerts SET is_active = ? WHERE id = ?",
                     (1 if update.is_active else 0, alert_id))
        if update.is_active:
            conn.execute("UPDATE alerts SET status = 'monitoring' WHERE id = ?", (alert_id,))
    if update.conditions is not None:
        conn.execute("UPDATE alerts SET conditions = ? WHERE id = ?",
                     (json.dumps(update.conditions), alert_id))
    if update.thresholds is not None:
        conn.execute("UPDATE alerts SET thresholds = ? WHERE id = ?",
                     (json.dumps(update.thresholds), alert_id))
    if update.advance_hours is not None:
        conn.execute("UPDATE alerts SET advance_hours = ? WHERE id = ?",
                     (update.advance_hours, alert_id))
    if update.name is not None:
        conn.execute("UPDATE alerts SET name = ? WHERE id = ?", (update.name, alert_id))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: int):
    conn = get_db()
    conn.execute("DELETE FROM alerts WHERE id = ?", (alert_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/alerts/{alert_id}/check-now")
async def check_alert_now(alert_id: int):
    conn = get_db()
    alert = conn.execute("""
        SELECT a.*, l.name as location_name, l.query as location_query
        FROM alerts a JOIN locations l ON a.location_id = l.id
        WHERE a.id = ?
    """, (alert_id,)).fetchone()
    conn.close()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found")
    weather = await fetch_weather(alert["location_query"])
    conditions = json.loads(alert["conditions"])
    thresholds = json.loads(alert["thresholds"])
    triggered = check_conditions(weather, conditions, thresholds)
    if triggered:
        conn = get_db()
        message = f"Manual check — {alert['location_name']}: {', '.join(triggered)}"
        conn.execute("""
            INSERT INTO notifications (alert_id, alert_name, message, conditions_met, location_name)
            VALUES (?, ?, ?, ?, ?)
        """, (alert_id, alert["name"], message, json.dumps(triggered), alert["location_name"]))
        conn.execute("UPDATE alerts SET last_triggered = ?, status = 'triggered' WHERE id = ?",
                     (datetime.utcnow().isoformat(), alert_id))
        conn.commit()
        conn.close()
    return {"triggered": triggered, "weather": weather.get("current", {})}


# ── Notifications ────────────────────────────────────────────────────────────

@app.get("/api/notifications")
async def list_notifications(unread_only: bool = False):
    conn = get_db()
    if unread_only:
        rows = conn.execute("SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC").fetchall()
    else:
        rows = conn.execute("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50").fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["conditions_met"] = json.loads(d["conditions_met"]) if d["conditions_met"] else []
        result.append(d)
    return result

@app.post("/api/notifications/mark-read")
async def mark_all_read():
    conn = get_db()
    conn.execute("UPDATE notifications SET is_read = 1")
    conn.commit()
    conn.close()
    return {"ok": True}

@app.patch("/api/notifications/{notif_id}/read")
async def mark_read(notif_id: int):
    conn = get_db()
    conn.execute("UPDATE notifications SET is_read = 1 WHERE id = ?", (notif_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.delete("/api/notifications/{notif_id}")
async def delete_notification(notif_id: int):
    conn = get_db()
    conn.execute("DELETE FROM notifications WHERE id = ?", (notif_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/api/notifications/unread-count")
async def unread_count():
    conn = get_db()
    count = conn.execute("SELECT COUNT(*) FROM notifications WHERE is_read = 0").fetchone()[0]
    conn.close()
    return {"count": count}

@app.post("/api/poll-now")
async def poll_now():
    await poll_alerts()
    return {"ok": True, "checked_at": datetime.utcnow().isoformat()}