-- ================= Dimensions =================

CREATE OR REFRESH MATERIALIZED VIEW gold_dim_driver
AS
WITH appearances AS (
  SELECT d.driver_id, d.first_name, d.last_name, d.name_acronym, d.country_code,
         d.team_name, d.driver_number, s.date_start
  FROM silver_session_drivers d
  JOIN silver_sessions s ON s.session_key = d.session_key
  WHERE s.session_type = 'Race' AND s.status = 'completed'
),
changes AS (
  SELECT *,
    CASE WHEN team_name     = LAG(team_name)     OVER w
          AND driver_number = LAG(driver_number) OVER w
         THEN 0 ELSE 1 END AS is_change
  FROM appearances
  WINDOW w AS (PARTITION BY driver_id ORDER BY date_start)
),
versions AS (
  SELECT *,
    SUM(is_change) OVER (PARTITION BY driver_id ORDER BY date_start) AS version_no
  FROM changes
),
spans AS (
  SELECT driver_id, version_no, team_name, driver_number, MIN(date_start) AS valid_from
  FROM versions
  GROUP BY driver_id, version_no, team_name, driver_number
),
latest_details AS (
  SELECT driver_id,
         MAX_BY(first_name,   date_start) FILTER (WHERE first_name   IS NOT NULL) AS first_name,
         MAX_BY(last_name,    date_start) FILTER (WHERE last_name    IS NOT NULL) AS last_name,
         MAX_BY(name_acronym, date_start) FILTER (WHERE name_acronym IS NOT NULL) AS name_acronym,
         MAX_BY(country_code, date_start) FILTER (WHERE country_code IS NOT NULL) AS country_code
  FROM appearances
  GROUP BY driver_id
)
SELECT
  concat(s.driver_id, '_v', s.version_no) AS driver_key,
  s.driver_id, s.version_no,
  d.first_name, d.last_name, d.name_acronym, d.country_code,
  s.team_name, s.driver_number, s.valid_from,
  LEAD(s.valid_from) OVER (PARTITION BY s.driver_id ORDER BY s.version_no)         AS valid_to,
  LEAD(s.valid_from) OVER (PARTITION BY s.driver_id ORDER BY s.version_no) IS NULL AS is_current
FROM spans s
JOIN latest_details d ON d.driver_id = s.driver_id;


CREATE OR REFRESH MATERIALIZED VIEW gold_dim_session
AS
WITH rounds AS (
  SELECT meeting_key,
         DENSE_RANK() OVER (PARTITION BY year ORDER BY date_start) AS round_number
  FROM silver_meetings
  WHERE NOT is_testing AND race_status <> 'cancelled'
)
SELECT
  s.session_key, s.meeting_key, s.year, r.round_number,
  m.meeting_name, s.session_name, s.session_type, s.date_start,
  s.location, s.country_name, s.circuit_short_name, s.status
FROM silver_sessions s
JOIN silver_meetings m ON m.meeting_key = s.meeting_key
LEFT JOIN rounds r     ON r.meeting_key = s.meeting_key;


-- ================= Facts =================

CREATE OR REFRESH MATERIALIZED VIEW gold_fact_session_result (
  CONSTRAINT has_driver_key EXPECT (driver_key IS NOT NULL) ON VIOLATION FAIL UPDATE
)
AS
SELECT
  r.session_key, dd.driver_key, sd.driver_id,
  r.status, r.position, r.finish_order,
  g.grid_position,
  g.grid_position - r.position AS positions_gained,
  r.points, r.laps_completed, r.race_time_sec, r.gap_to_leader_sec, r.laps_behind
FROM silver_session_results r
JOIN silver_sessions s
  ON s.session_key = r.session_key
JOIN silver_session_drivers sd
  ON  sd.session_key   = r.session_key
  AND sd.driver_number = r.driver_number
LEFT JOIN gold_dim_driver dd
  ON  dd.driver_id = sd.driver_id
  AND s.date_start >= dd.valid_from
  AND (dd.valid_to IS NULL OR s.date_start < dd.valid_to)
LEFT JOIN silver_starting_grid g
  ON  g.session_key   = r.session_key
  AND g.driver_number = r.driver_number;


CREATE OR REFRESH MATERIALIZED VIEW gold_fact_lap (
  CONSTRAINT has_driver_key EXPECT (driver_key IS NOT NULL) ON VIOLATION FAIL UPDATE,
  CONSTRAINT has_tyre       EXPECT (compound IS NOT NULL)
)
AS
SELECT
  l.session_key, dd.driver_key, sd.driver_id, l.lap_number, l.lap_start,
  l.lap_time_sec, l.sector_1_sec, l.sector_2_sec, l.sector_3_sec,
  l.speed_trap_kph, l.is_pit_out_lap, l.is_clean_lap,
  st.stint_number, st.compound, st.compound_type,
  st.tyre_age_start + (l.lap_number - st.lap_start) AS tyre_age_laps
