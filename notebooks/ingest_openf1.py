# Databricks notebook source
# MAGIC %md
# MAGIC # 01 · Ingest OpenF1
# MAGIC Lands raw OpenF1 JSON in the `landing` Volume. The *decisions* (what is finished, what is new)
# MAGIC live in `src/f1_ingest/planning.py` and are unit-tested; this notebook only does the I/O.
# MAGIC
# MAGIC Parameter `years`: empty = current season, or e.g. `2023,2024` for a backfill.

# COMMAND ----------

import gzip, json, os, sys, time
from datetime import datetime, timezone
import requests

# Make the tested module importable: src/ sits next to notebooks/ in the repo
sys.path.append(os.path.abspath("../src"))
from f1_ingest.planning import (
    INGESTED_SESSION_TYPES, endpoints_for, landed_marker_folder, locations_to_ingest,
    meetings_needing_grid, parse_years, sessions_to_ingest,
)

BASE_URL = "https://api.openf1.org/v1"
LANDING = "/Volumes/f1/bronze/landing/openf1"

_last_call = 0.0

def get_openf1(endpoint, **params):
    """Call one OpenF1 endpoint. Waits 2s between calls and retries on errors."""
    global _last_call
    for attempt in range(1, 6):
        wait = 2 - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()

        r = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=120)
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

def session_is_landed(session):
    """The marker endpoint is fetched last, so if its file exists the whole session is done."""
    folder = landed_marker_folder(session)
    return os.path.exists(f"{LANDING}/{folder}/year={session['year']}/session_key={session['session_key']}.json")

def grid_path(year, meeting_key):
    return f"{LANDING}/starting_grid/year={year}/meeting_key={meeting_key}.json"

def land_session(session):
    year, key = session["year"], session["session_key"]
    for endpoint, folder in endpoints_for(session):
        data = get_openf1(endpoint, session_key=key)
        write_json(f"{LANDING}/{folder}/year={year}/session_key={key}.json", data)

def land_season_lists(year):
    """Small lists, overwritten every run (the pipeline re-reads them in full)."""
    for endpoint in ["meetings", "sessions"]:
        data = get_openf1(endpoint, year=year)
        write_json(f"{LANDING}/{endpoint}/year={year}/{endpoint}.json", data)
        print(f"{endpoint}: {len(data)} rows")

# Car positions: one gzipped file per driver per race, plus a _SUCCESS marker once all drivers are done.
# Files starting with "_" are ignored by Spark, so a half-landed race is never read as complete.

def location_folder(session):
    return f"{LANDING}/location/year={session['year']}/session_key={session['session_key']}"

def location_is_landed(session):
    return os.path.exists(f"{location_folder(session)}/_SUCCESS")

def land_location(session):
    folder = location_folder(session)
    os.makedirs(folder, exist_ok=True)
    numbers = sorted({d["driver_number"] for d in get_openf1("drivers", session_key=session["session_key"])})
    rows = 0
    for n in numbers:
        data = get_openf1("location", session_key=session["session_key"], driver_number=n)
        if not data:
            continue                       # e.g. a car that never left the garage
        tmp, final = f"{folder}/_tmp_{n}.json.gz", f"{folder}/driver={n}.json.gz"
        with gzip.open(tmp, "wt") as f:    # ~10x smaller than plain JSON
            json.dump(data, f)
        os.replace(tmp, final)
        rows += len(data)
    open(f"{folder}/_SUCCESS", "w").close()
    return len(numbers), rows

def ingest_year(year):
    now = datetime.now(timezone.utc)
    land_season_lists(year)

    # Sessions: what's finished and not landed yet is decided by the tested module
    sessions = [s for t in INGESTED_SESSION_TYPES for s in get_openf1("sessions", year=year, session_type=t)]
    races = [s for s in sessions if s["session_type"] == "Race"]
    landed = {s["session_key"] for s in sessions if session_is_landed(s)}
    todo = sessions_to_ingest(sessions, landed, now)
    print(f"{len(sessions)} race and qualifying sessions: {len(landed)} already landed, {len(todo)} to ingest")
    for s in todo:
        land_session(s)
        print(f'done  {s["session_key"]} {s["location"]} - {s["session_name"]}')

    # Car positions for the track map: current-season Grand Prix races only
    loc_landed = {s["session_key"] for s in races if location_is_landed(s)}
    for s in locations_to_ingest(races, loc_landed, now):
        t0 = time.time()
        cars, rows = land_location(s)
        print(f'loc   {s["session_key"]} {s["location"]}: {cars} cars, {rows:,} positions, {time.time() - t0:.0f}s')

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