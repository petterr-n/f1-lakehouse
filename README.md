# F1-lakehouse
F1 analytics lakehouse on Databricks. It pulls real race data from [OpenF1](https://openf1.org) and refines it through Bronze, Silver and Gold layers into tables ready for analysis.

**Live site:** [petterr-n.github.io/f1-lakehouse](https://petterr-n.github.io/f1-lakehouse/) shows the latest race result and the current drivers' and constructors' standings.

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
4. **export**: write the gold tables the site needs to `/Volumes/f1/pipeline/exports/site/f1_site_data.json` ([notebooks/export_site_data.py](notebooks/export_site_data.py))

The job emails on failure.

## Publishing
The public site at [petterr-n.github.io/f1-lakehouse](https://petterr-n.github.io/f1-lakehouse/) is a static page ([site/index.html](site/index.html)) served by GitHub Pages. It only renders the exported JSON, so all numbers come from the validated gold tables.

[publish-site.yml](.github/workflows/publish-site.yml) downloads the latest export from Databricks and deploys the site:
- every Monday at 14:00 UTC, after the weekly job has finished
- on push to `main` when anything under `site/` changes
- manually via **Run workflow**

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
- **Weekly / on site changes**: publish the site to GitHub Pages ([publish-site.yml](.github/workflows/publish-site.yml))

All three need the `DATABRICKS_HOST` and `DATABRICKS_TOKEN` repo secrets.
