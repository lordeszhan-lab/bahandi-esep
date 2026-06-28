/**
 * Geofence presence-check (Prompt A).
 *
 * Pure geo helpers shared by the capture screen and the risk engine so the
 * "is the device actually at the store?" check has one implementation. The
 * store carries its 2GIS coordinates + a format-aware geofence radius; the
 * device carries the captured photo's GPS.
 *
 * Three outcomes:
 *   • "inside"  — device is within store.geofence_radius_m (no flag)
 *   • "outside" — device is beyond the radius → `geofence_fail` (hard watch)
 *   • "unknown" — the store has no coords yet (pre-geocode). Capture still
 *                 works; the risk engine emits a soft `geofence_unverified`
 *                 flag instead of failing, so a not-yet-geocoded store never
 *                 blocks a submission or hard-fails the score.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** The geofence-relevant slice of a stores row. */
export interface StoreGeofence {
  lat: number | null;
  lng: number | null;
  geofence_radius_m: number | null;
}

export type GeofenceState = "inside" | "outside" | "unknown";

const EARTH_RADIUS_M = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance between two lat/lng points in metres (haversine).
 * Returns null when either side is missing coordinates.
 */
export function distanceMeters(
  aLat: number | null,
  aLng: number | null,
  bLat: number | null,
  bLng: number | null,
): number | null {
  if (
    aLat == null || aLng == null || bLat == null || bLng == null ||
    Number.isNaN(aLat) || Number.isNaN(aLng) || Number.isNaN(bLat) || Number.isNaN(bLng)
  ) {
    return null;
  }
  const φ1 = aLat * DEG_TO_RAD;
  const φ2 = bLat * DEG_TO_RAD;
  const Δφ = (bLat - aLat) * DEG_TO_RAD;
  const Δλ = (bLng - aLng) * DEG_TO_RAD;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** True when the store has the coords + radius needed to run the check. */
export function storeIsGeocoded(store: StoreGeofence): boolean {
  return (
    store.lat != null &&
    store.lng != null &&
    store.geofence_radius_m != null
  );
}

/**
 * Is the device within the store's geofence? Assumes the store is geocoded
 * (caller should gate on `storeIsGeocoded` or use `geofenceState` instead).
 * Returns false when the device has no GPS.
 */
export function isWithinGeofence(
  device: GeoPoint | null,
  store: StoreGeofence,
): boolean {
  if (!device || !storeIsGeocoded(store)) return false;
  const dist = distanceMeters(device.lat, device.lng, store.lat, store.lng);
  if (dist == null) return false;
  return dist <= (store.geofence_radius_m as number);
}

/**
 * Full presence-check including the pre-geocode "unknown" case. Use this on
 * the capture screen and in the risk engine:
 *   outside   → `geofence_fail`
 *   unknown   → `geofence_unverified` (soft — never a hard fail)
 *   inside    → no flag
 */
export function geofenceState(
  device: GeoPoint | null,
  store: StoreGeofence,
): GeofenceState {
  if (!storeIsGeocoded(store)) return "unknown";
  if (!device) return "unknown";
  const dist = distanceMeters(device.lat, device.lng, store.lat, store.lng);
  if (dist == null) return "unknown";
  return dist <= (store.geofence_radius_m as number) ? "inside" : "outside";
}
