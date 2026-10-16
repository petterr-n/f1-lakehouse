-- Bronze:
CREATE OR REFRESH MATERIALIZED VIEW bronze_meetings
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/f1/bronze/landing/openf1/meetings/', format => 'json', multiLine => true);

CREATE OR REFRESH MATERIALIZED VIEW bronze_sessions
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM read_files('/Volumes/f1/bronze/landing/openf1/sessions/', format => 'json', multiLine => true);

-- Event data: new files only ever get added, so stream them incrementally
CREATE OR REFRESH STREAMING TABLE bronze_drivers
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/drivers/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_session_result
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/session_result/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_session_result_qualifying
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/session_result_qualifying/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_starting_grid
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/starting_grid/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_laps
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/laps/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_stints
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/stints/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_pit
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/pit/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_weather
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/weather/', format => 'json', multiLine => true);

CREATE OR REFRESH STREAMING TABLE bronze_race_control
AS SELECT *, _metadata.file_path AS _source_file, current_timestamp() AS _ingested_at
FROM STREAM read_files('/Volumes/f1/bronze/landing/openf1/race_control/', format => 'json', multiLine => true);