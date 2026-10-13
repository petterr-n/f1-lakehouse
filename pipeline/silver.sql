-- ================= Sessions, meetings, results =================

CREATE OR REFRESH MATERIALIZED VIEW silver_sessions (
  CONSTRAINT has_session_key EXPECT (session_key IS NOT NULL) ON VIOLATION FAIL UPDATE
)
AS
WITH latest AS (
  SELECT * FROM bronze_sessions
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY _ingested_at DESC) = 1
),
results AS (
  SELECT session_key, COUNT(*) AS result_rows
  FROM bronze_session_result
  GROUP BY session_key
)
SELECT
  s.session_key, s.meeting_key, CAST(s.year AS INT) AS year,
  s.session_name, s.session_type,
  CAST(s.date_start AS TIMESTAMP) AS date_start,
  CAST(s.date_end   AS TIMESTAMP) AS date_end,
  s.location, s.country_name, s.circuit_short_name,
  CASE
    WHEN CAST(s.date_end AS TIMESTAMP) > current_timestamp()        THEN 'scheduled'
    WHEN s.session_type = 'Race' AND COALESCE(r.result_rows, 0) = 0 THEN 'cancelled'
    ELSE 'completed'
  END AS status
FROM latest s
LEFT JOIN results r ON r.session_key = s.session_key;


CREATE OR REFRESH MATERIALIZED VIEW silver_meetings
AS
WITH latest AS (
  SELECT * FROM bronze_meetings
  QUALIFY ROW_NUMBER() OVER (PARTITION BY meeting_key ORDER BY _ingested_at DESC) = 1
),
race_status AS (
  SELECT meeting_key, MAX(CASE WHEN session_name = 'Race' THEN status END) AS race_status
  FROM silver_sessions
  GROUP BY meeting_key
)
SELECT
  m.meeting_key, CAST(m.year AS INT) AS year,
  m.meeting_name, m.meeting_official_name,
  m.location, m.country_name, m.circuit_short_name,
  CAST(m.date_start AS TIMESTAMP)     AS date_start,
  m.meeting_name ILIKE '%testing%'    AS is_testing,
  COALESCE(r.race_status, 'no race')  AS race_status
FROM latest m
LEFT JOIN race_status r ON r.meeting_key = m.meeting_key;


CREATE OR REFRESH MATERIALIZED VIEW silver_session_results (
  CONSTRAINT has_session     EXPECT (session_key IS NOT NULL)   ON VIOLATION FAIL UPDATE,
  CONSTRAINT has_driver      EXPECT (driver_number IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT valid_position  EXPECT (position IS NULL OR position BETWEEN 1 AND 22),
  CONSTRAINT valid_points    EXPECT (points >= 0),
  CONSTRAINT completed_a_lap EXPECT (laps_completed > 0)
)
AS
WITH latest AS (
  SELECT * FROM bronze_session_result
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number
                             ORDER BY _ingested_at DESC) = 1
)
SELECT
  session_key, meeting_key, year, driver_number,
  CASE WHEN dsq THEN 'disqualified'
       WHEN dns THEN 'did_not_start'
       WHEN dnf THEN 'retired'
       ELSE 'finished' END                     AS status,
  position,
  ROW_NUMBER() OVER (PARTITION BY session_key
                     ORDER BY position NULLS LAST, number_of_laps DESC, driver_number)
                                               AS finish_order,
  number_of_laps                               AS laps_completed,
  CAST(points AS DOUBLE)                       AS points,
  duration                                     AS race_time_sec,
  TRY_CAST(gap_to_leader AS DOUBLE)            AS gap_to_leader_sec,
  CASE WHEN gap_to_leader LIKE '+%LAP%'
         THEN CAST(regexp_extract(gap_to_leader, '[0-9]+', 0) AS INT)
       WHEN NOT (dnf OR dns OR dsq) THEN 0 END AS laps_behind
FROM latest;


