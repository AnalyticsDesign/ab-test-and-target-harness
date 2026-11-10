import type { ExperimentRow } from "./db";

/** spec §13.8: draft → running、running ↔ paused、running | paused → archived(復帰不可)。表外は 409 invalid_transition */
export const TRANSITIONS: Record<ExperimentRow["status"], Array<ExperimentRow["status"]>> = {
  draft: ["running"],
  running: ["paused", "archived"],
  paused: ["running", "archived"],
  archived: [],
};