FROM silver_laps l
JOIN silver_sessions s
  ON s.session_key = l.session_key
JOIN silver_session_drivers sd
  ON  sd.session_key   = l.session_key
  AND sd.driver_number = l.driver_number
LEFT JOIN gold_dim_driver dd
  ON  dd.driver_id = sd.driver_id
  AND s.date_start >= dd.valid_from
  AND (dd.valid_to IS NULL OR s.date_start < dd.valid_to)
LEFT JOIN silver_stints st
  ON  st.session_key   = l.session_key
  AND st.driver_number = l.driver_number
  AND l.lap_number BETWEEN st.lap_start AND st.lap_end;


-- ================= Analysis tables =================

CREATE OR REFRESH MATERIALIZED VIEW gold_agg_tyre_degradation
AS
WITH wet_sessions AS (
  SELECT DISTINCT session_key FROM gold_fact_lap WHERE compound_type = 'wet'
),
stint_slopes AS (
  SELECT f.session_key, f.driver_id, f.stint_number, f.compound,
         COUNT(*)                                    AS clean_laps,
         REGR_SLOPE(f.lap_time_sec, f.tyre_age_laps) AS sec_lost_per_lap
  FROM gold_fact_lap f
  WHERE f.is_clean_lap AND f.compound IN ('SOFT', 'MEDIUM', 'HARD')
  GROUP BY f.session_key, f.driver_id, f.stint_number, f.compound
  HAVING clean_laps >= 8
)
SELECT
  ds.year, ds.round_number, ds.meeting_name, ds.session_name, ss.compound,
  w.session_key IS NOT NULL                       AS mixed_conditions,
  COUNT(*)                                        AS stints,
  ROUND(PERCENTILE(ss.sec_lost_per_lap, 0.5), 3)  AS median_sec_lost_per_lap
FROM stint_slopes ss
JOIN gold_dim_session ds ON ds.session_key = ss.session_key
LEFT JOIN wet_sessions w ON w.session_key  = ss.session_key
GROUP BY ds.year, ds.round_number, ds.meeting_name, ds.session_name, ss.compound, w.session_key;


CREATE OR REFRESH MATERIALIZED VIEW gold_agg_championship_progress
AS
WITH round_points AS (
  SELECT ds.year, ds.round_number, f.driver_id, SUM(f.points) AS points
  FROM gold_fact_session_result f
  JOIN gold_dim_session ds ON ds.session_key = f.session_key
  GROUP BY ds.year, ds.round_number, f.driver_id
),
rounds AS (
  SELECT DISTINCT year, round_number, meeting_name
  FROM gold_dim_session
  WHERE session_name = 'Race' AND status = 'completed'
),
drivers AS (SELECT DISTINCT year, driver_id FROM round_points),
full_grid AS (
  SELECT r.year, r.round_number, r.meeting_name, d.driver_id
  FROM rounds r JOIN drivers d ON d.year = r.year
),
filled AS (
  SELECT g.*, COALESCE(p.points, 0) AS round_points
  FROM full_grid g
  LEFT JOIN round_points p
    ON p.year = g.year AND p.round_number = g.round_number AND p.driver_id = g.driver_id
),
cumulative AS (
  SELECT *, SUM(round_points) OVER (PARTITION BY year, driver_id ORDER BY round_number) AS total_points
  FROM filled
)
SELECT *,
  RANK() OVER (PARTITION BY year, round_number ORDER BY total_points DESC) AS championship_position
FROM cumulative;


CREATE OR REFRESH MATERIALIZED VIEW gold_season_points (
  CONSTRAINT has_driver_id EXPECT (driver_id IS NOT NULL) ON VIOLATION FAIL UPDATE
)
AS
SELECT r.year, d.driver_id,
       SUM(r.points)                                          AS points,
       COUNT_IF(r.position = 1 AND s.session_name = 'Race')   AS grand_prix_wins,
       COUNT_IF(r.position = 1 AND s.session_name = 'Sprint') AS sprint_wins,
       COUNT_IF(r.status = 'disqualified')                    AS disqualifications
FROM silver_session_results r
JOIN silver_sessions s
  ON s.session_key = r.session_key
LEFT JOIN silver_session_drivers d
  ON  d.session_key   = r.session_key
  AND d.driver_number = r.driver_number
