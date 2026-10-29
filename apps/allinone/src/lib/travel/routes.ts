import type { Place, Trip } from "./db";

export const DAY_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a813"];

export type RoutePair = { from: Place; to: Place; dayIndex: number };
export type Point2D = { x: number; y: number };
export type RouteArrow = [Point2D, Point2D, Point2D];

function located(p: Place): boolean {
  return typeof p.lat === "number" && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
    typeof p.lng === "number" && Number.isFinite(p.lng) && Math.abs(p.lng) <= 180;
}

/** Only actual neighbors inside a day are routes; an unlocated stop breaks the line. */
export function adjacentRoutePairs(trip: Pick<Trip, "days">): RoutePair[] {
  const pairs: RoutePair[] = [];
  trip.days.forEach((day, dayIndex) => {
    for (let index = 1; index < day.places.length; index += 1) {
      const from = day.places[index - 1], to = day.places[index];
      if (located(from) && located(to)) pairs.push({ from, to, dayIndex });
    }
  });
  return pairs;
}

/** A directional pair keeps its custom color across reordering; otherwise use the day's color. */
export function routeColor(trip: Pick<Trip, "routeStyles">, fromId: number, toId: number, dayIndex: number): string {
  const color = trip.routeStyles.find(style => style.fromPlaceId === fromId && style.toPlaceId === toId)?.color;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  const index = Number.isSafeInteger(dayIndex) && dayIndex >= 0 ? dayIndex : 0;
  return DAY_COLORS[index % DAY_COLORS.length];
}

/** Open chevron [wingA, tip, wingB] oriented along from→to at 62% of the segment. */
export function arrowGeometry(from: Point2D, to: Point2D, size = 10): RouteArrow | null {
  if (![from.x, from.y, to.x, to.y, size].every(Number.isFinite) || size <= 0) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < size * 2) return null;
  const ux = dx / length, uy = dy / length;
  const tip = { x: from.x + dx * 0.62, y: from.y + dy * 0.62 };
  const back = { x: tip.x - ux * size, y: tip.y - uy * size };
  const halfWidth = size * 0.6;
  return [
    { x: back.x - uy * halfWidth, y: back.y + ux * halfWidth },
    tip,
    { x: back.x + uy * halfWidth, y: back.y - ux * halfWidth },
  ];
}
