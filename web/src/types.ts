// Shape of data/qualifying.json, written by notebooks/export_site_data.py.
// If the export changes, change this file too – TypeScript will then point
// at every place in the site that needs updating.

export type Stage = "Q1" | "Q2" | "Q3";

export interface QualifyingResult {
  position: number | null; // null = no classified position (e.g. DNS)
  driver_number: number;
  driver_id: string;
  name: string;
  acronym: string;
  team: string;
  team_colour: string | null; // hex without '#', e.g. "3671C6"
  q1: number | null; // seconds
  q2: number | null;
  q3: number | null;
  stage: Stage | null;
  dns: boolean;
  dsq: boolean;
}

export interface QualifyingSession {
  session_key: number;
  season: number;
  location: string;
  session_name: "Qualifying" | "Sprint Qualifying";
  date: string; // ISO timestamp
  results: QualifyingResult[];
}

export interface QualifyingFile {
  generated_at: string;
  seasons: number[];
  sessions: QualifyingSession[];
}
