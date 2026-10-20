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
  AND l.lap_number BETWEEN st.lap_start AND st.lap_end
WHERE s.session_type = 'Race';          -- races and sprints only; qualifying laps get their own table


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


-- ================= Tables for the public site =================

-- Each team's colour per season, as OpenF1 reports it (latest race wins).
-- Ordered by date, not session_key: keys aren't in date order.
CREATE OR REFRESH MATERIALIZED VIEW gold_team_colours
AS
SELECT sd.year, sd.team_name,
       upper(MAX_BY(sd.team_colour, s.date_start)) AS team_colour   -- one colour per team per season, so one-off liveries don't leak in
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


CREATE OR REFRESH MATERIALIZED VIEW gold_qualifying_results
COMMENT 'Qualifying and sprint qualifying classification per session, ready for the site'
AS
SELECT
  year(s.date_start)  AS season,
  ds.round_number,
  s.meeting_key,
  s.session_key,
  s.location,
  s.session_name,                 -- 'Qualifying' or 'Sprint Qualifying'
  s.date_start,
  q.position,
  q.driver_number,
  d.driver_id,
  concat_ws(' ', d.first_name, d.last_name) AS full_name,
  d.name_acronym,
  d.team_name,
  c.team_colour,
  q.q1_seconds, q.q2_seconds, q.q3_seconds,
  q.q1_gap,     q.q2_gap,     q.q3_gap,
  q.stage_reached,
  q.laps,
  q.dns, q.dnf, q.dsq
FROM silver_qualifying_results q
JOIN silver_sessions s USING (session_key)
LEFT JOIN gold_dim_session ds ON ds.session_key = q.session_key
LEFT JOIN silver_session_drivers d
  ON d.session_key = q.session_key AND d.driver_number = q.driver_number
LEFT JOIN gold_team_colours c
  ON c.year = s.year AND c.team_name = d.team_name;

-- Every completed race and sprint, so the site can click through the season.
CREATE OR REFRESH MATERIALIZED VIEW gold_race_results (
  CONSTRAINT has_driver EXPECT (driver_id IS NOT NULL) ON VIOLATION FAIL UPDATE
)
COMMENT 'Classification of every completed race and sprint, ready for the site'
AS
WITH best_laps AS (
  SELECT session_key, driver_key, MIN(lap_time_sec) AS best_lap_sec
  FROM gold_fact_lap
  GROUP BY session_key, driver_key
)
SELECT
  ds.year AS season, ds.round_number, ds.meeting_key, ds.meeting_name,
  ds.session_key, ds.session_name,           -- 'Race' or 'Sprint'
  ds.location, ds.country_name, ds.date_start,
  f.finish_order, f.position, f.status,
  f.driver_id, d.first_name, d.last_name, d.name_acronym, d.driver_number,
  d.team_name, c.team_colour,
  f.grid_position, f.positions_gained, f.points, f.laps_completed,
  f.race_time_sec, f.gap_to_leader_sec, f.laps_behind,
  b.best_lap_sec,
  b.best_lap_sec = MIN(b.best_lap_sec) OVER (PARTITION BY f.session_key) AS has_fastest_lap
FROM gold_fact_session_result f
JOIN gold_dim_session ds    ON ds.session_key = f.session_key
JOIN gold_dim_driver d      ON d.driver_key   = f.driver_key
LEFT JOIN best_laps b       ON b.session_key  = f.session_key AND b.driver_key = f.driver_key
LEFT JOIN gold_team_colours c ON c.year = ds.year AND c.team_name = d.team_name
WHERE ds.session_type = 'Race' AND ds.status = 'completed';


