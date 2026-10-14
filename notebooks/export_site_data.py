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