GROUP BY r.year, d.driver_id;

-- ================= Tables for the public site =================

-- Each team's colour per season, as OpenF1 reports it (latest race wins).
-- Ordered by date, not session_key: keys aren't in date order.
CREATE OR REFRESH MATERIALIZED VIEW gold_team_colours
AS
SELECT sd.year, sd.team_name,
       MAX_BY(sd.team_colour, s.date_start) AS team_colour
FROM silver_session_drivers sd
JOIN silver_sessions s ON s.session_key = sd.session_key
GROUP BY sd.year, sd.team_name;


CREATE OR REFRESH MATERIALIZED VIEW gold_driver_standings (
  CONSTRAINT has_driver EXPECT (driver_id IS NOT NULL) ON VIOLATION FAIL UPDATE
)
AS
WITH totals AS (
  SELECT ds.year, f.driver_id,
         SUM(f.points)                                         AS points,
         COUNT_IF(f.position = 1  AND ds.session_name = 'Race') AS wins,
         COUNT_IF(f.position = 2  AND ds.session_name = 'Race') AS second_places,
         COUNT_IF(f.position <= 3 AND ds.session_name = 'Race') AS podiums,
         MAX_BY(f.driver_key, ds.date_start)                   AS latest_driver_key
  FROM gold_fact_session_result f
  JOIN gold_dim_session ds ON ds.session_key = f.session_key
  GROUP BY ds.year, f.driver_id
)
SELECT
  RANK() OVER (PARTITION BY t.year
               ORDER BY t.points DESC, t.wins DESC, t.second_places DESC) AS position,
  t.year, t.driver_id,
  d.first_name, d.last_name, d.name_acronym, d.driver_number,
  d.team_name, c.team_colour,
  t.points, t.wins, t.podiums
FROM totals t
JOIN gold_dim_driver d       ON d.driver_key = t.latest_driver_key
LEFT JOIN gold_team_colours c ON c.year = t.year AND c.team_name = d.team_name;


CREATE OR REFRESH MATERIALIZED VIEW gold_constructor_standings (
  CONSTRAINT has_team EXPECT (team_name IS NOT NULL) ON VIOLATION FAIL UPDATE
)
AS
WITH totals AS (
  SELECT ds.year, d.team_name,
         SUM(f.points)                                        AS points,
         COUNT_IF(f.position = 1 AND ds.session_name = 'Race') AS wins,
         COUNT_IF(f.position = 2 AND ds.session_name = 'Race') AS second_places
  FROM gold_fact_session_result f
  JOIN gold_dim_session ds ON ds.session_key = f.session_key
  JOIN gold_dim_driver  d  ON d.driver_key   = f.driver_key   -- the team AT THAT RACE
  GROUP BY ds.year, d.team_name
)
SELECT
  RANK() OVER (PARTITION BY t.year
               ORDER BY t.points DESC, t.wins DESC, t.second_places DESC) AS position,
  t.year, t.team_name, c.team_colour, t.points, t.wins
FROM totals t
LEFT JOIN gold_team_colours c ON c.year = t.year AND c.team_name = t.team_name;


CREATE OR REFRESH MATERIALIZED VIEW gold_latest_race_results
AS
WITH latest AS (
  SELECT session_key
  FROM gold_dim_session
  WHERE session_name = 'Race' AND status = 'completed'
  ORDER BY date_start DESC
  LIMIT 1
),
best_laps AS (
  SELECT driver_key, MIN(lap_time_sec) AS best_lap_sec
  FROM gold_fact_lap
  WHERE session_key = (SELECT session_key FROM latest)
  GROUP BY driver_key
)
SELECT
  ds.year, ds.round_number, ds.meeting_name, ds.location, ds.country_name, ds.date_start,
  f.finish_order, f.position, f.status,
  d.first_name, d.last_name, d.name_acronym, d.team_name, c.team_colour,
  f.grid_position, f.positions_gained, f.points, f.laps_completed,
  f.gap_to_leader_sec, f.laps_behind,
  b.best_lap_sec,
  b.best_lap_sec = MIN(b.best_lap_sec) OVER () AS has_fastest_lap
FROM gold_fact_session_result f
JOIN latest l               ON l.session_key = f.session_key
JOIN gold_dim_session ds    ON ds.session_key = f.session_key
JOIN gold_dim_driver d      ON d.driver_key   = f.driver_key
LEFT JOIN best_laps b       ON b.driver_key   = f.driver_key
LEFT JOIN gold_team_colours c ON c.year = ds.year AND c.team_name = d.team_name;