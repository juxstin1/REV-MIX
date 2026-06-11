import { TrackAnalysis } from "./audio/analysis";

export interface LoadedTrack {
  path: string;
  name: string;
  buffer: AudioBuffer;
  analysis: TrackAnalysis | null; // null while analysis is running
  /** stem-separation vocal awareness */
  voxStatus?: "pending" | "done" | "failed";
}
