"use strict";

// Status Timeline data model. Pure: no DOM, no host. Every rule a report author can
// observe is stated here and in tests/README.md, and the tests check it against an
// independent reference (tests/reference.py).
//
// INPUT: change EVENTS, one row per (Resource, Timestamp, State). Not tasks with a start
// and an end: a run is DERIVED as "from this event until the resource's next event".
//
// TIME: Power BI date/times carry no time zone. The visual reads each value's wall-clock
// fields (the Date the host hands over, read with local getters, or an ISO text) and works in
// "wall milliseconds" (Date.UTC of those fields). Durations are wall-clock differences, so a
// run across a daylight-saving change counts clock time (01:00 -> 04:00 on a spring-forward
// night is 3 h, although 2 h elapsed). Days, ISO weeks (Monday start), months, quarters and
// years are wall-calendar buckets. The viewer's time zone never changes a total.
//
// RULES (each has a named test case):
//  R1 out-of-order rows: events are sorted per resource by time; arrival order never matters.
//  R2 same instant, different states (one resource): the state that sorts LAST in the state
//     order is the one held; the others are counted as "simultaneous" and disclosed.
//  R3 same instant, same state: one event; the extra rows are counted as duplicates.
//  R4 repeat state (A then A later): no new run; counted as a repeat, not a change.
//  R5 blank state (null, empty, whitespace, non-finite number): the event starts an
//     "unknown" run. Unknown time is never added to any state's total; it is disclosed.
//  R6 blank or unreadable timestamp: the row is dropped and counted (never treated as 0/1970).
//  R7 AS-OF: the last run of every resource ends at the as-of time = the largest valid value
//     of the optional "As of" field when bound, otherwise the latest event time in the data.
//     Events after the as-of time are dropped and counted.
//  R8 blank resource: grouped into one "(Blank)" strip, as Power BI's own visuals do.

export const ROW_WINDOW = 30000;          // capabilities.json dataReductionAlgorithm.top.count
export const MAX_STYLED_STATES = 8;       // non-resting states with their own style; the rest fold into "Other"

export type TimeGrain = "hour" | "day" | "week" | "month" | "quarter" | "year";
export const GRAINS: TimeGrain[] = ["hour", "day", "week", "month", "quarter", "year"];

/** Desktop fix round 1, finding 2: Automatic draws hour blocks when the data spans at most this much
 *  wall time (As of minus the first event); longer spans keep the day/week/... choice they had. */
export const HOUR_GRAIN_SPAN = 3 * 86400000;

export interface RawRow {
    resource: unknown;
    timestamp: unknown;
    state: unknown;
    order?: unknown;       // "State order" field
    asOf?: unknown;        // "As of" field
    index: number;         // row index in the dataView (selection identity)
}

export interface Run {
    state: string | null;  // null = unknown (blank state event)
    start: number;
    end: number;
    row: number;           // dataView row of the event that started the run
    events: number;        // events folded into this run (1 + repeats)
}

export interface Strip {
    key: string;
    label: string;
    isBlank: boolean;
    firstRow: number;      // first dataView row of this resource (resource identity)
    order: number;         // first appearance order in the dataView
    runs: Run[];
    totals: Map<string, number>;  // state -> wall ms (unknown excluded)
    unknownMs: number;
    changes: number;       // state changes = runs - 1
    first: number;         // first event time
}

export interface Disclosures {
    received: number;
    blankTimestamp: number;
    badTimestamp: number;
    numericTimestamp: number;
    afterAsOf: number;
    simultaneous: number;
    duplicates: number;
    repeats: number;
    blankState: number;
    asOfIgnored: number;    // As of values that were blank / unreadable
    asOfFromField: boolean;
    truncated: boolean;     // the host's row window was reached or more data exists
    moreData: boolean;      // the host SAID more rows exist (metadata.segment): rows were dropped
}

