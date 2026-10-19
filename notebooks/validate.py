# Databricks notebook source
# Cross-table checks that expectations can't do (they only see one row at a time).
# Each query returns the number of problems: 0 = pass.

dbutils.widgets.text("schema", "pipeline", "Schema to validate")
SCHEMA = dbutils.widgets.get("schema")
print(f"Validating f1.{SCHEMA}\n")

checks = {

    "one winner per completed race/sprint": """
        SELECT COUNT(*) FROM (
          SELECT s.session_key
          FROM f1.pipeline.silver_sessions s
          LEFT JOIN f1.pipeline.silver_session_results r ON r.session_key = s.session_key
          WHERE s.session_type = 'Race' AND s.status = 'completed'
          GROUP BY s.session_key
          HAVING COUNT_IF(r.position = 1) <> 1)
    """,

    "2025 championship matches official result": """
        SELECT COUNT(*) FROM (
          SELECT * FROM VALUES ('lando_norris', 423), ('max_verstappen', 421), ('oscar_piastri', 410)
                           AS expected(driver_id, points)
          EXCEPT
          SELECT driver_id, CAST(total_points AS INT)
          FROM f1.pipeline.gold_agg_championship_progress
          WHERE year = 2025 AND round_number = 24)
    """,

    "driver_key is unique": """
        SELECT COUNT(*) FROM (
          SELECT driver_key FROM f1.pipeline.gold_dim_driver
          GROUP BY driver_key HAVING COUNT(*) > 1)
    """,

    "one current row per driver": """
        SELECT COUNT(*) FROM (
          SELECT driver_id FROM f1.pipeline.gold_dim_driver
          GROUP BY driver_id HAVING COUNT_IF(is_current) <> 1)
    """,

    "no duplicate laps in fact_lap": """
        SELECT COUNT(*) - COUNT(DISTINCT session_key, driver_key, lap_number)
        FROM f1.pipeline.gold_fact_lap
    """,

    "no results lost between silver and gold": """
        SELECT ABS((SELECT COUNT(*) FROM f1.pipeline.silver_session_results)
                 - (SELECT COUNT(*) FROM f1.pipeline.gold_fact_session_result))
    """,

    "no overlapping stints": """
        SELECT COUNT(*)
        FROM f1.pipeline.silver_stints a
        JOIN f1.pipeline.silver_stints b
          ON  a.session_key   = b.session_key
          AND a.driver_number = b.driver_number
          AND a.stint_number  < b.stint_number
          AND a.lap_start    <= b.lap_end
          AND b.lap_start    <= a.lap_end
    """,

    "every completed race/sprint has a grid (except known gaps)": """
        SELECT COUNT(*)
        FROM f1.pipeline.silver_sessions s
        LEFT ANTI JOIN f1.pipeline.silver_starting_grid g ON g.session_key = s.session_key
        WHERE s.session_type = 'Race' AND s.status = 'completed'
          AND s.session_key NOT IN (9864)   -- 2025 São Paulo Sprint: no grid in OpenF1 (known issue)
    """,

    "stint quarantine stays small (max 5)": """
        SELECT GREATEST(COUNT(*) - 5, 0) FROM f1.pipeline.silver_quarantine_stints
    """,

    "fact_lap only contains races and sprints": """
        SELECT COUNT(*)
        FROM f1.pipeline.gold_fact_lap f
        JOIN f1.pipeline.gold_dim_session s ON s.session_key = f.session_key
        WHERE s.session_type <> 'Race'
    """,

    "Exactly one pole per qualifying session": """
        SELECT count(*) FROM (
            SELECT session_key
            FROM f1.pipeline.gold_qualifying_results
            GROUP BY session_key
            HAVING count_if(position = 1) <> 1
        )
    """,

    "At most 10 cars in Q3": """
        SELECT count(*) FROM (
            SELECT session_key
            FROM f1.pipeline.gold_qualifying_results
            GROUP BY session_key
            HAVING count_if(stage_reached = 'Q3') > 10
        )
    """,

    "Standings after the last round match the season standings": """
        SELECT COUNT(*) FROM (
          SELECT b.year, b.driver_id, b.position, b.points
          FROM f1.pipeline.gold_driver_standings_by_round b
          WHERE b.round_number = (SELECT MAX(round_number) FROM f1.pipeline.gold_driver_standings_by_round x
                                  WHERE x.year = b.year)
          EXCEPT
          SELECT year, driver_id, position, points FROM f1.pipeline.gold_driver_standings)
    """,

    "One fastest lap per race/sprint": """
        SELECT COUNT(*) FROM (
          SELECT session_key FROM f1.pipeline.gold_race_results
          GROUP BY session_key HAVING COUNT_IF(has_fastest_lap) <> 1)
    """,

    "One colour per team per season on the site": """
        SELECT COUNT(*) FROM (
          SELECT season, team_name FROM (
            SELECT season, team_name, team_colour FROM f1.pipeline.gold_race_results
            UNION ALL
            SELECT season, team_name, team_colour FROM f1.pipeline.gold_qualifying_results)
          GROUP BY season, team_name
          HAVING COUNT(DISTINCT team_colour) <> 1 OR COUNT_IF(team_colour IS NULL) > 0)
    """,

    "every safety car message in a race is recognised": """
        SELECT count(*)
        FROM f1.pipeline.silver_race_control rc
        JOIN f1.pipeline.gold_dim_session s ON s.session_key = rc.session_key AND s.session_type = 'Race'
        WHERE rc.category = 'SafetyCar'
          AND NOT (rc.message LIKE 'VIRTUAL SAFETY CAR DEPLOYED%' OR rc.message LIKE 'VSC DEPLOYED%'
                OR rc.message LIKE 'VIRTUAL SAFETY CAR ENDING%'   OR rc.message LIKE 'VSC ENDING%'
                OR rc.message LIKE 'SAFETY CAR DEPLOYED%'         OR rc.message LIKE 'SAFETY CAR IN THIS LAP%'
                OR rc.message LIKE 'SAFETY CAR THROUGH THE PIT LANE%')
    """,
}

failures = []
for name, sql in checks.items():
    problems = spark.sql(sql.replace("f1.pipeline.", f"f1.{SCHEMA}.")).first()[0]
    print(f"{'PASS' if problems == 0 else 'FAIL'}  {name}  ({problems})")
    if problems != 0:
        failures.append(name)

if failures:
    raise Exception(f"{len(failures)} validation check(s) failed: {failures}")
print("\nAll checks passed.")