-- Driver standings as they stood after each round (race + sprint points up to and
-- including that round). Same ranking rules as gold_driver_standings.
CREATE OR REFRESH MATERIALIZED VIEW gold_driver_standings_by_round
AS
WITH rounds AS (
  SELECT DISTINCT year, round_number
  FROM gold_dim_session
  WHERE session_name = 'Race' AND status = 'completed'
),
per_round AS (
  SELECT ds.year, ds.round_number, f.driver_id,
         SUM(f.points)                                         AS points,
         COUNT_IF(f.position = 1  AND ds.session_name = 'Race') AS wins,
         COUNT_IF(f.position = 2  AND ds.session_name = 'Race') AS second_places,
         COUNT_IF(f.position <= 3 AND ds.session_name = 'Race') AS podiums,
         MAX_BY(f.driver_key, ds.date_start)                   AS driver_key
  FROM gold_fact_session_result f
  JOIN gold_dim_session ds ON ds.session_key = f.session_key
  GROUP BY ds.year, ds.round_number, f.driver_id
),
cumulative AS (
  SELECT r.year, r.round_number, p.driver_id,
         SUM(p.points)        AS points,
         SUM(p.wins)          AS wins,
         SUM(p.second_places) AS second_places,
         SUM(p.podiums)       AS podiums,
         MAX_BY(p.driver_key, p.round_number) AS driver_key
  FROM rounds r
  JOIN per_round p ON p.year = r.year AND p.round_number <= r.round_number
  GROUP BY r.year, r.round_number, p.driver_id
),
ranked AS (
  SELECT *,
    RANK() OVER (PARTITION BY year, round_number
                 ORDER BY points DESC, wins DESC, second_places DESC) AS position
  FROM cumulative
)
SELECT
  t.year, t.round_number, t.position,
  LAG(t.position) OVER (PARTITION BY t.year, t.driver_id ORDER BY t.round_number) AS previous_position,
  t.driver_id, d.first_name, d.last_name, d.name_acronym, d.driver_number,
  d.team_name, c.team_colour,
  t.points, t.wins, t.podiums
FROM ranked t
JOIN gold_dim_driver d        ON d.driver_key = t.driver_key
LEFT JOIN gold_team_colours c ON c.year = t.year AND c.team_name = d.team_name;


CREATE OR REFRESH MATERIALIZED VIEW gold_constructor_standings_by_round
AS
WITH rounds AS (
  SELECT DISTINCT year, round_number
  FROM gold_dim_session
  WHERE session_name = 'Race' AND status = 'completed'
),
per_round AS (
  SELECT ds.year, ds.round_number, d.team_name,
         SUM(f.points)                                        AS points,
         COUNT_IF(f.position = 1 AND ds.session_name = 'Race') AS wins,
         COUNT_IF(f.position = 2 AND ds.session_name = 'Race') AS second_places
  FROM gold_fact_session_result f
  JOIN gold_dim_session ds ON ds.session_key = f.session_key
  JOIN gold_dim_driver  d  ON d.driver_key   = f.driver_key   -- the team AT THAT RACE
  GROUP BY ds.year, ds.round_number, d.team_name
),
cumulative AS (
  SELECT r.year, r.round_number, p.team_name,
         SUM(p.points)        AS points,
         SUM(p.wins)          AS wins,
         SUM(p.second_places) AS second_places
  FROM rounds r
  JOIN per_round p ON p.year = r.year AND p.round_number <= r.round_number
  GROUP BY r.year, r.round_number, p.team_name
),
ranked AS (
  SELECT *,
    RANK() OVER (PARTITION BY year, round_number
                 ORDER BY points DESC, wins DESC, second_places DESC) AS position
  FROM cumulative
)
SELECT
  t.year, t.round_number, t.position,
  LAG(t.position) OVER (PARTITION BY t.year, t.team_name ORDER BY t.round_number) AS previous_position,
  t.team_name, c.team_colour, t.points, t.wins
FROM ranked t
LEFT JOIN gold_team_colours c ON c.year = t.year AND c.team_name = t.team_name;