export interface Model {
    strips: Strip[];
    states: string[];       // state order (index 0 = resting state)
    start: number;
    asOf: number;
    events: number;         // events used
    disclosures: Disclosures;
}

// ── value readers (1180.2.4: blank, text, NaN and negatives keep their own meaning) ──

export function isBlank(v: unknown): boolean {
    return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Wall milliseconds of a Date's local calendar fields. */
export function wallOfDate(d: Date): number {
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

export type TimeRead = { ok: true; t: number } | { ok: false; why: "blank" | "numeric" | "bad" };

/** A timestamp in wall ms. Text: ISO 8601 date or date-time; with Z or an offset it is an
 *  instant, read as the viewer's local wall clock (as a Date is). Numbers are refused (they are Date Hierarchy levels such as a
 *  year, never a date), as are impossible dates (2026-02-30). */
export function readTime(v: unknown): TimeRead {
    if (isBlank(v)) return { ok: false, why: "blank" };
    if (v instanceof Date) return isNaN(v.getTime()) ? { ok: false, why: "bad" } : { ok: true, t: wallOfDate(v) };
    if (typeof v === "number") return { ok: false, why: "numeric" };
    if (typeof v !== "string") return { ok: false, why: "bad" };
    const m = ISO.exec(v.trim());
    if (!m) return { ok: false, why: "bad" };
    const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => (m[i] === undefined ? 0 : Number(m[i])));
    const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
    if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return { ok: false, why: "bad" };
    let t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    const back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return { ok: false, why: "bad" };
    if (m[8] && m[8] !== "Z") {
        const sign = m[8][0] === "-" ? -1 : 1;
        const digits = m[8].slice(1).replace(":", "");
        const oh = Number(digits.slice(0, 2)), om = Number(digits.slice(2));
        // ISO 8601 offset: hours 00-23, minutes 00-59; anything else is unreadable (review 2, finding 4)
        if (oh > 23 || om > 59) return { ok: false, why: "bad" };
        t -= sign * (oh * 60 + om) * 60000;
    }
    // Desktop fix round 1, finding 1: text with Z or an offset is an INSTANT. Power BI Desktop handed
    // this visual its datetimes as such text (the JSON form of the Date it built from the wall
    // clock in the viewer's zone, e.g. 20 Nov 00:00 at UTC+10:30 -> "2026-11-19T13:30:00.000Z"), so
    // the wall clock is that instant's LOCAL fields, read exactly as a Date is. Read as UTC fields it
    // drew every time one zone offset early. Naive text and Dates are unchanged.
    if (m[8]) return { ok: true, t: wallOfDate(new Date(t)) };
    return { ok: true, t };
}

/** A state label, or null for a blank state (R5). Numbers keep their own text ("-1", "0").
 *  A Date state (review 4 finding 2) is its full wall datetime caption: the date, plus the time
 *  down to the millisecond whenever it is not midnight, so two values on one day stay two states
 *  (the caption is one-to-one with the wall time, never a day key). */
export function readState(v: unknown): string | null {
    if (isBlank(v)) return null;
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : dateCaption(wallOfDate(v));
    return String(v);
}

const BLANK_KEY = "\u0000blank";

/** A datetime Resource's caption: the date, plus hh:mm (and :ss, .mmm) when they are not zero. */
export function dateCaption(wall: number): string {
    const iso = new Date(wall).toISOString();          // yyyy-mm-ddThh:mm:ss.mmmZ
    const time = iso.slice(11, 23);
    if (time === "00:00:00.000") return iso.slice(0, 10);
    const tail = time.endsWith(".000") ? (time.slice(5, 8) === ":00" ? time.slice(0, 5) : time.slice(0, 8)) : time;
    return iso.slice(0, 10) + " " + tail;
}

export function readResource(v: unknown): { key: string; label: string | null } {
    if (isBlank(v)) return { key: BLANK_KEY, label: null };
    if (typeof v === "number" && !Number.isFinite(v)) return { key: BLANK_KEY, label: null };
    // Review 2 finding 2: the KEY is the full wall datetime (two values on one day are two
    // resources); the caption is chosen separately.
    if (v instanceof Date) { if (isNaN(v.getTime())) return { key: BLANK_KEY, label: null }; const w = wallOfDate(v); return { key: "d:" + w, label: dateCaption(w) }; }
    const s = String(v);
    return { key: "v:" + s, label: s };
}

function readOrder(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ── state order ──────────────────────────────────────────────────────────────

export type OrderMode = "alphabetical" | "firstSeen" | "custom";

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
/** Natural order ("2" before "10"), ties broken by code unit so the order is total. */
export function naturalCompare(a: string, b: string): number {
    const c = collator.compare(a, b);
    return c !== 0 ? c : (a < b ? -1 : a > b ? 1 : 0);
}

/** State order. A bound "State order" field wins (smallest value per state, ascending; states
 *  without a number follow in natural order). Otherwise the pane: alphabetical (natural),
 *  first seen (earliest event time), or a custom comma-separated list (listed states first,
 *  in list order; unlisted ones follow in natural order). */
export function orderStates(seen: Map<string, { first: number; order: number | null }>, mode: OrderMode, custom: string, useField: boolean): string[] {
    const names = Array.from(seen.keys());
    if (useField) {
        const withNum = names.filter(n => seen.get(n).order !== null).sort((a, b) => (seen.get(a).order - seen.get(b).order) || naturalCompare(a, b));
        const without = names.filter(n => seen.get(n).order === null).sort(naturalCompare);
        return withNum.concat(without);
    }
    if (mode === "firstSeen") return names.sort((a, b) => (seen.get(a).first - seen.get(b).first) || naturalCompare(a, b));
    if (mode === "custom") {
        const list = custom.split(",").map(s => s.trim()).filter(s => s.length > 0);
        const rank = new Map<string, number>();
        list.forEach((s, i) => { if (!rank.has(s)) rank.set(s, i); });
        const listed = names.filter(n => rank.has(n)).sort((a, b) => rank.get(a) - rank.get(b));
        const rest = names.filter(n => !rank.has(n)).sort(naturalCompare);
        return listed.concat(rest);
    }
    return names.sort(naturalCompare);
}

// ── the model ────────────────────────────────────────────────────────────────

export interface BuildOptions {
    orderMode: OrderMode;
    customOrder: string;
    useOrderField: boolean;
    blankLabel: string;
    truncated: boolean;     // host said there is more data (metadata.segment)
}

interface Ev { key: string; t: number; state: string | null; rank: number; row: number }

export function buildModel(rows: RawRow[], opt: BuildOptions): Model {
    const d: Disclosures = {
        received: rows.length, blankTimestamp: 0, badTimestamp: 0, numericTimestamp: 0, afterAsOf: 0,
        simultaneous: 0, duplicates: 0, repeats: 0, blankState: 0, asOfIgnored: 0, asOfFromField: false,
        truncated: opt.truncated || rows.length >= ROW_WINDOW,
        moreData: opt.truncated,
    };
    // As of (R7)
    let asOfField = -Infinity;
    let asOfBound = false;
    for (const r of rows) {
        if (!("asOf" in r)) continue;
        asOfBound = true;
        const a = readTime(r.asOf);
        if (a.ok) asOfField = Math.max(asOfField, a.t); else d.asOfIgnored++;
    }
    const resources = new Map<string, { label: string | null; firstRow: number; order: number }>();
    const evs: Ev[] = [];
    const seen = new Map<string, { first: number; order: number | null }>();
    for (const r of rows) {
        const res = readResource(r.resource);
        const time = readTime(r.timestamp);
        if (!time.ok) {
            const why = (time as { why: string }).why;
            if (why === "blank") d.blankTimestamp++; else if (why === "numeric") d.numericTimestamp++; else d.badTimestamp++;
            continue;
        }
        const state = readState(r.state);
        if (!resources.has(res.key)) resources.set(res.key, { label: res.label, firstRow: r.index, order: resources.size });
        evs.push({ key: res.key, t: time.t, state, rank: 0, row: r.index });
        if (state !== null) {
            const o = readOrder(r.order);
            const s = seen.get(state);
            if (!s) seen.set(state, { first: time.t, order: o });
            else { s.first = Math.min(s.first, time.t); if (o !== null) s.order = s.order === null ? o : Math.min(s.order, o); }
        }
    }
    const latest = evs.reduce((m, e) => Math.max(m, e.t), -Infinity);
    const asOf = asOfBound && Number.isFinite(asOfField) ? asOfField : latest;
    d.asOfFromField = asOfBound && Number.isFinite(asOfField);
    const kept = evs.filter(e => { if (e.t > asOf) { d.afterAsOf++; return false; } return true; });

    // States seen only after the as-of time do not enter the order.
    const keptStates = new Set(kept.map(e => e.state).filter(s => s !== null) as string[]);
    for (const k of Array.from(seen.keys())) if (!keptStates.has(k)) seen.delete(k);
    const states = orderStates(seen, opt.orderMode, opt.customOrder, opt.useOrderField);
    const rankOf = new Map<string, number>();
    states.forEach((s, i) => rankOf.set(s, i));
    for (const e of kept) e.rank = e.state === null ? -1 : rankOf.get(e.state);

    const byRes = new Map<string, Ev[]>();
    for (const e of kept) { let a = byRes.get(e.key); if (!a) byRes.set(e.key, a = []); a.push(e); }
    const strips: Strip[] = [];
    let events = 0;
    for (const [key, list] of byRes) {
        // R1 sort by time; R2 within an instant, lowest rank first so the last-ranked state is held.
        list.sort((a, b) => (a.t - b.t) || (a.rank - b.rank) || (a.row - b.row));
        const held: Ev[] = [];
        for (let i = 0; i < list.length;) {
            let j = i;
            while (j + 1 < list.length && list[j + 1].t === list[i].t) j++;
            const group = list.slice(i, j + 1);
            const distinct = new Set(group.map(g => (g.state === null ? "\u0000" : "v" + g.state)));
            d.duplicates += group.length - distinct.size;          // R3
            d.simultaneous += distinct.size - 1;                    // R2
            held.push(group[group.length - 1]);
            i = j + 1;
        }
        const runs: Run[] = [];
        for (const e of held) {
            events++;
            if (e.state === null) d.blankState++;
            const last = runs[runs.length - 1];
            if (last && last.state === e.state) { last.events++; d.repeats++; continue; }   // R4
            if (last) last.end = e.t;
            runs.push({ state: e.state, start: e.t, end: asOf, row: e.row, events: 1 });
        }
        const totals = new Map<string, number>();
        let unknownMs = 0;
        for (const r of runs) {
            const len = r.end - r.start;
            if (r.state === null) unknownMs += len; else totals.set(r.state, (totals.get(r.state) || 0) + len);
        }
        const info = resources.get(key);
        strips.push({
            key, label: info.label === null ? opt.blankLabel : info.label, isBlank: info.label === null,
            firstRow: info.firstRow, order: info.order, runs, totals, unknownMs,
            changes: runs.length - 1, first: runs[0].start,
        });
    }
    strips.sort((a, b) => a.order - b.order);
    const start = strips.reduce((m, s) => Math.min(m, s.first), Infinity);
    return { strips, states, start, asOf, events, disclosures: d };
}

/** The run covering wall time t on a strip, or null (binary search; runs are contiguous). */
export function runAt(strip: Strip, t: number): Run | null {
    const runs = strip.runs;
    let lo = 0, hi = runs.length - 1;
    if (hi < 0 || t < runs[0].start || t > runs[hi].end) return null;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (runs[mid].start <= t) lo = mid; else hi = mid - 1;
    }
    return runs[lo];
}

// ── calendar buckets (look A) ───────────────────────────────────────────────

const DAY = 86400000;

export function bucketStart(t: number, g: TimeGrain): number {
    const d = new Date(t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    switch (g) {
        case "hour": return Date.UTC(y, m, d.getUTCDate(), d.getUTCHours());
        case "day": return Date.UTC(y, m, d.getUTCDate());
        case "week": { const day0 = Date.UTC(y, m, d.getUTCDate()); return day0 - ((d.getUTCDay() + 6) % 7) * DAY; }
        case "month": return Date.UTC(y, m, 1);
        case "quarter": return Date.UTC(y, m - (m % 3), 1);
        default: return Date.UTC(y, 0, 1);
    }
}

export function nextBucket(t: number, g: TimeGrain): number {
    const d = new Date(t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth();
    switch (g) {
        case "hour": return t + 3600000;
        case "day": return t + DAY;
        case "week": return t + 7 * DAY;
        case "month": return Date.UTC(y, m + 1, 1);
        case "quarter": return Date.UTC(y, m + 3, 1);
        default: return Date.UTC(y + 1, 0, 1);
    }
}

/** The most calendar buckets one grain may take (review 2, finding 3). */
export const MAX_BUCKETS = 100000;

/** Buckets [start, end) covering [start, asOf]; a bucket that begins exactly at asOf is not drawn
 *  unless it is the only one. The walk stops after MAX_BUCKETS + 1 buckets, so a list longer than
 *  MAX_BUCKETS means "does not fit": pick the grain with grainWithin() (capped at MAX_BUCKETS) and never
 *  draw such a list. */
export function buckets(start: number, asOf: number, g: TimeGrain): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let b = bucketStart(start, g); out.length <= MAX_BUCKETS; b = nextBucket(b, g)) {
        if (b >= asOf && out.length > 0) break;
        out.push([b, nextBucket(b, g)]);
        if (b >= asOf) break;
    }
    return out;
}

/** The coarsest-needed grain: the finest grain whose bucket count fits `maxBuckets`. */
export function autoGrain(start: number, asOf: number, maxBuckets: number): TimeGrain {
    // hour blocks for a short span, even past maxBuckets: day blocks over two days hide every
    // state shorter than half a day (the owner's 48 hourly rows drew only Up); the blocks' own
    // MIN_BLOCK_PX check still coarsens to day where hour blocks cannot be drawn
    if (asOf - start <= HOUR_GRAIN_SPAN) return "hour";
    for (const g of GRAINS.slice(1)) if (buckets(start, asOf, g).length <= maxBuckets) return g;
    return "year";
}

/** How many buckets grain g takes over [start, asOf], counting no further than limit + 1. */
export function bucketCount(start: number, asOf: number, g: TimeGrain, limit: number): number {
    let n = 0;
    for (let b = bucketStart(start, g); n <= limit; b = nextBucket(b, g)) {
        if (b >= asOf && n > 0) break;
        n++;
        if (b >= asOf) break;
    }
    return n;
}

/** Fix round 3, item 1: the finest grain at or coarser than g that takes at most maxBuckets
 *  buckets (so every block can be at least the minimum width), else "year". */
export function grainWithin(start: number, asOf: number, g: TimeGrain, maxBuckets: number): TimeGrain {
    for (const x of GRAINS.slice(GRAINS.indexOf(g))) if (bucketCount(start, asOf, x, maxBuckets) <= maxBuckets) return x;
    return "year";
}

/** The state with the most time in a bucket; a tie goes to the state later in the state order;
 *  unknown (null) loses every tie; undefined when nothing covers the bucket. */
function pickDominant(time: Map<string | null, number>, rank: (s: string | null | undefined) => number): string | null | undefined {
    let best: string | null | undefined = undefined;
    let bestT = -1;
    for (const [s, v] of time) {
        if (v > bestT || (v === bestT && rank(s) > rank(best))) { best = s; bestT = v; }
    }
    return best;
}

/** A bucket's state: the state held for the most wall time inside it (covered time only);
 *  a tie goes to the state later in the state order; unknown loses every tie. undefined when
 *  the strip has no coverage in the bucket (before its first event). */
export function dominantState(strip: Strip, b0: number, b1: number, states: string[]): string | null | undefined {
    const time = new Map<string | null, number>();
    for (const r of strip.runs) {
        if (r.end <= b0) continue;
        if (r.start >= b1) break;
        const ov = Math.min(r.end, b1) - Math.max(r.start, b0);
        if (!(ov > 0)) continue;
        time.set(r.state, (time.get(r.state) || 0) + ov);
    }
    if (time.size === 0) return undefined;
    return pickDominant(time, s => (s === null || s === undefined ? -1 : states.indexOf(s)));
}

/** One block of a strip: its dominant state (undefined = no coverage), the Always-show state drawn
 *  on it as a marker (M1), and `cover`, the share of the bucket the strip's data covers (1 = the
 *  whole period; less for the period holding the first event or the As of time). */
export interface BlockInfo { ds: string | null | undefined; mark: string | null; markMs: number; cover: number }

/** Every block of one strip in ONE sweep over its runs and the buckets (fix round 3, item 1):
 *  O(runs + buckets), never a rescan of the runs per bucket. Runs are contiguous and sorted. */
export function stripBlocks(strip: Strip, list: Array<[number, number]>, states: string[], always: Set<string>): BlockInfo[] {
    const rankOf = new Map<string, number>();
    states.forEach((s, i) => rankOf.set(s, i));
    const rank = (s: string | null | undefined) => (s === null || s === undefined ? -1 : (rankOf.has(s) ? rankOf.get(s) : -1));
    const runs = strip.runs;
    const nr = runs.length;
    const out: BlockInfo[] = new Array(list.length);
    let p = 0;
    for (let j = 0; j < list.length; j++) {
        const b0 = list[j][0], b1 = list[j][1];
        while (p < nr && runs[p].end <= b0) p++;
        const time = new Map<string | null, number>();
        let covered = 0;
        for (let q = p; q < nr; q++) {
            const r = runs[q];
            if (r.start >= b1) break;
            const ov = Math.min(r.end, b1) - Math.max(r.start, b0);
            if (!(ov > 0)) continue;
            time.set(r.state, (time.get(r.state) || 0) + ov);
            covered += ov;
        }
        const ds = time.size === 0 ? undefined : pickDominant(time, rank);
        let mark: string | null = null; let markMs = 0;
        if (ds !== undefined && always.size > 0) {
            for (const [k, v] of time) {
                if (k === null || k === ds || !always.has(k)) continue;
                if (v > markMs || (v === markMs && rank(k) > rank(mark))) { mark = k; markMs = v; }
            }
        }
        out[j] = { ds, mark, markMs, cover: ds === undefined ? 0 : Math.min(1, covered / (b1 - b0)) };
    }
    return out;
}

// ── strip order ──────────────────────────────────────────────────────────────

export type SortMode = "data" | "name" | "currentState" | "timeInState";

export function currentRun(s: Strip): Run { return s.runs[s.runs.length - 1]; }

export function sortStrips(strips: Strip[], mode: SortMode, states: string[]): Strip[] {
    const out = strips.slice();
    const rank = (s: string | null) => (s === null ? -1 : states.indexOf(s));
    const len = (s: Strip) => { const r = currentRun(s); return r.end - r.start; };
    if (mode === "name") out.sort((a, b) => naturalCompare(a.label, b.label) || a.order - b.order);
    else if (mode === "currentState") out.sort((a, b) => (rank(currentRun(b).state) - rank(currentRun(a).state)) || (len(b) - len(a)) || a.order - b.order);
    else if (mode === "timeInState") out.sort((a, b) => (len(b) - len(a)) || a.order - b.order);
    else out.sort((a, b) => a.order - b.order);
    return out;
}
