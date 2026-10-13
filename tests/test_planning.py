from datetime import datetime, timedelta, timezone

import pytest

from f1_ingest.planning import (
    is_finished, meetings_needing_grid, parse_years, sessions_to_ingest,
)

# A fixed "now" makes the tests give the same result every time they run
NOW = datetime(2026, 10, 19, 14, 0, tzinfo=timezone.utc)


def session(key, meeting, ended_hours_ago):
    """A fake OpenF1 session that ended a given number of hours before NOW (negative = future)."""
    end = NOW - timedelta(hours=ended_hours_ago)
    return {"session_key": key, "meeting_key": meeting, "date_end": end.isoformat()}


# --- is_finished ---------------------------------------------------------

def test_future_session_is_not_finished():
    assert not is_finished(session(1, 10, ended_hours_ago=-48), NOW)


def test_session_that_ended_recently_is_not_finished_yet():
    assert not is_finished(session(1, 10, ended_hours_ago=6), NOW)


def test_session_that_ended_long_ago_is_finished():
    assert is_finished(session(1, 10, ended_hours_ago=13), NOW)


def test_exactly_at_settle_time_counts_as_finished():
    assert is_finished(session(1, 10, ended_hours_ago=12), NOW)


def test_reads_openf1_date_format():
    # Same format as the API; 17 hours before NOW
    s = {"session_key": 1, "meeting_key": 10, "date_end": "2026-10-18T21:00:00+00:00"}
    assert is_finished(s, NOW)


# --- sessions_to_ingest --------------------------------------------------

def test_only_finished_and_not_landed_sessions_are_ingested():
    sessions = [
        session(1, 10, ended_hours_ago=100),   # finished, already landed
        session(2, 10, ended_hours_ago=100),   # finished, not landed  -> ingest
        session(3, 11, ended_hours_ago=2),     # finished too recently
        session(4, 12, ended_hours_ago=-24),   # in the future
    ]
    result = sessions_to_ingest(sessions, landed_keys={1}, now=NOW)
    assert [s["session_key"] for s in result] == [2]


# --- meetings_needing_grid -----------------------------------------------

def test_sprint_weekend_needs_one_grid_file():
    races = [session(1, 10, ended_hours_ago=30),   # sprint
             session(2, 10, ended_hours_ago=20)]   # race, same weekend
    assert meetings_needing_grid(races, landed_meeting_keys=set(), now=NOW) == [10]


def test_landed_and_unfinished_weekends_need_no_grid():
    races = [session(1, 10, ended_hours_ago=100),  # grid already landed
             session(2, 11, ended_hours_ago=100),  # needs a grid
             session(3, 12, ended_hours_ago=1)]    # not finished long enough
    assert meetings_needing_grid(races, landed_meeting_keys={10}, now=NOW) == [11]


# --- parse_years ---------------------------------------------------------

def test_empty_years_means_current_season():
    assert parse_years("", NOW) == [2026]


def test_years_are_parsed_with_spaces():
    assert parse_years("2023, 2024", NOW) == [2023, 2024]


def test_years_outside_openf1_range_are_rejected():
    with pytest.raises(ValueError):
        parse_years("2019", NOW)