// Shape of the files in data/, written by notebooks/export_site_data.py.
// If the export changes, change this file too – TypeScript will then point
// at every place in the site that needs updating.

export type Stage = "Q1" | "Q2" | "Q3";

// ---------- qualifying.json ----------

export interface QualifyingResult {
  position: number | null; // null = no classified position (e.g. DNS)
  driver_number: number;
  driver_id: string;
  name: string;
  acronym: string;
  team: string;
  team_colour: string | null; // "#RRGGBB", one per team per season
  q1: number | null; // seconds
  q2: number | null;
  q3: number | null;
  stage: Stage | null;
  dns: boolean;
  dsq: boolean;
}

export interface QualifyingSession {
  session_key: number;
  meeting_key: number;
  season: number;
  round: number | null;
  location: string;
  session_name: string; // "Qualifying", "Sprint Qualifying" or (2023) "Sprint Shootout"
  date: string; // ISO timestamp
  results: QualifyingResult[];
}

export interface QualifyingFile {
  generated_at: string;
  seasons: number[];
  sessions: QualifyingSession[];
}

// ---------- races.json ----------

export type RaceStatus = "finished" | "retired" | "did_not_start" | "disqualified";

export interface RaceResult {
  position: number | null;
  status: RaceStatus;
  driver_number: number;
  driver_id: string;
  name: string;
  acronym: string;
  team: string;
  team_colour: string | null;
  grid: number | null; // null = pit lane start or no grid data
  gained: number | null;
  points: number;
  laps: number;
  time: number | null; // total race time in seconds
  gap: number | null; // seconds behind the winner
  laps_behind: number | null;
  best_lap: number | null;
  fastest_lap: boolean;
}

export interface RaceSession {
  session_key: number;
  meeting_key: number;
  season: number;
  round: number;
  meeting_name: string;
  location: string;
  country: string;
  session_name: "Race" | "Sprint";
  date: string;
  results: RaceResult[];
}

export interface RacesFile {
  generated_at: string;
  sessions: RaceSession[];
}

// ---------- standings.json ----------

export interface DriverStanding {
  position: number;
  previous: number | null; // position after the previous round
  driver_id: string;
  name: string;
  acronym: string;
  number: number;
  team: string;
  team_colour: string | null;
  points: number;
  wins: number;
  podiums: number;
}

export interface ConstructorStanding {
  position: number;
  previous: number | null;
  team: string;
  team_colour: string | null;
  points: number;
  wins: number;
}

export interface RoundStandings {
  season: number;
  round: number;
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
}

export interface StandingsFile {
  generated_at: string;
  rounds: RoundStandings[];
}

// ---------- built by the site ----------

// Everything that happened at one race weekend
export interface Weekend {
  season: number;
  round: number;
  name: string; // "Singapore Grand Prix"
  location: string;
  country: string;
  date: string; // the main race (or the last session we have)
  race?: RaceSession;
  sprint?: RaceSession;
  qualifying?: QualifyingSession;
  sprintQualifying?: QualifyingSession;
}

export type Tab = "race" | "replay" | "qualifying" | "sprint" | "sprintQualifying";

// ---------- replay/<session_key>.json ----------

export interface ReplayDriver {
  id: string;
  acronym: string;
  name: string;
  team: string;
  team_colour: string | null;
}

export type Tyre = "S" | "M" | "H" | "I" | "W";

// One car on one lap:
// [driver index, gap to leader (s), laps behind, lap time (s), tyre, tyre age (laps), pitted at the end of this lap (0/1)]
// The last three were added later, so older files may not have them.
export type ReplayEntry = [number, number | null, number, number | null, (Tyre | null)?, (number | null)?, (0 | 1)?];

// A safety car, virtual safety car or red flag period, by lap. to = null: it lasted to the finish.
export interface Neutralisation {
  kind: "SC" | "VSC" | "RED";
  from: number;
  to: number | null;
}

export interface ReplayLap {
  lap: number; // 0 = starting grid
  order: ReplayEntry[]; // already in race order: first entry is P1
}

// ---------- map/<session_key>.json (track map, current season only) ----------

export interface MapCar {
  id: string; // driver_id, same key as ReplayDriver.id
  xy: (number | null)[]; // [x0, y0, x1, y1, ...], one pair every `step` seconds from the start; null = no data
}

export interface MapFile {
  session_key: number;
  step: number; // seconds between positions
  outline: [number, number][]; // the circuit, in driving order
  laps: [number, number][]; // [lap, seconds after the start] when the leader finished it
  cars: MapCar[];
}

export interface ReplayFile {
  session_key: number;
  drivers: ReplayDriver[];
  neutralisations?: Neutralisation[];
  laps: ReplayLap[];
}
