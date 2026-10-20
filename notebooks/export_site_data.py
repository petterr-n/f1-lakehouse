# Databricks notebook source
# MAGIC %md
# MAGIC # Export site data
# MAGIC Writes the validated gold tables the public site needs as JSON files:
# MAGIC `races.json`, `qualifying.json` and `standings.json`.
# MAGIC No calculations here: everything is computed (and tested) in gold.

# COMMAND ----------

import json, os
from datetime import datetime, timezone

dbutils.widgets.text("schema", "pipeline", "Schema to export from")
SCHEMA = dbutils.widgets.get("schema")
OUT_DIR = f"/Volumes/f1/{SCHEMA}/exports/site"
GENERATED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")

def rows(sql):
    return spark.sql(sql).collect()

def write(name, payload):
    out = f"{OUT_DIR}/{name}"
    tmp = out + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, ensure_ascii=False, default=str)   # default=str turns timestamps into text
    os.replace(tmp, out)   # atomic: the site never sees a half-written file
    print(f"Wrote {out}: {os.path.getsize(out) / 1024:.0f} KB")

os.makedirs(OUT_DIR, exist_ok=True)

# COMMAND ----------

# Races and sprints: every completed session, grouped so the site can click through them

races = {}
for r in rows(f"""
    SELECT * FROM f1.{SCHEMA}.gold_race_results
    ORDER BY date_start, session_key, finish_order
"""):
    s = races.setdefault(r.session_key, {
        "session_key": r.session_key,
        "meeting_key": r.meeting_key,
        "season": r.season,
        "round": r.round_number,
        "meeting_name": r.meeting_name,
        "location": r.location,
        "country": r.country_name,
        "session_name": r.session_name,          # "Race" or "Sprint"
        "date": r.date_start.isoformat(),
        "results": [],
    })
    s["results"].append({
        "position": r.position,
        "status": r.status,                      # finished / retired / did_not_start / disqualified
        "driver_number": r.driver_number,
        "driver_id": r.driver_id,
        "name": f"{r.first_name} {r.last_name}",
        "acronym": r.name_acronym,
        "team": r.team_name,
        "team_colour": r.team_colour,            # "#RRGGBB", one per team per season
        "grid": r.grid_position,
        "gained": r.positions_gained,
        "points": r.points,
        "laps": r.laps_completed,
        "time": r.race_time_sec,
        "gap": r.gap_to_leader_sec,
        "laps_behind": r.laps_behind,
        "best_lap": r.best_lap_sec,
        "fastest_lap": bool(r.has_fastest_lap),
    })

assert races, "Refusing to export: no races"
write("races.json", {"generated_at": GENERATED_AT, "sessions": list(races.values())})

# COMMAND ----------

# Qualifying: every session, so the site can click through them

sessions = {}
for r in rows(f"""
    SELECT * FROM f1.{SCHEMA}.gold_qualifying_results
    ORDER BY date_start, session_key, position NULLS LAST, driver_number
"""):
    s = sessions.setdefault(r.session_key, {
        "session_key": r.session_key,
        "meeting_key": r.meeting_key,
        "season": r.season,
        "round": r.round_number,
        "location": r.location,
        "session_name": r.session_name,          # "Qualifying" or "Sprint Qualifying"
        "date": r.date_start.isoformat(),
        "results": [],
    })
    s["results"].append({
        "position": r.position,
        "driver_number": r.driver_number,
        "driver_id": r.driver_id,
        "name": r.full_name,
        "acronym": r.name_acronym,
        "team": r.team_name,
        "team_colour": r.team_colour,
        "q1": r.q1_seconds,
        "q2": r.q2_seconds,
        "q3": r.q3_seconds,
        "stage": r.stage_reached,
        "dns": r.dns,
        "dsq": r.dsq,
    })

assert sessions, "Refusing to export: no qualifying sessions"
write("qualifying.json", {
    "generated_at": GENERATED_AT,
    "seasons": sorted({s["season"] for s in sessions.values()}),
    "sessions": list(sessions.values()),
})

# COMMAND ----------

