-- Live (replay) pipeline: lap events in, current race order out.
-- Separate from the weekly pipeline: different schedule, can fail on its own.

CREATE OR REFRESH STREAMING TABLE live_lap_events (
  CONSTRAINT has_keys EXPECT (run_id IS NOT NULL AND driver_number IS NOT NULL AND lap_number IS NOT NULL)
    ON VIOLATION DROP ROW
)
COMMENT 'One row per completed lap, appended as replay files arrive'
AS SELECT
  *,
  current_timestamp()  AS ingested_at,     -- processing time (when we saw it)
  _metadata.file_path  AS source_file
FROM STREAM read_files(
  '/Volumes/f1/bronze/landing/live_replay/',
  format => 'json',
  schemaHints => 'run_id STRING, session_key BIGINT, driver_number BIGINT, lap_number INT,
                  lap_time_sec DOUBLE, completed_at TIMESTAMP, race_seconds DOUBLE'
);

CREATE OR REFRESH MATERIALIZED VIEW live_current_order
COMMENT 'Race order right now, for the most recent replay run'
AS
WITH latest_run AS (
  SELECT max(run_id) AS run_id FROM live_lap_events
),
laps AS (
  SELECT e.* FROM live_lap_events e JOIN latest_run USING (run_id)
),
per_driver AS (
  SELECT
    session_key,
    driver_number,
    max(lap_number)                  AS laps,
    max_by(completed_at, lap_number) AS last_completed_at,
    max_by(lap_time_sec, lap_number) AS last_lap_sec,
    min(lap_time_sec)                AS best_lap_sec
  FROM laps
  GROUP BY session_key, driver_number
),
ordered AS (
  -- Most laps first; on the same lap, whoever crossed the line first
  SELECT *, row_number() OVER (ORDER BY laps DESC, last_completed_at) AS position
  FROM per_driver
),
leader_laps AS (
  SELECT l.lap_number, l.completed_at
  FROM laps l JOIN ordered o ON o.driver_number = l.driver_number AND o.position = 1
)
SELECT
  o.position,
  o.driver_number,
  d.name_acronym,
  d.team_name,
  o.laps,
  max(o.laps) OVER () - o.laps AS laps_behind,
  -- Gap = how long after the leader this car crossed the line on the same lap
  CASE WHEN o.position > 1
       THEN (unix_millis(o.last_completed_at) - unix_millis(ll.completed_at)) / 1000.0
  END AS gap_to_leader_sec,
  o.last_lap_sec,
  o.best_lap_sec,
  o.last_completed_at
FROM ordered o
LEFT JOIN leader_laps ll ON ll.lap_number = o.laps
LEFT JOIN silver_session_drivers d
  ON d.session_key = o.session_key AND d.driver_number = o.driver_number;