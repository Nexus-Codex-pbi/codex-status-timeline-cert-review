"use strict";

/**
 *  Power BI model format string → the text Power BI prints for a number.
 *
 *  THE REFERENCE is powerbi-visuals-utils-formattingutils 6.1.2
 *  (`valueFormatter.format(value, format, undefined, locale)`), the library
 *  Microsoft's own visuals format with. A custom pattern is read here the way
 *  that library reads it, step for step (section choice, scaling, rounding,
 *  digit placement). The aim is that a measure prints the same text in this
 *  suite as in a table beside it; that is checked against the library, not
 *  against Power BI Desktop. The library itself is deliberately NOT bundled:
 *  a runtime package in every visual is a certification-surface change. This
 *  file is a pure function over a string, checked against the library's
 *  recorded output (`_shared/tests/numberFormat.sweep.cjs`).
 *
 *  DELIBERATE DIFFERENCES from the reference. Each is a named class in the
 *  sweep test, which states the exact text expected for every pair it runs:
 *    - finite-not-infinity: a finite value never prints as infinity (percent
 *      of a value near the top of the double range prints its digits; an
 *      exponent pattern moves the power of ten in the text).
 *    - empty-section-keeps-value: an EMPTY section (no characters at all)
 *      does not blank a non-zero value. A negative value is sent through the
 *      positive section with its sign (`0.0;;"flat"` prints -3.5 as "-3.5";
 *      reference: ""); where that section has no digit placeholder either,
 *      and for a positive value with an empty positive section, the value
 *      prints as it does with no format. What the positive section then
 *      prints is its own business: `#;` prints -0.1 as "", as it prints 0.1.
 *      An empty ZERO section does print nothing, and a section of spaces
 *      prints its spaces, as the reference does.
 *    - integer-digits-kept: `.00` keeps the integer digits (the reference
 *      prints 1234.5 as ".50").
 *    - no-format-trimmed / named-format-prints-value: with no format string
 *      the reference prints the double's shortest round-trip digits; given
 *      the NAME of a predefined format (General, General Number, Currency,
 *      Fixed, Standard, Percent, Scientific, Yes/No, True/False, On/Off,
 *      spaces around it allowed) it prints the name in place of the number.
 *      ("Currency" is the exception: see CURRENCY below.)
 *      Both print the value here, in the reference's notation (plain from
 *      0.0001 up to 1e15, exponent outside) with the digits trimmed: at most
 *      three decimals, three significant digits below 0.001, four in exponent
 *      notation, no thousands separator (owner decision 2026-11-20). Any
 *      other word prints as the reference prints it, letter for letter.
 *    - unsigned-exponent-keeps-digits / lowercase-exponent-rounds: see
 *      scientificSection.
 *    - parenthesised-scaling-comma: a scaling comma closing a parenthesised
 *      section scales (`#,0,;(#,0,)`), so both signs of one measure read at
 *      the same magnitude. Spaces outside the parentheses do not change that.
 *    - standard strings: a value that rounds to zero carries no sign
 *      (standard-negative-zero); `D` pads a negative integer
 *      (d-pads-negative); `X` never prints "undefined"
 *      (hex-never-undefined); `F` prints digits, never "1e+21"
 *      (standard-wide-digits); under N, C and P a value below 0.000001
 *      prints its shortest decimal digits rounded half up to the requested
 *      places (standard-small-digits: the reference prints 0.00000015 as
 *      "1.00000005" under N8).
 *    - decimal-text-rounding (owner's Desktop pass 2026-11-24): below 1e15 a
 *      value rounds in the decimal text of its 15 significant digits, half
 *      away from zero, not in the binary double (864.15 under `#,0.0` prints
 *      "864.2"; the reference prints "864.1"). Custom sections, N, C, P, F.
 *    - c-prints-number (same pass): a bare `C` or `c` prints as `0.00`
 *      ("-431.00"); the reference prints "($431.00)".
 *  A non-finite value prints "NaN", "+Infinity" or "-Infinity" with no unit,
 *  as the reference does.
 *
 *  CURRENCY (owner rule 2026-11-22, "Currency should always be 2 decimal").
 *  Three more deliberate differences, each a named class in the sweep, with
 *  its expected texts in `numberFormat.sweep.currency.json`:
 *    - currency-named-two-decimals: the predefined name "Currency" prints as
 *      `C` does (symbol, separators, 2 decimals, the culture's negative form);
 *      the reference prints the word.
 *    - locale-tag-currency: a locale tag `[$€-407]` prints its symbol (the
 *      text between `[$` and the first `-` or `]`; `[$-409]` prints nothing)
 *      where it stands, as a quoted literal would; the reference reads the
 *      tag's digits as placeholders ("[$€-447]2.50" for 42.5). The decimal
 *      point and separator stay the host locale's, as everywhere here.
 *    - currency-units-two-decimals: under display units
 *      (`formatModelNumberInUnits`) a currency format prints 2 decimals and
 *      the unit follows the digits ("$1.23M", "($1.23M)", "1.23M €").
 *  `KEEP_AUTHOR_CURRENCY_DECIMALS` holds the one exception: an author's own
 *  decimal count (`$#,0`, `C0`) is kept outside display units.
 *
 *  DISPLAY UNITS (owner rulings 2026-11-22), expected texts in
 *  `numberFormat.sweep.compact.json`:
 *    - units-compact-currency: `formatModelNumberInUnitsCompact`, for text
 *      inside a plot, drops a currency value's trailing fraction zeros under
 *      display units ("$500K", "$12.5K", "$1.58M"); everything else prints
 *      as `formatModelNumberInUnits`.
 *    - units-one-unit: under display units the display unit is the only
 *      unit; the format's own scaling commas and unit literal are dropped
 *      (`#,0.00,,"M"` reads "1.58M" under M, never "MM"). Outside display
 *      units such a format prints as the reference prints it ("1,580,000M").
 *
 *  LOCALES. The suite ships in English: en-US, en-GB, en-AU, en-CA, en-NZ and
 *  en-IE are the supported cultures, and the ones whose standard strings are
 *  checked against the reference. The decimal point and the thousands
 *  separator are the host's for the locale, and the digits are Latin
 *  whatever digits the locale writes; a standard letter this file does not
 *  know prints the host's own text for the locale, digits included. Currency
 *  (`C`) takes its symbol and negative form from the reference for those six
 *  cultures; any other locale prints the en-US symbol and form around its own
 *  marks.
 *
 *  History: six visuals each carried a hand-rolled copy that read ONE decimal
 *  count from the pattern (`0.##` printed 12.34 as "12"); later rounds added
 *  literals, scaling commas, exponents and placement one class at a time, and
 *  every independent review found another class. Round 4 (2026-11-20) replaced
 *  the stack of special cases with the reference's own reading.
 */

