"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ITooltipService = powerbi.extensibility.ITooltipService;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import ILocalizationManager = powerbi.extensibility.ILocalizationManager;
import ISandboxExtendedColorPalette = powerbi.extensibility.ISandboxExtendedColorPalette;
import DataView = powerbi.DataView;
import DataViewCategoryColumn = powerbi.DataViewCategoryColumn;
import DataViewValueColumn = powerbi.DataViewValueColumn;

import { VisualFormattingSettingsModel, DEFAULT_ACCENT, DEFAULT_TRACK, DEFAULT_TEXT } from "./settings";
import {
    buildModel, Model, RawRow, Strip, Run, runAt, buckets, autoGrain, grainWithin, MAX_BUCKETS, stripBlocks, BlockInfo, GRAINS, sortStrips, currentRun,
    TimeGrain, SortMode, OrderMode, ROW_WINDOW, wallOfDate, readResource,
} from "./model";
import { formatDuration, formatWhen, formatShortDate, formatDay, formatAxis, formatAxisEnd, axisMaxExtra, axisLabelHasDate, axisLabelHasYear, formatAxisWithYear, crossesDay, formatPeriod, axisTicks, autoUnit, tableDecimals, formatTableValue, DurationUnit, UnitWords } from "./format";
import { stateStyles, StateStyle, UNKNOWN_STYLE, foldedCount, Pattern, Role } from "./palette";
import { applyPadding, clampPadding, Insets, PADDING_DEFAULTS } from "./padding";
import { compositeOver, contrastInk, contrastRatio, mutedInk, surfaceTone, toRgba } from "./shared/colorHelpers";
import { surfaceTokens, mix } from "./shared/designTokens";
import { resolveCodexTheme, backgroundColorIsUnset, neonColorFor, neonFilter, ResolvedCodexTheme, forcedInk } from "./shared/codexThemeSettings";
import { textAlignFor } from "./shared/textFormatting";
import { formatModelNumber } from "./shared/numberFormat";
import { LicenseGate } from "./shared/licensing";

const SVGNS = "http://www.w3.org/2000/svg";
// review 5 finding 3: redundant cues for states whose colours converge ("cross" is Other states'
// own look, so it is free only where Other states is not near). Review 6 finding 2: 14 cues. At
// most 10 looks are drawn (the resting track, 8 styled states, Other states), so a state compares
// with at most 9 others and a cue no near state uses always exists: no two states share a look.
const CUE_PATTERNS: Pattern[] = ["dots", "vertical", "horizontal", "hatch", "dotsDense", "hatchDense",
    "hatchBack", "grid", "ring", "cross", "dotsSparse", "hatchBackDense", "verticalDense", "horizontalDense"];
const CUE_DE_BG_OFF = 12, CUE_DE_BG_ON = 10;
/** Review 6 items 3 and 5: a cue's ink stands at least CUE_INK_MIN:1 off its base colour. The page
 *  is the ink where it does; otherwise a SHADE of the base (the base pushed toward black or white
 *  until CUE_SHADE:1), never plain black on a pale colour. The base colour itself is never changed. */
const CUE_INK_MIN = 2, CUE_SHADE = 3;
const PATTERN_TILE: Record<string, number> = { hatch: 4, hatchDense: 3, cross: 4, dots: 3, dotsDense: 2, vertical: 3, horizontal: 3, outlineDot: 4,
    hatchBack: 4, hatchBackDense: 3, grid: 4, ring: 4, dotsSparse: 4, verticalDense: 2, horizontalDense: 2 };
const LIGHT_ACCENT = "#0384a3";     // the drawn light-theme accent (variants page --brand)
const DARK_ACCENT = "#00d9ff";
/** Desktop fix round 1, finding 3: the meaning hues (default state colour, up to 4 styled states).
 *  Measured with the suite's own oracles (cases.py lab / simulate / contrast): on white every hue
 *  clears 3.5:1 and on #0d0d24 5.6:1; every pair, and each against the track, CIE76 >= 35 (>= 22
 *  under simulated deutan / protan vision). */
const ROLE_HUES: Record<"light" | "dark", Record<Role, string>> = {
    light: { slate: "#7d8799", blue: "#2b6cd4", amber: "#b97a00", red: "#c4262e" },
    dark: { slate: "#8e98ab", blue: "#4f8fff", amber: "#f2b33d", red: "#f2545b" },
};
/** Fix round 3, item 1: the narrowest block drawn. A grain whose blocks would be narrower is
 *  drawn at the finest coarser grain whose blocks fit (with the "drawn by" notice when forced). */
const MIN_BLOCK_PX = 2;
// fix round 10, ruling F: a column set is admitted only where the strip it leaves (width-monotone
// estimate) is at least this share of the content width (measured, see tests/README.md). Blocks: 0.2;
// the blocks' own grain check (MIN_BLOCK_PX on the strip left) keeps them from going a grain coarser
// for the column (0.25 withheld the column 54aff7d drew on the 300 px card with 40 px labels by 2 px)
const COL_STRIP_SHARE = 0.4;
const COL_STRIP_SHARE_BLOCKS = 0.2;
// Board: measured, the fit test alone (columns beside a strip at its minimum, as at 54aff7d) gave 748
// priority 1-3 falls on the quick growth gate (the axis and rows leave as NOW, FOR, SINCE arrive)
const COL_STRIP_SHARE_BOARD = 0.5;
/** The labels' family when the pane's Font family is empty: drawn AND measured in it (item 7). */
const LABEL_FONT_FALLBACK = "Segoe UI, sans-serif";
/** headW's safety margin over the measured header text (fix round 4, item 7). */
const HEAD_ALLOWANCE = 2;
/** Fix round 3, item 2: a block whose period the data covers less of than this is partial. */
const PARTIAL_BELOW = 1 - 1e-9;

type Style = "blocks" | "runs" | "board";
// fix round 10: an axis label and the axis a strip width settles on (see axisPlan)
type AxisLabel = { x: number; s: string; anchor: string };
type AxisPlan = { size: number; labels: AxisLabel[] };

/** c, pushed toward `ink` in 5% steps until it reaches `min`:1 against `surface`. */
function atLeast(c: string, surface: string, ink: string, min: number): string {
    for (let t = 0; t <= 1.0001; t += 0.05) {
        const m = mix(c, ink, t);
        if (contrastRatio(m, surface) >= min) return m;
    }
    return ink;
}

/** CIE76 colour difference of two #rrggbb colours (sRGB, D65). */
function deltaE(a: string, b: string): number {
    const lab = (h: string) => {
        const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        const n = parseInt(h.slice(1), 16);
        const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), bl = lin(n & 255);
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const x = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047), y = f(0.2126 * r + 0.7152 * g + 0.0722 * bl), z = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const p = lab(a), q = lab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Fix round 4, item 3: with Show background OFF a DEFAULT state colour must reach 3:1 on the
 *  page after its strength is applied. The states are re-spread along one path through the
 *  accent: from the surface side (u < 0, the accent mixed toward the page) to an ink side (u > 0,
 *  the accent mixed toward black or toward white). The weakest state sits at the first point of
 *  that path that reaches MARK_MIN (with a 0.05 margin); the strongest at least 0.45 further, and
 *  further still until the two ends are MARK_SPREAD delta E apart, so the order still reads by
 *  strength. Of black and white, the side whose 4-state ramp keeps neighbours further apart wins
 *  (a mid-grey page has more room toward white for a light accent). `k` is the state's place
 *  among its hue's states, 0 (weakest) to 1 (strongest). */
const MARK_MIN = 3;
/** Fix round 10 (R4): a mark that alone carries a period's status and whose fill measures under
 *  EDGE_MIN:1 on the composited surface gets a 1 px inner edge at EDGE_MIN:1 or better against the
 *  surface (and against the fill where some shade of it can reach both). EDGE_FULL_PX: the smallest
 *  side that takes a full inner edge; a mark narrower than that takes only its top and bottom
 *  edges (so a 2 px wide mark keeps its fill between them), and one lower than that takes none. */
const EDGE_MIN = 3;
const EDGE_FULL_PX = 3;
/** Fix round 10 (R3): the visual's own text and muted inks read at TEXT_MIN:1 on the composited
 *  surface, its focus ink at FOCUS_MIN:1 on the surface and against the mark it rings. */
const TEXT_MIN = 4.5;
const FOCUS_MIN = 3;
/** The inks are resolved 0.1 above each bar: the page composites the card at its own rounding
 *  (measured: a muted ink resolved to 4.50:1 on compositeOver's surface read 4.46:1 on the
 *  browser's, white card at 70% over grey 60). */
const AIM = 0.1;

/** R3: the better-reading of the light-surface and dark-surface token text inks, pushed toward
 *  black or white (whichever reads better) until it clears TEXT_MIN on `surface`. */
function textInkOn(surface: string): string {
    const a = surfaceTokens("light").text, b = surfaceTokens("dark").text;
    const best = contrastRatio(a, surface) >= contrastRatio(b, surface) ? a : b;
    return atLeast(best, surface, contrastInk(surface, "#000000", "#ffffff"), TEXT_MIN + AIM);
}
const MARK_SPREAD = 34;
const rampCache = new Map<string, { lo: number; hi: number; ink: string }>();
function markOnPage(accent: string, surface: string, k: number): string {
    const key = accent + surface;
    const along = (ink: string) => (u: number) => (u < 0 ? mix(accent, surface, -u) : mix(accent, ink, u));
    let ramp = rampCache.get(key);
    if (!ramp) {
        let best: { lo: number; hi: number; ink: string; score: number } | null = null;
        for (const ink of ["#000000", "#ffffff"]) {
            const at = along(ink);
            let lo = NaN;
            for (let u = 1; u >= -1; u = Math.round((u - 0.01) * 100) / 100) {
                if (contrastRatio(at(u), surface) >= MARK_MIN + 0.05) lo = u; else break;
            }
            if (!Number.isFinite(lo)) continue;
            let hi = Math.min(1, Math.max(0, lo + 0.45));
            while (hi < 1 && deltaE(at(lo), at(hi)) < MARK_SPREAD) hi = Math.min(1, Math.round((hi + 0.05) * 100) / 100);
            let score = Infinity;
            for (let q = 0; q < 3; q++) score = Math.min(score, deltaE(at(lo + (hi - lo) * q / 3), at(lo + (hi - lo) * (q + 1) / 3)));
            if (!best || score > best.score) best = { lo, hi, ink, score };
        }
        ramp = best ? { lo: best.lo, hi: best.hi, ink: best.ink } : { lo: 1, hi: 1, ink: contrastInk(surface, "#000000", "#ffffff") };
        rampCache.set(key, ramp);
    }
    return along(ramp.ink)(ramp.lo + (ramp.hi - ramp.lo) * Math.max(0, Math.min(1, k)));
}

/** The second hue for states 5-8: the accent turned -150 degrees in HSL, same saturation and
 *  lightness (cyan -> amber; never a red/green pair, the order still reads by strength). */
