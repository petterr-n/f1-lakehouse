# Databricks notebook source
# MAGIC %md
# MAGIC # Export site data
# MAGIC Writes the validated gold tables the public site needs into ONE JSON file.
# MAGIC No calculations here: everything is computed (and tested) in gold.

# COMMAND ----------

import json, os
from datetime import datetime, timezone

dbutils.widgets.text("schema", "pipeline", "Schema to export from")
SCHEMA = dbutils.widgets.get("schema")
OUT_DIR = f"/Volumes/f1/{SCHEMA}/exports/site"
OUT_FILE = f"{OUT_DIR}/f1_site_data.json"

def rows(sql):
    return [r.asDict() for r in spark.sql(sql).collect()]

season = spark.sql(f"SELECT MAX(year) FROM f1.{SCHEMA}.gold_driver_standings").first()[0]

drivers = rows(f"""
    SELECT position, first_name, last_name, name_acronym, driver_number,
           team_name, team_colour, points, wins, podiums
    FROM f1.{SCHEMA}.gold_driver_standings
    WHERE year = {season}
    ORDER BY position, last_name
""")

constructors = rows(f"""
    SELECT position, team_name, team_colour, points, wins
    FROM f1.{SCHEMA}.gold_constructor_standings
    WHERE year = {season}
    ORDER BY position, team_name
""")

results = rows(f"""
    SELECT finish_order, position, status, first_name, last_name, name_acronym,
           team_name, team_colour, grid_position, positions_gained, points,
           laps_completed, gap_to_leader_sec, laps_behind, best_lap_sec, has_fastest_lap
    FROM f1.{SCHEMA}.gold_latest_race_results
    ORDER BY finish_order
""")

race = spark.sql(f"""
    SELECT year, round_number, meeting_name, location, country_name, date_start
    FROM f1.{SCHEMA}.gold_latest_race_results
    LIMIT 1
""").first().asDict()

data = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "source": "OpenF1 (openf1.org)",
    "season": season,
    "latest_race": {**race, "results": results},
    "driver_standings": drivers,
    "constructor_standings": constructors,
}

# Last line of defence: never publish an empty or nonsensical file
assert drivers and constructors and results, "Refusing to export: a section is empty"
assert drivers[0]["position"] == 1 and constructors[0]["position"] == 1, "Standings don't start at 1"

os.makedirs(OUT_DIR, exist_ok=True)
tmp = OUT_FILE + ".tmp"
with open(tmp, "w") as f:
    json.dump(data, f, default=str, indent=2)   # default=str turns timestamps into text
os.replace(tmp, OUT_FILE)                       # swap in one step: never a half-written file

print(f"Wrote {OUT_FILE}: season {season}, {len(drivers)} drivers, "
      f"{len(constructors)} teams, latest race: {race['meeting_name']}")