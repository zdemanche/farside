import type { ReactNode } from "react";

export type Tone = "good" | "warn" | "crit" | "neutral";

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function coverageTone(state: string): Tone {
  return state === "assessed" ? "good" : state === "unassessed" ? "warn" : "neutral";
}
