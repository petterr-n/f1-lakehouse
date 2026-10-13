"""Decision logic for OpenF1 ingestion.

Pure functions: no API calls, no files, no Spark. That makes them fast and easy to test.
"""
from datetime import datetime, timedelta

SETTLE_TIME = timedelta(hours=12)   # give OpenF1 time to finish publishing a session's data
FIRST_OPENF1_YEAR = 2023


def is_finished(session: dict, now: datetime, settle: timedelta = SETTLE_TIME) -> bool:
    """A session counts as finished once it ended at least `settle` ago."""
    return datetime.fromisoformat(session["date_end"]) <= now - settle


def sessions_to_ingest(sessions: list[dict], landed_keys: set, now: datetime,
                       settle: timedelta = SETTLE_TIME) -> list[dict]:
    """Finished sessions that haven't been landed yet."""
    return [s for s in sessions
            if is_finished(s, now, settle) and s["session_key"] not in landed_keys]


def meetings_needing_grid(races: list[dict], landed_meeting_keys: set, now: datetime,
                          settle: timedelta = SETTLE_TIME) -> list[int]:
    """Weekends with at least one finished race session and no grid file yet (sorted)."""
    finished = {s["meeting_key"] for s in races if is_finished(s, now, settle)}
    return sorted(finished - set(landed_meeting_keys))


def parse_years(param: str, now: datetime) -> list[int]:
    """'' -> current season; '2023, 2024' -> [2023, 2024]. Rejects years OpenF1 doesn't have."""
    param = (param or "").strip()
    if not param:
        return [now.year]
    years = [int(p) for p in param.split(",") if p.strip()]
    for y in years:
        if not FIRST_OPENF1_YEAR <= y <= now.year:
            raise ValueError(f"OpenF1 has data from {FIRST_OPENF1_YEAR} to {now.year}, got {y}")
    return years