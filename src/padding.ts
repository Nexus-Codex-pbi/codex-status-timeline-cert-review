"use strict";

// Content padding (format pane card "Content padding", object `contentPadding`). The clamp and
// the starvation rule follow pbiTimeBreakdown src/padding.ts (feat/abc-classification 5276da1);
// the defaults are this visual's own. Padding is applied INSIDE the visual's root (layout
// arithmetic on the content box), never on options.element, so the root stays edge to edge
// (cert 1180.2.5) and a right-click in a padding strip lands on the visual's own surface.
// PA1: this visual draws no border or bracket strokes on its edges, so the inside of the
// strokes is the visual's edge; padding is measured from there.

export interface Insets { top: number; right: number; bottom: number; left: number }

export const PADDING_DEFAULTS: Readonly<Insets> = { top: 8, right: 12, bottom: 8, left: 12 };
export const PADDING_MIN = 0;
export const PADDING_MAX = 64;
/** The smallest content box padding may squeeze the content to. */
export const MIN_CONTENT = { width: 140, height: 72 } as const;

/** A persisted side as whole px in 0..64; missing / non-numeric means the default. */
export function clampPadding(value: unknown, fallback: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) return fallback;
    return Math.min(PADDING_MAX, Math.max(PADDING_MIN, Math.round(value))) + 0;
}

/** One axis of the starvation rule: padding at or under the default total is never touched;
 *  above it, when the content would get less than min(floor, room - defaults), both sides
 *  shrink by one factor until it does not (never below the default total). */
export function yieldAxis(a: number, b: number, room: number, today: number, floor: number): [number, number] {
    const total = a + b;
    if (total <= today) return [a, b];
    const space = Math.max(0, Number.isFinite(room) ? room : 0);
    const least = Math.min(floor, Math.max(0, space - today));
    const allowed = Math.max(today, space - least);
    if (total <= allowed) return [a, b];
    const whole = Math.floor(allowed);
    const first = Math.floor(a * whole / total);
    return [first, Math.min(b, whole - first)];
}

export function applyPadding(req: Insets, width: number, height: number): Insets {
    const [left, right] = yieldAxis(req.left, req.right, width, PADDING_DEFAULTS.left + PADDING_DEFAULTS.right, MIN_CONTENT.width);
    const [top, bottom] = yieldAxis(req.top, req.bottom, height, PADDING_DEFAULTS.top + PADDING_DEFAULTS.bottom, MIN_CONTENT.height);
    return { top, right, bottom, left };
}