-- Race order lap by lap, for the replay on the site.
-- One row per car per lap it completed. Lap 0 is the starting grid.
CREATE OR REFRESH MATERIALIZED VIEW gold_race_lap_order (
  CONSTRAINT has_driver     EXPECT (driver_id IS NOT NULL) ON VIOLATION DROP ROW,
  CONSTRAINT valid_position EXPECT (position >= 1)
)
COMMENT 'Order, gap and laps behind after every lap of every race and sprint (lap 0 = grid)'
AS
WITH crossings AS (
  -- When a car finished lap N = when it started lap N+1 (this also covers lap 1,
  -- which often has no time of its own). Only the very last lap uses start + lap time.
  SELECT
    session_key, driver_id, lap_number, lap_time_sec,
    compound,
    tyre_age_laps,
    -- The next lap is a pit-out lap = the car pitted at the end of this one
    coalesce(lead(is_pit_out_lap) OVER w, false) AS pitted,
    coalesce(
      CASE WHEN lead(lap_number) OVER w = lap_number + 1 THEN lead(lap_start) OVER w END,
      timestamp_millis(unix_millis(lap_start) + CAST(lap_time_sec * 1000 AS BIGINT))
    ) AS crossed_at
  FROM gold_fact_lap
  WINDOW w AS (PARTITION BY session_key, driver_id ORDER BY lap_number)
),
ranked AS (
  -- Order on each lap = the order the cars crossed the line at the end of that lap
  SELECT *,
         row_number() OVER (PARTITION BY session_key, lap_number ORDER BY crossed_at) AS position,
         min(crossed_at) OVER (PARTITION BY session_key, lap_number)                  AS leader_at
  FROM crossings
  WHERE crossed_at IS NOT NULL
),
leader_line AS (
  -- When the leader completed each lap
  SELECT DISTINCT session_key, lap_number, leader_at FROM ranked
),
behind AS (
  -- How many laps the leader had done when this car crossed the line
  SELECT r.session_key, r.driver_id, r.lap_number,
         max(l.lap_number) - r.lap_number AS laps_behind
  FROM ranked r
  JOIN leader_line l
    ON l.session_key = r.session_key AND l.leader_at <= r.crossed_at
  GROUP BY r.session_key, r.driver_id, r.lap_number
)
SELECT
  r.session_key, r.lap_number, r.driver_id, r.position, r.crossed_at,
  (unix_millis(r.crossed_at) - unix_millis(r.leader_at)) / 1000.0 AS gap_to_leader_sec,
  greatest(b.laps_behind, 0)                                      AS laps_behind,
  r.lap_time_sec,
  r.compound,
  r.tyre_age_laps,
  r.pitted
FROM ranked r
JOIN behind b USING (session_key, driver_id, lap_number)

UNION ALL

-- Lap 0: the starting grid
SELECT
  f.session_key, 0 AS lap_number, f.driver_id, f.grid_position AS position,
  CAST(NULL AS TIMESTAMP), CAST(NULL AS DOUBLE), 0, CAST(NULL AS DOUBLE), CAST(NULL AS STRING), CAST(NULL AS INT), false
FROM gold_fact_session_result f
WHERE f.grid_position IS NOT NULL;

-- Safety car, virtual safety car and red flag periods, by lap, for the replay.
CREATE OR REFRESH MATERIALIZED VIEW gold_race_neutralisations (
  CONSTRAINT has_lap EXPECT (start_lap IS NOT NULL) ON VIOLATION DROP ROW
)
COMMENT 'One row per SC / VSC / red flag period in a race or sprint: kind, first lap, last lap'
AS
WITH signals AS (
  SELECT rc.session_key, rc.lap_number, rc.message_time,
         CASE
           WHEN rc.message LIKE 'VIRTUAL SAFETY CAR DEPLOYED%'
             OR rc.message LIKE 'VSC DEPLOYED%'                THEN 'VSC'
           WHEN rc.message LIKE 'SAFETY CAR DEPLOYED%'         THEN 'SC'
           WHEN rc.flag = 'RED' OR rc.message LIKE 'RED FLAG%' THEN 'RED'
         END AS start_kind,
         CASE
           WHEN rc.message LIKE 'VIRTUAL SAFETY CAR ENDING%'
             OR rc.message LIKE 'VSC ENDING%'                  THEN 'VSC'
           WHEN rc.message LIKE 'SAFETY CAR IN THIS LAP%'      THEN 'SC'
         END AS end_kind
  FROM silver_race_control rc
  JOIN gold_dim_session s ON s.session_key = rc.session_key AND s.session_type = 'Race'
  WHERE rc.lap_number IS NOT NULL
)
SELECT
  s.session_key,
  s.start_kind  AS kind,
  s.lap_number  AS start_lap,
  CASE WHEN s.start_kind = 'RED' THEN s.lap_number          -- a red flag is shown on its own lap
       ELSE min_by(e.lap_number, e.message_time) END AS end_lap   -- NULL = lasted to the finish