/** Digits after the decimal point that a model format requires / permits. */
export function fractionDigitsFor(format: string | null | undefined): { min: number; max: number } {
    if (!format) return { min: 0, max: 0 };
    // First fraction section only, so multi-section formats
    // ("0.00%;-0.00%;0.00%") keep reading their positive section.
    const dm = format.match(/\.([0#]+)/);
    if (!dm) return { min: 0, max: 0 };
    const section = dm[1];
    const min = (section.match(/0/g) || []).length;
    const optional = (section.match(/#/g) || []).length;
    return { min, max: min + optional };
}

/** Sections of a format, split on `;` outside quotes and escapes. */
export function numericSections(format: string): string[] {
    const sections: string[] = [];
    let start = 0;
    let quote = "";
    for (let i = 0; i < format.length; i++) {
        const c = format[i];
        if (quote) {
            if (c === quote) quote = "";
        } else if (c === "\\") {
            i++;
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if (c === ";") {
            sections.push(format.slice(start, i));
            start = i + 1;
        }
    }
    sections.push(format.slice(start));
    return sections;
}

const STANDARD_FORMAT = /^[a-z]\d{0,2}$/i;
// The names DAX gives its predefined numeric formats. A name is not a pattern.
const NAMED_FORMAT = /^ *(general( number)?|currency|fixed|standard|percent|scientific|yes\/no|true\/false|on\/off) *$/i;
const SCIENTIFIC_FORMAT = /e[+-]*[0#]+/i;
const CURRENCY_NAME = /^ *currency *$/i;
/**
 *  What a bare `C` (or `c`) prints as (c-prints-number). MEASURED (owner, Power BI Desktop 2.159,
 *  2026-11-24): a measure formatted "C" at -431 prints "-431.00" in the built-in Table, no symbol,
 *  no brackets. INFERRED, not measured: no thousands separator (as with no format string), and the
 *  same reading under display units. `C0`..`C99` and the name "Currency" are unchanged.
 */
const C_AS_PRINTED = "0.00";
/** A currency sign in a custom section: $, the cent/pound/currency/yen signs and the Unicode currency block. */
const CURRENCY_MARK = /[$¢-¥₠-⃏]/;

/**
 *  THE EXCEPTION to "currency prints 2 decimals" (coordinator's recommendation,
 *  owner may veto). true: an author's explicit decimal count in a currency
 *  format is kept (`$#,0` prints "$43", `C0` prints "$43", `C3` "$42.500").
 *  VETO = set this to false: then `C` with any digit count, and every custom
 *  section that carries a currency sign or a locale-tag symbol, prints exactly
 *  2 decimals. Display units always print 2 decimals for currency, whatever
 *  this says.
 */
const KEEP_AUTHOR_CURRENCY_DECIMALS: boolean = true;

/**
 *  Format a finite number with a Power BI model format string.
 *
 *  `locale` supplies the decimal point and the thousands separator; undefined
 *  means the host default. Callers keep their own null guard; a non-finite
 *  number prints as "NaN", "+Infinity" or "-Infinity".
 */
export function formatModelNumber(n: number, format: string | null | undefined, locale?: string): string {
    return formatCore(n, format, locale, undefined);
}

/**
 *  A number under display units: `n / divisor` printed through the format with
 *  `suffix` ("K", "M", "B") right after the digits, so a symbol or bracket
 *  after the number stays outside it ("($1.23M)", "1.23M €"). A currency
 *  format prints 2 decimals here (owner rule 2026-11-22), even where the
 *  pattern asks for none: the author's count was for unscaled units. Other
 *  formats keep their own decimals. The display unit is the only unit: the
 *  format's own scaling commas and unit literal are dropped (`#,0.00,,"M"`
 *  prints 1,580,000 under M as "1.58M", not "1.58M,,M"; see withoutOwnUnits).
 *  `divisor` 1 with no suffix, a divisor that is not a positive finite number,
 *  or a non-finite value prints exactly as `formatModelNumber`.
 */
export function formatModelNumberInUnits(n: number, format: string | null | undefined, divisor: number, suffix: string, locale?: string): string {
    return inUnits(n, format, divisor, suffix, locale, false);
}

/**
 *  `formatModelNumberInUnits` for text inside a plot (axis ticks, data
 *  labels), where width is scarce (owner rule 2026-11-22, "drop the decimals
 *  inside the chart only under K/M/B"): under display units a currency value
 *  drops trailing fraction zeros, keeping at most 2 decimals ("$500K",
 *  "$12.5K", "$1.58M", "($18K)"). Every other output, and every output with
 *  no display units, is exactly `formatModelNumberInUnits`. Tooltips, cards
 *  and screen-reader text keep `formatModelNumberInUnits` (2 decimals).
 */
export function formatModelNumberInUnitsCompact(n: number, format: string | null | undefined, divisor: number, suffix: string, locale?: string): string {
    return inUnits(n, format, divisor, suffix, locale, true);
}

function inUnits(n: number, format: string | null | undefined, divisor: number, suffix: string, locale: string | undefined, compact: boolean): string {
    if (typeof n !== "number" || !isFinite(n) || !(divisor > 0) || !isFinite(divisor) || (divisor === 1 && !suffix)) {
        return formatModelNumber(n, format, locale);
    }
    return formatCore(n / divisor, format, locale, suffix || "", compact);
}

/**
 *  `units` undefined: no display units. A string (possibly empty): under display units, with that suffix.
 *  `compact` (display units only): a currency value drops trailing fraction zeros.
 */
function formatCore(n: number, format: string | null | undefined, locale: string | undefined, units: string | undefined, compact = false): string {
    if (typeof n !== "number") return String(n);
    if (!isFinite(n)) return isNaN(n) ? "NaN" : n > 0 ? "+Infinity" : "-Infinity";
    const unit = units || "";
    const trim = compact && units !== undefined;
    // The predefined name "Currency" prints as C does (owner rule 2026-11-22).
    if (format && CURRENCY_NAME.test(format)) return standardNumber(n, "C", locale, units, trim);
    // A bare `C` prints as Power BI Desktop's table prints it: a number with 2 decimals, no symbol (c-prints-number).
    if (format === "C" || format === "c") return formatCore(n, C_AS_PRINTED, locale, units, compact);
    // No format, or the name of a predefined format, which is not a pattern.
    if (!format || NAMED_FORMAT.test(format)) return plainNumber(n, locale) + unit;
    if (STANDARD_FORMAT.test(format)) {
        const text = standardNumber(n, format, locale, units, trim);
        return unit && format.charAt(0).toUpperCase() !== "C" ? afterLastDigit(text, unit) : text;
    }

    // positive[;negative[;zero]]: chosen by the sign of the value itself, and
    // an explicit negative section prints the magnitude as that section says.
    const sections = numericSections(format);
    const explicit = sections.length > 1;
    let section = n > 0 ? sections[0] : n === 0 ? (sections.length > 2 ? sections[2] : sections[0]) : explicit ? sections[1] : sections[0];
    let value = explicit ? Math.abs(n) : n;
    if (explicit && n !== 0 && section === "") {
        // An empty section does not blank a non-zero value.
        if (n > 0 || !symbolsOf(sections[0]).some(isPlaceholder)) return plainNumber(n, locale) + unit;
        section = sections[0];
        value = n;
    }
    let symbols = symbolsOf(section);
    const exponent = SCIENTIFIC_FORMAT.exec(symbols.map((s) => (s.lit ? "\uE100" : s.c)).join(""));
    if (exponent) return scientificSection(value, symbols, exponent.index, locale) + unit;
    if (units !== undefined) symbols = withoutOwnUnits(symbols, unit);
    if ((units !== undefined || !KEEP_AUTHOR_CURRENCY_DECIMALS) && isCurrencySection(symbols)) symbols = withTwoDecimals(symbols, trim ? "#" : "0");
    if (unit) symbols = withSuffix(symbols, unit);
    return customSection(value, symbols, locale);
}

/** A literal that names a unit of scale (spaces trimmed). Lowercase m, b and t stay: metres, bytes, tonnes. */
const UNIT_LITERAL = /^(?:K|k|M|B|T|MM|bn|Bn|BN|mn|Mn|MN|tn|Tn)$/;

/**
 *  Under display units the display unit is the only unit (owner report
 *  2026-11-22: `#,0,,"M"` printed "1.58MM"): every raw comma, and every
 *  literal whose text is a unit (UNIT_LITERAL, or the display-unit suffix
 *  itself), standing after the digits (right of the last integer digit
 *  placeholder and before the point, or right of the last digit
 *  placeholder) is dropped. Thousands-separator commas, a comma between
 *  decimal digits, other literals and locale-tag symbols stay. Outside
 *  display units nothing changes: `#,0,,"M"` prints "1,580,000M" as the
 *  reference and Desktop's table do.
 */
function withoutOwnUnits(symbols: FormatSymbol[], suffix: string): FormatSymbol[] {
    const dot = symbols.findIndex((s) => !s.lit && s.c === ".");
    const end = dot < 0 ? symbols.length : dot;
    let lastWhole = -1;
    let lastAny = -1;
    symbols.forEach((s, i) => {
        if (!isPlaceholder(s)) return;
        lastAny = i;
        if (i < end) lastWhole = i;
    });
    const named = suffix.trim();
    return symbols.filter((s, i) => {
        if (i <= lastWhole || (i > end && i < lastAny)) return true;
        if (!s.lit) return s.c !== ",";
        const text = s.c.trim();
        return s.currency === true || text === "" || !(UNIT_LITERAL.test(text) || text === named);
    });
}

/** A currency section: a currency sign outside the digit placeholders, or a locale tag with a symbol. */
function isCurrencySection(symbols: FormatSymbol[]): boolean {
    return symbols.some((s) => s.currency === true || (!isPlaceholder(s) && CURRENCY_MARK.test(s.c)));
}

/**
 *  The section with exactly two decimal places: `$#,0` \u2192 `$#,0.00`, `$#,0.###` \u2192 `$#,0.00`; literals kept.
 *  `digit` "#" (compact): two optional places, `$#,0.##`, so trailing zeros and a bare point drop.
 */
function withTwoDecimals(symbols: FormatSymbol[], digit: "0" | "#" = "0"): FormatSymbol[] {
    const isDot = (s: FormatSymbol): boolean => !s.lit && s.c === ".";
    const two: FormatSymbol[] = [{ c: digit, lit: false }, { c: digit, lit: false }];
    const dot = symbols.findIndex(isDot);
    if (dot >= 0) {
        let end = symbols.length;
        for (let i = dot + 1; i < symbols.length; i++) if (isDot(symbols[i])) { end = i; break; }
        const literals = symbols.slice(dot + 1, end).filter((s) => !isPlaceholder(s));
        return symbols.slice(0, dot + 1).concat(two, literals, symbols.slice(end));
    }
    let last = -1;
    symbols.forEach((s, i) => { if (isPlaceholder(s)) last = i; });
    if (last < 0) return symbols;
    // Scaling commas right after the last digit stay left of the new point, so they still scale.
    let at = last + 1;
    while (at < symbols.length && !symbols[at].lit && symbols[at].c === ",") at++;
    return symbols.slice(0, at).concat([{ c: ".", lit: false }], two, symbols.slice(at));
}

/** The display-unit suffix as a literal right after the last digit placeholder (at the end if there is none). */
function withSuffix(symbols: FormatSymbol[], suffix: string): FormatSymbol[] {
    let last = -1;
    symbols.forEach((s, i) => { if (isPlaceholder(s)) last = i; });
    const at = last < 0 ? symbols.length : last + 1;
    return symbols.slice(0, at).concat([{ c: suffix, lit: true }], symbols.slice(at));
}

/** `suffix` after the last digit of a printed text (at the end if it has none). */
function afterLastDigit(text: string, suffix: string): string {
    const m = /\d(?!.*\d)/.exec(text);
    return m ? text.slice(0, m.index + 1) + suffix + text.slice(m.index + 1) : text + suffix;
}

interface LocaleMarks { point: string; group: string; }

const marksByLocale = new Map<string, LocaleMarks>();

/**
 *  The locale's decimal point and thousands separator, read once per locale
 *  from the host's number parts with Latin digits (a locale whose own digits
 *  are not Latin would otherwise hand back a digit as its separator). A
 *  locale the host does not know prints with English marks.
 */
function localeMarks(locale?: string): LocaleMarks {
    const key = locale || "";
    let marks = marksByLocale.get(key);
    if (!marks) {
        marks = { point: ".", group: "," };
        try {
            const parts = new Intl.NumberFormat(locale, { numberingSystem: "latn", useGrouping: true }).formatToParts(12345678.5);
            for (const part of parts) {
                if (part.type === "decimal") marks.point = part.value;
                else if (part.type === "group") marks.group = part.value;
            }
        } catch {
            // not a locale: English marks
        }
        if (marksByLocale.size >= 64) marksByLocale.clear();
        marksByLocale.set(key, marks);
    }
    return marks;
}

/** The host's own text for a number, for a format letter this file does not know. */
function hostText(n: number, locale?: string): string {
    try {
        return n.toLocaleString(locale);
    } catch {
        return n.toLocaleString("en-US");
    }
}

/**
 *  No format string. The reference prints every digit of the double in plain
 *  notation from 0.0001 up to 1e15 and exponent notation outside it; this
 *  keeps the same switch points and trims the digits: at most three decimals,
 *  three significant digits below 0.001 ("0.0004"), and at most three mantissa
 *  decimals in exponent notation ("1.235E+20", "5E-5"). No thousands separator.
 */
function plainNumber(n: number, locale?: string): string {
    if (n === 0) return "0";
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const point = localeMarks(locale).point;
    if (abs < 1e-4 || abs >= 1e15) {
        // Four significant digits. Rounded through a number where that stays finite (the
        // smallest doubles keep their short text); in the text itself at the top of the range.
        const rounded = Number(abs.toPrecision(4));
        const parts = (isFinite(rounded) ? rounded.toExponential() : abs.toExponential(3)).split("e");
        return sign + parts[0].replace(/\.0+$|(\.\d*?)0+$/, "$1").replace(".", point) + "E" + parts[1];
    }
    if (abs < 0.001) return sign + Number(abs.toPrecision(3)).toFixed(7).replace(/0+$/, "").replace(".", point);
    // Through Number(): past twelve integer digits toFixed(3) prints digits the double does not hold.
    const text = String(Number(abs.toFixed(3)));
    return (text === "0" ? "" : sign) + text.replace(".", point);
}

/** Thousands separators into a run of integer digits. */
function grouped(digits: string, group: string): string {
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

/** "1234.50" → "1,234.50" in the locale's marks; the input uses "." and no sign. */
function localised(fixed: string, marks: LocaleMarks, group: boolean): string {
    const split = fixed.split(".");
    const whole = group ? grouped(split[0], marks.group) : split[0];
    return split.length > 1 ? whole + marks.point + split[1] : whole;
}

/** |x| as plain digits: JavaScript's shortest text for the double, exponent notation written out. */
function expandedText(x: number): { whole: string; right: string } {
    const split = String(x).split("e");
    const mantissa = split[0].split(".");
    let whole = mantissa[0];
    let right = mantissa.length > 1 ? mantissa[1] : "";
    const exponent = split.length > 1 ? parseInt(split[1], 10) : 0;
    if (exponent > 0) {
        right = right.padEnd(exponent, "0");
        whole += right.slice(0, exponent);
        right = right.substring(exponent);
    } else if (exponent < 0) {
        right = "0".repeat(-exponent - 1) + whole + right;
        whole = "0";
    }
    return { whole, right };
}

/** Plain decimal digits rounded half up to `precision` decimals, in the text (no arithmetic on a double). */
function roundedText(whole: string, right: string, precision: number): string {
    if (right.length <= precision) return precision > 0 ? whole + "." + right.padEnd(precision, "0") : whole;
    const kept = (whole + right.slice(0, precision)).split("");
    if (right.charAt(precision) >= "5") {
        let i = kept.length - 1;
        while (i >= 0 && kept[i] === "9") kept[i--] = "0";
        if (i >= 0) kept[i] = String(Number(kept[i]) + 1);
        else kept.unshift("1");
    }
    const all = kept.join("");
    return precision > 0 ? all.slice(0, all.length - precision) + "." + all.slice(all.length - precision) : all;
}

/**
 *  |x| below 1e15 as Power BI rounds it (decimal-text-rounding): the decimal text of its 15
 *  significant digits (as Excel and .NET Framework show a double), `shift` places up (moved in the
 *  text, so 0.0125 at two places up is exactly "1.25"), then rounded half away from zero at
 *  `precision` decimals in that text. MEASURED (owner, Desktop 2.159, 2026-11-24): 864.15 under
 *  "#,0.0" prints "864.2", and DAX FORMAT(864.15, "#,0.0") also "864.2"; the double is
 *  864.1499999999999773 and the reference library prints "864.1". Plain digits, no sign.
 */
function decimalRounded(abs: number, shift: number, precision: number): string {
    const digits = expandedText(Number(abs.toPrecision(15)));
    let whole = digits.whole;
    let right = digits.right;
    if (shift > 0) {
        right = right.padEnd(shift, "0");
        whole += right.slice(0, shift);
        right = right.slice(shift);
    } else if (shift < 0) {
        whole = whole.padStart(1 - shift, "0");
        right = whole.slice(whole.length + shift) + right;
        whole = whole.slice(0, whole.length + shift);
    }
    whole = whole.replace(/^0+(?=\d)/, "");
    return roundedText(whole, right, Math.max(0, precision));
}

/** Below this magnitude a double has at most 15 integer digits and decimalRounded applies. */
const DECIMAL_LIMIT: number = 1e15;

/**
 *  N, C and P (`percent`: the value two places up) round as custom patterns
 *  do below 1e15 (decimal-text-rounding: 1.005 is "1.01" under N2 and under
 *  `0.00`). From 1e15 up they round the way the reference does:
 *  `Math.round(x * 10^p) / 10^p`, then the shortest text of that double cut or
 *  zero-filled to `p` decimals.
 *
 *  Below 0.000001 the reference's text is wrong (it pads the exponent form on
 *  the wrong side: 1.5e-7 prints "1.00000005"), and a double cannot carry the
 *  rounding either (1e-25 * 1e25 / 1e25 is 9.999999999999999e-26). There the
 *  value's shortest decimal digits are rounded half up in the text, so a
 *  value that fits the requested places prints unchanged.
 */
function roundedStandard(abs: number, precision: number, percent: boolean): string {
    const digits = expandedText(abs);
    if (percent) {
        const right = digits.right.padEnd(2, "0");
        digits.whole = (digits.whole + right.slice(0, 2)).replace(/^0+(?=\d)/, "");
        digits.right = right.slice(2);
    }
    if (digits.whole === "0" && digits.right.slice(0, 6) === "000000" && /[1-9]/.test(digits.right)) {
        return roundedText("0", digits.right, Math.max(0, precision));
    }
    if ((percent ? abs * 100 : abs) < DECIMAL_LIMIT) return decimalRounded(abs, percent ? 2 : 0, precision);
    const x = percent ? abs * 100 : abs;
    const factor = Math.pow(10, precision);
    let rounded = Math.round(x * factor) / factor;
    if (!isFinite(rounded)) rounded = x;
    const text = expandedText(rounded);
    if (precision <= 0) return text.whole;
    // Never longer than `precision`: through 22 places 10^p is exact and the
    // quotient of an integer by it round-trips in p decimals; from 23 places a
    // value of 0.000001 or more has at most 23 decimals in its shortest text.
    return text.whole + "." + text.right.padEnd(precision, "0");
}

/** Currency symbol and negative form per culture, from the reference's table. */
const CURRENCY: { [locale: string]: { symbol: string; parenthesised: boolean } } = {
    "en-US": { symbol: "$", parenthesised: true },
    "en-GB": { symbol: "\u00A3", parenthesised: false },
    "en-AU": { symbol: "$", parenthesised: false },
    "en-CA": { symbol: "$", parenthesised: false },
    "en-NZ": { symbol: "$", parenthesised: false },
    "en-IE": { symbol: "\u20AC", parenthesised: false },
};

/**
 *  .NET standard format strings (one letter, up to two precision digits), as
 *  the reference prints them: N grouped, C currency in the culture's form,
 *  P percent with a space before the sign, F fixed, D padded integer, E
 *  exponent with three exponent digits, G general, R round-trip, X
 *  hexadecimal. Any other letter prints the host's own text for the number.
 */
function standardNumber(n: number, format: string, locale?: string, units?: string, compact = false): string {
    const letter = format.charAt(0);
    const given = format.length > 1 ? parseInt(format.slice(1), 10) : undefined;
    const places = given === undefined ? 2 : given;
    const marks = localeMarks(locale);
    const abs = Math.abs(n);
    const point = (s: string): string => (marks.point === "." ? s : s.replace(".", marks.point));
    // A sign is printed only beside a digit that is not zero.
    const negative = (body: string): boolean => n < 0 && /[1-9]/.test(body);
    try {
        switch (letter.toUpperCase()) {
            case "N": {
                const body = localised(roundedStandard(abs, places, false), marks, true);
                return negative(body) ? "-" + body : body;
            }
            case "C": {
                const culture = (locale !== undefined && Object.prototype.hasOwnProperty.call(CURRENCY, locale) && CURRENCY[locale]) || CURRENCY["en-US"];
                // 2 decimals unless the author gave a count (and the exception keeps it); always 2 under display units.
                const currencyPlaces = given === undefined || units !== undefined || !KEEP_AUTHOR_CURRENCY_DECIMALS ? 2 : given;
                let digits = roundedStandard(abs, currencyPlaces, false);
                // Compact (display units only): trailing fraction zeros drop ("500.00" -> "500", "12.50" -> "12.5").
                if (compact) digits = digits.replace(/\.0+$|(\.\d*?)0+$/, "$1");
                const body = culture.symbol + localised(digits, marks, true) + (units || "");
                if (!negative(body)) return body;
                return culture.parenthesised ? `(${body})` : "-" + body;
            }
            case "P": {
                // At the top of the double range the product is infinite: the digits N prints, two places up.
                const body = localised(isFinite(abs * 100) ? roundedStandard(abs, places, true) : expandedText(abs).whole + "00" + (places > 0 ? "." + "0".repeat(places) : ""), marks, true);
                return (negative(body) ? "-" + body : body) + " %";
            }
            case "F": {
                // toFixed, as the reference; past 1e21 toFixed answers "1e+21", so the digits are written out.
                const body = abs < DECIMAL_LIMIT ? decimalRounded(abs, 0, places) : abs < 1e21 ? abs.toFixed(places) : expandedText(abs).whole + (places > 0 ? "." + "0".repeat(places) : "");
                return point(negative(body) ? "-" + body : body);
            }
            case "D": {
                // Zero-padded to the given length. The reference pads the plain text of a
                // positive value only; a negative integer is padded here as .NET pads it.
                const pad = (t: string): string => (given !== undefined && t.length < given ? "0".repeat(given - t.length) + t : t);
                if (n < 0) return Math.floor(n) === n && abs < 1e21 ? "-" + pad(abs.toString()) : point(n.toString());
                return point(pad(abs.toString()));
            }
            case "E": {
                const pattern = symbolsOf("0." + "0".repeat(given === undefined ? 6 : given) + letter + "+000");
                return scientificSection(n, pattern, pattern.length - 5, locale);
            }
            case "G": {
                if (abs === 0 || (1e-4 <= abs && abs < 1e15)) return point(given !== undefined ? n.toPrecision(given) : n.toString());
                return point((given !== undefined ? n.toExponential(given) : n.toExponential()).replace("e", "E"));
            }
            case "R":
                return point(n.toString());
            case "X": {
                let hex = abs.toString(16);
                if (letter === "X") hex = hex.toUpperCase();
                if (given !== undefined && hex.length < given) hex = "0".repeat(given - hex.length) + hex;
                return (n < 0 ? "-" : "") + point(hex);
            }
            default:
                return hostText(n, locale);
        }
    } catch {
        return hostText(n, locale);
    }
}

interface FormatSymbol { c: string; lit: boolean; currency?: boolean; }

function isPlaceholder(s: FormatSymbol): boolean {
    return !s.lit && (s.c === "0" || s.c === "#");
}

/**
 *  One section as pattern characters and literal runs: "…", '…' and \x are
 *  literals; an unterminated quote runs to the end of the section and a
 *  trailing backslash is dropped (.NET and the reference do the same).
 *  A locale tag `[$€-407]` is its symbol as a literal (see locale-tag-currency
 *  in the header); a `[` not followed by `$`, or with no closing `]`, is not.
 */
function symbolsOf(section: string): FormatSymbol[] {
    const out: FormatSymbol[] = [];
    for (let i = 0; i < section.length; i++) {
        const c = section[i];
        const close = c === "[" && section[i + 1] === "$" ? section.indexOf("]", i + 2) : -1;
        if (close >= 0) {
            const body = section.slice(i + 2, close);
            const dash = body.indexOf("-");
            const symbol = dash < 0 ? body : body.slice(0, dash);
            out.push({ c: symbol, lit: true, currency: symbol !== "" });
            i = close;
        } else if (c === "\\") {
            out.push({ c: i + 1 < section.length ? section[i + 1] : "", lit: true });
            i++;
        } else if (c === '"' || c === "'") {
            const close = section.indexOf(c, i + 1);
            const end = close < 0 ? section.length : close;
            out.push({ c: section.slice(i + 1, end), lit: true });
            i = end;
        } else {
            out.push({ c, lit: false });
        }
    }
    return out;
}

const POWERS_OF_TEN = [1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15];

/** Integer digits of |value| minus one, as the reference counts them. */
function wholeDigits(abs: number): number {
    if (abs < 1e16) {
        let k = 0;
        while (k < 15 && abs >= POWERS_OF_TEN[k + 1]) k++;
        return k;
    }
    const x = Math.log(abs) / Math.log(10);
    const rounded = Math.round(x);
    return Math.abs(x - rounded) < 0.0001 ? rounded : Math.floor(x);
}

/**
 *  Fixed-point text at `precision` decimals, the reference's way: a double
 *  carries about sixteen significant digits, so decimals past them are zeros,
 *  and a value past sixteen integer digits prints its sixteen digits then
 *  zeros (never JavaScript's "1e+21").
 */
function fixedText(value: number, precision: number): string {
    let result: string;
    let zeros = 0;
    if (precision > 16) {
        zeros = precision - 16;
        precision = 16;
    }
    const digits = wholeDigits(Math.abs(value));
    if (digits < 16) {
        if (digits > 0) {
            const most = 16 - digits;
            if (precision > most) {
                zeros += precision - most;
                precision = most;
            }
        }
        result = value.toFixed(precision);
    } else if (digits === 16) {
        result = value.toFixed(0);
        zeros += precision;
        if (zeros > 0) result += ".";
    } else {
        result = value.toExponential(15);
        const e = result.indexOf("e");
        if (e > 0) {
            const dot = result.indexOf(".");
            const mantissa = result.substring(0, e);
            const power = parseInt(result.substring(e + 1), 10) - (mantissa.length - dot - 1);
            result = mantissa.replace(".", "") + "0".repeat(Math.max(0, power));
            if (precision > 0) result += "." + "0".repeat(precision);
        }
    }
    if (zeros > 0) result += "0".repeat(zeros);
    return result;
}

/**
 *  `|value| * scale` as digits when the product leaves the double range
 *  (0.0%-style patterns on a value above about 1.8e306). `scale` is then a
 *  power of ten above one, so the decimal exponent moves in the text and the
 *  result is an integer followed by `precision` zero decimals.
 */
function shiftedDigits(value: number, scale: number, precision: number): string {
    const parts = Math.abs(value).toExponential(15).split("e");
    const exponent = Number(parts[1]) + Math.round(Math.log(scale) / Math.LN10);
    const mantissa = parts[0].replace(".", "");
    const whole = mantissa + "0".repeat(Math.max(0, exponent + 1 - mantissa.length));
    return (value < 0 ? "-" : "") + whole + (precision > 0 ? "." + "0".repeat(precision) : "");
}

/**
 *  One custom section, read as the reference reads it:
 *    - `%` multiplies by 100 and `‰` by 1000, wherever they stand unquoted;
 *    - each comma immediately left of the decimal point, or closing the
 *      section, divides by 1000 (and, here only, one closing a parenthesised
 *      section: see the header);
 *    - the value is rounded to the count of placeholders after the point;
 *    - integer digits fill the placeholders from the right, surplus digits
 *      join the first one, a comma left of the last integer placeholder turns
 *      thousands separators on, and every other character prints where it
 *      was written (commas after the point included).
 */
function customSection(value: number, symbols: FormatSymbol[], locale?: string): string {
    const count = symbols.length;
    const isRaw = (i: number, c: string): boolean => i >= 0 && i < count && !symbols[i].lit && symbols[i].c === c;
    let dot = -1;
    let secondDot = -1;
    let parts = 1;
    let percent = false;
    let permille = false;
    for (let i = 0; i < count; i++) {
        if (symbols[i].lit) continue;
        const c = symbols[i].c;
        if (c === ".") {
            if (dot < 0) dot = i;
            else if (secondDot < 0) secondDot = i;
        } else if (c === "%") {
            percent = true;
        } else if (c === "‰") {
            permille = true;
        }
    }
    if (percent) parts *= 100;
    if (permille) parts *= 1000;

    let anchor = dot < 0 ? count : dot;
    if (dot < 0) {
        const space = (i: number): boolean => !symbols[i].lit && /\s/.test(symbols[i].c);
        let first = 0;
        let last = count - 1;
        while (first < count && space(first)) first++;
        while (last >= 0 && space(last)) last--;
        if (first < last && isRaw(first, "(") && isRaw(last, ")")) anchor = last;
    }
    let scale = parts;
    for (let i = anchor - 1; isRaw(i, ","); i--) scale = scale / 1000;

    let precision = 0;
    if (dot >= 0) {
        for (let i = dot; i < count; i++) {
            if (symbols[i].lit) continue;
            if (symbols[i].c === "0" || symbols[i].c === "#") precision++;
            if (symbols[i].c === "E") break;
        }
        precision = Math.min(19, precision);
    }

    let text: string;
    const scaled = scale !== 1 ? value * scale : value;
    if (!isFinite(scaled)) {
        text = shiftedDigits(value, scale, precision);
    } else {
        const shift = Math.round(Math.log(scale) / Math.LN10);
        const decimal = Math.abs(value) < DECIMAL_LIMIT && Math.abs(scaled) < DECIMAL_LIMIT && Math.abs(Math.pow(10, shift) / scale - 1) < 1e-9;
        text = decimal ? (value < 0 ? "-" : "") + decimalRounded(Math.abs(value), shift, precision) : fixedText(scaled, precision);
        const rounded = parseFloat(text);
        if (isFinite(rounded)) text = fixedText(rounded, precision);
    }

    return fuse(text, symbols, localeMarks(locale));
}

/**
 *  A rounded number (plain digits, "." for the point) into one run of format
 *  symbols: integer digits left of the first point, decimals between it and a
 *  second point (anything after a second point is not printed).
 */
function fuse(text: string, symbols: FormatSymbol[], marks: LocaleMarks): string {
    let dot = -1;
    let secondDot = symbols.length;
    for (let i = 0; i < symbols.length; i++) {
        if (symbols[i].lit || symbols[i].c !== ".") continue;
        if (dot < 0) dot = i;
        else { secondDot = i; break; }
    }
    if (dot < 0) return fuseWhole(text, symbols, marks.group, false);
    const wholeFormat = symbols.slice(0, dot);
    const fractionFormat = symbols.slice(dot + 1, secondDot);
    const split = text.split(".");
    const fraction = fuseFraction((split[1] || "").replace(/0+$/, ""), fractionFormat);
    const whole = fuseWhole(split[0], wholeFormat, marks.group, fractionFormat.some(isPlaceholder));
    return fraction.formatOnly || fraction.text === "" ? whole + fraction.text : whole + marks.point + fraction.text;
}

/**
 *  An exponent section (`0.00E+00`, `#.##e-0`), read as the reference reads
 *  it: the mantissa pattern is everything left of the exponent letter, the
 *  exponent pattern everything right of its sign, and each is filled like a
 *  plain section. A `+` in the pattern always prints the exponent's sign; a
 *  `-` or no sign prints it for negative exponents only. Percent, per-mille
 *  and scaling commas count only where they stand in the mantissa pattern.
 *
 *  Two deliberate differences: with no sign in the pattern the reference
 *  drops the first exponent placeholder (`0.00E0` prints "1.23E"), and under
 *  a lowercase `e` it counts the exponent placeholders as decimals and then
 *  cuts the mantissa instead of rounding it (99.96 prints "9.99e+01").
 */
function scientificSection(value: number, symbols: FormatSymbol[], at: number, locale?: string): string {
    const isRaw = (i: number, c: string): boolean => i >= 0 && i < symbols.length && !symbols[i].lit && symbols[i].c === c;
    const plus = isRaw(at + 1, "+");
    const mantissaFormat = symbols.slice(0, at);
    const exponentFormat = symbols.slice(plus || isRaw(at + 1, "-") ? at + 2 : at + 1);

    let dot = -1;
    for (let i = 0; i < symbols.length && dot < 0; i++) if (isRaw(i, ".")) dot = i;
    let precision = 0;
    if (dot >= 0) {
        for (let i = dot; i < symbols.length; i++) {
            if (i === at || isRaw(i, "E")) break;
            if (isPlaceholder(symbols[i])) precision++;
        }
        precision = Math.min(19, precision);
    }
    let scale = 1;
    if (mantissaFormat.some((s) => !s.lit && s.c === "%")) scale *= 100;
    if (mantissaFormat.some((s) => !s.lit && s.c === "\u2030")) scale *= 1000;
    const anchor = dot >= 0 && dot < at ? dot : at;
    for (let i = anchor - 1; isRaw(i, ","); i--) scale = scale / 1000;
    const scaled = value * scale;

    let parts: string[];
    if (isFinite(scaled)) {
        parts = scaled.toExponential(precision).split("e");
    } else {
        // The product left the double range; the scale is a power of ten, so it moves the exponent.
        parts = value.toExponential(precision).split("e");
        const shifted = Number(parts[1]) + Math.round(Math.log(scale) / Math.LN10);
        parts[1] = (shifted < 0 ? "-" : "+") + Math.abs(shifted);
    }
    const marks = localeMarks(locale);
    let exponent = fuse(parts[1], exponentFormat, marks);
    if (exponent.charAt(0) === "+" && !plus) exponent = exponent.substring(1);
    return fuse(parts[0], mantissaFormat, marks) + symbols[at].c + exponent;
}

/**
 *  Integer digits into the placeholders left of the point, from the right.
 *  `keepWhole`: the section has decimals but no integer placeholder (`.00`);
 *  the integer digits then print ahead of the point instead of vanishing.
 */
function fuseWhole(value: string, format: FormatSymbol[], group: string, keepWhole: boolean): string {
    let firstComma = -1;
    let lastPlaceholder = -1;
    for (let i = 0; i < format.length; i++) {
        if (firstComma < 0 && !format[i].lit && format[i].c === ",") firstComma = i;
        if (isPlaceholder(format[i])) lastPlaceholder = i;
    }
    const groups = firstComma > -1 && firstComma < lastPlaceholder;
    let sign = "";
    if (value.charAt(0) === "-" || value.charAt(0) === "+") {
        sign = value.charAt(0);
        value = value.substring(1);
    }
    const isZero = value === "0";
    let result = "";
    let buffer = "";
    let vi = value.length - 1;
    let inGroup = 0;
    const separate = (): void => {
        if (!groups) return;
        if (inGroup === 3) {
            result = group + result;
            inGroup = 1;
        } else {
            inGroup++;
        }
    };
    for (let fi = format.length - 1; fi > -1; fi--) {
        const s = format[fi];
        if (isPlaceholder(s)) {
            if (buffer !== "") {
                result = buffer + result;
                buffer = "";
            }
            if (vi > -1 || s.c === "0") separate();
            if (vi > -1) {
                // A lone zero is not copied into an optional placeholder.
                if (!(isZero && s.c === "#")) result = value.charAt(vi) + result;
                vi--;
            } else if (s.c === "0") {
                result = "0" + result;
            }
        } else if (s.lit || s.c !== ",") {
            buffer = s.c + buffer;
        }
    }
    if (vi > -1 && (result !== "" || (keepWhole && !isZero && lastPlaceholder < 0))) {
        while (vi > -1) {
            separate();
            result = value.charAt(vi) + result;
            vi--;
        }
    }
    return sign + buffer + result;
}

/** Decimal digits into the placeholders right of the point, from the left. */
function fuseFraction(value: string, format: FormatSymbol[]): { text: string; formatOnly: boolean } {
    let text = "";
    let formatOnly = true;
    let vi = 0;
    for (const s of format) {
        const placeholder = isPlaceholder(s);
        if (vi < value.length) {
            if (placeholder) {
                text += value.charAt(vi++);
                formatOnly = false;
            } else {
                text += s.c;
            }
        } else if (!(placeholder && s.c === "#")) {
            text += s.c;
            formatOnly = formatOnly && !(placeholder && s.c === "0");
        }
    }
    return { text, formatOnly };
}
