"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/offline/sw-register";

/**
 * PWA registration — Prompt 23.1.
 *
 * Mounted app-wide in the root layout. The prod-gate (register only when
 * NODE_ENV === 'production') and the dev teardown (unregister any SW + clear
 * caches) live in `registerServiceWorker`, so every caller — this component
 * and the Prompt 7 capture hook — stays safe. In dev no SW is ever active, so
 * local edits are visible immediately; in a production build over HTTPS it
 * enables Add to Home Screen, a standalone launch with the green theme, and an
 * offline app shell.
 */
export function PwaRegister() {
  useEffect(() => {
    void registerServiceWorker();
  }, []);

  return null;
}