FROM signals s
LEFT JOIN signals e
  ON  e.session_key = s.session_key
  AND e.message_time > s.message_time
  -- The period ends at its own "ending" message, or when a different kind starts (VSC turned into SC)
  AND (e.end_kind = s.start_kind OR (e.start_kind IS NOT NULL AND e.start_kind <> s.start_kind))
WHERE s.start_kind IS NOT NULL
GROUP BY s.session_key, s.start_kind, s.lap_number, s.message_time;

-- The circuit, drawn from the fastest clean lap of each race, with points in driving order.
-- Uses the raw positions (~3.8/s, ~350 points per lap), so corners stay smooth.
CREATE OR REFRESH MATERIALIZED VIEW gold_track_outline
COMMENT 'Circuit outline per race: x/y points of one clean fast lap, in driving order'
AS
WITH best_lap AS (
  SELECT session_key, driver_number, lap_start,
         timestamp_millis(unix_millis(lap_start) + CAST(lap_time_sec * 1000 AS BIGINT)) AS lap_end
  FROM silver_laps
  WHERE is_clean_lap AND lap_start IS NOT NULL AND lap_time_sec IS NOT NULL
  QUALIFY row_number() OVER (PARTITION BY session_key ORDER BY lap_time_sec) = 1
)
SELECT b.session_key,
       row_number() OVER (PARTITION BY b.session_key ORDER BY l.date) AS seq,
       l.x, l.y
FROM best_lap b
JOIN bronze_location l
  ON  l.session_key   = b.session_key
  AND l.driver_number = b.driver_number
  AND l.date BETWEEN b.lap_start AND b.lap_end;


-- How much of each race has car positions. Visible, not blocking: a race without
-- enough data just doesn't get a map, the results and standings are unaffected.
CREATE OR REFRESH MATERIALIZED VIEW gold_location_coverage
COMMENT 'Seconds of the race with car positions, and whether that is enough for a map (>= 90%)'
AS
WITH have AS (
  SELECT session_key, count(DISTINCT t) AS seconds_with_data
  FROM silver_location GROUP BY session_key
),
race AS (
  SELECT session_key, (unix_millis(max(lap_start)) - unix_millis(min(lap_start))) / 1000.0 AS race_seconds
  FROM silver_laps GROUP BY session_key
)
SELECT h.session_key,
       h.seconds_with_data,
       round(r.race_seconds)                                          AS race_seconds,
       least(100, round(100 * h.seconds_with_data / r.race_seconds, 1)) AS coverage_pct,
       h.seconds_with_data >= 0.9 * r.race_seconds                    AS has_map
FROM have h JOIN race r USING (session_key);

-- Car positions every 2 seconds, keyed by driver, only for races with enough data for a map.
-- This is what the map export reads; the site interpolates between the points.
CREATE OR REFRESH MATERIALIZED VIEW gold_location_frames (
  CONSTRAINT has_driver EXPECT (driver_id IS NOT NULL) ON VIOLATION DROP ROW
)
COMMENT 'One position per car every 2 s during the race, for races where gold_location_coverage.has_map'
AS
SELECT l.session_key, d.driver_id, l.t, l.x, l.y
FROM silver_location l
JOIN gold_location_coverage c
  ON c.session_key = l.session_key AND c.has_map
LEFT JOIN silver_session_drivers d
  ON d.session_key = l.session_key AND d.driver_number = l.driver_number
WHERE second(l.t) % 2 = 0;