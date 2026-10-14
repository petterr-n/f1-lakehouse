import type {
  QualifyingFile,
  RacesFile,
  RoundStandings,
  StandingsFile,
  Weekend,
} from "./types";

export interface SiteData {
  generatedAt: string;
  seasons: number[];
  weekends: Weekend[]; // in date order, all seasons
  standings: Map<string, RoundStandings>; // "2026-17" -> table after round 17
}

async function getJson<T>(file: string): Promise<T> {
  const res = await fetch(`data/${file}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not load ${file} (HTTP ${res.status})`);
  return res.json();
}

export const roundKey = (season: number, round: number) => `${season}-${round}`;

export async function loadData(): Promise<SiteData> {
  const [races, quali, standings] = await Promise.all([
    getJson<RacesFile>("races.json"),
    getJson<QualifyingFile>("qualifying.json"),
    getJson<StandingsFile>("standings.json"),
  ]);

  // Group every session into its weekend. Races carry the proper event name,
  // so they go first; a weekend with only qualifying so far uses the location.
  const weekends = new Map<number, Weekend>();
  const weekend = (meetingKey: number, init: () => Weekend) => {
    let w = weekends.get(meetingKey);
    if (!w) weekends.set(meetingKey, (w = init()));
    return w;
  };

  for (const s of races.sessions) {
    const w = weekend(s.meeting_key, () => ({
      season: s.season,
      round: s.round,
      name: s.meeting_name,
      location: s.location,
      country: s.country,
      date: s.date,
    }));
    if (s.session_name === "Sprint") w.sprint = s;
    else {
      w.race = s;
      w.date = s.date;
    }
  }

  for (const s of quali.sessions) {
    if (s.round === null) continue; // testing etc.
    const w = weekend(s.meeting_key, () => ({
      season: s.season,
      round: s.round!,
      name: s.location,
      location: s.location,
      country: "",
      date: s.date,
    }));
    if (s.session_name === "Qualifying") w.qualifying = s;
    else w.sprintQualifying = s;
  }

  const list = [...weekends.values()].sort((a, b) => a.season - b.season || a.round - b.round);

  return {
    generatedAt: races.generated_at,
    seasons: [...new Set(list.map((w) => w.season))],
    weekends: list,
    standings: new Map(standings.rounds.map((r) => [roundKey(r.season, r.round), r])),
  };
}

// The table as it stood after this round – or the latest one before it,
// if the race hasn't happened yet (e.g. only qualifying is in).
export function standingsFor(data: SiteData, season: number, round: number): RoundStandings | undefined {
  for (let r = round; r > 0; r--) {
    const s = data.standings.get(roundKey(season, r));
    if (s) return s;
  }
  return undefined;
}
