"""Decision logic for OpenF1 ingestion.

Pure functions: no API calls, no files, no Spark. That makes them fast and easy to test.
"""
from datetime import datetime, timedelta

SETTLE_TIME = timedelta(hours=8)   # give OpenF1 time to finish publishing a session's data
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


# --- What to fetch per session type -------------------------------------
# (API endpoint, landing folder). Qualifying results have a different shape
# (Q1/Q2/Q3 lists), so they land in their own folder.
# race_control is always last: its file is the "session fully landed" marker.

RACE_ENDPOINTS = [
    ("drivers", "drivers"),
    ("session_result", "session_result"),
    ("laps", "laps"),
    ("stints", "stints"),
    ("pit", "pit"),
    ("weather", "weather"),
    ("race_control", "race_control"),
]

QUALIFYING_ENDPOINTS = [
    ("drivers", "drivers"),
    ("session_result", "session_result_qualifying"),
    ("laps", "laps"),
    ("race_control", "race_control"),
]

INGESTED_SESSION_TYPES = ("Race", "Qualifying")   # OpenF1: sprints are "Race", sprint qualifying is "Qualifying"


def endpoints_for(session: dict) -> list[tuple[str, str]]:
    """(API endpoint, landing folder) pairs to fetch for one session."""
    if session["session_type"] == "Race":
        return RACE_ENDPOINTS
    if session["session_type"] == "Qualifying":
        return QUALIFYING_ENDPOINTS
    raise ValueError(f"Session type not ingested: {session['session_type']}")


def landed_marker_folder(session: dict) -> str:
    """The folder whose file proves a session was landed completely (the last one fetched)."""
    return endpoints_for(session)[-1][1]

# --- Car positions (track map) ------------------------------------------
# The location endpoint is ~3.8 samples per second per car, ~25k rows per car per race.
# To keep volume and API calls down it's only fetched for Grand Prix races (not sprints)
# in the current season.

def wants_location(session: dict, now: datetime) -> bool:
    """Car positions are fetched for Grand Prix races of the current season only."""
    return session.get("session_name") == "Race" and session.get("year") == now.year


def locations_to_ingest(races: list[dict], landed_keys: set, now: datetime,
                        settle: timedelta = SETTLE_TIME) -> list[dict]:
    """Finished current-season Grand Prix races whose car positions haven't been landed yet."""
    return [s for s in races
            if wants_location(s, now) and is_finished(s, now, settle) and s["session_key"] not in landed_keys]
