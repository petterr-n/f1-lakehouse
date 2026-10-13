# Databricks notebook source
# MAGIC %md
# MAGIC # 01 · Ingest OpenF1
# MAGIC Lands raw OpenF1 JSON in the `landing` Volume. The *decisions* (what is finished, what is new)
# MAGIC live in `src/f1_ingest/planning.py` and are unit-tested; this notebook only does the I/O.
# MAGIC
# MAGIC Parameter `years`: empty = current season, or e.g. `2023,2024` for a backfill.

# COMMAND ----------

import json, os, sys, time
from datetime import datetime, timezone
import requests

# Make the tested module importable: src/ sits next to notebooks/ in the repo
sys.path.append(os.path.abspath("../src"))
from f1_ingest.planning import meetings_needing_grid, parse_years, sessions_to_ingest

BASE_URL = "https://api.openf1.org/v1"
LANDING = "/Volumes/f1/bronze/landing/openf1"
SESSION_ENDPOINTS = ["drivers", "session_result", "laps", "stints", "pit", "weather", "race_control"]

_last_call = 0.0

def get_openf1(endpoint, **params):
    """Call one OpenF1 endpoint. Waits 2s between calls and retries on errors."""
    global _last_call
    for attempt in range(1, 6):
        wait = 2 - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()

        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=30)
        if r.status_code == 404:
            return []
        if r.status_code == 429 or r.status_code >= 500:
            print(f"  {endpoint}: HTTP {r.status_code}, retry {attempt} in {10 * attempt}s")
            time.sleep(10 * attempt)
            continue
        r.raise_for_status()
        return r.json()

    raise RuntimeError(f"{endpoint} failed after 5 attempts")

# COMMAND ----------

def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)

def session_is_landed(year, session_key):
    """race_control is fetched last, so if its file exists the whole session is done."""
    return os.path.exists(f"{LANDING}/race_control/year={year}/session_key={session_key}.json")

def grid_path(year, meeting_key):
    return f"{LANDING}/starting_grid/year={year}/meeting_key={meeting_key}.json"

def land_session(session):
    year, key = session["year"], session["session_key"]
    for endpoint in SESSION_ENDPOINTS:
        data = get_openf1(endpoint, session_key=key)
        write_json(f"{LANDING}/{endpoint}/year={year}/session_key={key}.json", data)

def land_season_lists(year):
    """Small lists, overwritten every run (the pipeline re-reads them in full)."""
    for endpoint in ["meetings", "sessions"]:
        data = get_openf1(endpoint, year=year)
        write_json(f"{LANDING}/{endpoint}/year={year}/{endpoint}.json", data)
        print(f"{endpoint}: {len(data)} rows")

def ingest_year(year):
    now = datetime.now(timezone.utc)
    land_season_lists(year)

    # Sessions: what's finished and not landed yet is decided by the tested module
    races = get_openf1("sessions", year=year, session_type="Race")
    landed = {s["session_key"] for s in races if session_is_landed(year, s["session_key"])}
    todo = sessions_to_ingest(races, landed, now)
    print(f"{len(races)} race sessions: {len(landed)} already landed, {len(todo)} to ingest")
    for s in todo:
        land_session(s)
        print(f'done  {s["session_key"]} {s["location"]} - {s["session_name"]}')

    # Grids: one file per weekend; never save an empty grid, so it is retried next run
    grid_landed = {s["meeting_key"] for s in races if os.path.exists(grid_path(year, s["meeting_key"]))}
    for mk in meetings_needing_grid(races, grid_landed, now):
        grid = get_openf1("starting_grid", meeting_key=mk)
        if grid:
            write_json(grid_path(year, mk), grid)
            print(f"grid  meeting {mk}: {len(grid)} rows")
        else:
            print(f"grid  meeting {mk}: none yet, will retry next run")

# COMMAND ----------

dbutils.widgets.text("years", "", "Years (comma-separated, empty = current season)")

for year in parse_years(dbutils.widgets.get("years"), datetime.now(timezone.utc)):
    print(f"\n===== {year} =====")
    ingest_year(year)