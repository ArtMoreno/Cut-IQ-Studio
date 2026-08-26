import { useSyncExternalStore } from "react";

export const PRO_PRICE_LABEL = "$29.99 once";
/** Live Gumroad product for the one-time Pro key. */
export const PRO_PURCHASE_URL =
  "https://artjmoreno.gumroad.com/l/cut-iq-studio-pro";

interface ProDialogState {
  open: boolean;
  /** The feature that prompted the dialog, so the copy can name it. */
  prompt: string | null;
}

/**
 * A three-field store does not justify pulling in a state library, so this is a
 * module-level subscription driven by useSyncExternalStore.
 */
let state: ProDialogState = { open: false, prompt: null };
const listeners = new Set<() => void>();

function emit(next: ProDialogState) {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openProDialog(prompt?: string) {
  emit({ open: true, prompt: prompt ?? null });
}

export function closeProDialog() {
  emit({ open: false, prompt: null });
}

export function useProDialog(): ProDialogState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** True when a tRPC error came back from the server-side Pro gate. */
export function isPaymentRequired(error: unknown): boolean {
  const code = (error as { data?: { code?: string } })?.data?.code;
  return code === "PAYMENT_REQUIRED";
}
