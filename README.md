# Skywatcher

A personal weather alert app to be prepared. Set conditions, pick locations, and get notified before the weather changes.

## Setup

### 1. Install dependencies
```bash
pip install -r requirements.txt
```

### 2. Get a Weatherstack API key
Sign up at https://weatherstack.com (free tier works fine).

### 3. Set your API key
**Option A — environment variable (recommended):**
```bash
export WEATHERSTACK_API_KEY=your_key_here
```

**Option B — edit main.py directly:**
Change line 8:
```python
WEATHERSTACK_API_KEY = "your_actual_key_here"
```

### 4. Run the app
```bash
uvicorn main:app --reload --port 8000
```

Then open http://localhost:8000 in your browser.

---

## How it works

1. **Add locations** — Use the Locations page to add cities, zip codes, or GPS coordinates. You can also click the GPS button to use your current location.

2. **Create alerts** — On the My Alerts page, click "New alert" and choose:
   - Which conditions to watch (rain, snow, high temp, wind, etc.)
   - Thresholds (e.g. only alert if temp exceeds 90°F)
   - How far in advance to notify you (30 min – 24 hrs)
   - Whether to send browser push notifications

3. **Get notified** — The app polls Weatherstack every 15 minutes in the background. When conditions match, a notification appears in the dashboard and (optionally) as a browser push notification. Click "Check now" in the sidebar to trigger an immediate check.

---

## Tech stack

- **Backend**: FastAPI + SQLite (via sqlite3) + APScheduler
- **Weather**: Weatherstack current conditions API
- **Frontend**: Vanilla HTML/CSS/JS 


```

## Weatherstack free tier notes

- Free plan supports **current weather only** (no forecast)
- 250 requests/month on the free plan — the 15-min poll interval uses ~2,880/month, so upgrade to a paid plan or increase the poll interval in `main.py` (change `minutes=15` in the scheduler)
- To increase the interval: find `scheduler.add_job(poll_alerts, "interval", minutes=15 ...)` in main.py and change to `minutes=60` or more

## Customizing

- **Poll interval**: Change `minutes=15` in `main.py` line with `scheduler.add_job`
- **Add conditions**: Add new condition types in the `check_conditions()` function and `THRESHOLD_CONFIG` in `app.js`
- **Units**: Currently uses Fahrenheit — change `"units": "f"` to `"units": "m"` in `fetch_weather()` for Celsius