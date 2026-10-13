# F1-lakehouse
F1 analytics lakehouse on Databricks. It pulls real race data from [OpenF1](https://openf1.org) and refines it through Bronze, Silver and Gold layers into tables ready for analysis.

```
OpenF1 API ──► landing Volume (JSON) ──► Bronze ──► Silver ──► Gold
               notebooks/ingest_openf1.py   └──── pipeline/*.sql ────┘
```

## Ingesting
[notebooks/ingest_openf1.py](notebooks/ingest_openf1.py) lands raw JSON in `/Volumes/f1/bronze/landing/openf1`, one file per session and endpoint (drivers, results, laps, stints, pit stops, weather, race control).

- Only sessions that ended more than 12 hours ago and haven't been landed already are fetched.
- The `years` parameter defaults to the current season. Pass e.g. `2023,2024` to backfill.
- The decisions about what to fetch live in [src/f1_ingest/planning.py](src/f1_ingest/planning.py) as pure functions, so they can be unit-tested without the API.

## Modelling
A serverless Lakeflow (DLT) pipeline in [pipeline/](pipeline/) builds three layers in the `f1` catalog:

| Layer  | What it holds |
|--------|---------------|
| Bronze | Raw JSON as tables, plus source file and ingest time. Event data is streamed incrementally. |
| Silver | Deduplicated, typed and cleaned tables (sessions, meetings, results, drivers, grid, laps, stints) with data-quality expectations. |
| Gold   | Star schema: `dim_driver` (SCD2, tracks team and number changes), `dim_session`, `fact_session_result`, `fact_lap`. Analysis tables: tyre degradation, championship progress and season points. |

## Automating
The `f1_weekly` job ([resources/f1_weekly.job.yml](resources/f1_weekly.job.yml)) runs every Monday at 14:00 (Oslo time):

1. **ingest**: land new OpenF1 data (retries twice)
2. **transform**: run the pipeline
3. **validate**: cross-table checks such as one winner per race, unique driver keys, and the 2025 standings matching the official result

The job emails on failure.

## Operating
Everything is deployed as a Databricks Asset Bundle ([databricks.yml](databricks.yml)):

| Target | Schema        | Mode        |
|--------|---------------|-------------|
| `dev`  | `pipeline_dev` | development (default) |
| `prod` | `pipeline`     | production |

```bash
pytest -v                              # unit tests
databricks bundle validate -t dev
databricks bundle deploy -t dev
databricks bundle run f1_weekly -t dev
```

CI/CD with GitHub Actions:
- **Pull requests to `main`**: run tests and validate the prod bundle ([ci.yml](.github/workflows/ci.yml))
- **Push to `main`**: run tests and deploy to prod ([deploy.yml](.github/workflows/deploy.yml))

Both need the `DATABRICKS_HOST` and `DATABRICKS_TOKEN` repo secrets.
