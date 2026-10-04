import type { Dispatch, SetStateAction } from "react";
import type { SetupDraft } from "./drafts.js";
export interface SetupDraftProps {
  draft: SetupDraft;
  set: <K extends keyof SetupDraft>(key: K, value: SetupDraft[K]) => void;
  setDraft: Dispatch<SetStateAction<SetupDraft>>;
}
