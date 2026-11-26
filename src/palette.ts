"use strict";

// State styles. States are not good or bad, so there are no direction colours (no lime, no
// magenta, no red/green): the resting state (first in the state order) is the TRACK colour and
// every other state is the ACCENT (cyan) at a strength that rises with the state order.
//
//   1 other state:   100%
//   2 other states:  45%, 100%            (the drawn look: "cyan at two strengths")
//   3 other states:  40%, 70%, 100%
//   4 other states:  35%, 57%, 78%, 100%
//   5-8 other states: states 1-4 take the accent at 40/60/80/100%; states 5-8 take a SECOND hue
//                    (the accent turned -150 deg: cyan -> amber) at the strengths for their
//                    own count (5 -> 100%; 6 -> 45/100%; ...). No hatch: a hatch does not survive
//                    a 4-6 px block (fix round 1, M5). Measured: tests/cases.py
//                    palette_states_distinguishable (CIE76 delta E >= 10 for every pair of drawn
//                    state colours and each against the surface, >= 5 under simulated deutan /
//                    protan vision, the resting track >= 1.3:1 against the surface; light, dark,
//                    neon).
//   more than 8:     the states after the 8th in the order fold into one "Other states" style
//                    (track colour with a cross hatch), disclosed under the chart; tooltips still
//                    name each run's real state.
// Desktop fix round 1, finding 3 (the owner: Maintenance, Degraded and Down read as three cyan
// shades): with the DEFAULT state colour and up to 4 styled states, each state takes its own hue by
// its place in the state order, which already means "later = more serious" (R2 ties, the Board's
// sort): the last state red, then amber, then blue, then slate grey (1 state: red; 2: blue, red;
// 3: blue, amber, red; 4: slate, blue, amber, red). The resting state stays the neutral track. A
// state colour the author set keeps the single-accent strength ramp above, drawn as set.
// High contrast: no opacity at all. Host foreground on host background as a pattern ladder:
//   resting = outline only; then sparse hatch, dense hatch, cross hatch, solid; states 5-8 use
//   dots, dense dots, vertical, horizontal lines; "Other" = outline with a dot.
// tests/palette check: every pair of styles differs (composited colour delta E >= 10 in light,
// dark and neon, or a different pattern).

import { MAX_STYLED_STATES } from "./model";

export type Pattern = "none" | "hatch" | "hatchDense" | "cross" | "dots" | "dotsDense" | "vertical" | "horizontal" | "outline" | "outlineDot"
    // review 6 finding 2: more redundant cues for Show background off (the other diagonal, a grid,
    // a ring, sparse and dense variants), so every state up to the role limit has its own look
    | "hatchBack" | "hatchBackDense" | "grid" | "ring" | "dotsSparse" | "verticalDense" | "horizontalDense";

export type Role = "slate" | "blue" | "amber" | "red";

export interface StateStyle {
    role?: Role;            // Desktop fix round 1: the meaning hue (default state colour, up to 4 states)
    kind: "track" | "accent" | "other" | "unknown";
    level: number;          // 0 resting, 1..n others, -1 unknown, n+1 other
    strength: number;       // accent opacity 0..1 (1 for track / hc)
    pattern: Pattern;
    hue: 0 | 1;             // 0 the accent, 1 the second hue (states 5-8)
}

const STRENGTHS: Record<number, number[]> = {
    1: [1], 2: [0.45, 1], 3: [0.4, 0.7, 1], 4: [0.35, 0.57, 0.78, 1],
};

/** Style per state index (into the state order). `restingAsTrack` false gives the first state
 *  an accent strength too. */
const ROLES: Record<number, Role[]> = { 1: ["red"], 2: ["blue", "red"], 3: ["blue", "amber", "red"], 4: ["slate", "blue", "amber", "red"] };

export function stateStyles(stateCount: number, restingAsTrack: boolean, hc: boolean, semantic = false): StateStyle[] {
    const out: StateStyle[] = [];
    const first = restingAsTrack ? 1 : 0;
    const others = Math.max(0, stateCount - first);
    const styled = Math.min(others, MAX_STYLED_STATES);
    const steps = STRENGTHS[Math.min(4, Math.max(1, styled))];
    const hcLadder: Pattern[] = ["hatch", "hatchDense", "cross", "none"];
    const hcExtra: Pattern[] = ["dots", "dotsDense", "vertical", "horizontal"];
    for (let i = 0; i < stateCount; i++) {
        if (i < first) { out.push({ kind: "track", level: 0, strength: 1, pattern: hc ? "outline" : "none", hue: 0 }); continue; }
        const k = i - first;            // 0-based among others
        if (k >= MAX_STYLED_STATES) { out.push({ kind: "other", level: styled + 1, strength: 1, pattern: hc ? "outlineDot" : "cross", hue: 0 }); continue; }
        const lv = k + 1;
        if (hc) {
            // ladder ends on solid for the top state when there are 4 or fewer
            const pat = styled <= 4 ? hcLadder[hcLadder.length - styled + k] : (k < 4 ? hcLadder[k] : hcExtra[k - 4]);
            out.push({ kind: "accent", level: lv, strength: 1, pattern: pat, hue: 0 });
            continue;
        }
        if (styled <= 4 && semantic) { out.push({ kind: "accent", level: lv, strength: 1, pattern: "none", hue: 0, role: ROLES[styled][k] }); continue; }
        if (styled <= 4) { out.push({ kind: "accent", level: lv, strength: steps[k], pattern: "none", hue: 0 }); continue; }
        const second = k >= 4;
        // first hue past 4 states: 40/60/80/100% (35% sat on the light track under protan vision)
        const step = second ? STRENGTHS[styled - 4][k - 4] : WIDE_FIRST[k];
        out.push({ kind: "accent", level: lv, strength: step, pattern: "none", hue: second ? 1 : 0 });
    }
    return out;
}

const WIDE_FIRST = [0.4, 0.6, 0.8, 1];

export const UNKNOWN_STYLE: StateStyle = { kind: "unknown", level: -1, strength: 1, pattern: "outline", hue: 0 };

/** Count of states that fold into "Other states". */
export function foldedCount(stateCount: number, restingAsTrack: boolean): number {
    return Math.max(0, stateCount - (restingAsTrack ? 1 : 0) - MAX_STYLED_STATES);
}
