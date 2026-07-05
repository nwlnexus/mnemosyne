export type Provenance = { session: string; cwd: string; ts: string };
export type LearningKind = "fact" | "decision" | "lesson" | "noise";
export type Learning = {
  text: string;
  kind: LearningKind;
  confidence: number;
  provenance: Provenance;
  title?: string;
};
export type Turn = { role: "user" | "assistant"; text: string };
