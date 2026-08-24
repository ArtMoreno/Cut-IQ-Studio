export interface StudioMarkState {
  inPoint: number | null;
  outPoint: number | null;
}

export type StudioMarkAction =
  | { ok: true; inPoint: number; outPoint: number | null }
  | { ok: false; message: string };

/** Pure marking state transition shared by buttons and keyboard shortcuts. */
export function markStudioIn(state: StudioMarkState, playhead: number): StudioMarkAction {
  if (!Number.isFinite(playhead) || playhead < 0) return { ok: false, message: "The player is not ready yet." };
  return {
    ok: true,
    inPoint: playhead,
    outPoint: state.outPoint != null && state.outPoint > playhead ? state.outPoint : null,
  };
}

export function markStudioOut(
  state: StudioMarkState,
  playhead: number,
  validate: (inPoint: number, outPoint: number) => { ok: true } | { ok: false; message: string },
): StudioMarkAction {
  if (!Number.isFinite(playhead) || playhead < 0) return { ok: false, message: "The player is not ready yet." };
  if (state.inPoint == null || playhead <= state.inPoint) {
    return { ok: false, message: "Set an Out point after the In point." };
  }
  const validated = validate(state.inPoint, playhead);
  return validated.ok
    ? { ok: true, inPoint: state.inPoint, outPoint: playhead }
    : { ok: false, message: validated.message };
}