function secondHue(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let h = 0;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    if (d !== 0) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = ((h * 60 - 150) % 360 + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m0 = l - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return "#" + [r1, g1, b1].map(v => Math.round((v + m0) * 255).toString(16).padStart(2, "0")).join("");
}

interface Colours {
    hc: boolean;
    surface: string;
    text: string;
    muted: string;
    accent: string;
    accent2: string;        // states 5-8: the accent's hue turned -150 deg (cyan -> amber)
    track: string;
    focus: string;
    glow: string;           // CSS filter for accent marks ("none" outside Neon)
    theme: "light" | "dark";
    markFloor: boolean;     // fix round 4 item 3: Show background off with the DEFAULT state colour
    semantic: boolean;      // Desktop fix round 1: the DEFAULT state colour, so states take meaning hues
}

interface Fill { fill: string; stroke?: string; dash?: string }

interface Columns {
    resource?: DataViewCategoryColumn;
    timestamp?: DataViewCategoryColumn;
    state?: DataViewCategoryColumn;
    order?: DataViewValueColumn;
    asOf?: DataViewValueColumn;
    tooltips: DataViewValueColumn[];
}

/** One drawn strip: the hit-test and selection data behind a row. */
interface RowCtx {
    strip: Strip;
    el: HTMLElement;
    svg: SVGSVGElement;
    focusRect: SVGRectElement;
    hit: (x: number) => { run: Run | null; label?: string; extra?: VisualTooltipDataItem[] } | null;
    marks: Array<{ x: number; w: number; run: Run; tip?: () => VisualTooltipDataItem[] }>;   // keyboard stops
    focusIndex: number;
    paths: Map<string, SVGPathElement>;                 // state key -> path (for dimming)
    edges: Map<string, SVGPathElement>;                 // state key -> its R4 inner edge (dimmed with it)
}

export class Visual implements IVisual {
    private host: IVisualHost;
    private target: HTMLElement;
    private root: HTMLDivElement;
    private defs: SVGSVGElement;
    private events: IVisualEventService;
    private selectionManager: ISelectionManager;
    private tooltipService: ITooltipService;
    private loc: ILocalizationManager;
    private settings: VisualFormattingSettingsModel;
    private settingsService: FormattingSettingsService;
    private measureCtx: CanvasRenderingContext2D | null = null;
    private probe: HTMLSpanElement;
    private scrollbar = -1;
    private licenseGate: LicenseGate;
    private lastOptions: VisualUpdateOptions | null = null;
    private destroyed = false;

    private dv: DataView | null = null;
    private cols: Columns = { tooltips: [] };
    private model: Model | null = null;
    private rows: RowCtx[] = [];
    private selected: ISelectionId[] = [];
    private idCache = new Map<string, ISelectionId>();
    private colours: Colours;
    private styles: StateStyle[] = [];
    private patternSeq = 0;
    private focusRow = 0;
    private tipOpen = false;
    private onContextMenu: (e: MouseEvent) => void;
    private periodLabels = new Map<string, string>();
    private axisTexts = new Map<string, string>();
    private runsOrderCache: { key: string; e: number; base: number[]; levels: number[][]; es: number[] } | null = null;   // runsOrder for the current range
    private coarsened: { from: TimeGrain; to: TimeGrain } | null = null;   // a forced grain whose blocks would be under MIN_BLOCK_PX
    private partialDrawn = false;     // a block covers only part of its period (item 2)
    private locale = "en-US";

    constructor(options: VisualConstructorOptions) {
        // NO FREE TIER: the suite's shared licence gate (vendored, fails open). The check is
        // async, so the last update is replayed once it resolves.
        this.licenseGate = new LicenseGate(options.host, () => {
            if (this.lastOptions) this.update(this.lastOptions);
        });
        this.host = options.host;
        this.target = options.element;
        this.target.style.margin = "0";
        this.target.style.padding = "0";
        this.target.style.overflow = "hidden";
        this.events = options.host.eventService;
        this.selectionManager = this.host.createSelectionManager();
        this.tooltipService = options.host.tooltipService;
        this.loc = this.host.createLocalizationManager();
        this.settingsService = new FormattingSettingsService(this.loc);
        this.locale = this.host.locale || "en-US";

        this.root = document.createElement("div");
        this.root.className = "st-root";
        this.target.appendChild(this.root);

        // 1180.2.5: ONE contextmenu listener on options.element; a right-click on a mark passes
        // that mark's identity, anywhere else the empty-space menu.
        // Kept as a field so destroy() can remove it (review 2, finding 10).
        this.onContextMenu = (e: MouseEvent) => {
            const id = this.idAtEvent(e);
            this.selectionManager.showContextMenu(id || {}, { x: e.clientX, y: e.clientY });
            e.preventDefault();
        };
        this.target.addEventListener("contextmenu", this.onContextMenu);
        // A click on empty space clears the selection.
        this.root.addEventListener("click", () => { this.select(null, false); });
        this.selectionManager.registerOnSelectCallback((ids: ISelectionId[]) => { this.selected = ids || []; this.applySelection(); });
    }

    private t(key: string, ...args: Array<string | number>): string {
        let s = this.loc.getDisplayName(key) || key;
        args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
        return s;
    }

    /** A count the visual prints itself (rows, resources, changes): no thousands separator (fix
     *  round 10, the owner's decision of 2026-11-20: 1264, not 1,264). */
    // fix round 11 (S1): the visual's own counts through the shared formatter, format "0" (no separator)
    private n(v: number): string { return formatModelNumber(v, "0", this.locale); }

    public update(options: VisualUpdateOptions): void {
        if (this.destroyed) return;
        this.events.renderingStarted(options);
        this.lastOptions = options;
        if (this.licenseGate.blockedThisFrame(options.dataViews)) {
            this.target.style.display = "none";
            this.events.renderingFinished(options);
            return;
        }
        this.target.style.display = "";
        try {
            this.dv = options.dataViews?.[0] ?? null;
            this.settings = this.settingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, this.dv || undefined);
            const st = this.settings.statusTimeline;
            // An enum value from a newer/older schema resolves to undefined: fall back to the first item.
            for (const dd of [st.style, st.sortStrips, st.stateOrder, st.timeGrain, st.durationUnit, this.settings.codexTheme.mode, this.settings.codexTheme.neonScope]) {
                if (!dd.value) dd.value = dd.items[0];
            }
            this.idCache.clear();
            this.selected = this.selectionManager.getSelectionIds() as ISelectionId[];
            this.render(options.viewport.width, options.viewport.height);
            this.events.renderingFinished(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    // ── colours ─────────────────────────────────────────────────────────────

    private ensureProbe(): void {
        if (this.probe && this.probe.isConnected) return;
        this.probe = document.createElement("span");
        this.probe.className = "st-probe";
        this.root.appendChild(this.probe);
    }

    /** Any CSS colour (hex, rgb(), or a name such as "Orange" from an fx rule) as #rrggbb. The
     *  shared contrast helpers parse hex only and score a NAME as black (KPI Sparkline round 7),
     *  so every colour is normalised here first. */
    private hex(c: string | undefined | null, fallback: string): string {
        if (!c) return fallback;
        const s = String(c).trim();
        if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
        if (/^#[0-9a-f]{3}$/i.test(s)) return ("#" + s.slice(1).split("").map(x => x + x).join("")).toLowerCase();
        this.ensureProbe();
        this.probe.style.color = "";
        this.probe.style.color = s;
        if (!this.probe.style.color) return fallback;
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(this.probe).color);
        if (!m) return fallback;
        return "#" + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, "0")).join("");
    }

    /** Background shown? (Background card "Show background"; absent = on) */
    private showBackground(): boolean { return this.settings.background.show.value !== false; }

    private resolveColours(): { colours: Colours; theme: ResolvedCodexTheme; bg: string } {
        const pal = this.host.colorPalette as ISandboxExtendedColorPalette;
        const hc = !!pal.isHighContrast;
        const bgCard = this.settings.background;
        const behind = this.hex(pal.background?.value, "#ffffff");
        const bgHex = this.hex(bgCard.backgroundColor.value?.value, "#ffffff");
        const showBg = this.showBackground();
        const bgPct = showBg ? Math.max(0, Math.min(100, Number(bgCard.transparency.value ?? 0))) : 100;
        const autoTheme = surfaceTone(compositeOver(bgHex, bgPct, behind));
        // shared-code round 2 (B1): Automatic follows a dark report theme when the report holds no
        // Background colour. The colour has an fx button (ConstantOrRule, no selector), and a rule
        // Power BI resolved reaches this visual only as metadata.objects.background.backgroundColor
        // (no per-row objects are read), so a resolved rule reads as set and passes false here.
        const autoBgIsUnset = backgroundColorIsUnset(this.dv?.metadata?.objects);
        const theme = resolveCodexTheme(this.settings.codexTheme, { hcActive: hc, autoTheme, autoBgHex: bgHex, autoTransparencyPct: bgPct, behindHex: behind, autoBgIsUnset });
        if (hc) {
            const fg = this.hex(pal.foreground?.value, "#ffffff");
            const bg = this.hex(pal.background?.value, "#000000");
            const sel = this.hex(pal.foregroundSelected?.value, fg);
            return { colours: { hc, surface: bg, text: fg, muted: fg, accent: fg, accent2: fg, track: fg, focus: sel, glow: "none", theme: surfaceTone(bg), markFloor: false, semantic: false }, theme, bg };
        }
        // Show background OFF (every mode, AMENDMENT 2026-11-17): nothing is painted, so the
        // page IS the surface. Ink and chrome come from the host palette (foreground judged
        // against palette.background); a forced mode keeps only its accent (mark) colour.
        const surface = showBg ? theme.surfaceHex : behind;
        const tone: "light" | "dark" = showBg ? theme.theme : surfaceTone(behind);
        const tok = surfaceTokens(tone);
        const hostInk = this.hex(pal.foreground?.value, tok.text);
        // fix round 4 item 3: the fallback ink is judged against the page too; when neither the
        // host ink nor the theme ink reads, black or white (whichever reads better: >= 4.58:1)
        // fix round 10 (R3): on a painted card the ink is resolved on the composited surface, not
        // by the card's tone bucket alone (grey 128 at 100% read 3.23:1 with the dark-tone ink)
        const baseText = showBg ? textInkOn(surface)
            : contrastRatio(hostInk, surface) >= 4.5 ? hostInk
                : contrastRatio(tok.text, surface) >= 4.5 ? tok.text : contrastInk(surface, "#000000", "#ffffff");
        const sc = this.settings.stateColours;
        const themeAccent = theme.theme === "light" ? LIGHT_ACCENT : DARK_ACCENT;
        let tokenUsed = false;
        const pick = (raw: string | undefined, def: string, token: string): string => {
            const v = this.hex(raw, def);
            tokenUsed = true;
            if (v === def) return token;                        // pane default = the theme's colour
            // fix round 11 (S6, owner ruling 2026-11-21): a MARK colour the author set (accent, track)
            // is drawn as set in every mode outside high contrast. Text no longer comes through here
            // (desk round 12, owner rule 2026-11-23): see `text` below.
            tokenUsed = false;
            return v;
        };
        // The theme's own track must stand off the surface (1.3:1, M5): a theme track that falls
        // short is pushed toward the ink until it shows. An author colour is never replaced.
        let accent = pick(sc.accent.value?.value, DEFAULT_ACCENT, themeAccent);
        const accentIsToken = tokenUsed;
        accent = neonColorFor(accent, theme);
        const tokTrack = atLeast(tok.track, surface, baseText, 1.3);
        const track = pick(sc.track.value?.value, DEFAULT_TRACK, tokTrack);
        // desk round 12 (owner rule 2026-11-23): under a forced Light/Dark mode an explicit text
        // colour goes through forcedInk on the surface it sits on (navy on Dark flips to the ink);
        // Automatic keeps it as set, the pane default takes the theme's ink, as before.
        const rawText = this.hex(this.settings.labels.textColor.value?.value, DEFAULT_TEXT);
        const text = forcedInk(rawText, baseText, theme, rawText === DEFAULT_TEXT, surface);
        const muted = mutedInk(text, surface, TEXT_MIN + AIM);
        // R3: the focus ink is always the visual's own (there is no focus colour in the pane): the
        // accent, pushed toward black or white until it clears FOCUS_MIN on the surface
        const focus = contrastRatio(accent, surface) >= FOCUS_MIN + AIM ? accent : atLeast(accent, surface, contrastInk(surface, "#000000", "#ffffff"), FOCUS_MIN + AIM);
        return {
            colours: { hc, surface, text, muted, accent, accent2: secondHue(accent), track, focus, glow: neonFilter(accent, theme.glow), theme: tone, markFloor: !showBg && accentIsToken, semantic: accentIsToken },
            theme, bg: bgHex,
        };
    }

    /** The colour of a state style on the surface: accent at `strength`, mixed to an opaque hex. */
    private styleColour(s: StateStyle): string {
        const c = this.colours;
        if (c.hc) return c.text;
        if (s.kind === "track" || s.kind === "other") return c.track;
        if (s.kind === "unknown") return c.muted;
        if (s.role) {
            const hue = ROLE_HUES[c.theme][s.role];
            // Show background off: the hue pushed toward black or white until it reads on the page
            return c.markFloor ? atLeast(hue, c.surface, contrastInk(c.surface, "#000000", "#ffffff"), MARK_MIN + 0.05) : hue;
        }
        if (c.markFloor) {
            // the state's place among the drawn strengths of its own hue (0 weakest, 1 strongest)
            const peers = this.styles.filter(x => x.kind === "accent" && x.hue === s.hue).map(x => x.strength);
            const lo = Math.min(...peers);
            return markOnPage(s.hue === 1 ? c.accent2 : c.accent, c.surface, lo >= 1 ? 1 : (s.strength - lo) / (1 - lo));
        }
        return mix(c.surface, s.hue === 1 ? c.accent2 : c.accent, s.strength);
    }

    /** Review 5 finding 3: no two states may share a look. Whole palette, every pair across hue
     *  families and against the resting track and "Other states": when two drawn colours come
     *  closer than CUE_DE (CIE76; 12 with the background off, where the ramps converge toward black
     *  or white on the page; the palette's own 10 with it on), the WEAKER state gains a redundant
     *  pattern on its colour (mark and legend chip), the strongest keeps the solid accent. The
     *  colour itself is never changed, so a colour the author or an fx rule set stays exactly as set. */
    private addRedundantCues(): void {
        if (this.colours.hc) return;
        const limit = this.showBackground() ? CUE_DE_BG_ON : CUE_DE_BG_OFF;
        const seen: Array<{ colour: string; pattern: string }> = [];
        for (const s of this.styles) if (s.kind !== "accent") seen.push({ colour: this.styleColour(s), pattern: s.pattern });
        const accents = this.styles.filter(s => s.kind === "accent").sort((a, b) => b.strength - a.strength || b.level - a.level);
        for (const s of accents) {
            const colour = this.styleColour(s);
            const near = seen.filter(x => deltaE(x.colour, colour) < limit);
            if (near.some(x => x.pattern === s.pattern)) {
                const free = CUE_PATTERNS.find(p => !near.some(x => x.pattern === p));
                if (free) s.pattern = free;
            }
            seen.push({ colour, pattern: s.pattern });
        }
    }

    private pattern(kind: string, base: string | null, ink: string): string {
        const id = `st-p${++this.patternSeq}`;
        const p = document.createElementNS(SVGNS, "pattern");
        p.setAttribute("id", id);
        p.setAttribute("patternUnits", "userSpaceOnUse");
        // Tiles of 2-4 px so every pattern puts ink inside a 4-6 px block (M5).
        const size = PATTERN_TILE[kind] || 4;
        p.setAttribute("width", String(size));
        p.setAttribute("height", String(size));
        if (kind === "hatch" || kind === "hatchDense") p.setAttribute("patternTransform", "rotate(45)");
        if (kind === "hatchBack" || kind === "hatchBackDense") p.setAttribute("patternTransform", "rotate(-45)");
        if (base) { const r = document.createElementNS(SVGNS, "rect"); r.setAttribute("width", String(size)); r.setAttribute("height", String(size)); r.setAttribute("fill", base); p.appendChild(r); }
        const line = (x1: number, y1: number, x2: number, y2: number) => {
            const l = document.createElementNS(SVGNS, "line");
            l.setAttribute("x1", String(x1)); l.setAttribute("y1", String(y1)); l.setAttribute("x2", String(x2)); l.setAttribute("y2", String(y2));
            l.setAttribute("stroke", ink); l.setAttribute("stroke-width", kind === "hatchDense" || kind === "hatchBackDense" ? "1.2" : kind === "verticalDense" || kind === "horizontalDense" || kind === "grid" ? "0.8" : "1.4");
            p.appendChild(l);
        };
        const dot = (cx: number, cy: number, r: number) => { const c = document.createElementNS(SVGNS, "circle"); c.setAttribute("cx", String(cx)); c.setAttribute("cy", String(cy)); c.setAttribute("r", String(r)); c.setAttribute("fill", ink); p.appendChild(c); };
        if (kind === "hatch" || kind === "hatchDense" || kind === "hatchBack" || kind === "hatchBackDense") line(0, 0, 0, size);
        else if (kind === "cross") { line(0, 0, size, size); line(size, 0, 0, size); }
        else if (kind === "grid") { line(size / 2, 0, size / 2, size); line(0, size / 2, size, size / 2); }
        else if (kind === "vertical" || kind === "verticalDense") line(size / 2, 0, size / 2, size);
        else if (kind === "horizontal" || kind === "horizontalDense") line(0, size / 2, size, size / 2);
        else if (kind === "dots") dot(size / 2, size / 2, 1);
        else if (kind === "dotsDense") dot(size / 2, size / 2, 0.75);
        else if (kind === "dotsSparse") dot(size / 2, size / 2, 0.6);
        else if (kind === "outlineDot") dot(size / 2, size / 2, 0.8);
        else if (kind === "ring") { const c = document.createElementNS(SVGNS, "circle"); c.setAttribute("cx", String(size / 2)); c.setAttribute("cy", String(size / 2)); c.setAttribute("r", "1.3"); c.setAttribute("fill", "none"); c.setAttribute("stroke", ink); c.setAttribute("stroke-width", "0.8"); p.appendChild(c); }
        this.defs.appendChild(p);
        return `url(#${id})`;
    }

    private fillCache = new Map<string, Fill>();
    private fillOf(s: StateStyle): Fill {
        const key = `${s.kind}|${s.level}|${s.pattern}`;
        const hit = this.fillCache.get(key);
        if (hit) return hit;
        const c = this.colours;
        let f: Fill;
        if (s.kind === "unknown") f = { fill: "none", stroke: c.muted, dash: "2 2" };
        else if (c.hc) {
            if (s.pattern === "outline") f = { fill: "none", stroke: c.text };
            else if (s.pattern === "outlineDot") f = { fill: this.pattern("outlineDot", null, c.text), stroke: c.text };
            else if (s.pattern === "none") f = { fill: c.text };
            else f = { fill: this.pattern(s.pattern, c.surface, c.text), stroke: c.text };
        } else if (s.pattern === "none") f = { fill: this.styleColour(s) };
        else {
            const base = this.styleColour(s);
            // a cue's ink: the page where it stands off the colour, else a shade of the colour
            // itself (review 6 item 5), at least CUE_INK_MIN:1 off it either way (item 3)
            const ink = s.kind === "other" ? c.muted : contrastRatio(base, c.surface) >= CUE_INK_MIN ? c.surface : atLeast(base, base, contrastInk(base, "#000000", "#ffffff"), CUE_SHADE);
            f = { fill: this.pattern(s.pattern, base, ink) };
        }
        this.fillCache.set(key, f);
        return f;
    }

    /** Fix round 10 (R4): the inner-edge ink of a status mark whose fill is under EDGE_MIN:1 on the
     *  composited surface (null where the fill reads by itself, in high contrast, and for the
     *  unknown state, which is already drawn as a muted dashed outline). The fill is never
     *  changed, whether default, author-set or fx: the edge is added beside it. The ink is the
     *  fill pushed toward black or white (whichever reads better on the surface) until it clears
     *  EDGE_MIN against the surface AND the fill; where no shade clears both, the surface alone. */
    private edgeCache = new Map<string, string | null>();
    private edgeOf(s: StateStyle): string | null {
        const c = this.colours;
        if (c.hc || s.kind === "unknown") return null;
        const fill = this.styleColour(s);
        const key = fill + c.surface;
        if (this.edgeCache.has(key)) return this.edgeCache.get(key);
        let e: string | null = null;
        if (contrastRatio(fill, c.surface) < EDGE_MIN) {
            const ink = contrastInk(c.surface, "#000000", "#ffffff");
            for (let t = 0; t <= 1.0001 && !e; t += 0.05) {
                const m = mix(fill, ink, t);
                if (contrastRatio(m, c.surface) >= EDGE_MIN && contrastRatio(m, fill) >= EDGE_MIN) e = m;
            }
            if (!e) e = atLeast(fill, c.surface, ink, EDGE_MIN);
        }
        this.edgeCache.set(key, e);
        return e;
    }

    /** Fix round 10 (R3): the ring drawn round a focused mark (2 px, just outside it): the focus
     *  ink where it clears FOCUS_MIN against the surface AND the mark's fill; else that ink pushed
     *  toward black, then white, until it clears both. Where no single ink can (measured: a mid-dark
     *  surface round the full-strength accent: 1147 of the 43520 Runs rings on the focus grid), the ring is two-tone: its
     *  outer pixel the focus ink (FOCUS_MIN on the surface) and its inner pixel, the one against
     *  the mark, that ink pushed until it clears FOCUS_MIN against the fill. */
    private ringCache = new Map<string, { outer: string; inner: string | null }>();
    private ringOf(run: Run): { outer: string; inner: string | null } {
        const c = this.colours;
        const s = this.styleOfState(run.state);
        if (c.hc || s.kind === "unknown") return { outer: c.focus, inner: null };
        const fill = s.kind === "track" ? c.track : this.styleColour(s);
        const key = fill + c.surface + c.focus;
        const hit = this.ringCache.get(key);
        if (hit) return hit;
        const bar = FOCUS_MIN + AIM;
        const worse = (m: string) => Math.min(contrastRatio(m, c.surface), contrastRatio(m, fill));
        let r: string | null = worse(c.focus) >= bar ? c.focus : null;
        for (const ink of ["#000000", "#ffffff"]) {
            for (let t = 0.05; t <= 1.0001 && !r; t += 0.05) { const m = mix(c.focus, ink, t); if (worse(m) >= bar) r = m; }
        }
        const ring = r ? { outer: r, inner: null } : { outer: c.focus, inner: atLeast(c.focus, fill, contrastInk(fill, "#000000", "#ffffff"), bar) };
        this.ringCache.set(key, ring);
        return ring;
    }

    private styleOfState(state: string | null): StateStyle {
        if (state === null || !this.model) return UNKNOWN_STYLE;
        const i = this.model.states.indexOf(state);
        return this.styles[i] || UNKNOWN_STYLE;
    }

    // ── data ────────────────────────────────────────────────────────────────

    private readColumns(dv: DataView | null): Columns {
        const out: Columns = { tooltips: [] };
        const cat = dv?.categorical;
        for (const c of cat?.categories || []) {
            const r = c.source.roles || {};
            if (r.resource) out.resource = c;
            if (r.timestamp) out.timestamp = c;
            if (r.state) out.state = c;
        }
        for (const v of cat?.values || []) {
            const r = v.source.roles || {};
            if (r.stateOrder) out.order = v;
            if (r.asOf) out.asOf = v;
            if (r.tooltips) out.tooltips.push(v);
        }
        return out;
    }

    private resourceId(strip: Strip): ISelectionId | null {
        const c = this.cols.resource;
        if (!c) return null;
        const key = "r" + strip.firstRow;
        let id = this.idCache.get(key);
        if (!id) { id = this.host.createSelectionIdBuilder().withCategory(c, strip.firstRow).createSelectionId(); this.idCache.set(key, id); }
        return id;
    }

    /** Resource AND state: the identity of a run or block (cross-filters "this machine while Running"). */
    private runId(run: Run): ISelectionId | null {
        const c = this.cols;
        if (!c.resource) return null;
        const key = "s" + run.row;
        let id = this.idCache.get(key);
        if (!id) {
            const b = this.host.createSelectionIdBuilder().withCategory(c.resource, run.row);
            if (c.state) b.withCategory(c.state, run.row);
            id = b.createSelectionId();
            this.idCache.set(key, id);
        }
        return id;
    }

    // ── render ──────────────────────────────────────────────────────────────

    private clear(): void {
        while (this.root.firstChild) this.root.removeChild(this.root.firstChild);
        this.rows = [];
        this.fillCache.clear();
        this.edgeCache.clear();
        this.ringCache.clear();
        this.patternSeq = 0;
        this.defs = document.createElementNS(SVGNS, "svg") as SVGSVGElement;
        this.defs.setAttribute("class", "st-defs");
        this.defs.setAttribute("aria-hidden", "true");
        this.root.appendChild(this.defs);
        this.ensureProbe();
    }

    private measure(text: string, px: number, weight = 400): number {
        if (!this.measureCtx) {
            const canvas = document.createElement("canvas");
            this.measureCtx = canvas.getContext("2d");
        }
        const ctx = this.measureCtx;
        if (!ctx || typeof ctx.measureText !== "function") return text.length * px * 0.6;
        const lf = this.settings.labels.font;
        // item 7: the family the labels are DRAWN in (render() sets the same fallback on the root)
        ctx.font = `${lf.italic.value ? "italic " : ""}${weight} ${px}px ${lf.fontFamily.value || LABEL_FONT_FALLBACK}`;
        return ctx.measureText(text).width;
    }

    private render(width: number, height: number): void {
        // item 3: a re-render must not drop keyboard focus: remember the focused strip by key
        const active = document.activeElement;
        const focusKey = active && this.root.contains(active) ? (this.rows.find(r => r.el === active)?.strip.key ?? null) : null;
        this.clear();
        const { colours, theme } = this.resolveColours();
        this.colours = colours;
        // Background: painted on the root (edge to edge). HC paints the host background.
        const bgCard = this.settings.background;
        if (colours.hc) this.root.style.background = colours.surface;
        else if (!this.showBackground()) this.root.style.background = "transparent";     // every mode (AMENDMENT)
        else if (theme.mode !== "auto") this.root.style.background = toRgba(theme.bgHex, theme.transparencyPct);
        // Automatic paints the fill the theme resolved: the author's Background colour, or (B1)
        // the Dark card where none is set on a dark report theme
        else this.root.style.background = toRgba(theme.bgHex, Number(bgCard.transparency.value ?? 0));
        this.root.style.color = colours.text;
        this.root.style.setProperty("--st-text", colours.text);
        this.root.style.setProperty("--st-muted", colours.muted);
        this.root.style.setProperty("--st-focus", colours.focus);
        this.root.style.setProperty("--st-surface", colours.surface);
        // readiness check: the rows scrollbar takes the card's tone (it drew a white track on a dark card)
        this.root.style.colorScheme = colours.theme;
        this.root.classList.toggle("st-hc", colours.hc);
        const lf = this.settings.labels.font;
        const fs = Math.max(8, Math.min(32, Number(lf.fontSize.value) || 12));
        this.root.style.fontFamily = lf.fontFamily.value || LABEL_FONT_FALLBACK;
        this.root.style.fontSize = `${fs}px`;
        this.root.style.fontStyle = lf.italic.value ? "italic" : "normal";

        const cp = this.settings.contentPadding;
        const req: Insets = {
            top: clampPadding(cp.top.value, PADDING_DEFAULTS.top), right: clampPadding(cp.right.value, PADDING_DEFAULTS.right),
            bottom: clampPadding(cp.bottom.value, PADDING_DEFAULTS.bottom), left: clampPadding(cp.left.value, PADDING_DEFAULTS.left),
        };
        const pad = applyPadding(req, width, height);
        const content = document.createElement("div");
        content.className = "st-content";
        content.style.padding = `${pad.top}px ${pad.right}px ${pad.bottom}px ${pad.left}px`;
        content.style.minHeight = `${Math.max(0, height)}px`;
        this.root.appendChild(content);
        this.renderTitle(content, colours, theme);

        this.cols = this.readColumns(this.dv);
        const c = this.cols;
        const missing: string[] = [];
        if (!c.resource) missing.push(this.t("Setup_Resource"));
        if (!c.timestamp) missing.push(this.t("Setup_Timestamp"));
        if (!c.state) missing.push(this.t("Setup_State"));
        if (missing.length === 3) { this.renderLanding(content); this.fitNonChart(content); return; }
        if (missing.length > 0) { this.renderSetup(content, this.t("Setup_Missing", missing.join(this.t("List_Separator"))), true); this.fitNonChart(content); return; }

        const raw = this.rawRows();
        const st = this.settings.statusTimeline;
        this.model = buildModel(raw, {
            orderMode: st.stateOrder.value.value as OrderMode,
            customOrder: String(st.customOrder.value || ""),
            useOrderField: !!c.order,
            blankLabel: this.t("Blank"),
            truncated: !!this.dv?.metadata?.segment,
        });
        const m = this.model;
        const d = m.disclosures;
        if (m.strips.length === 0) {
            this.renderSetup(content, this.emptyMessage(d), false); this.fitNonChart(content);
            return;
        }
        this.styles = stateStyles(m.states.length, st.restingAsTrack.value !== false, colours.hc, colours.semantic);
        this.addRedundantCues();
        const style = st.style.value.value as Style;
        const sortSetting = String(st.sortStrips.value.value);
        const sort: SortMode = sortSetting === "auto" ? (style === "board" ? "currentState" : "data") : sortSetting as SortMode;
        const strips = sortStrips(m.strips, sort, m.states);
        const keep = content.childNodes.length;
        const contentW = width - pad.left - pad.right;
        this.renderChart(content, style, strips, contentW, fs);
        // The root scrolls vertically when the visual is shorter than its content (1180.2.2): its
        // scrollbar takes width the first pass gave the chart, so lay the chart out again without it.
        const rootBar = this.root.offsetWidth - this.root.clientWidth;
        if (rootBar > 0) {
            while (content.childNodes.length > keep) content.removeChild(content.lastChild);
            this.rows = [];
            this.renderChart(content, style, strips, contentW - rootBar, fs);
        }
        this.applySelection();
        if (focusKey !== null) {
            const again = this.rows.find(r => r.strip.key === focusKey);
            if (again) again.el.focus({ preventScroll: true });
        }
    }

    /** Why nothing is drawn (review 7 finding 3): one cause keeps its own message (singular for
     *  one row); several causes are each counted, with the fix for each that has one. The same
     *  text is the message, its full-text title and the accessible name. */
    private emptyMessage(d: Model["disclosures"]): string {
        const blank = d.blankTimestamp, bad = d.badTimestamp, num = d.numericTimestamp, after = d.afterAsOf;
        const one = d.received === 1;
        if (num === 0 && after === 0) return this.t(one ? "Setup_NoValidEvents_One" : "Setup_NoValidEvents", this.n(d.received), this.n(blank), this.n(bad));
        if (blank === 0 && bad === 0 && after === 0) return this.t("Setup_NumericTime");
        if (blank === 0 && bad === 0 && num === 0) return after === 1 ? this.t("Setup_AllAfterAsOf_One") : this.t("Setup_AllAfterAsOf", this.n(after));
        const parts: string[] = [];
        if (blank) parts.push(this.t("Drop_Blank", this.n(blank)));
        if (bad) parts.push(this.t("Drop_Bad", this.n(bad)));
        if (num) parts.push(this.t("Drop_Numeric", this.n(num)));
        if (after) parts.push(this.t("Drop_After", this.n(after)));
        let msg = this.t("Setup_Mixed", this.n(d.received), parts.join(this.t("List_Separator")));
        if (num) msg += " " + this.t("Fix_Numeric");
        if (after) msg += " " + this.t("Fix_After");
        return msg;
    }

    private rawRows(): RawRow[] {
        const c = this.cols;
        const n = c.resource.values.length;
        const out: RawRow[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const r: RawRow = { resource: c.resource.values[i], timestamp: c.timestamp.values[i], state: c.state.values[i], index: i };
            if (c.order) r.order = c.order.values[i];
            if (c.asOf) r.asOf = c.asOf.values[i];
            out[i] = r;
        }
        return out;
    }

    private renderTitle(parent: HTMLElement, colours: Colours, theme: ResolvedCodexTheme): void {
        const t = this.settings.titleSettings;
        if (!t.showTitle.value || !t.titleText.value) return;
        const el = document.createElement("div");
        el.className = "st-title";
        el.textContent = t.titleText.value;
        el.title = t.titleText.value;           // L5: a title cut by its ellipsis keeps its full text
        el.style.fontFamily = t.titleFontFamily.value || "Segoe UI, sans-serif";
        el.style.fontSize = `${Number(t.titleFontSize.value) || 14}px`;
        el.style.fontWeight = t.titleBold.value ? "700" : "400";
        el.style.fontStyle = t.titleItalic.value ? "italic" : "normal";
        el.style.textDecoration = t.titleUnderline.value ? "underline" : "none";
        el.style.textAlign = textAlignFor(t.titleAlign.value as string);
        const raw = this.hex(t.titleColor.value?.value, "#1a1a2e");
        // desk round 12 (owner rule 2026-11-23): an explicit title colour goes through forcedInk on
        // the card under a forced mode; Automatic paints it as set
        el.style.color = colours.hc ? colours.text : forcedInk(raw, colours.text, theme, raw === "#1a1a2e", colours.surface);
        parent.appendChild(el);
    }

    private renderLanding(parent: HTMLElement): void {
        const wrap = document.createElement("div");
        wrap.className = "st-empty";
        const h = document.createElement("div");
        h.className = "st-empty-title";
        h.textContent = this.t("Visual_Short_Description");
        const p = document.createElement("div");
        p.className = "st-empty-body";
        p.textContent = this.t("Visual_Landing_Message");
        wrap.appendChild(h);
        wrap.appendChild(p);
        // fix round 7: the full explanation stays in the accessible name whatever fitNonChart sheds
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", `${h.textContent}. ${p.textContent}`);
        parent.appendChild(wrap);
    }

    /** Review 6 finding 1 (fix round 7): the landing and setup states fit the card as the chart
     *  does; neither the root nor any ancestor scrolls. Text goes, the least needed first: the
     *  setup list's last values; then the message (landing: its body) stops wrapping and shows one
     *  line, cut by an ellipsis, its full text in its title (the list is fitted again beside it);
     *  then the list; then the message; then the landing heading (one line, then gone); then the
     *  visual title, after which the heading and the message come back (one line) while they fit.
     *  Every piece is whole or absent; the wrapper's aria-label keeps the full text. */
    private fitNonChart(content: HTMLElement): void {
        const root = this.root;
        // (a centred text wider than the card overflows both sides alike, so the root's scroll
        // range sees it; a per-box check here was dropped on measurement, fix round 7)
        const fits = (): boolean => !(root.scrollHeight > root.clientHeight + 0.5 || root.scrollWidth > root.clientWidth + 0.5);
        if (fits()) return;
        const wrap = content.querySelector<HTMLElement>(".st-setup, .st-empty");
        const list = content.querySelector<HTMLElement>(".st-setup-list");
        const items = list ? Array.from(list.children) as HTMLElement[] : [];
        let shown = items.length;
        const show = (k: number) => {
            shown = k;
            if (!list || !wrap) return;
            while (list.firstChild) list.removeChild(list.firstChild);
            for (let i = 0; i < k; i++) list.appendChild(items[i]);
            if (k === 0) { if (list.parentElement) list.remove(); }
            else if (!list.parentElement) wrap.appendChild(list);
        };
        // review 7 finding 2: every candidate is measured in one stable, gutter-free geometry (the
        // root's own scrollbars, shown only while it overflows, made a 3-item list measure as tall
        // as a 1-item one); the result is re-checked with real scrollbars at the end
        root.style.overflow = "hidden";
        // the most list values that fit (a prefix: the roving tab stop stays on the first value):
        // the next value never fits whole beside them
        const fitList = (): boolean => {
            if (!list) return fits();
            let lo = 0, hi = items.length;
            show(hi);
            if (fits()) return true;
            while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); show(mid); if (fits()) lo = mid; else hi = mid - 1; }
            show(lo);
            return fits();
        };
        const line = (el: HTMLElement | null) => { if (el) { el.classList.add("st-line"); el.title = el.textContent || ""; } };
        const drop = (el: Element | null) => { if (el && el.parentElement) el.remove(); };
        const message = content.querySelector<HTMLElement>(".st-setup-message, .st-empty-body");
        const heading = content.querySelector<HTMLElement>(".st-empty-title");
        const ladder = (): void => {
            if (fitList()) return;
            line(message);
            if (fitList()) return;
            drop(message);
            // the message gone, list values may fit on their own (review 7 finding 2)
            if (fitList()) return;
            line(heading);
            if (fits()) return;
            drop(heading);
            if (fits()) return;
            drop(content.querySelector(".st-title"));
            // with the title gone there may be room again: the heading, then the message, each on
            // its one line, back in that order while they fit; then the list values that fit
            show(0);
            for (const el of [heading, message]) {
                if (!el || !wrap) continue;
                wrap.insertBefore(el, el === message && heading && heading.parentElement ? heading.nextSibling : wrap.firstChild);
                if (!fits()) el.remove();
            }
            fitList();
        };
        ladder();
        root.style.removeProperty("overflow");
        // the winning prefix, re-checked with real scrollbars
        while (list && shown > 0 && !fits()) show(shown - 1);
    }

    /** A setup message naming exactly what to add. With one or two wells bound (1180.2.2.3), the
     *  bound field's values are still listed and select / cross-filter like the full visual. */
    private renderSetup(parent: HTMLElement, message: string, listBound: boolean): void {
        const wrap = document.createElement("div");
        wrap.className = "st-setup";
        const p = document.createElement("div");
        p.className = "st-setup-message";
        p.setAttribute("role", "status");
        p.textContent = message;
        wrap.appendChild(p);
        // fix round 7: the full explanation stays in the accessible name whatever fitNonChart sheds
        wrap.setAttribute("role", "group");
        wrap.setAttribute("aria-label", message);
        const col = this.cols.resource || this.cols.state || this.cols.timestamp;
        if (listBound && col) {
            const list = document.createElement("div");
            list.className = "st-setup-list";
            list.setAttribute("role", "list");
            const seen = new Set<string>();
            const values = col.values || [];
            for (let i = 0; i < values.length && seen.size < 200; i++) {
                // item 5: one item per resource KEY (a datetime is its full wall time, never a caption
                // rounded to the minute), captioned exactly as the chart captions it
                const res = readResource(values[i]);
                const label = res.label === null ? this.t("Blank") : res.label;
                if (seen.has(res.key)) continue;
                seen.add(res.key);
                const item = document.createElement("div");
                item.className = "st-setup-item";
                item.setAttribute("role", "listitem");
                item.tabIndex = seen.size === 1 ? 0 : -1;
                item.textContent = label;
                item.title = label;                     // fix round 7: a value cut by its ellipsis keeps its full text
                const id = this.host.createSelectionIdBuilder().withCategory(col, i).createSelectionId();
                const tip = [{ displayName: col.source.displayName, value: label }];
                // fix round 11 (S7, owner ruling: selection as Power BI's own visuals): shift adds too
                item.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); this.select(id, e.ctrlKey || e.metaKey || e.shiftKey); });
                item.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.select(id, e.ctrlKey || e.metaKey || e.shiftKey); return; }
                    if (e.key === "Escape") { this.onEscape(e, null); return; }      // item 4: as the rows
                    // review 2 finding 9: roving focus over every listed value (one tab stop)
                    const items = Array.from(list.children) as HTMLElement[];
                    const at = items.indexOf(item);
                    const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -2;
                    if (to === -2) return;
                    e.preventDefault();
                    const next = items[Math.max(0, Math.min(items.length - 1, to))];
                    if (next) next.focus();
                });
                item.addEventListener("focus", () => {
                    (Array.from(list.children) as HTMLElement[]).forEach(el => { el.tabIndex = el === item ? 0 : -1; });
                    const box = item.getBoundingClientRect();
                    this.showTip({ coordinates: [box.left + box.width / 2, box.bottom], isTouchEvent: false, dataItems: tip, identities: [id] });
                });
                item.addEventListener("blur", () => this.hideTip(true));
                item.addEventListener("mousemove", (e: MouseEvent) => this.showTip({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: tip, identities: [id] }));
                item.addEventListener("mouseleave", () => this.hideTip(false));
                (item as HTMLElement & { stId?: ISelectionId }).stId = id;
                list.appendChild(item);
            }
            wrap.appendChild(list);
        }
        parent.appendChild(wrap);
    }

    // ── the chart ───────────────────────────────────────────────────────────

    private unitWords(): UnitWords {
        return { min: this.t("Unit_Min"), h: this.t("Unit_H"), d: this.t("Unit_D"), wk: this.t("Unit_Wk"), lessThanMin: this.t("Unit_LessThanMin") };
    }

    private dur(ms: number, unit: DurationUnit): string { return formatDuration(ms, unit, this.unitWords(), this.locale); }

    /** A run's length as text. A zero-length run (the current run of a resource whose latest
     *  event IS the as-of time) reads "just started", never "0 h" (M3). */
    private runDur(ms: number, unit?: DurationUnit): string {
        if (ms === 0) return this.t("JustStarted");
        return this.dur(ms, unit || this.unitFor([ms]));
    }

    private unitFor(values: number[]): DurationUnit {
        const setting = this.settings.statusTimeline.durationUnit.value.value as DurationUnit;
        if (setting !== "auto") return setting;
        return autoUnit(values.reduce((a, b) => Math.max(a, b), 0));
    }

    /** The ONE unit of the Runs totals table (M4): the pane's unit, or Auto's unit for the span. */
    private tableUnit(span: number): Exclude<DurationUnit, "auto"> {
        const setting = this.settings.statusTimeline.durationUnit.value.value as DurationUnit;
        return setting !== "auto" ? setting : autoUnit(span);
    }

    private unitPlural(u: Exclude<DurationUnit, "auto">): string {
        return this.t(u === "minutes" ? "Unit_Minutes" : u === "hours" ? "Unit_Hours" : u === "days" ? "Unit_Days" : "Unit_Weeks");
    }

    private grainWord(g: TimeGrain): string { return this.t("Grain_" + g[0].toUpperCase() + g.slice(1)).toLocaleLowerCase(this.locale); }

    private stateLabel(s: string | null): string { return s === null ? this.t("NoState") : s; }

    /** "Always show" states (M1) that exist in the data. */
    private alwaysList(): Set<string> {
        const raw = String(this.settings.statusTimeline.alwaysShow.value || "");
        const out = new Set<string>();
        for (const p of raw.split(",")) { const v = p.trim(); if (v && this.model.states.indexOf(v) >= 0) out.add(v); }
        return out;
    }

    private periodText(): string {
        const m = this.model;
        if (m.asOf - m.start <= 3 * 86400000) return `${formatWhen(m.start, this.locale)} – ${formatWhen(m.asOf, this.locale)}`;
        const same = new Date(m.start).getUTCFullYear() === new Date(m.asOf).getUTCFullYear();
        return `${same ? formatShortDate(m.start, this.locale) : formatDay(m.start, this.locale)} – ${formatDay(m.asOf, this.locale)}`;
    }

    private renderChart(content: HTMLElement, style: Style, strips: Strip[], contentW: number, fs: number, floorGrain?: TimeGrain, noAxis = false): void {
        const m = this.model;
        const st = this.settings.statusTimeline;
        const keepNodes = content.childNodes.length;
        this.coarsened = null;
        this.partialDrawn = false;
        const showTotals = st.showTotals.value !== false;
        const showSub = st.showSubtitle.value !== false;
        const resting = st.restingAsTrack.value !== false;
        const gap = 8;
        const headFs = Math.max(8, Math.round(fs * 0.8));
        const span = Math.max(1, m.asOf - m.start);

        // ---- columns for this look ----
        // min: a column that may shrink (its text is a name with a title); parts: name + number cells
        interface Col { key: string; header: string; width: number; cls: string; values: string[]; title?: string[]; min?: number; parts?: Array<[string, string]>; shortHeader?: string }
        const cols: Col[] = [];
        let grain: TimeGrain = "week";
        let blockList: Array<[number, number]> = [];
        let blocks: BlockInfo[][] = [];
        let runsTotals: string[] | null = null;
        let runsAlt: Col[] | null = null;      // Runs: the "Most time in" column, when the state columns lead
        const widest = (texts: string[], px: number, w = 400) => texts.reduce((a, s) => Math.max(a, this.measure(s, px, w)), 0);
        const header = (txt: string) => txt.toLocaleUpperCase(this.locale);
        // letter-spacing .08em is added after EVERY character (fix round 4, item 7: 8% of the
        // width under-measured capitals and cut long headers by a few px with room to spare)
        const headW = (txt: string) => this.measure(header(txt), headFs, 600) + Array.from(header(txt)).length * 0.08 * headFs + HEAD_ALLOWANCE;
        const unit = this.tableUnit(span);

        // Block strips AND the board's history strip are drawn as blocks (drawn looks A and C).
        if (style !== "runs") {
            const g = String(st.timeGrain.value.value);
            const maxBlocks = style === "blocks" ? Math.max(4, Math.floor(Math.max(60, contentW * 0.6) / 6)) : Math.max(4, Math.floor(Math.max(40, contentW * 0.3) / 4));
            // a forced grain is coarsened by grainWithin below (it replaced fittingGrain in fix round 3)
            grain = g === "auto" ? autoGrain(m.start, m.asOf, maxBlocks) : g as TimeGrain;
            if (floorGrain && GRAINS.indexOf(floorGrain) > GRAINS.indexOf(grain)) grain = floorGrain;
            // item 1: no strip is wider than the content, so a grain needing more than contentW / 2
            // buckets cannot draw 2 px blocks; the exact strip width is checked after layout (below).
            grain = grainWithin(m.start, m.asOf, grain, Math.min(MAX_BUCKETS, Math.max(1, Math.floor(contentW / MIN_BLOCK_PX))));
            if (g !== "auto" && grain !== g) this.coarsened = { from: g as TimeGrain, to: grain };
            blockList = buckets(m.start, m.asOf, grain);
            const always = this.alwaysList();
            blocks = strips.map(s => stripBlocks(s, blockList, m.states, always));
            this.partialDrawn = blocks.some(list => list.some(bi => bi.ds !== undefined && bi.cover < PARTIAL_BELOW));
        }
        if (style === "blocks") {
            if (showTotals) {
                // item 2: a block adds the share of its period the data covers (a full period 1, the
                // period of the first event or of As of less); one decimal for the whole column
                // when any value is not whole.
                const sums = blocks.map(list => {
                    let n = 0;
                    for (const { ds, cover } of list) {
                        if (ds === undefined || ds === null) continue;
                        if (resting && m.states.indexOf(ds) === 0) continue;
                        n += cover;
                    }
                    return n;
                });
                const whole = sums.every(v => Math.abs(v - Math.round(v)) < 1e-9);
                const one = (v: number) => (v > 0 && Math.round(v * 10) === 0 ? "<" + formatModelNumber(0.1, "0.0", this.locale)
                    : formatModelNumber(Math.round(v * 10) / 10, "0.0", this.locale));
                const values = sums.map(v => this.t("Count_" + grain, whole ? this.n(Math.round(v)) : one(v)));
                const plural = this.t("GrainPlural_" + grain);
                const head = resting && m.states.length > 0 ? this.t("A_Header", plural, m.states[0]) : this.t("A_HeaderAll", plural);
                // The header spans the strip and the column; when even that is too narrow the short
                // form ("Active weeks", the drawn label) is used, never a cut-off header.
                const shortHead = resting ? this.t("A_HeaderShort", plural.toLocaleLowerCase(this.locale)) : head;
                cols.push({ key: "blocks", header: head, shortHeader: shortHead, width: Math.ceil(widest(values, fs, 700)), cls: "st-num", values });
            }
        } else if (style === "runs" && showTotals) {
            // M4: ONE unit for the whole table (stated once, in the subtitle), numbers only, one
            // decimal when whole units would print two different totals alike.
            const perState = m.states.map(s => strips.map(x => x.totals.get(s) || 0));
            const dec = tableDecimals(([] as number[]).concat(...perState), unit);
            const fmt = (v: number) => formatTableValue(v, unit, dec, this.locale);
            // review 2 drawn-look ruling: whatever columns fit, every total stays keyboard reachable
            runsTotals = strips.map((x, i) => this.t("Aria_Totals", this.unitPlural(unit).toLocaleLowerCase(this.locale), m.states.map((s, k) => `${s} ${fmt(perState[k][i])}`).join(this.t("List_Separator"))));
            const stateCols: Col[] = m.states.map((s, k) => {
                const values = perState[k].map(fmt);
                const w = Math.max(widest(values, fs, 700), headW(s));
                return { key: "state:" + s, header: s, width: Math.ceil(w), cls: "st-num", values };
            });
            const need = stateCols.reduce((a, c2) => a + c2.width + gap, 0);
            const labelGuess = Math.min(widest(strips.map(s => s.label), fs), contentW * 0.3);
            // Not every state column fits: one "Most time in" column (state + total); every
            // state's total stays in the strip tooltip. (fix round 10: both are candidates, see the fit)
            const mostCol = (): Col => {
                const parts: Array<[string, string]> = strips.map(s => {
                    let best: string | null = null; let bt = -1;
                    for (const [k, v] of s.totals) if (v > bt || (v === bt && m.states.indexOf(k) > m.states.indexOf(best))) { best = k; bt = v; }
                    return best === null ? ["", ""] : [best, fmt(bt)];
                });
                const values = parts.map(([a, b2]) => (a ? `${a} ${b2}` : ""));
                const head = this.t("B_MostTime");
                const durW = widest(parts.map(p2 => p2[1]), fs, 700);
                const full = widest(parts.map(p2 => p2[0]), fs, 600) + 5 + durW;
                const w = Math.min(full, Math.max(70, contentW * 0.34));
                return { key: "most", header: head, width: Math.ceil(w), min: Math.ceil(durW + 5 + Math.min(24, full - durW)), cls: "st-mostcol", values, title: values, parts };
            };
            if (contentW - labelGuess - need >= Math.max(80, contentW * 0.35)) { cols.push(...stateCols); runsAlt = [mostCol()]; }
            else cols.push(mostCol());
        } else if (style === "board") {
            const boardNow = strips.map(s => this.stateLabel(currentRun(s).state));
            const forVals = strips.map(s => { const r = currentRun(s); return r.end - r.start; });
            const forUnit = this.unitFor(forVals);
            const forText = forVals.map(v => this.runDur(v, forUnit));
            const sinceText = strips.map(s => this.sinceText(currentRun(s).start));
            const nowW = Math.min(widest(boardNow, fs, 700) + 18, Math.max(64, contentW * 0.28));
            const nowHead = headW(this.t("C_Now"));
            cols.push({ key: "now", header: this.t("C_Now"), width: Math.ceil(Math.max(nowW, nowHead)), min: Math.ceil(Math.max(nowHead, 40)), cls: "st-now", values: boardNow, title: boardNow });
            if (showTotals) {
                cols.push({ key: "for", header: this.t("C_For"), width: Math.ceil(Math.max(widest(forText, fs, 700), headW(this.t("C_For")))), cls: "st-num", values: forText });
                cols.push({ key: "since", header: this.t("C_Since"), width: Math.ceil(Math.max(widest(sinceText, fs), headW(this.t("C_Since")))), cls: "st-num st-dim", values: sinceText });
            }
        }

        // ---- fit: the board drops SINCE then FOR, a name column shrinks to its minimum ----
        let minStrip = style === "board" ? 40 : 60;
        const minLabel = 28;
        // The fit keeps room for the rows host's scrollbar, which is known only after layout.
        const fitW = contentW - this.scrollbarWidth();
        // Fix round 10 (R2): the optional columns are candidates, richest first (the board drops
        // SINCE then FOR then NOW; Runs the state columns, then "Most time in"), each fitted as
        // before: a name column shrinks to its minimum; a totals column that still does not fit
        // goes (every total stays in the strip's tooltip); the board's strip gives up its minimum
        // (fix round 6: the visual never scrolls sideways). Which candidate is drawn is decided
        // once the rows' mode is known (below): the richest whose axis and headings equal those
        // of the chart without columns.
        type Fitted = { cs: Col[]; ms: number };
        const fitCols = (list: Col[]): Fitted | null => {
            const cs = list.map(c2 => Object.assign({}, c2));
            let ms = minStrip;
            const need = () => minLabel + gap + ms + cs.reduce((a, c2) => a + c2.width + gap, 0);
            for (const c2 of cs) if (c2.min !== undefined && need() > fitW) c2.width = Math.max(c2.min, c2.width - (need() - fitW));
            if (need() > fitW && style !== "board" && cs.length > 0) return null;
            if (need() > fitW) ms = Math.max(8, ms - (need() - fitW));
            return need() <= fitW || cs.length === 0 ? { cs, ms } : null;
        };
        const cands: Col[][] = [];
        if (style === "board") for (let k = cols.length; k >= 1; k--) cands.push(cols.slice(0, k));
        else if (cols.length > 0) { cands.push(cols.slice()); if (runsAlt) cands.push(runsAlt); }
        // each set at its natural widths, then with every shrinkable column at its minimum (a column
        // that grows with the card must not cost the axis a label it would show without it)
        const fitted = ([] as Array<Fitted | null>).concat(...cands.map(list => [fitCols(list),
            list.some(c2 => c2.min !== undefined && c2.min < c2.width) ? fitCols(list.map(c2 => (c2.min !== undefined ? Object.assign({}, c2, { width: Math.min(c2.width, c2.min) }) : c2))) : null]))
            .filter((f): f is Fitted => f !== null);
        const bare = fitCols([]) as Fitted;
        cols.length = 0;
        let colsW = 0;
        const lf = this.settings.labels.font;
        const labelWeight = lf.bold.value ? 700 : 500;            // review 2 finding 8: Bold works
        const labelNeed = Math.ceil(widest(strips.map(s => s.label), fs, labelWeight)) + 2;
        let labelW = 0;      // set once the rows host's gutter is known (below)
        const drawn = this.drawnStates(style, blocks);
        const legendItems = this.legendItems(style, drawn);

        // ---- skeleton: subtitle, header row, rows host, axis, legend + summary + notes ----
        // EVERY part takes its final height before the rows host is measured (H1: the board's
        // summary line used to arrive after the measurement and push the last row out of view).
        const grid = (cells: HTMLElement[], stripW: number, cls: string) => {
            const row = document.createElement("div");
            row.className = cls;
            row.style.gridTemplateColumns = [labelW, stripW, ...cols.map(c2 => c2.width)].map(w => `${w}px`).join(" ");
            row.style.columnGap = `${gap}px`;
            cells.forEach(cel => row.appendChild(cel));
            return row;
        };
        const cell = (cls: string, text = "") => { const e = document.createElement("div"); e.className = cls; if (text) e.textContent = text; return e; };

        if (showSub) {
            const subText = style === "blocks" ? this.t("Sub_Blocks", this.periodText(), this.grainWord(grain))
                : style === "runs" ? (showTotals ? this.t("Sub_Runs", this.unitPlural(unit), this.periodText()) : this.t("Sub_RunsPeriod", this.periodText()))
                    : this.t("Sub_Board", formatWhen(m.asOf, this.locale), this.grainWord(grain));
            // narrow: the short form (no period), then an ellipsis with the full text in the title
            const shortText = style === "blocks" ? this.t("Sub_BlocksShort", this.grainWord(grain))
                : style === "runs" ? (showTotals ? this.t("Sub_RunsShort", this.unitPlural(unit)) : this.periodText())
                    : this.t("Sub_BoardShort", formatShortDate(m.asOf, this.locale));
            const subFs = fs * 0.8;
            const fitsSub = (txt: string) => this.measure(header(txt), subFs, 600) * 1.08 + 2 <= contentW;
            const shown = fitsSub(subText) ? subText : shortText;
            const sub = cell("st-subtitle", header(shown));
            sub.title = header(subText);
            content.appendChild(sub);
        }
        const headH = Math.ceil(headFs * 1.6);
        const axisH = Math.ceil(fs * 1.5);
        const headRow = document.createElement("div");
        headRow.style.height = `${headH}px`;
        headRow.style.flex = "0 0 auto";
        content.appendChild(headRow);
        const host = document.createElement("div");
        host.className = "st-rows";
        // review 5 finding 2: a list of selectable rows is a listbox of options, the roles on which
        // aria-selected is a supported state (on a listitem the selection never reaches the
        // accessibility tree)
        host.setAttribute("role", "listbox");
        host.setAttribute("aria-multiselectable", "true");
        host.setAttribute("aria-label", this.t("Aria_Chart", this.t(style === "blocks" ? "Style_Blocks" : style === "runs" ? "Style_Runs" : "Style_Board"), this.n(strips.length))
            + (noAxis ? ". " + this.periodText() : ""));     // fix round 7: an axis with no label that fits leaves its range here
        content.appendChild(host);
        const axisRow = document.createElement("div");
        axisRow.style.height = `${axisH}px`;
        axisRow.style.flex = "0 0 auto";
        content.appendChild(axisRow);
        const foot = document.createElement("div");
        foot.className = "st-foot";
        content.appendChild(foot);
        if (style === "board") {
            // Board footnote: the latest state count, first line of the foot
            const counts = new Map<string | null, number>();
            strips.forEach(s => { const k = currentRun(s).state; counts.set(k, (counts.get(k) || 0) + 1); });
            let best: string | null = null; let bn = -1;
            for (const [k, v] of counts) if (v > bn || (v === bn && m.states.indexOf(k) > m.states.indexOf(best))) { best = k; bn = v; }
            foot.appendChild(cell("st-summary", this.t("C_Summary", this.n(bn), this.n(strips.length), this.stateLabel(best))));
        }
        this.renderLegend(foot, legendItems, style, strips);
        this.renderNotes(foot);

        // ---- rows: ONE scroll container (M6), every row reachable (H1), pitch capped (L3) ----
        //  fit:  all rows fit at >= the minimum pitch: they share the height up to 3.4x the font
        //        size; the chart then keeps its natural height and sits at the top.
        //  rows: they do not fit, the rest of the chart fits and the rows host can show 2 rows:
        //        the rows host scrolls (its gutter reserved, so no column sits under it: H2).
        //  root: otherwise the rows take their natural height and the visual (root) scrolls.
        const n = Math.max(1, strips.length);
        const minPitch = Math.ceil(fs * 1.9);
        const maxPitch = Math.ceil(fs * 3.4);
        // Fix round 6, owner addition: the visual never scrolls as a whole (Power BI Desktop draws
        // a classic scrollbar for it). Fix round 10 (R2, as ruled for this round): the time axis
        // and then the heading row are part of the chart: each shows where all rows fit with it or
        // at least 2 whole rows show with it (a monotone threshold: both are shorter than one row
        // pitch, so the row they take at the threshold is never a row that was showing). The
        // furniture - subtitle, legend, summary, notes, then the title - shows only where it costs
        // nothing: the same whole rows with it as without (and no overflow). If even the bare chart
        // shows fewer than 2 rows, the rows host takes what is left and scrolls (H1).
        // fix round 11 (S5): the root never scrolls, so no scrollbar reports a sideways overflow any
        // more (a horizontal scrollbar used to take height and make the column test fail): it is
        // tested directly (the Runs changes count, nowrap, 169 px wide in a 90..168 px card)
        const over = () => this.root.scrollHeight > this.root.clientHeight + 0.5 || this.root.scrollWidth > this.root.clientWidth + 0.5;
        const whole = () => { const h = host.clientHeight; return n * minPitch <= h ? n : Math.floor(h / minPitch); };
        const chartOk = () => !over() && (n * minPitch <= host.clientHeight || host.clientHeight >= 2 * minPitch);
        let hideHead = false, hideAxis = false;
        const show = (e: Element | null, on: boolean) => { if (e) (e as HTMLElement).style.display = on ? "" : "none"; };
        const furniture: Array<[Element | null, boolean]> = [
            [content.querySelector(".st-subtitle"), false],
            [foot.querySelector(".st-legend"), true],
            [foot.querySelector(".st-summary"), true],
            [foot.querySelector(".st-notes"), true],
            [content.querySelector(".st-title"), false],
        ];
        for (const [e] of furniture) show(e, false);
        show(foot, false);
        show(headRow, false);
        // Fix round 10, ruling F: totals are data. On Runs and Blocks the heading row names the
        // totals columns, so it is reserved by the same monotone threshold as the axis (all rows
        // fit, or at least 2 whole rows show, with it) and BEFORE the axis, whether or not a column
        // set is admitted at this width: a column set arriving on a wider card then costs no
        // height, and a taller card never loses the row the columns need. (Rank never falls.)
        const sbMax = this.scrollbarWidth();
        const yearIn = (p: AxisPlan | null) => !!p && p.labels.some(l => /\b(1[89]\d\d|2\d\d\d)\b/.test(l.s));
        // the strip a set leaves and its label lead; the axis plan on it is asked for only where the
        // share and grain tests pass (Runs and the Board), so a rejected set costs no plan
        const stripAt = (f: Fitted) => {
            const cw = f.cs.reduce((a, c2) => a + c2.width + gap, 0);
            let lw = Math.min(labelNeed, Math.max(40, Math.floor(contentW * 0.3)));
            lw = Math.max(28, Math.min(lw, contentW - sbMax - cw - gap - f.ms));
            return { sw: Math.max(f.ms, Math.floor(contentW - sbMax - lw - cw - gap)), lead: lw + gap };
        };
        // the requirement is fixed by the data, never by this width (measured: a requirement taken
        // from the bare chart's axis at this width rises as the card widens and flips a column set
        // off; the plan's start and end labels are not monotone in the strip width either, so
        // they are not part of it): min(3, the labels a very wide strip shows) (Board 2), and a
        // year where a very wide strip prints one
        let req: { need: number; year: boolean } | null = null;
        const requirement = () => {
            if (!req) { const roomy = this.axisPlan(style, 4096, fs, span, blockList, grain, 0); req = { need: Math.min(style === "board" ? 2 : 3, roomy ? roomy.labels.length : 0), year: yearIn(roomy) }; }
            return req;
        };
        const admit = (f: Fitted) => {
            const est = fitW - Math.min(labelNeed, Math.max(40, fitW * 0.3)) - f.cs.reduce((a, c2) => a + (c2.min !== undefined ? Math.min(c2.min, c2.width) : c2.width) + gap, 0) - gap;
            if (est < (style === "blocks" ? COL_STRIP_SHARE_BLOCKS : style === "board" ? COL_STRIP_SHARE_BOARD : COL_STRIP_SHARE) * fitW) return false;
            const { sw, lead } = stripAt(f);
            if (style !== "runs" && grain !== "year" && blockList.length > 1 && sw / blockList.length < MIN_BLOCK_PX) return false;
            // Blocks: one narrow count column; measured, an axis requirement there withheld the
            // column that 54aff7d drew at 245x309 and 360x400 (big fonts), so Blocks keeps (1)-(2)
            if (style === "blocks") return true;
            const { need, year } = requirement();
            if (need === 0) return true;
            const plan = this.axisPlan(style, sw, fs, span, blockList, grain, lead);
            if (!plan || plan.labels.length < need) return false;
            return !year || yearIn(plan);
        };
        // Fix round 11, ruling J (the coordinator's, for owner review; round 10's ruling H): a heading
        // row with nothing in it is room taken from the rows for no reading. Column admission rests
        // on the width alone (above), so the set this width admits is known before any height is
        // spent: where none is admitted, no heading row is reserved.
        const pick = cands.length > 0 ? (fitted.find(admit) || null) : null;
        const headFirst = style !== "board" && pick !== null;
        if (headFirst) {
            show(headRow, true);
            if (!chartOk()) { hideHead = true; show(headRow, false); }
        }
        // fix round 7, finding 2: an axis with no tick label that fits reserves no row
        if (noAxis) { hideAxis = true; show(axisRow, false); }
        else if (!chartOk()) { hideAxis = true; show(axisRow, false); }
        // The Board's year heading is P3 (the threshold, after the axis)
        if (style === "board") {
            show(headRow, true);
            if (!chartOk()) { hideHead = true; show(headRow, false); }
        } else if (!headFirst) hideHead = true;
        // the longest prefix of that order that costs nothing (never a greedy pass: an item skipped
        // here and admitted on a larger card would push out one admitted after it)
        // (a chart that shows no whole row, or overflows bare, takes no furniture at all; the rows
        // host's CSS minimum is dropped first, so an item is measured against the real room)
        host.style.minHeight = "0";
        const admitted: Array<[Element, boolean]> = [];
        // Fix round 10, ruling G (the coordinator's, for owner review): rows are data, the title is
        // chrome. Which case applies is judged on the layout without the title or furniture (the
        // axis and heading rows as admitted above):
        //  - the rows scroll even so: the title is placed next, before the furniture, by the rule-B
        //    threshold: wherever at least 2 whole rows show with it (so it never displaces an
        //    admitted axis or heading row, which rank over it, and never arrives at a step where it
        //    costs a row: measured, a title shown down to 1 row went off where the axis arrived and
        //    again where every row fit, 2 on-to-off steps on 63 quick-gate ladders); where it cannot show, no furniture
        //    shows either (furniture in the slack below the title's own threshold would be pushed
        //    out at the step where the title arrives: measured, 48 subtitle falls on shard 0).
        //  - every row fits whole: the title stays last (below) and shows only where every row
        //    still fits with it; else it gives way, its text in the card's accessible name.
        const titleEl = content.querySelector<HTMLElement>(".st-title");
        const scrolling = whole() < n;
        const titleFirst = !!titleEl && scrolling;
        // (ruling G, scrolling rows: the title, judged after the axis and heading rows and before the
        // furniture, shows where it fits and keeps every axis or heading row admitted above on at
        // least 2 whole rows; it is popped last of all). Where it cannot show, no furniture shows
        // either: furniture admitted in the slack below the title's own threshold would be pushed
        // out at the step where the title arrives (measured: the subtitle, 375 px wide, 7 rows)
        let furnitureOk = true;
        if (titleFirst) {
            show(titleEl, true);
            if (over() || whole() < 2 || !chartOk()) { show(titleEl, false); furnitureOk = false; }
            else admitted.push([titleEl, false]);
        }
        for (const [e, inFoot] of furniture) {
            if (!furnitureOk) break;
            if (!e) continue;
            if (e === titleEl && scrolling) break;
            const rows0 = whole();
            if (rows0 < 1 || over()) break;
            show(e, true);
            if (inFoot) show(foot, true);
            if (whole() !== rows0 || over()) {
                show(e, false);
                if (inFoot && !Array.from(foot.children).some(c => (c as HTMLElement).style.display !== "none")) show(foot, false);
                break;
            }
            admitted.push([e, inFoot]);
        }
        if (over()) host.style.minHeight = "0";
        const hostH = Math.max(0, host.clientHeight);
        let pitch = minPitch;
        let mode: "fit" | "rows" | "root";
        if (n * minPitch <= hostH) { mode = "fit"; pitch = Math.min(maxPitch, Math.max(minPitch, Math.floor(hostH / n))); }
        else mode = "rows";
        if (mode === "rows") host.classList.add("st-scrolls");
        else { host.style.flex = "0 0 auto"; host.style.minHeight = "0"; host.style.height = `${n * pitch}px`; }
        // fix round 8: clientHeight rounds a fractional host height up, so a pitch from it can
        // overflow the root by that fraction (the 300x263 Board, padding 32, 40 px labels): only
        // then the pitch steps down, never below the minimum; a chart that fits is unchanged
        while (mode === "fit" && pitch > minPitch && over()) { pitch--; host.style.height = `${n * pitch}px`; }
        // the final row height can still leave the root over by a fraction: the furniture admitted
        // last goes first (it never costs a row and never causes a scrollbar)
        while (over() && admitted.length > 0) {
            const [e, inFoot] = admitted.pop() as [Element, boolean];
            show(e, false);
            if (e === headRow) hideHead = true;
            if (inFoot && !Array.from(foot.children).some(c => (c as HTMLElement).style.display !== "none")) show(foot, false);
        }
        // fix round 11 (S5): furniture that gave way above leaves its room to the rows (the title
        // admitted at the minimum pitch and popped for a fraction left 23 px below one row at
        // 300 x 261..278): the pitch grows back while one pixel more still fits
        if (mode === "fit" && n > 0) {
            while (pitch < maxPitch) {
                host.style.height = `${n * (pitch + 1)}px`;
                if (over()) { host.style.height = `${n * pitch}px`; break; }
                pitch++;
            }
        }
        // ruling G: a title that gave way keeps its full text in the card's accessible name
        if (titleEl && titleEl.style.display === "none") { content.setAttribute("role", "group"); content.setAttribute("aria-label", titleEl.textContent || ""); }
        else { content.removeAttribute("role"); content.removeAttribute("aria-label"); }
        // Fix round 10 (R5): scrolling rows rest on whole rows. The rows viewport is a whole number
        // of row pitches (the remainder falls below the chart, as in fit mode) and a scroll that
        // has settled (80 ms without a scroll event) is rounded to a whole row, so a resting
        // position reached by wheel, keys or End shows no part row at the top or the bottom.
        // Not CSS scroll-snap: measured, a one-row viewport let a snap area as tall as the snapport
        // rest anywhere inside it (90 x 48: wheel rests at 100 and 40 over 23 px rows)
        if (mode === "rows") {
            // the fractional box, not clientHeight: clientHeight rounds 35.5 up to 36, which took
            // 2 rows of 18 px into 35.5 px and pushed .st-root 1 px into scrolling (runs 90 x 120)
            const k = Math.floor(Math.min(host.clientHeight, host.getBoundingClientRect().height) / pitch);
            if (k >= 1) { host.style.flex = "0 0 auto"; host.style.minHeight = "0"; host.style.height = `${k * pitch}px`; }
            let settle = 0;
            const rowPitch = pitch;
            host.addEventListener("scroll", () => {
                window.clearTimeout(settle);
                settle = window.setTimeout(() => {
                    const to = Math.round(host.scrollTop / rowPitch) * rowPitch;
                    if (Math.abs(to - host.scrollTop) > 0.5) host.scrollTop = to;
                }, 80);
            }, { passive: true });
        }
        host.setAttribute("data-mode", mode);
        const sb = mode === "rows" ? this.scrollbarWidth() : 0;
        const widths = (f: Fitted) => {
            const cw = f.cs.reduce((a, c2) => a + c2.width + gap, 0);
            let lw = Math.min(labelNeed, Math.max(40, Math.floor(contentW * 0.3)));
            lw = Math.max(28, Math.min(lw, contentW - sb - cw - gap - f.ms));
            return { cw, lw, sw: Math.max(f.ms, Math.floor(contentW - sb - lw - cw - gap)) };
        };
        // Fix round 10, ruling F: a column set is admitted on quantities that only grow with the
        // card's WIDTH (never by comparing the axis with and without it, which flips as the card
        // widens), so the column-set rank (none < "Most time in" < the state columns; on the Board
        // the number of columns) never falls on a larger card:
        //  (1) the set fits (fitCols);
        //  (2) the strip it leaves, estimated from width-monotone terms (the scrollbar gutter always
        //      reserved, the label column at its uncapped share, each column at its minimum), is at
        //      least COL_STRIP_SHARE of the width;
        //  (3) the axis, planned on that set's strip (gutter reserved, so the plan does not depend on
        //      the height), keeps the start label, the end label and a year where the bare chart's
        //      axis has them, at least min(3, bare count) labels (Board 2), and the blocks' grain.
        // The richest admitted set is drawn; the axis is then planned on the strip that remains.
        const chosen = (style !== "board" && hideHead ? null : pick) || bare;
        cols.push(...chosen.cs);
        minStrip = chosen.ms;
        colsW = widths(chosen).cw;
        labelW = widths(chosen).lw;
        const stripW = widths(chosen).sw;
        if (style !== "runs" && grain !== "year" && blockList.length > 1 && stripW / blockList.length < MIN_BLOCK_PX) {
            // item 1: the real strip is narrower than the estimate: draw again one grain coarser
            while (content.childNodes.length > keepNodes) content.removeChild(content.lastChild);
            this.rows = [];
            this.renderChart(content, style, strips, contentW, fs, GRAINS[GRAINS.indexOf(grain) + 1]);
            return;
        }

        // header
        const headCells: HTMLElement[] = [cell("st-head"), cell("st-head")];
        // review 5 finding 7: the Board year heading carries its full text like every other heading
        if (style === "board") {
            // review 6 finding 6: when the year does not fit over the strip it also takes the empty
            // label heading beside it (right-aligned against the strip); when even that room cannot
            // show 3 graphemes and the ellipsis it is dropped. The title keeps the full text.
            const ys = this.yearSpan();
            const yc = headCells[1];
            yc.title = ys;
            if (headW(ys) <= stripW) yc.textContent = header(ys);
            else {
                const room = labelW + gap + stripW;
                const three = Array.from(header(ys)).slice(0, 3).join("") + "\u2026";
                if (headW(ys) <= room || headW(three) <= room) yc.textContent = header(ys);
                yc.style.gridColumn = "1 / span 2";
                yc.style.textAlign = "right";
                headCells.splice(0, 1);
            }
        }
        if (style === "runs" && !showSub && cols.length > 0) { headCells[0].textContent = header(this.unitPlural(unit)); headCells[0].classList.add("st-head-num"); }
        if (cols.length === 1 && (cols[0].key === "blocks" || cols[0].key === "most")) {
            // one totals column: its header spans the strip too (the drawn "ACTIVE WEEKS" sits there)
            const c2 = cols[0];
            const room = stripW + gap + c2.width;
            // fix round 10 (R2, item c): the long wording is kept wherever the long arrangement fits:
            // over the strip and column, else spanning the empty label heading too; only then the
            // short form. review 7 finding 4: only a header whose measured text (without headW's
            // 2 px allowance) is wider than its room spans; review 6 (fix round 7) item 3: one cut
            // even in short form also takes the empty label heading (right-aligned on the column)
            const canSpan = !headCells[0].textContent;
            const wide = labelW + gap + room;
            let txt = c2.header;
            let span3 = false;
            if (headW(c2.header) > room) {
                if (canSpan && headW(c2.header) <= wide) span3 = true;
                else if (c2.shortHeader) txt = c2.shortHeader;
            }
            if (headW(txt) - HEAD_ALLOWANCE > room && canSpan) span3 = true;
            const h = cell("st-head st-head-num", header(txt));
            h.title = txt;
            h.style.gridColumn = span3 ? "1 / span 3" : "2 / span 2";
            headCells.length = span3 ? 0 : 1;
            headCells.push(h);
        } else cols.forEach(c2 => { const h = cell("st-head st-head-num", header(c2.header)); h.title = c2.header; if (c2.key === "now") h.classList.remove("st-head-num"); headCells.push(h); });
        const hr = grid(headCells, stripW, "st-grid st-headrow");
        hr.style.fontSize = `${headFs}px`;
        hr.style.height = `${headH}px`;
        // a shed header row or axis is left out of the DOM, not drawn hidden
        if (hideHead) content.removeChild(headRow); else content.replaceChild(hr, headRow);

        // rows
        const barH = Math.max(6, Math.round(Math.min(pitch * (style === "board" ? 0.42 : 0.6), fs * (style === "board" ? 1.3 : 2.2))));
        strips.forEach((s, i) => {
            const label = cell("st-label st-name", s.label);
            label.title = s.label;
            if (lf.bold.value) label.style.fontWeight = "700";
            if (lf.underline.value) label.style.textDecoration = "underline";
            if (s.isBlank) label.classList.add("st-dim");
            const svg = document.createElementNS(SVGNS, "svg") as SVGSVGElement;
            svg.setAttribute("class", "st-strip");
            svg.setAttribute("width", String(stripW));
            svg.setAttribute("height", String(pitch));
            const cells: HTMLElement[] = [label, svg as unknown as HTMLElement];
            cols.forEach(c2 => {
                if (c2.key === "now") {
                    const now = cell("st-now");
                    const sw = document.createElementNS(SVGNS, "svg");
                    sw.setAttribute("width", "12"); sw.setAttribute("height", "12"); sw.setAttribute("class", "st-swatch");
                    this.swatch(sw, this.styleOfState(currentRun(s).state), 12, 12);
                    now.appendChild(sw);
                    const nm = cell("st-name st-now-name", c2.values[i]);
                    nm.title = c2.values[i];
                    if (currentRun(s).state !== null && !(resting && m.states.indexOf(currentRun(s).state) === 0)) nm.classList.add("st-strong");
                    now.appendChild(nm);
                    cells.push(now);
                } else if (c2.parts) {
                    const v = cell("st-pair");
                    const nm = cell("st-name st-pair-name", c2.parts[i][0]);
                    nm.title = c2.parts[i][0];
                    v.appendChild(nm);
                    v.appendChild(cell("st-num", c2.parts[i][1]));
                    cells.push(v);
                } else {
                    const v = cell(c2.cls, c2.values[i]);
                    if (c2.title) v.title = c2.title[i];
                    cells.push(v);
                }
            });
            const row = grid(cells, stripW, "st-grid st-row");
            row.style.height = `${pitch}px`;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", "false");
            row.tabIndex = i === Math.min(this.focusRow, strips.length - 1) ? 0 : -1;
            const allStateCols = m.states.length > 0 && m.states.every(st => cols.some(c2 => c2.key === "state:" + st));
            row.setAttribute("aria-label", this.stripAria(s) + (runsTotals && !allStateCols ? ". " + runsTotals[i] : ""));
            host.appendChild(row);
            const ctx = this.drawStrip(style, s, svg, stripW, pitch, barH, span, blockList, blocks[i] || [], grain);
            ctx.el = row;
            this.rows.push(ctx);
            this.wireRow(ctx, label, i);
        });

        // axis
        const axisCells: HTMLElement[] = [cell("st-axis-spacer")];
        const axisSvg = document.createElementNS(SVGNS, "svg") as SVGSVGElement;
        axisSvg.setAttribute("class", "st-axis");
        axisSvg.setAttribute("width", String(stripW));
        axisSvg.setAttribute("height", String(axisH));
        axisCells.push(axisSvg as unknown as HTMLElement);
        cols.forEach(() => axisCells.push(cell("st-axis-spacer")));
        if (hideAxis) { content.removeChild(axisRow); return; }
        if (!this.drawAxis(axisSvg, style, stripW, axisH, fs, span, blockList, grain, labelW + gap)) {
            // fix round 7, finding 2: not one tick label fits: lay the chart out again without the
            // axis row, its height going to the rows (the range stays in the rows' aria-label)
            while (content.childNodes.length > keepNodes) content.removeChild(content.lastChild);
            this.rows = [];
            this.renderChart(content, style, strips, contentW, fs, floorGrain, true);
            return;
        }
        content.replaceChild(grid(axisCells, stripW, "st-grid st-axisrow"), axisRow);
        // fix round 9 (B): the Board's As of label, end-anchored at the strip's end, sits inside the
        // card: ink that passes the card's edge by more than the half pixel its clip tolerates (an
        // 8 px "Sep 30" at padding 0) moves left by the whole overhang
        // Fix round 10: every look and every label the same: the Runs As of label (0.5 px past the
        // card at padding 0), a lone start label wider than its measure ("Feb 2025" 0.7 px past a
        // 90 px card) and the last Blocks bucket name ("Q1 2026" 0.8 px past a 321 px card)
        // and the same inside the axis itself: an end-anchored label's glyph passes its advance (the
        // 8 px Runs "Jun 14" 0.54 px past its axis once the most-labels size could reach 8 px)
        const rootRight = Math.min(this.root.getBoundingClientRect().right, axisSvg.getBoundingClientRect().right);
        // fix round 11 (S2): every label measured first, then moved: a move between two reads made the
        // next read lay the page out again
        const ticks = Array.from(axisSvg.querySelectorAll(".st-tick"));
        const overs = ticks.map(t => t.getBoundingClientRect().right - rootRight);
        ticks.forEach((t, i) => {
            if (overs[i] > 0.5) t.setAttribute("x", (Math.floor((Number(t.getAttribute("x")) - overs[i]) * 10) / 10).toFixed(1));
        });
    }

    /** The width a classic scrollbar takes here (0 with overlay scrollbars). */
    private scrollbarWidth(): number {
        if (this.scrollbar >= 0) return this.scrollbar;
        const d = document.createElement("div");
        d.style.cssText = "position:absolute;visibility:hidden;width:60px;height:60px;overflow:scroll;";
        this.root.appendChild(d);
        this.scrollbar = Math.max(0, d.offsetWidth - d.clientWidth);
        this.root.removeChild(d);
        return this.scrollbar;
    }

    private yearSpan(): string {
        const m = this.model;
        const a = new Date(m.start).getUTCFullYear(), b = new Date(m.asOf).getUTCFullYear();
        return a === b ? String(a) : `${a}–${b}`;
    }

    private sinceText(t: number): string {
        const m = this.model;
        if (m.asOf - m.start <= 3 * 86400000) return formatWhen(t, this.locale);
        const sameYear = new Date(t).getUTCFullYear() === new Date(m.asOf).getUTCFullYear();
        return sameYear ? formatShortDate(t, this.locale) : formatWhen(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()), this.locale);
    }

    private stripAria(s: Strip): string {
        const r = currentRun(s);
        // item 6: "now Idle, just started" for a zero-length current run, never "for just started"
        if (r.end - r.start === 0) return this.t("Aria_StripJustStarted", s.label, this.stateLabel(r.state), this.changesText(s.changes));
        return this.t("Aria_Strip", s.label, this.stateLabel(r.state), this.runDur(r.end - r.start), this.changesText(s.changes));
    }

    /** "1 state change", "0 state changes", "3 state changes" (review 3 item 6). */
    private changesText(n: number): string {
        return n === 1 ? this.t("Changes_One", this.n(n)) : this.t("Changes_Other", this.n(n));
    }

    private swatch(svg: Element, s: StateStyle, w: number, h: number): void {
        const f = this.fillOf(s);
        const r = document.createElementNS(SVGNS, "rect");
        r.setAttribute("x", "0.5"); r.setAttribute("y", "0.5"); r.setAttribute("width", String(w - 1)); r.setAttribute("height", String(h - 1)); r.setAttribute("rx", "2");
        r.setAttribute("fill", f.fill);
        const edge = f.stroke ? null : this.edgeOf(s);
        if (f.stroke || edge) { r.setAttribute("stroke", f.stroke || edge); r.setAttribute("stroke-width", "1"); }
        if (f.dash) r.setAttribute("stroke-dasharray", f.dash);
        svg.appendChild(r);
    }

    /** The tooltip of blocks j..k of a strip (one block, or one keyboard stop's run of equal
     *  blocks): the period, the dominant state, its time there, and an Always-show marker. */
    private blockTip(s: Strip, blockList: Array<[number, number]>, info: BlockInfo[], j: number, k: number): VisualTooltipDataItem[] {
        const m = this.model;
        const ds = info[j].ds;
        const b0 = blockList[j][0], b1 = blockList[k][1];
        const inRange = (state: string | null) => s.runs.reduce((a, r) => a + (r.state === state ? Math.max(0, Math.min(r.end, b1) - Math.max(r.start, b0)) : 0), 0);
        const t = inRange(ds);
        // item 2: the period shown is the COVERED range: from the strip's first event at the
        // earliest, to As of at the latest
        const items: VisualTooltipDataItem[] = [
            { displayName: this.t("Tip_Period"), value: `${formatWhen(Math.max(b0, s.first), this.locale)} – ${formatWhen(Math.min(b1, m.asOf), this.locale)}` },
            { displayName: this.t("Tip_MostTime"), value: this.stateLabel(ds) },
            { displayName: this.t("Tip_TimeInPeriod"), value: this.dur(t, this.unitFor([t])) },
        ];
        if (j === k && info[j].mark) items.push({ displayName: this.t("Tip_AlsoShown"), value: `${info[j].mark} · ${this.dur(info[j].markMs, this.unitFor([info[j].markMs]))}` });
        return items;
    }

    /** Draws one strip as ONE path per state (so 30,000 events stay a few hundred elements) and
     *  returns the hit-test used by hover, click, context menu and the keyboard. */
    private drawStrip(style: Style, s: Strip, svg: SVGSVGElement, w: number, h: number, barH: number, span: number,
        blockList: Array<[number, number]>, info: BlockInfo[], grain: TimeGrain): RowCtx {
        const m = this.model;
        const x = (t: number) => ((t - m.start) / span) * w;
        const cy = h / 2;
        const parts = new Map<string, string[]>();
        const styleFor = new Map<string, StateStyle>();
        const edgeParts = new Map<string, string[]>();
        const rect = (x0: number, y0: number, ww: number, hh: number) => `M${x0.toFixed(2)} ${y0.toFixed(2)}h${ww.toFixed(2)}v${hh.toFixed(2)}h${(-ww).toFixed(2)}Z`;
        // R4: each mark's edge lies INSIDE its own box (inset half a pixel, 1 px wide), so two
        // neighbours of different status show two edges with their own fills between them, never
        // one outline round both; see EDGE_FULL_PX for small marks
        const add = (key: string, st: StateStyle, x0: number, y0: number, ww: number, hh: number) => {
            let a = parts.get(key); if (!a) { parts.set(key, a = []); styleFor.set(key, st); }
            a.push(rect(x0, y0, ww, hh));
            if (!this.edgeOf(st) || hh < EDGE_FULL_PX) return;
            let e = edgeParts.get(key); if (!e) edgeParts.set(key, e = []);
            if (ww >= EDGE_FULL_PX) e.push(rect(x0 + 0.5, y0 + 0.5, ww - 1, hh - 1));
            else e.push(`M${x0.toFixed(2)} ${(y0 + 0.5).toFixed(2)}h${ww.toFixed(2)}M${x0.toFixed(2)} ${(y0 + hh - 0.5).toFixed(2)}h${ww.toFixed(2)}`);
        };
        const keyOf = (state: string | null) => (state === null ? "\u0000" : "v" + state);
        const marks: RowCtx["marks"] = [];
        let hit: RowCtx["hit"];
        void grain;

        if (style !== "runs") {
            // Block strips (A) and the board's history strip (C): one block per period.
            const n = blockList.length;
            const bw = w / Math.max(1, n);
            const g = bw > 5 ? 1.5 : bw > 2.5 ? 0.6 : 0;
            const doms = info.map(b => b.ds);
            const stripeH = Math.max(2, Math.round(barH / 3));
            const minPartH = Math.max(2, Math.round(barH / 3));
            doms.forEach((ds, j) => {
                if (ds === undefined) return;
                // item 2: a partial period (the data covers only part of it) is as tall as the share
                // covered, at least a third of a block, standing on the same baseline
                const cover = info[j].cover;
                const hh = cover < PARTIAL_BELOW ? Math.min(barH, Math.max(minPartH, Math.round(barH * cover))) : barH;
                const top = cy + barH / 2 - hh;
                add(keyOf(ds), this.styleOfState(ds), j * bw, top, Math.max(0.5, bw - g), hh);
                // M1 Always show: the top third of the block (at least 2 px) is the marked state
                const mk = info[j].mark;
                if (mk) add("m" + mk, this.styleOfState(mk), j * bw, top, Math.max(0.5, bw - g), Math.min(stripeH, hh));
            });
            // keyboard: one stop per run of equal blocks; the stop's tooltip, aria and Enter all
            // use THIS run of blocks (H4), never a pixel hit test
            let j = 0;
            let rp = 0;      // runs before this stop's first bucket are never needed again (item 1)
            while (j < n) {
                if (doms[j] === undefined) { j++; continue; }
                let k = j;
                while (k + 1 < n && doms[k + 1] === doms[j]) k++;
                const ds = doms[j];
                while (rp < s.runs.length && s.runs[rp].end <= blockList[j][0]) rp++;
                let run = s.runs[0];
                for (let q = rp; q < s.runs.length && s.runs[q].start < blockList[k][1]; q++) if (s.runs[q].state === ds && s.runs[q].end > blockList[j][0]) { run = s.runs[q]; break; }
                const j0 = j, k0 = k;
                marks.push({ x: j * bw, w: (k - j + 1) * bw - g, run, tip: () => this.blockTip(s, blockList, info, j0, k0) });
                j = k + 1;
            }
            hit = (px: number) => {
                const j2 = Math.floor(px / bw);
                if (j2 < 0 || j2 >= n || doms[j2] === undefined) return null;
                const [b0, b1] = blockList[j2];
                const ds = doms[j2];
                // L7: the block's identity is its dominant state, the state its tooltip names
                const run = s.runs.find(r => r.state === ds && r.end > b0 && r.start < b1) || null;
                return { run, label: this.t("Tip_Period"), extra: this.blockTip(s, blockList, info, j2, j2) };
            };
        } else {
            const n = Math.max(1, this.styles.length - 1);
            {
                // the resting line runs the strip's whole history (B)
                const line = document.createElementNS(SVGNS, "rect");
                line.setAttribute("x", x(s.first).toFixed(2)); line.setAttribute("y", (cy - 1).toFixed(2));
                line.setAttribute("width", Math.max(0, w - x(s.first)).toFixed(2)); line.setAttribute("height", "2");
                line.setAttribute("fill", this.colours.hc ? this.colours.text : this.colours.track);
                line.setAttribute("class", "st-baseline");
                svg.appendChild(line);
            }
            for (const r of s.runs) {
                const x0 = x(r.start), x1 = x(r.end);
                const ww = x1 - x0;
                const stl = this.styleOfState(r.state);
                // review 4 finding 5: EVERY run is a keyboard stop, in time order: a resting run
                // is drawn as the line and a zero-length run draws nothing, but both keep a stop
                if (!(ww > 0) || stl.kind === "track") { marks.push({ x: x0, w: Math.max(1, ww), run: r }); continue; }
                const hh = stl.kind === "unknown" ? Math.max(4, barH * 0.35) : Math.max(4, barH * (0.35 + 0.65 * Math.min(1, stl.level / n)));
                const gp = ww > 3 ? 1 : 0;
                add(keyOf(r.state), stl, x0, cy - hh / 2, Math.max(0.4, ww - gp), hh);
                marks.push({ x: x0, w: Math.max(1, ww - gp), run: r });
            }
            hit = (px: number) => {
                const t = m.start + (px / w) * span;
                const run = runAt(s, t);
                return run ? { run } : null;
            };
        }
        const paths = new Map<string, SVGPathElement>();
        const edges = new Map<string, SVGPathElement>();
        // paint order: lowest level first so stronger states sit on top of hairline neighbours
        // (Always-show markers, keys "m...", paint last: they sit on top of their block)
        const rankKey = (k: string) => (k[0] === "m" ? 1000 : 0) + styleFor.get(k).level;
        const keys = Array.from(parts.keys()).sort((a, b) => rankKey(a) - rankKey(b));
        for (const key of keys) {
            const stl = styleFor.get(key);
            const f = this.fillOf(stl);
            const p = document.createElementNS(SVGNS, "path") as SVGPathElement;
            p.setAttribute("d", parts.get(key).join(""));
            p.setAttribute("fill", f.fill);
            if (f.stroke) { p.setAttribute("stroke", f.stroke); p.setAttribute("stroke-width", "1"); }
            if (f.dash) p.setAttribute("stroke-dasharray", f.dash);
            p.setAttribute("class", "st-mark");
            p.setAttribute("data-key", key === "\u0000" ? "none" : key);     // "v<state>" a state, "m<state>" an Always-show marker
            if (stl.kind === "accent" && this.colours.glow !== "none") p.style.filter = this.colours.glow;
            svg.appendChild(p);
            paths.set(key, p);
            const ed = edgeParts.get(key);
            if (ed) {
                const ep = document.createElementNS(SVGNS, "path") as SVGPathElement;
                ep.setAttribute("d", ed.join(""));
                ep.setAttribute("fill", "none");
                ep.setAttribute("stroke", this.edgeOf(stl));
                ep.setAttribute("stroke-width", "1");
                ep.setAttribute("class", "st-edge");
                ep.setAttribute("aria-hidden", "true");
                ep.setAttribute("data-key", key === "\u0000" ? "none" : key);
                svg.appendChild(ep);
                edges.set(key, ep);
            }
        }
        const focusRect = document.createElementNS(SVGNS, "rect") as SVGRectElement;
        focusRect.setAttribute("class", "st-focus");
        focusRect.setAttribute("y", "1");
        focusRect.setAttribute("height", String(Math.max(2, h - 2)));
        focusRect.setAttribute("rx", "2");
        svg.appendChild(focusRect);
        return { strip: s, el: null, svg, focusRect, hit, marks, focusIndex: -1, paths, edges };
    }

    /** Draws the axis; false when no tick label fits (fix round 7: the caller then gives the
     *  reserved row back to the rows). `lead`: the empty axis-row room left of the strip (the label
     *  column's spacer and the gap) that the Board's lone As of label may run into. */
    private drawAxis(svg: SVGSVGElement, style: Style, w: number, h: number, fs: number, span: number, blockList: Array<[number, number]>, grain: TimeGrain, lead = 0): boolean {
        const plan = this.axisPlan(style, w, fs, span, blockList, grain, lead);
        if (!plan) return false;
        for (const p of plan.labels) {
            const t = document.createElementNS(SVGNS, "text");
            t.setAttribute("x", p.x.toFixed(1));
            t.setAttribute("y", String(Math.round(h * 0.72)));
            t.setAttribute("text-anchor", p.anchor);
            t.setAttribute("class", "st-tick");
            t.setAttribute("font-size", String(plan.size));
            t.textContent = p.s;
            svg.appendChild(t);
        }
        return true;
    }

    /** Fix round 10 (R2, fix 1): the axis labels for a strip `w` px wide with `lead` px of empty
     *  axis row left of it, or null when not one label fits. The layout and the column choice
     *  measure the same plan that is drawn. Every look takes the LONGEST FITTING PREFIX of ONE
     *  fixed priority order (never a greedy solve) at each tick size from the axis size down to
     *  60% of it (never under 8 px), and the size that shows the most labels wins (ties: the
     *  larger). A set of labels that fits at one width fits at every wider one (positions scale,
     *  labels keep their size), so a wider strip never shows fewer labels, another precision or
     *  fewer years. */
    private axisPlan(style: Style, w: number, fs: number, span: number, blockList: Array<[number, number]>, grain: TimeGrain, lead = 0): AxisPlan | null {
        const tickFs = Math.max(8, Math.round(fs * 0.82));
        const least = Math.max(8, Math.round(tickFs * 0.6));
        const sizes: number[] = [];
        for (let s = tickFs; s >= least; s--) sizes.push(s);
        const cache = new Map<string, number>();
        const mw = (s: string, size: number) => { const k = size + "|" + s; let v = cache.get(k); if (v === undefined) cache.set(k, v = this.measure(s, size)); return v; };
        if (style === "board") return this.boardPlan(w, sizes, lead, mw);
        if (style === "blocks") return this.periodPlan(w, sizes, blockList, grain, mw);
        return this.runsPlan(w, sizes, span, mw);
    }

    /** The Board axis: the start / As of pair over the strip; else the As of label alone (it may
     *  run left into the empty axis room beside the strip, never past it); else (review 8 finding
     *  6) the start label, start-anchored, against that same free width, where it names the same
     *  calendar year as the As of label (the label that replaces it on a wider card then loses no
     *  year); else none. A single instant is ONE label (review 8: not "Jun 20 | Jun 20"). */
    private boardPlan(w: number, sizes: number[], lead: number, mw: (s: string, size: number) => number): AxisPlan | null {
        const m = this.model;
        let a = formatShortDate(m.start, this.locale), b = formatShortDate(m.asOf, this.locale);
        // the precision the pair settled on: -1 the short dates, else formatAxis's `extra`
        let bx = -1;
        // review 4 finding 4: two different instants never share a label (a same-day board
        // shows the times, as precise as needed)
        for (let ex = 1; a === b && m.asOf !== m.start && ex <= axisMaxExtra(m.asOf - m.start) + 1; ex++) {
            a = formatAxis(m.start, m.asOf - m.start, this.locale, ex - 1);
            b = formatAxis(m.asOf, m.asOf - m.start, this.locale, ex - 1);
            bx = ex - 1;
        }
        const yearsDiffer = new Date(m.start).getUTCFullYear() !== new Date(m.asOf).getUTCFullYear();
        // fix round 9 (A): the same date a year or more apart carries the year
        if (a === b && yearsDiffer) { a = formatDay(m.start, this.locale); b = formatDay(m.asOf, this.locale); }
        // shared-code round (Part A): a pair in different calendar years: each label that lacks
        // its year gets it, at the precision the pair settled on
        else if (yearsDiffer) {
            const sp = m.asOf - m.start;
            const has = (t: number) => bx >= 0 && axisLabelHasYear(t, sp, bx);
            if (!has(m.start)) a = bx < 0 ? formatDay(m.start, this.locale) : formatAxisWithYear(m.start, sp, this.locale, bx);
            if (!has(m.asOf)) b = bx < 0 ? formatDay(m.asOf, this.locale) : formatAxisWithYear(m.asOf, sp, this.locale, bx);
        }
        const single = m.asOf === m.start;
        if (!single) for (const size of sizes) if (mw(a, size) + mw(b, size) + 8 <= w) return { size, labels: [{ x: 0, s: a, anchor: "start" }, { x: w, s: b, anchor: "end" }] };
        for (const size of sizes) if (mw(b, size) <= w + lead) return { size, labels: [{ x: w, s: b, anchor: "end" }] };
        if (!single && !yearsDiffer) for (const size of sizes) {
            const wa = mw(a, size);
            if (wa <= w + lead) return { size, labels: [{ x: Math.max(-lead, Math.min(0, w - wa)), s: a, anchor: "start" }] };
        }
        return null;
    }

    /** The Runs axis. ONE fixed order: the start and the As of end label, then (an axis over a
     *  day boundary) the first midnight, then the calendar ticks level by level, coarse to fine.
     *  The axis is the longest fitting prefix of LEVELS: a level's ticks join together, leaving
     *  out only those whose label would touch the start or the As of label at this width (a
     *  gap that only grows with the width). The precision is fixed for the axis, not the width:
     *  the first (hh:mm with dated midnights, then date + time, ...) at which the start and the
     *  As of differ, and the levels join while no two different instants print alike. R1: where
     *  the range crosses a New Year, the first dated label of each calendar year in the drawn set
     *  carries the year. */
    private runsPlan(w: number, sizes: number[], span: number, mw: (s: string, size: number) => number): AxisPlan | null {
        const m = this.model;
        const spanMs = m.asOf - m.start;
        const key = `${m.start}|${m.asOf}|${this.locale}`;
        if (!this.runsOrderCache || this.runsOrderCache.key !== key) this.runsOrderCache = Object.assign({ key }, this.runsOrder());
        const { e: e0, base, levels, es } = this.runsOrderCache;
        let e = e0;
        const xOf = (t: number) => (t === m.start ? 0 : spanMs > 0 && t === m.asOf ? w : ((t - m.start) / span) * w);
        const box = (t: number, s: string, size: number) => {
            const end = spanMs > 0 && t === m.asOf, x = xOf(t), tw = mw(s, size);
            return { x, s, anchor: end ? "end" : "start", l: end ? x - tw : x, r: end ? x : x + tw };
        };
        const valid = (ts: number[], size: number): AxisLabel[] | null => {
            const tx = this.runsTexts(ts, e);
            if (new Set(tx.values()).size !== tx.size) return null;
            const boxes = ts.map(t => box(t, tx.get(t) as string, size));
            const sorted = boxes.slice().sort((p, q) => p.l - q.l);
            for (let i = 0; i < sorted.length; i++) {
                if (sorted[i].l < -0.5 || sorted[i].r > w + 0.5) return null;
                if (i > 0 && sorted[i].l < sorted[i - 1].r + 8) return null;
            }
            return sorted.map(({ x, s, anchor }) => ({ x, s, anchor }));
        };
        let best: AxisPlan | null = null;
        // a span of up to two days across a day boundary keeps review 5/6's day layout (regular
        // candidates only, each valid on every wider card: monotone by construction)
        if (crossesDay(m.start, m.asOf) && spanMs > 0 && spanMs <= 2 * 86400000) {
            const yr = new Date(m.start).getUTCFullYear() !== new Date(m.asOf).getUTCFullYear();
            for (const size of sizes) {
                const ls = this.dayAxisLayout(w, span, spanMs, axisMaxExtra(spanMs), (s: string) => mw(s, size), yr);
                if (!ls || ls.length === 0) continue;
                const labels = ls.slice().sort((p, q) => p.l - q.l).map(p => ({ x: p.x, s: p.s, anchor: p.anchor }));
                if (!best || labels.length > best.labels.length) best = { size, labels };
            }
            return best;
        }
        for (const size of sizes) {
            e = e0;
            let ls = valid(base.slice(0, 1), size);
            if (!ls) continue;
            const both = valid(base, size);
            if (both) {
                ls = both;
                for (let k = 1; k <= levels.length; k++) {
                    // the union of the first k levels must space out at this width as a whole
                    // (consecutive gaps scale with the width, so a level that fits fits wider);
                    // only ticks against the start or As of label are left out, a test that
                    // also only loosens as the card widens
                    const union = ([] as number[]).concat(...levels.slice(0, k)).sort((p, q) => p - q);
                    const ek = es[k - 1], keep = e;
                    e = ek;   // the first k levels print at the precision the k-th needs (never lower than before)
                    const tx = this.runsTexts(base.concat(union), e);
                    let ok = true;
                    for (let i = 1; i < union.length && ok; i++) if (xOf(union[i]) - xOf(union[i - 1]) < mw(tx.get(union[i - 1]) as string, size) + 8) ok = false;
                    if (!ok) { e = keep; break; }
                    const ticks = union.filter(t => {
                        const bx = box(t, tx.get(t) as string, size);
                        return base.every(q => { const bq = box(q, tx.get(q) as string, size); return bx.r + 8 <= bq.l || bq.r + 8 <= bx.l; });
                    });
                    const f = valid(base.concat(ticks), size);
                    if (!f) { e = keep; break; }
                    ls = f;
                }
            }
            if (!best || ls.length > best.labels.length) best = { size, labels: ls };
        }
        // the start label fits at no size (a strip narrower than it): the coarsest level's tick
        // nearest the middle, alone, where it fits (its fit only loosens as the card widens, and
        // the start label, once it fits, replaces it)
        if (!best && levels.length > 0) {
            const lv = levels[0].slice().sort((p, q) => Math.abs(xOf(p) - w / 2) - Math.abs(xOf(q) - w / 2));
            for (const size of sizes) {
                e = es[0];
                const t = lv.find(t2 => { const tx = this.runsTexts([t2], e); return xOf(t2) + mw(tx.get(t2) as string, size) <= w + 0.5; });
                if (t !== undefined) { best = { size, labels: [{ x: xOf(t), s: this.runsTexts([t], e).get(t) as string, anchor: "start" }] }; break; }
            }
        }
        return best;
    }

    /** Review 5 finding 4 + review 6 finding 1: the Runs axis of a span of up to two days that
     *  crosses a day boundary. It names the day ("Apr 2" at the first midnight, always, on the clock
     *  tiers: the native style), never repeats a label, and NEVER shows fewer labels on a wider card
     *  nor changes its label style as the card grows. Every candidate is a REGULAR layout whose
     *  validity only improves with width: a tick step, every k-th tick of it in step with the first
     *  midnight, up to that many first-day ticks left out at the head and last-day ticks (from the
     *  last midnight on) at the tail, or no ticks at all, the start and the As of labels each on or off, or the start / middle / end anchors. A
     *  candidate is valid when every label fits, no two touch (8 px) and no text repeats; it is
     *  never thinned to fit, so a candidate valid on a card stays valid on every wider card (each
     *  position scales with the width, each label keeps its size). Precisions in the order a clock
     *  that repeats across days needs them (hh:mm with dated midnights, date hh:mm, hh:mm:ss, date
     *  hh:mm:ss, then milliseconds): the first precision with any valid dated candidate wins, and
     *  of its candidates the one with the most labels (ties: the finer step, fewer left out, with
     *  the start and the As of). */
    private dayAxisLayout(w: number, span: number, spanMs: number, top: number, mw: (s: string) => number, yr = false): Array<{ x: number; t: number; s: string; anchor: string; l: number; r: number; d?: boolean; y?: boolean }> | null {
        const m = this.model;
        const DAY_MS = 86400000;
        type L = { x: number; t: number; s: string; anchor: string; l: number; r: number; d?: boolean; y?: boolean };
        const t1 = (Math.floor(m.start / DAY_MS) + 1) * DAY_MS;          // the first midnight
        const tN = Math.floor(m.asOf / DAY_MS) * DAY_MS;                  // the last midnight
        const steps: number[][] = [];
        for (let k = Math.max(1, Math.floor(w / 48)); k >= 1; k--) {
            const ts = axisTicks(m.start, m.asOf, k).filter(t => t > m.start && t < m.asOf);
            const prev = steps[steps.length - 1];
            if (!prev || prev.length !== ts.length || prev[0] !== ts[0]) steps.push(ts);
        }
        const xOf = (t: number) => ((t - m.start) / span) * w;
        const valid = (ls: L[]): boolean => {
            ls.sort((a, b) => a.l - b.l);
            const seen = new Set<string>();
            for (let i = 0; i < ls.length; i++) {
                if (ls[i].l < -0.5 || ls[i].r > w + 0.5 || seen.has(ls[i].s)) return false;
                seen.add(ls[i].s);
                if (i > 0 && ls[i].l < ls[i - 1].r + 8) return false;
            }
            return ls.length > 0;
        };
        for (const ex of [0, 3, 1, 4, 2, 5]) {
            if (ex > top) continue;
            const cache = new Map<number, string>();
            const lab = (t: number) => { let v = cache.get(t); if (v === undefined) cache.set(t, v = formatAxis(t, spanMs, this.locale, ex, true)); return v; };
            const at = (t: number, anchor: string, s = lab(t)): L => {
                const x = anchor === "end" ? w : anchor === "middle" ? w / 2 : xOf(t), tw = mw(s);
                return { x, t, s, anchor, l: anchor === "end" ? x - tw : anchor === "middle" ? x - tw / 2 : x, r: anchor === "end" ? x : anchor === "middle" ? x + tw / 2 : x + tw };
            };
            // on the clock tiers the first midnight is always a label, by its date
            // (left-aligned on its tick, or, where that runs off the axis, right-aligned on it)
            const forcedAll: Array<L | null> = [null];
            if (ex < 3 && t1 <= m.asOf) {
                forcedAll.length = 0;
                if (t1 === m.asOf) forcedAll.push(at(t1, "end"));
                else {
                    forcedAll.push(at(t1, "start"));
                    const fe = at(t1, "start"); fe.anchor = "end"; fe.r = fe.x; fe.l = fe.x - mw(fe.s);
                    forcedAll.push(fe);
                }
            }
            const startL = at(m.start, "start"), endL = at(m.asOf, "end", formatAxisEnd(m.asOf, spanMs, this.locale, ex, true));
            const dated = (ls: L[]) => ls.some(p => axisLabelHasDate(p.t, spanMs, ex, true));
            const best: { ls: L[] | null } = { ls: null };
            // shared-code round (Part A), `yr`: a candidate's dated labels carry the year on the
            // first and wherever it changes (a span of up to two days over New Year), measured
            // fix round 10 (R1, fix 2): the first drawn label of each calendar year carries it, a
            // clock label included: it takes its date and year ("Dec 31, 2025, 11:55 PM", precision
            // kept), so each year an axis shows is named on its first tick
            const withYears = (ls: L[]): L[] => {
                let prev = NaN;
                return ls.slice().sort((a, b) => a.t - b.t).map(p => {
                    const d = axisLabelHasDate(p.t, spanMs, ex, true);
                    const y = new Date(p.t).getUTCFullYear(), need = y !== prev;
                    prev = y;
                    if (!yr || !need) return Object.assign({}, p, { d, y: false });
                    const s = formatAxisWithYear(p.t, spanMs, this.locale, d ? ex : ex + 3, true), tw = mw(s);
                    return { x: p.x, t: p.t, s, anchor: p.anchor, d, y: true, l: p.anchor === "end" ? p.x - tw : p.anchor === "middle" ? p.x - tw / 2 : p.x, r: p.anchor === "end" ? p.x : p.anchor === "middle" ? p.x + tw / 2 : p.x + tw };
                });
            };
            const offer = (raw: L[]) => { const ls = withYears(raw); if (dated(ls) && valid(ls) && (!best.ls || ls.length > best.ls.length)) best.ls = ls; };
            for (const forced of forcedAll) {
            for (const ts of steps) for (let every = 1; every <= Math.max(1, ts.length); every++) {
                const i1 = ts.indexOf(t1);
                const phase = i1 >= 0 ? i1 % every : 0;
                const sub = ts.filter((_, i) => (i - phase) % every === 0);
                const before = sub.filter(t => t < t1).length, after = sub.filter(t => t >= tN && t !== t1).length;
                for (let head = 0; head <= before; head++) for (let tail = 0; tail <= after; tail++) {
                    const ticks = sub.slice(head, sub.length - tail).filter(t => !forced || t !== forced.t).map(t => at(t, "start"));
                    for (const withStart of [true, false]) for (const withEnd of [true, false]) {
                        const ls = (forced ? [forced] : []).concat(ticks);
                        if (withStart) ls.push(startL);
                        if (withEnd && m.asOf !== (forced && forced.t)) ls.push(endL);
                        offer(ls);
                    }
                }
            }
            // no ticks: the first midnight with or without the start and the As of
            for (const withStart of [true, false]) for (const withEnd of [true, false]) {
                const ls = forced ? [forced] : [];
                if (withStart) ls.push(startL);
                if (withEnd && m.asOf !== (forced && forced.t)) ls.push(endL);
                offer(ls);
            }
            }
            if (spanMs > 0 && forcedAll[0] === null) {
                offer([startL, at(m.start + spanMs / 2, "middle"), at(m.asOf, "end")]);
                offer([startL, at(m.asOf, "end")]);
            }
            if (best.ls) return best.ls;
        }
        return null;
    }

    /** The label of each instant in a Runs label set at precision `e` (the As of: its end label),
     *  with R1's years where the range crosses a New Year. */
    private runsTexts(ts: number[], e: number): Map<number, string> {
        const m = this.model;
        const spanMs = m.asOf - m.start;
        const dayCross = crossesDay(m.start, m.asOf);
        const yearOf = (t: number) => new Date(t).getUTCFullYear();
        const crossesYear = yearOf(m.start) !== yearOf(m.asOf);
        const out = new Map<number, string>();
        const seen = new Set<number>();
        for (const t of ts.slice().sort((p, q) => p - q)) {
            const end = spanMs > 0 && t === m.asOf;
            const d = axisLabelHasDate(t, spanMs, e, dayCross);
            const y = d && axisLabelHasYear(t, spanMs, e, end);
            const first = d && !seen.has(yearOf(t));
            if (d) seen.add(yearOf(t));
            // the text depends on the instant, the span, the precision, the locale and which form is
            // drawn: format each once per instance (runsPlan asks for it per level, size and column candidate)
            const kind = crossesYear && first && !y ? 2 : end ? 1 : 0;
            const k = t + "|" + kind + "|" + e + "|" + m.start + "|" + m.asOf + "|" + this.locale;
            let txt = this.axisTexts.get(k);
            if (txt === undefined) {
                txt = kind === 2 ? formatAxisWithYear(t, spanMs, this.locale, e, dayCross, end)
                    : kind === 1 ? formatAxisEnd(t, spanMs, this.locale, e, dayCross) : formatAxis(t, spanMs, this.locale, e, dayCross);
                if (this.axisTexts.size > 20000) this.axisTexts.clear();
                this.axisTexts.set(k, txt);
            }
            out.set(t, txt);
        }
        return out;
    }

    /** The Runs label order and its precision (see runsPlan); depends on the data, never on the
     *  width. `levels`: the ticks each level adds. */
    private runsOrder(): { e: number; base: number[]; levels: number[][]; es: number[] } {
        const m = this.model;
        const spanMs = m.asOf - m.start;
        const base = spanMs > 0 ? [m.start, m.asOf] : [m.start];
        const dayCross = crossesDay(m.start, m.asOf);
        const raw: number[][] = [];
        if (dayCross) raw.push([(Math.floor(m.start / 86400000) + 1) * 86400000].filter(t => t > m.start && t < m.asOf));
        let prev = "";
        if (spanMs > 0) for (let k = 1; k <= 48; k++) {
            const ts = axisTicks(m.start, m.asOf, k).filter(t => t > m.start && t < m.asOf);
            const id = ts.join(",");
            if (id !== prev) { raw.push(ts); prev = id; }
        }
        const top = axisMaxExtra(spanMs);
        const precisions = (dayCross ? [0, 3, 1, 4, 2, 5] : [0, 1, 2, 3, 4, 5]).filter(p => p <= top);
        const distinct = (ts: number[], e: number) => { const tx = this.runsTexts(ts, e); return new Set(tx.values()).size === tx.size; };
        const i0 = precisions.findIndex(e => distinct(base, e));
        if (i0 < 0) return { e: precisions[precisions.length - 1], base, levels: [], es: [] };
        // each level carries the lowest precision (from the base's, never falling along the order)
        // at which every label so far reads differently; a level no precision can tell apart is
        // passed over (over a long day-crossing span the next-midnight tick prints the start's own
        // "Jan 2026"), so the order, like the base, depends on the data only, never the width
        const levels: number[][] = [], es: number[] = [];
        const inOrder = new Set(base);
        let all = base.slice(), pi = i0;
        for (const lv of raw) {
            const add = lv.filter(t => !inOrder.has(t));
            if (add.length === 0) continue;
            // (only a range inside one day climbs to seconds and milliseconds; a range across days
            // keeps the base's precision, and its finer levels are passed over)
            let pj = pi;
            while (pj < precisions.length && !distinct(all.concat(add), precisions[pj]) && !dayCross) pj++;
            if (pj < precisions.length && !distinct(all.concat(add), precisions[pj])) continue;
            if (pj === precisions.length) continue;
            pi = pj;
            levels.push(add);
            es.push(precisions[pi]);
            add.forEach(t => inOrder.add(t));
            all = all.concat(add);
        }
        return { e: precisions[i0], base, levels, es };
    }

    /** Block strips draw every calendar bucket at the SAME width (the drawn look A), so their
     *  axis is categorical (review 2, finding 1): a label sits at the left edge of the bucket it
     *  names. The labelled buckets are every `step`-th, steps 1, 2, 4, 8 ... (each set holds every
     *  coarser one); the smallest step at which no two labels collide. R1: the first label of each
     *  calendar year carries the year; a bucket name without it only ever stands alone, on a range
     *  inside one calendar year. Most labels
     *  win, then the year, then the larger size. */
    private periodPlan(w: number, sizes: number[], blockList: Array<[number, number]>, grain: TimeGrain, mw: (s: string, size: number) => number): AxisPlan | null {
        const n = blockList.length;
        if (n === 0) return null;
        const bw = w / n;
        const years0 = blockList.map(bk => new Date(bk[0]).getUTCFullYear());
        const yearOf = (j: number) => years0[j];
        const crossesYear = yearOf(0) !== yearOf(n - 1);
        // a bucket's name depends only on its start, the grain, the year flag and the locale: format
        // each once per instance (the plan is asked for several sizes, steps and column candidates)
        const memo = this.periodLabels;
        if (memo.size > 20000) memo.clear();
        const lab = (j: number, y: boolean) => {
            const yy = y || grain === "year", k = blockList[j][0] + "|" + grain + "|" + (yy ? 1 : 0) + "|" + this.locale;
            let s = memo.get(k);
            if (s === undefined) { s = formatPeriod(blockList[j][0], grain, yy, this.locale); memo.set(k, s); }
            return s;
        };
        const steps: number[] = [];
        for (let s = 1; s < 2 * n; s *= 2) steps.push(s);
        let best: AxisPlan | null = null, bestYears = false;
        for (const size of sizes) for (const years of [true, false]) for (const step of steps) {
            const placed: AxisLabel[] = [];
            let ok = true;
            let prevYear = NaN;
            for (let j = 0; j < n; j += step) {
                const y = years && (j === 0 || yearOf(j) !== prevYear);
                const s = lab(j, y), tw = mw(s, size);
                const x = j * bw;
                if (j + step < n && tw + 6 > step * bw) { ok = false; break; }
                if (x + tw > w + 0.5) { if (j === 0) ok = false; break; }   // the last label may not fit: dropped
                placed.push({ x, s, anchor: "start" });
                prevYear = yearOf(j);
            }
            if (!ok || placed.length === 0) continue;
            // R1: a range across a New Year never shows a bucket name without its year, even alone
            if (!years && grain !== "year" && (placed.length > 1 || crossesYear)) continue;
            if (!best || placed.length > best.labels.length || (placed.length === best.labels.length && years && !bestYears)) { best = { size, labels: placed }; bestYears = years; }
            break;
        }
        return best;
    }

    /** The states that are actually DRAWN (M1): for block strips and the board, the dominant
     *  state of some block, an Always-show marker, or (board) a NOW swatch; null = every state
     *  that has a run (the Runs look draws every run). */
    private drawnStates(style: Style, blocks: BlockInfo[][]): Set<string | null> | null {
        if (style === "runs") return null;
        const out = new Set<string | null>();
        for (const list of blocks) for (const b of list) { if (b.ds !== undefined) out.add(b.ds); if (b.mark) out.add(b.mark); }
        if (style === "board") for (const s of this.model.strips) out.add(currentRun(s).state);
        return out;
    }

    private legendItems(style: Style, drawn: Set<string | null> | null): { items: Array<{ style: StateStyle; label: string }>; hidden: number } {
        const m = this.model;
        const items: Array<{ style: StateStyle; label: string }> = [];
        const has = (st: string | null) => drawn === null || drawn.has(st);
        let hidden = 0;
        let foldedDrawn = 0;
        m.states.forEach((s, i) => {
            if (this.styles[i].kind === "other") { if (has(s)) foldedDrawn++; else hidden++; return; }
            if (has(s)) items.push({ style: this.styles[i], label: s }); else hidden++;
        });
        if (foldedDrawn > 0) items.push({ style: this.styles[this.styles.length - 1], label: this.t("OtherStates", this.n(foldedDrawn)) });
        if (m.disclosures.blankState > 0 && has(null)) items.push({ style: UNKNOWN_STYLE, label: this.t("NoState") });
        void style;
        return { items, hidden };
    }

    private renderLegend(foot: HTMLElement, legend: { items: Array<{ style: StateStyle; label: string }>; hidden: number }, style: Style, strips: Strip[]): void {
        const items = legend.items;
        if (this.settings.statusTimeline.showLegend.value === false) return;
        const lg = document.createElement("div");
        lg.className = "st-legend";
        lg.setAttribute("role", "list");
        lg.setAttribute("aria-label", this.t("Aria_Legend"));
        const n = Math.max(1, this.styles.length - 1);
        for (const it of items) {
            const e = document.createElement("div");
            e.className = "st-legend-item";
            e.setAttribute("role", "listitem");
            const sw = document.createElementNS(SVGNS, "svg");
            const hh = style === "runs" ? (it.style.kind === "track" ? 3 : it.style.kind === "unknown" ? 5 : Math.round(5 + 7 * Math.min(1, it.style.level / n))) : 10;
            sw.setAttribute("width", "10"); sw.setAttribute("height", "12"); sw.setAttribute("class", "st-swatch");
            const g = document.createElementNS(SVGNS, "g");
            g.setAttribute("transform", `translate(0 ${(12 - hh) / 2})`);
            sw.appendChild(g);
            this.swatch(g, it.style, 10, hh);
            e.appendChild(sw);
            const t = document.createElement("span");
            t.className = "st-legend-label";
            t.textContent = it.label;
            t.title = it.label;
            e.appendChild(t);
            lg.appendChild(e);
        }
        if (legend.hidden > 0) {
            // states with time in the data that no block shows at this grain (M1)
            const c = document.createElement("div");
            c.className = "st-legend-extra st-legend-hidden";
            c.textContent = this.t("Legend_NotShown", this.n(legend.hidden));
            c.title = this.t("Legend_NotShown_Tip");
            lg.appendChild(c);
        }
        if (style === "runs") {
            const changes = strips.reduce((a, s) => a + s.changes, 0);
            const c = document.createElement("div");
            c.className = "st-legend-extra";
            c.textContent = this.changesText(changes);
            lg.appendChild(c);
        }
        foot.appendChild(lg);
    }

    /** Disclosures: every row not drawn, every rule that changed what is drawn, the as-of rule. */
    private renderNotes(foot: HTMLElement): void {
        const m = this.model;
        const d = m.disclosures;
        const notes: Array<{ text: string; warn: boolean }> = [];
        // M2 + review 2 finding 5: say only what is known. The host's segment flag = Power BI
        // reports more data (how many rows were received is all the visual knows); exactly the row
        // limit with no flag = rows MAY be missing. Neither names a resource: the delivered order
        // does not guarantee that only the last one is incomplete.
        if (d.truncated) notes.push({ warn: true, text: d.moreData ? this.t("Note_TruncatedMore", this.n(d.received)) : this.t("Note_TruncatedAtLimit", this.n(ROW_WINDOW), this.n(d.received)) });
        if (this.coarsened) notes.push({ warn: true, text: this.t("Note_GrainCoarsened", this.grainWord(this.coarsened.from), this.n(MIN_BLOCK_PX), this.grainWord(this.coarsened.to)) });
        const dropped = d.blankTimestamp + d.badTimestamp + d.numericTimestamp + d.afterAsOf;
        if (dropped > 0) {
            const parts: string[] = [];
            if (d.blankTimestamp) parts.push(this.t("Drop_Blank", this.n(d.blankTimestamp)));
            if (d.badTimestamp + d.numericTimestamp) parts.push(this.t("Drop_Bad", this.n(d.badTimestamp + d.numericTimestamp)));
            if (d.afterAsOf) parts.push(this.t("Drop_After", this.n(d.afterAsOf)));
            notes.push({ warn: true, text: this.t("Note_Dropped", this.n(dropped), parts.join(this.t("List_Separator"))) });
        }
        if (this.partialDrawn) notes.push({ warn: false, text: this.t(this.settings.statusTimeline.style.value.value === "board" ? "Note_PartialBoard" : "Note_PartialBlocks") });
        if (d.simultaneous > 0) notes.push({ warn: false, text: this.t("Note_Simultaneous", this.n(d.simultaneous)) });
        if (d.blankState > 0) notes.push({ warn: false, text: this.t("Note_BlankState", this.n(d.blankState)) });
        const folded = foldedCount(m.states.length, this.settings.statusTimeline.restingAsTrack.value !== false);
        if (folded > 0) notes.push({ warn: false, text: this.t("Note_Folded", this.n(folded)) });
        if (d.asOfIgnored > 0) notes.push({ warn: false, text: this.t("Note_AsOfIgnored", this.n(d.asOfIgnored)) });
        if (m.asOf === m.start) notes.push({ warn: false, text: this.t("Note_OneInstant") });
        notes.push({ warn: false, text: this.t(d.asOfFromField ? "Note_AsOfField" : "Note_AsOfLatest", formatWhen(m.asOf, this.locale)) });
        const box = document.createElement("div");
        box.className = "st-notes";
        for (const n of notes) {
            const e = document.createElement("div");
            e.className = n.warn ? "st-note st-warn" : "st-note";
            if (n.warn) {
                e.setAttribute("role", "status");
                const ic = document.createElementNS(SVGNS, "svg");
                ic.setAttribute("width", "11"); ic.setAttribute("height", "11"); ic.setAttribute("viewBox", "0 0 12 12"); ic.setAttribute("class", "st-warn-icon"); ic.setAttribute("aria-hidden", "true");
                const p = document.createElementNS(SVGNS, "path");
                p.setAttribute("d", "M6 1 11.2 10.5H.8Z M6 4.4V7.4 M6 8.6V9.2");
                p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.3"); p.setAttribute("stroke-linejoin", "round"); p.setAttribute("stroke-linecap", "round");
                ic.appendChild(p);
                e.appendChild(ic);
            }
            const t = document.createElement("span");
            t.textContent = n.text;
            e.appendChild(t);
            box.appendChild(e);
        }
        foot.appendChild(box);
    }

    // ── interaction ─────────────────────────────────────────────────────────

    private tooltipFor(ctx: RowCtx, h: { run: Run | null; extra?: VisualTooltipDataItem[] }): { items: VisualTooltipDataItem[]; id: ISelectionId | null } {
        const m = this.model;
        const items: VisualTooltipDataItem[] = [{ displayName: this.cols.resource.source.displayName, value: ctx.strip.label }];
        const r = h.run;
        if (h.extra) items.push(...h.extra);
        else if (r) {
            items.push({ displayName: this.cols.state.source.displayName, value: this.stateLabel(r.state) });
            items.push({ displayName: this.t("Tip_From"), value: formatWhen(r.start, this.locale) });
            items.push({ displayName: this.t("Tip_To"), value: r.end === m.asOf ? this.t("Tip_ToAsOf", formatWhen(r.end, this.locale)) : formatWhen(r.end, this.locale) });
            items.push({ displayName: this.t("Tip_Duration"), value: this.runDur(r.end - r.start) });
            if (r.events > 1) items.push({ displayName: this.t("Tip_Repeats"), value: this.n(r.events - 1) });
        }
        if (r) for (const c of this.cols.tooltips) items.push({ displayName: c.source.displayName, value: this.cellText(c.values[r.row], c.source.format) });
        return { items, id: r ? this.runId(r) : this.resourceId(ctx.strip) };
    }

    private stripTooltip(ctx: RowCtx): VisualTooltipDataItem[] {
        const s = ctx.strip;
        const r = currentRun(s);
        const items: VisualTooltipDataItem[] = [
            { displayName: this.cols.resource.source.displayName, value: s.label },
            { displayName: this.t("Tip_Now"), value: `${this.stateLabel(r.state)} · ${this.runDur(r.end - r.start)}` },
            { displayName: this.t("Tip_Changes"), value: this.n(s.changes) },
        ];
        const unit = this.unitFor(Array.from(s.totals.values()));
        for (const st of this.model.states) if (s.totals.has(st)) items.push({ displayName: st, value: this.dur(s.totals.get(st), unit) });
        if (s.unknownMs > 0) items.push({ displayName: this.t("NoState"), value: this.dur(s.unknownMs, unit) });
        return items;
    }

    /** 1180.2.4: a tooltip value keeps its own kind: blank prints "(Blank)", text prints as text,
     *  a number through its format string, a date as a wall-clock date. Never 0 for blank. */
    private cellText(v: unknown, format: string | undefined): string {
        if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return this.t("Blank");
        if (typeof v === "number") return Number.isFinite(v) ? formatModelNumber(v, format, this.locale) : String(v);
        if (v instanceof Date) return isNaN(v.getTime()) ? this.t("Blank") : formatWhen(wallOfDate(v), this.locale);
        return String(v);
    }

    private wireRow(ctx: RowCtx, label: HTMLElement, index: number): void {
        const svg = ctx.svg;
        const local = (e: MouseEvent) => e.clientX - svg.getBoundingClientRect().left;
        const show = (e: MouseEvent, items: VisualTooltipDataItem[], id: ISelectionId | null) =>
            this.showTip({ coordinates: [e.clientX, e.clientY], isTouchEvent: false, dataItems: items, identities: id ? [id] : [] });
        svg.addEventListener("mousemove", (e: MouseEvent) => {
            const h = ctx.hit(local(e));
            if (!h) { this.hideTip(true); return; }
            const tip = this.tooltipFor(ctx, h);
            show(e, tip.items, tip.id);
        });
        svg.addEventListener("mouseleave", () => this.hideTip(false));
        svg.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            const h = ctx.hit(local(e));
            this.focusRow = index;
            this.select(h && h.run ? this.runId(h.run) : this.resourceId(ctx.strip), e.ctrlKey || e.metaKey || e.shiftKey);
        });
        label.addEventListener("mousemove", (e: MouseEvent) => show(e, this.stripTooltip(ctx), this.resourceId(ctx.strip)));
        label.addEventListener("mouseleave", () => this.hideTip(false));
        ctx.el.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            this.focusRow = index;
            this.select(this.resourceId(ctx.strip), e.ctrlKey || e.metaKey || e.shiftKey);
        });
        ctx.el.addEventListener("keydown", (e: KeyboardEvent) => this.onKey(e, ctx, index));
        ctx.el.addEventListener("focus", () => { this.focusRow = index; this.rows.forEach((r, i) => { r.el.tabIndex = i === index ? 0 : -1; }); });
        ctx.el.addEventListener("blur", () => { ctx.focusIndex = -1; ctx.focusRect.removeAttribute("width"); ctx.svg.querySelector(".st-focus-in")?.remove(); ctx.el.removeAttribute("aria-description"); this.hideTip(true); });
    }

    // Tooltip visibility is tracked so Escape can close an open tooltip first (review 2, finding 7).
    private showTip(args: powerbi.extensibility.TooltipShowOptions): void { this.tipOpen = true; this.tooltipService.show(args); }
    private hideTip(immediately: boolean): void { this.tipOpen = false; this.tooltipService.hide({ isTouchEvent: false, immediately }); }

    private onKey(e: KeyboardEvent, ctx: RowCtx, index: number): void {
        const move = (to: number) => { const r = this.rows[to]; if (r) { r.el.focus(); } };
        const multi = e.ctrlKey || e.metaKey || e.shiftKey;
        if (e.key === "ArrowDown") { e.preventDefault(); move(index + 1); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); move(index - 1); return; }
        if (e.key === "Home") { e.preventDefault(); move(0); return; }
        if (e.key === "End") { e.preventDefault(); move(this.rows.length - 1); return; }
        // fix round 10 (R5): Page Down / Page Up move the focus a viewport of whole rows, so the
        // focused row stays in view (a native page scroll left it above the rows in view)
        if (e.key === "PageDown" || e.key === "PageUp") {
            e.preventDefault();
            const host = ctx.el.parentElement, rh = ctx.el.offsetHeight || 1;
            const page = Math.max(1, Math.floor((host ? host.clientHeight : rh) / rh));
            const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, index + (e.key === "PageDown" ? page : -page)))];
            if (r) {
                r.el.focus({ preventScroll: true });
                // the focused row is brought wholly into view by whole rows
                if (host) {
                    const top = r.el.getBoundingClientRect().top - host.getBoundingClientRect().top - host.clientTop + host.scrollTop, bottom = top + rh;
                    if (top < host.scrollTop) host.scrollTop = top;
                    else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight;
                }
            }
            return;
        }
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            if (ctx.marks.length === 0) return;
            const step = e.key === "ArrowRight" ? 1 : -1;
            ctx.focusIndex = ctx.focusIndex < 0 ? (step > 0 ? 0 : ctx.marks.length - 1) : Math.max(0, Math.min(ctx.marks.length - 1, ctx.focusIndex + step));
            const mk = ctx.marks[ctx.focusIndex];
            ctx.focusRect.setAttribute("x", (mk.x - 1).toFixed(2));
            ctx.focusRect.setAttribute("width", Math.max(3, mk.w + 2).toFixed(2));
            const ring = this.ringOf(mk.run);
            ctx.focusRect.style.stroke = ring.outer;
            let inner = ctx.svg.querySelector<SVGRectElement>(".st-focus-in");
            if (ring.inner) {
                // R3: the inner pixel of a two-tone ring, drawn over the outer one's inner half
                if (!inner) { inner = document.createElementNS(SVGNS, "rect") as SVGRectElement; inner.setAttribute("class", "st-focus-in"); ctx.svg.appendChild(inner); }
                const fy = Number(ctx.focusRect.getAttribute("y")), fh = Number(ctx.focusRect.getAttribute("height"));
                inner.setAttribute("x", (mk.x - 0.5).toFixed(2));
                inner.setAttribute("width", Math.max(2, mk.w + 1).toFixed(2));
                inner.setAttribute("y", String(fy + 0.5));
                inner.setAttribute("height", String(Math.max(1, fh - 1)));
                inner.style.stroke = ring.inner;
            } else if (inner) inner.remove();
            // H4: the stop's OWN run (or run of blocks), never a pixel hit test: a narrow mark
            // can share its centre pixel with a neighbour.
            const h = mk.tip ? { run: mk.run, extra: mk.tip() } : { run: mk.run };
            const tip = this.tooltipFor(ctx, h);
            const box = ctx.svg.getBoundingClientRect();
            this.showTip({ coordinates: [box.left + mk.x + mk.w / 2, box.bottom], isTouchEvent: false, dataItems: tip.items, identities: tip.id ? [tip.id] : [] });
            ctx.el.setAttribute("aria-description", tip.items.map(i => `${i.displayName}: ${i.value}`).join(", "));
            return;
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            const mk = ctx.focusIndex >= 0 ? ctx.marks[ctx.focusIndex] : null;
            this.select(mk ? this.runId(mk.run) : this.resourceId(ctx.strip), multi);
            return;
        }
        if (e.key === "Escape") this.onEscape(e, ctx.el);
    }

    /** Escape, for the rows and the setup list alike (review 3 item 4): 1, close an open tooltip
     *  (and a row stop's transient description); 2, clear a selection this visual owns; otherwise
     *  the key is left to the host (not consumed). */
    private onEscape(e: KeyboardEvent, row: HTMLElement | null): void {
        if (this.tipOpen) { e.preventDefault(); this.hideTip(true); if (row) row.removeAttribute("aria-description"); return; }
        if (this.selected.length > 0 && this.canInteract()) { e.preventDefault(); this.select(null, false); }
    }

    /** False when the host shows the visual without interaction (dashboard tile, some embeds). */
    private canInteract(): boolean {
        return this.host.hostCapabilities?.allowInteractions !== false;
    }

    private select(id: ISelectionId | null, multi: boolean): void {
        if (!this.canInteract()) return;
        if (!id) {
            if (this.selected.length === 0) return;
            this.selectionManager.clear().then(() => { this.selected = []; this.applySelection(); });
            return;
        }
        this.selectionManager.select(id, multi).then((ids: ISelectionId[]) => { this.selected = ids || []; this.applySelection(); });
    }

    private isSel(id: ISelectionId | null): boolean {
        return !!id && this.selected.some(s => s && (s.equals ? s.equals(id) : s === id));
    }

    /** Dims what is not selected: a resource selection keeps its whole strip, a run selection
     *  keeps that resource's runs of that state. */
    private applySelection(): void {
        const any = this.selected.length > 0;
        for (const ctx of this.rows) {
            const strip = ctx.strip;
            const whole = this.isSel(this.resourceId(strip));
            // review 5 finding 2: whether the row holds the selection comes from its runs' LOGICAL
            // identities, never from the painted paths alone (a resting run in Runs is the baseline,
            // it has no filled path)
            let anyHere = whole || (any && strip.runs.some(r => this.isSel(this.runId(r))));
            const base = ctx.svg.querySelector(".st-baseline") as SVGElement | null;
            if (base) {
                const restOn = !any || whole || strip.runs.some(r => this.styleOfState(r.state).kind === "track" && this.isSel(this.runId(r)));
                if (this.colours.hc) { base.style.opacity = ""; base.style.fill = any && restOn ? this.colours.focus : ""; }
                else base.style.opacity = restOn ? "" : "0.32";
            }
            for (const [key, path] of ctx.paths) {
                const state = key === "\u0000" ? null : key.slice(1);
                const run = strip.runs.find(r => r.state === state);
                const on = !any || whole || (run ? this.isSel(this.runId(run)) : false);
                if (on && any) anyHere = true;
                if (this.colours.hc) {
                    // L4: high contrast never dims by opacity; the selection is drawn in the
                    // system highlight colour instead.
                    path.style.opacity = "";
                    const sel = any && on;
                    path.style.stroke = sel ? this.colours.focus : "";
                    path.style.strokeWidth = sel ? "2" : "";
                } else path.style.opacity = on ? "" : "0.32";
                const ep = ctx.edges.get(key);
                if (ep) ep.style.opacity = path.style.opacity;
            }
            ctx.el.classList.toggle("st-dimmed", any && !anyHere && !this.colours.hc);
            ctx.el.classList.toggle("st-hc-selected", any && anyHere && this.colours.hc);
            ctx.el.setAttribute("aria-selected", String(any && anyHere));
        }
        const items = this.root.querySelectorAll(".st-setup-item");
        items.forEach((el: Element) => {
            const id = (el as HTMLElement & { stId?: ISelectionId }).stId;
            el.classList.toggle("st-dimmed", any && !this.isSel(id));
        });
    }

    private idAtEvent(e: MouseEvent): ISelectionId | null {
        const t = e.target as Element;
        for (const ctx of this.rows) {
            if (!ctx.el.contains(t)) continue;
            if (ctx.svg.contains(t)) {
                const h = ctx.hit(e.clientX - ctx.svg.getBoundingClientRect().left);
                if (h && h.run) return this.runId(h.run);
            }
            return this.resourceId(ctx.strip);
        }
        const item = t && t.closest ? t.closest(".st-setup-item") as (HTMLElement & { stId?: ISelectionId }) | null : null;
        return item && item.stId ? item.stId : null;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        const s = this.settings;
        s.statusTimeline.reveal();
        s.codexTheme.reveal();
        const loc = (dd: { items: Array<{ displayName: unknown; displayNameKey?: string }> }) => dd.items.forEach(i => { if (i.displayNameKey) i.displayName = this.t(i.displayNameKey); });
        const st = s.statusTimeline;
        [st.style, st.sortStrips, st.stateOrder, st.timeGrain, st.durationUnit].forEach(dd => loc(dd as unknown as { items: Array<{ displayName: unknown; displayNameKey?: string }> }));
        return this.settingsService.buildFormattingModel(s);
    }

    public destroy(): void {
        // Drop the in-flight licence check FIRST: its redraw callback replays update().
        this.licenseGate.dispose();
        this.destroyed = true;
        if (this.target) this.target.removeEventListener("contextmenu", this.onContextMenu);
        while (this.root && this.root.firstChild) this.root.removeChild(this.root.firstChild);
        this.rows = [];
        this.model = null;
        this.root = null;
        this.target = null;
    }
}
