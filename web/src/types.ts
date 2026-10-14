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

export type Tab = "race" | "qualifying" | "sprint" | "sprintQualifying";
