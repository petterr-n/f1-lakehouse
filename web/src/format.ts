import type { RaceResult } from "./types";

// 78.123 -> "1:18.123", null -> ""
export function lapTime(seconds: number | null): string {
  if (seconds === null) return "";
  const m = Math.floor(seconds / 60);
  const s = (seconds - m * 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}

// 6120.785 -> "1:42:00.785"
export function raceTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const rest = lapTime(seconds - h * 3600);
  return h ? `${h}:${rest.padStart(9, "0")}` : rest;
}

// Winner's time, "+3.214", "+1 lap", or why there's no time
export function raceGap(r: RaceResult): string {
  if (r.status === "disqualified") return "DSQ";
  if (r.status === "did_not_start") return "DNS";
  if (r.status === "retired") return "DNF";
  if (r.position === 1 && r.time !== null) return raceTime(r.time);
  if (r.laps_behind) return `+${r.laps_behind} lap${r.laps_behind > 1 ? "s" : ""}`;
  if (r.gap !== null) return `+${r.gap.toFixed(3)}`;
  return "";
}

// 25 -> "25", 0.5 -> "0.5"
export function points(p: number): string {
  return Number.isInteger(p) ? String(p) : p.toFixed(1);
}

export function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Team colour from the data, with a neutral fallback
export function colour(c: string | null): string {
  return c && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : "#6B7280";
}

// Escape text before putting it into HTML
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