# Championship standings after every round, so the site can show the table as it stood

standings = {}   # "2026-18" -> {"drivers": [...], "constructors": [...]}

def entry(r):
    return standings.setdefault(f"{r.year}-{r.round_number}", {
        "season": r.year, "round": r.round_number, "drivers": [], "constructors": []})

for r in rows(f"""
    SELECT * FROM f1.{SCHEMA}.gold_driver_standings_by_round
    ORDER BY year, round_number, position, last_name
"""):
    entry(r)["drivers"].append({
        "position": r.position,
        "previous": r.previous_position,
        "driver_id": r.driver_id,
        "name": f"{r.first_name} {r.last_name}",
        "acronym": r.name_acronym,
        "number": r.driver_number,
        "team": r.team_name,
        "team_colour": r.team_colour,
        "points": r.points,
        "wins": r.wins,
        "podiums": r.podiums,
    })

for r in rows(f"""
    SELECT * FROM f1.{SCHEMA}.gold_constructor_standings_by_round
    ORDER BY year, round_number, position, team_name
"""):
    entry(r)["constructors"].append({
        "position": r.position,
        "previous": r.previous_position,
        "team": r.team_name,
        "team_colour": r.team_colour,
        "points": r.points,
        "wins": r.wins,
    })

# Last line of defence: never publish an empty or nonsensical table
for key, s in standings.items():
    assert s["drivers"] and s["constructors"], f"Refusing to export: empty standings for {key}"
    assert s["drivers"][0]["position"] == 1 and s["constructors"][0]["position"] == 1, \
        f"Standings for {key} don't start at 1"

write("standings.json", {"generated_at": GENERATED_AT, "rounds": list(standings.values())})

# COMMAND ----------

# Replay: race order after every lap, one small file per race (replay/<session_key>.json).
# Compact on purpose: drivers are listed once, laps refer to them by index.

REPLAY_DIR = f"{OUT_DIR}/replay"
os.makedirs(REPLAY_DIR, exist_ok=True)

def r3(x):
    return None if x is None else round(float(x), 3)

# Who drove in each race (name, team and colour as they were that day)
drivers = {}
for r in rows(f"""
    SELECT DISTINCT session_key, driver_id, name_acronym, first_name, last_name, team_name, team_colour
    FROM f1.{SCHEMA}.gold_race_results
"""):
    drivers.setdefault(r.session_key, {})[r.driver_id] = r

replays = {}
for r in rows(f"""
    SELECT session_key, lap_number, position, driver_id, gap_to_leader_sec, laps_behind, lap_time_sec,
        compound, tyre_age_laps, pitted
    FROM f1.{SCHEMA}.gold_race_lap_order
    ORDER BY session_key, lap_number, position
"""):
    known = drivers.get(r.session_key, {})
    if r.driver_id not in known:
        continue   # no result row for this driver, nothing to show

    rp = replays.setdefault(r.session_key, {"session_key": r.session_key, "drivers": [], "index": {}, "laps": {}})
    if r.driver_id not in rp["index"]:
        d = known[r.driver_id]
        rp["index"][r.driver_id] = len(rp["drivers"])
        rp["drivers"].append({
            "id": r.driver_id,
            "acronym": d.name_acronym,
            "name": f"{d.first_name} {d.last_name}",
            "team": d.team_name,
            "team_colour": d.team_colour,
        })

    # One entry per car, already in race order:
    # [driver index, gap, laps behind, lap time, tyre (S/M/H/I/W), tyre age, pitted this lap (0/1)]
    tyre = {"SOFT": "S", "MEDIUM": "M", "HARD": "H", "INTERMEDIATE": "I", "WET": "W"}.get(r.compound)
    rp["laps"].setdefault(r.lap_number, []).append(
        [rp["index"][r.driver_id], r3(r.gap_to_leader_sec), r.laps_behind, r3(r.lap_time_sec),
         tyre, r.tyre_age_laps, 1 if r.pitted else 0]
    )

