# Databricks notebook source
# MAGIC %md
# MAGIC # Replay a session as if it were live
# MAGIC Plays back the laps of a past session in the order they were completed, sped up,
# MAGIC as small JSON files in the landing Volume. A streaming pipeline can treat them like a live feed.

# COMMAND ----------

import json, os, time
from datetime import datetime, timezone

dbutils.widgets.text("session_key", "", "Session key to replay")
dbutils.widgets.text("speed", "30", "Speed-up (30 = 30x real time)")
dbutils.widgets.text("schema", "pipeline_dev", "Schema to read laps from")

SESSION_KEY = int(dbutils.widgets.get("session_key"))
SPEED = float(dbutils.widgets.get("speed"))
SCHEMA = dbutils.widgets.get("schema")
TICK = 2  # seconds of real time between batches

RUN_ID = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
OUT = f"/Volumes/f1/bronze/landing/live_replay/run={RUN_ID}"

# COMMAND ----------

# Every completed lap becomes one event, stamped with the moment the lap was finished
laps = spark.sql(f"""
    SELECT session_key, driver_number, lap_number, lap_time_sec,
           timestamp_millis(unix_millis(lap_start) + CAST(lap_time_sec * 1000 AS BIGINT)) AS completed_at
    FROM f1.{SCHEMA}.silver_laps
    WHERE session_key = {SESSION_KEY}
      AND lap_start IS NOT NULL AND lap_time_sec IS NOT NULL
    ORDER BY completed_at
""").collect()

if not laps:
    raise ValueError(f"No laps found for session {SESSION_KEY} in f1.{SCHEMA}.silver_laps")

first = laps[0].completed_at
events = [
    {
        "run_id": RUN_ID,
        "session_key": r.session_key,
        "driver_number": r.driver_number,
        "lap_number": r.lap_number,
        "lap_time_sec": r.lap_time_sec,
        "completed_at": r.completed_at.isoformat(),
        "race_seconds": (r.completed_at - first).total_seconds(),
    }
    for r in laps
]
print(f"{len(events)} lap events, {events[-1]['race_seconds'] / 60:.0f} min of racing, "
      f"replay takes about {events[-1]['race_seconds'] / SPEED / 60:.1f} min")

# COMMAND ----------

# Play back: every TICK seconds, write all events that have "happened" by now
os.makedirs(OUT, exist_ok=True)
start = time.monotonic()
i = batch_no = 0

while i < len(events):
    time.sleep(TICK)
    race_now = (time.monotonic() - start) * SPEED

    batch = []
    while i < len(events) and events[i]["race_seconds"] <= race_now:
        batch.append(events[i])
        i += 1
    if not batch:
        continue

    batch_no += 1
    final = f"{OUT}/batch_{batch_no:05d}.json"
    tmp = f"{OUT}/_tmp_{batch_no:05d}.json"   # names starting with _ are ignored by Spark
    with open(tmp, "w") as f:
        f.write("\n".join(json.dumps(e) for e in batch))   # one JSON object per line
    os.replace(tmp, final)                                  # appears in one piece

    print(f"batch {batch_no:4d}: {len(batch):3d} laps  |  race time {race_now / 60:5.1f} min  |  {i}/{len(events)}")

print(f"Done: {batch_no} files in {OUT}")