CREATE OR REFRESH MATERIALIZED VIEW silver_session_drivers (
  CONSTRAINT has_driver_id EXPECT (driver_id IS NOT NULL AND driver_id <> '') ON VIOLATION FAIL UPDATE
)
AS
SELECT
  regexp_replace(lower(concat_ws(' ', first_name, last_name)), ' ', '_') AS driver_id,
  session_key, meeting_key, year, driver_number,
  first_name, last_name, name_acronym, team_name,
  concat('#', team_colour) AS team_colour,
  country_code
FROM bronze_drivers
QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number
                           ORDER BY _ingested_at DESC) = 1;


CREATE OR REFRESH MATERIALIZED VIEW silver_starting_grid (
  CONSTRAINT linked_to_race EXPECT (session_key IS NOT NULL)
)
AS
WITH grid AS (
  SELECT * FROM bronze_starting_grid
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number
                             ORDER BY _ingested_at DESC) = 1
)
SELECT
  race.session_key  AS session_key,
  g.session_key     AS qualifying_session_key,
  g.meeting_key,
  q.year,
  g.driver_number,
  g.position        AS grid_position,
  g.lap_duration    AS qualifying_lap_sec
FROM grid g
JOIN silver_sessions q
  ON q.session_key = g.session_key
LEFT JOIN silver_sessions race
  ON  race.meeting_key  = g.meeting_key
  AND race.session_name = CASE
        WHEN q.session_name = 'Qualifying'                              THEN 'Race'
        WHEN q.session_name IN ('Sprint Qualifying', 'Sprint Shootout') THEN 'Sprint'
      END;


-- ================= Laps (quarantine replaced by DROP ROW expectations) =================

CREATE OR REFRESH MATERIALIZED VIEW silver_laps (
  CONSTRAINT has_keys      EXPECT (session_key IS NOT NULL AND driver_number IS NOT NULL AND lap_number IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT positive_time EXPECT (lap_time_sec IS NULL OR lap_time_sec > 0) ON VIOLATION DROP ROW
)
AS
WITH latest AS (
  SELECT * FROM bronze_laps
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number, lap_number
                             ORDER BY _ingested_at DESC) = 1
),
typed AS (
  SELECT
    session_key, meeting_key, year, driver_number, lap_number,
    CAST(date_start AS TIMESTAMP)   AS lap_start,
    lap_duration                    AS lap_time_sec,
    duration_sector_1               AS sector_1_sec,
    duration_sector_2               AS sector_2_sec,
    duration_sector_3               AS sector_3_sec,
    i1_speed                        AS speed_i1_kph,
    i2_speed                        AS speed_i2_kph,
    st_speed                        AS speed_trap_kph,
    COALESCE(is_pit_out_lap, false) AS is_pit_out_lap,
    PERCENTILE(lap_duration, 0.5) OVER (PARTITION BY session_key) AS session_median_sec
  FROM latest
)
SELECT
  * EXCEPT (session_median_sec),
  (lap_time_sec IS NOT NULL
   AND lap_number > 1
   AND NOT is_pit_out_lap
   AND lap_time_sec <= 1.10 * session_median_sec) AS is_clean_lap
FROM typed;


-- ================= Stints (staging -> clean + quarantine) =================

