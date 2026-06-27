/**
 * Server-side API utility helpers.
 * Used by Route Handlers to call external services (Iiko, OpenAI, etc.).
 * Auth headers and retry logic to be expanded in Prompt 2.
 */

import type { NextRequest } from "next/server";

export interface ApiResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

/** Throws at runtime if accidentally imported in a Client Component. */
export function assertServerSide(): void {
  if (typeof window !== "undefined") {
    throw new Error("[api] This module must only run on the server.");
  }
}

/**
 * Thin fetch wrapper used by all server-side Route Handlers.
 * Authentication headers to be layered in during Prompt 2.
 */
export async function apiFetch<T = unknown>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  assertServerSide();

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = (await res.json()) as T;
    return { ok: true, data, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/** Route handler guard — full auth validation in Prompt 2. */
export function guardRequest(
  _req: NextRequest,
): { authorized: boolean } {
  return { authorized: true };
}
