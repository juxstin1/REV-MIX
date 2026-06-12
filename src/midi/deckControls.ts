/**
 * Bridge between the MIDI layer (App) and each deck's existing performance
 * controls, which live inside the `CDJ` component (CUE / LOOP / FX banks, hot
 * cues, loops, FX hold/lock, sync, pitch bend). CDJ registers its live handlers
 * here on mount; App's MIDI targets call them by deck id. This keeps all the
 * pad/loop/fx behaviour in CDJ — MIDI just drives the same handlers the
 * on-screen buttons do.
 */

import { DeckId } from "../audio/engine";

export type PadBank = "CUE" | "LOOP" | "FX";

export interface DeckControls {
  setBank(b: PadBank): void;
  /**
   * Fire pad `i` for a SPECIFIC bank, regardless of the on-screen bank, and
   * switch the visible tab to match. The REV-5 sends a distinct note per
   * (mode, pad), so the note itself tells us the bank — we don't depend on the
   * UI being in sync. `pressed` matters only for FX (hold) pads.
   */
  padInBank(bank: PadBank, i: number, pressed: boolean): void;
  autoLoop(): void; // toggle a default 4-beat loop
  loopHalve(): void;
  loopDouble(): void;
  sync(): void;
  bend(dir: 1 | -1, on: boolean): void;
}

const registry: Partial<Record<DeckId, DeckControls>> = {};

export function registerDeck(id: DeckId, c: DeckControls): void {
  registry[id] = c;
}

export function unregisterDeck(id: DeckId): void {
  delete registry[id];
}

export function deckControls(id: DeckId): DeckControls | undefined {
  return registry[id];
}