# Safety car / VSC / red flag periods, so the site can show a banner on those laps
periods = {}
for r in rows(f"""
    SELECT session_key, kind, start_lap, end_lap
    FROM f1.{SCHEMA}.gold_race_neutralisations
    ORDER BY session_key, start_lap
"""):
    periods.setdefault(r.session_key, []).append({"kind": r.kind, "from": r.start_lap, "to": r.end_lap})

assert replays, "Refusing to export: no replay data"

total = 0
for key, rp in replays.items():
    payload = {
        "session_key": key,
        "drivers": rp["drivers"],
        "neutralisations": periods.get(key, []),   # [{"kind": "VSC", "from": 7, "to": 8}, ...]; to = null means until the finish
        "laps": [{"lap": lap, "order": order} for lap, order in sorted(rp["laps"].items())],
    }
    out = f"{REPLAY_DIR}/{key}.json"
    with open(out + ".tmp", "w") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))   # no spaces = smaller file
    os.replace(out + ".tmp", out)
    total += os.path.getsize(out)

print(f"Wrote {len(replays)} replay files to {REPLAY_DIR}: {total / 1024:.0f} KB in total, "
      f"{total / len(replays) / 1024:.0f} KB on average")

# COMMAND ----------

# Track map: one file per race that has enough position data (map/<session_key>.json).
# Each car's positions are one flat list [x0, y0, x1, y1, ...], one pair every STEP seconds from
# the start of the race; a gap in the data is null, null. Coordinates are divided by 10
# (OpenF1 units are ~10 cm), still sub-metre precision, but shorter numbers = smaller file.

MAP_DIR = f"{OUT_DIR}/map"
os.makedirs(MAP_DIR, exist_ok=True)
STEP = 2

def q(v):
    return None if v is None else int(round(v / 10))

# Circuit outline per race
outlines = {}
for r in rows(f"SELECT session_key, x, y FROM f1.{SCHEMA}.gold_track_outline ORDER BY session_key, seq"):
    outlines.setdefault(r.session_key, []).append([q(r.x), q(r.y)])

# When the leader completed each lap, so the map can follow the replay's lap slider
leader = {}
for r in rows(f"""
    SELECT session_key, lap_number, crossed_at
    FROM f1.{SCHEMA}.gold_race_lap_order
    WHERE position = 1 AND lap_number > 0
    ORDER BY session_key, lap_number
"""):
    leader.setdefault(r.session_key, []).append((r.lap_number, r.crossed_at))

# One race at a time, so we never hold all positions in memory at once
map_keys = [r.session_key for r in rows(f"SELECT session_key FROM f1.{SCHEMA}.gold_location_coverage WHERE has_map")]
sizes = []
for key in map_keys:
    frames = rows(f"SELECT driver_id, t, x, y FROM f1.{SCHEMA}.gold_location_frames WHERE session_key = {key}")
    if not frames or key not in outlines:
        print(f"map   {key}: skipped (no positions or no outline)")
        continue

    t0 = min(r.t for r in frames)
    n = int((max(r.t for r in frames) - t0).total_seconds() // STEP) + 1
    cars = {}
    for r in frames:
        i = int((r.t - t0).total_seconds() // STEP)
        xy = cars.setdefault(r.driver_id, [None] * (2 * n))
        xy[2 * i], xy[2 * i + 1] = q(r.x), q(r.y)

    payload = {
        "session_key": key,
        "step": STEP,                                   # seconds between positions
        "outline": outlines[key],                       # [[x, y], ...] in driving order
        "laps": [[lap, round((ts - t0).total_seconds(), 1)]   # [lap, seconds after the start] when the leader finished it
                 for lap, ts in leader.get(key, [])],
        "cars": [{"id": d, "xy": xy} for d, xy in cars.items()],
    }
    out = f"{MAP_DIR}/{key}.json"
    with open(out + ".tmp", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(out + ".tmp", out)
    sizes.append(os.path.getsize(out))

print(f"Wrote {len(sizes)} map files to {MAP_DIR}: {sum(sizes) / 1024 / 1024:.1f} MB in total, "
      f"{sum(sizes) / len(sizes) / 1024:.0f} KB on average")
