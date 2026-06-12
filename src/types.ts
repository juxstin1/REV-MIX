import { TrackAnalysis } from "./audio/analysis";

export interface LoadedTrack {
  path: string;
  name: string;
  buffer: AudioBuffer;
  analysis: TrackAnalysis | null; // null while analysis is running
  /** stem-separation vocal awareness */
  voxStatus?: "pending" | "done" | "failed";
}

/** A mixer channel's pot/fader positions (0..1). Lifted to App so the on-screen
 *  controls and the MIDI controller stay in sync. */
export interface StripState {
  trim: number;
  high: number;
  mid: number;
  low: number;
  filter: number;
  fader: number;
}

export const initialStrip: StripState = {
  trim: 0.5,
  high: 0.5,
  mid: 0.5,
  low: 0.5,
  filter: 0.5,
  fader: 1,
};