CREATE OR REFRESH MATERIALIZED VIEW silver_stints_staged
AS
WITH latest AS (
  SELECT * FROM bronze_stints
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number, stint_number
                             ORDER BY _ingested_at DESC) = 1
),
filled AS (
  SELECT
    st.*,
    st.lap_end IS NULL AS lap_end_inferred,
    LEAST(
      COALESCE(st.lap_end, LEAD(st.lap_start) OVER w - 1, r.laps_completed),
      LEAD(st.lap_start) OVER w - 1
    ) AS lap_end_filled,
    st.lap_end > LEAD(st.lap_start) OVER w - 1 AS lap_end_trimmed
  FROM latest st
  LEFT JOIN silver_session_results r
         ON r.session_key = st.session_key
        AND r.driver_number = st.driver_number
  WINDOW w AS (PARTITION BY st.session_key, st.driver_number ORDER BY st.stint_number)
),
flagged AS (
  SELECT *,
    (lap_start IS NULL AND lap_end_filled = 0)
      OR (lap_end_filled = lap_start - 1) AS is_zero_lap_stint
  FROM filled
)
SELECT
  session_key, meeting_key, year, driver_number, stint_number,
  CASE WHEN compound IS NULL OR compound = 'UNKNOWN' THEN 'UNKNOWN'
       ELSE upper(compound) END                    AS compound,
  CASE WHEN compound IN ('SOFT', 'MEDIUM', 'HARD') THEN 'dry'
       WHEN compound IN ('INTERMEDIATE', 'WET')    THEN 'wet'
       ELSE 'unknown' END                          AS compound_type,
  lap_start,
  lap_end_filled                                   AS lap_end,
  lap_end_inferred,
  COALESCE(lap_end_trimmed, false)                 AS lap_end_trimmed,
  is_zero_lap_stint,
  CASE WHEN is_zero_lap_stint THEN 0
       ELSE lap_end_filled - lap_start + 1 END     AS stint_laps,
  tyre_age_at_start                                AS tyre_age_start,
  CASE
    WHEN is_zero_lap_stint          THEN NULL
    WHEN lap_start IS NULL          THEN 'missing lap_start'
    WHEN lap_end_filled < lap_start THEN 'ends before it starts'
  END                                              AS _issue
FROM flagged;


CREATE OR REFRESH MATERIALIZED VIEW silver_stints (
  CONSTRAINT non_negative_length EXPECT (stint_laps >= 0)
)
AS SELECT * EXCEPT (_issue) FROM silver_stints_staged WHERE _issue IS NULL;


CREATE OR REFRESH MATERIALIZED VIEW silver_quarantine_stints
AS SELECT * FROM silver_stints_staged WHERE _issue IS NOT NULL;


-- ================= Pit stops, weather, race control =================

CREATE OR REFRESH MATERIALIZED VIEW silver_pit_stops
AS
SELECT
  session_key, meeting_key, year, driver_number, lap_number,
  CAST(date AS TIMESTAMP)               AS pit_entry_time,
  COALESCE(lane_duration, pit_duration) AS lane_time_sec,
  stop_duration                         AS stationary_time_sec
FROM bronze_pit
QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, driver_number, lap_number
                           ORDER BY _ingested_at DESC) = 1;


CREATE OR REFRESH MATERIALIZED VIEW silver_weather (
  CONSTRAINT plausible_track_temp EXPECT (track_temp_c IS NULL OR track_temp_c BETWEEN 5 AND 70)
)
AS
WITH latest AS (
  SELECT * FROM bronze_weather
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, date ORDER BY _ingested_at DESC) = 1
)
SELECT
  session_key, meeting_key, year,
  CAST(date AS TIMESTAMP)        AS measured_at,
  air_temperature                AS air_temp_c,
  NULLIF(track_temperature, 0)   AS track_temp_c,
  humidity                       AS humidity_pct,
  pressure                       AS pressure_mbar,
  rainfall > 0                   AS is_raining,
  wind_speed                     AS wind_speed_ms,
  wind_direction                 AS wind_direction_deg
FROM latest;


CREATE OR REFRESH MATERIALIZED VIEW silver_race_control
AS
WITH latest AS (
  SELECT * FROM bronze_race_control
  QUALIFY ROW_NUMBER() OVER (PARTITION BY session_key, date, message
                             ORDER BY _ingested_at DESC) = 1
)
SELECT
  * EXCEPT (date, _rescued_data, _source_file, _ingested_at),
  CAST(date AS TIMESTAMP) AS message_time
FROM latest;