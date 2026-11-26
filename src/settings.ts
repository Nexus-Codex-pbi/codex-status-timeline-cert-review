"use strict";

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";

import FormattingSettingsCard = formattingSettings.SimpleCard;
import FormattingSettingsCompositeCard = formattingSettings.CompositeCard;
import FormattingSettingsGroup = formattingSettings.Group;
import FormattingSettingsSlice = formattingSettings.Slice;
import FormattingSettingsModel = formattingSettings.Model;

import { BackgroundSettings } from "./shared/backgroundSettings";
import { CodexThemeSettings } from "./shared/codexThemeSettings";
import { TitleSettings } from "./shared/titleSettings";
import { makeFontControl } from "./shared/textFormatting";
import { LicenceSettings } from "./shared/licenceSettings";
import { PADDING_DEFAULTS, PADDING_MAX, PADDING_MIN } from "./padding";

const ConstantOrRule = powerbi.VisualEnumerationInstanceKinds.ConstantOrRule;

/** Declared colour defaults. A pane value still equal to one of these means "the theme's own
 *  colour" (light accent #0384a3 / dark #00d9ff, the theme's track and ink). */
export const DEFAULT_ACCENT = "#00d9ff";
export const DEFAULT_TRACK = "#e2e4ef";
export const DEFAULT_TEXT = "#14141f";

const item = (value: string, displayName: string, displayNameKey: string) => ({ value, displayName, displayNameKey });

export const STYLE_ITEMS = [
    item("blocks", "Block strips", "Style_Blocks"),
    item("runs", "Runs and state totals", "Style_Runs"),
    item("board", "Current state board", "Style_Board"),
];
const SORT_ITEMS = [
    item("auto", "Automatic", "Sort_Auto"),
    item("data", "As received", "Sort_Data"),
    item("name", "Name", "Sort_Name"),
    item("currentState", "Current state", "Sort_CurrentState"),
    item("timeInState", "Time in current state", "Sort_TimeInState"),
];
// Owner-agreed default (fix round 1): first appearance in time, so the resting state is the
// state each resource starts in. Alphabetical stays available.
const ORDER_ITEMS = [
    item("firstSeen", "First seen", "Order_FirstSeen"),
    item("alphabetical", "Alphabetical", "Order_Alphabetical"),
    item("custom", "Custom list", "Order_Custom"),
];
const GRAIN_ITEMS = [
    item("auto", "Automatic", "Grain_Auto"),
    item("hour", "Hour", "Grain_Hour"),
    item("day", "Day", "Grain_Day"),
    item("week", "Week", "Grain_Week"),
    item("month", "Month", "Grain_Month"),
    item("quarter", "Quarter", "Grain_Quarter"),
    item("year", "Year", "Grain_Year"),
];
const UNIT_ITEMS = [
    item("auto", "Automatic", "Unit_Auto"),
    item("minutes", "Minutes", "Unit_Minutes"),
    item("hours", "Hours", "Unit_Hours"),
    item("days", "Days", "Unit_Days"),
    item("weeks", "Weeks", "Unit_Weeks"),
];

export class StatusTimelineCard extends FormattingSettingsCompositeCard {
    name = "statusTimeline";
    displayName = "Status timeline";
    displayNameKey = "Card_StatusTimeline";

    style = new formattingSettings.ItemDropdown({ name: "style", displayName: "Style", displayNameKey: "Prop_Style", items: STYLE_ITEMS, value: STYLE_ITEMS[0] });
    sortStrips = new formattingSettings.ItemDropdown({ name: "sortStrips", displayName: "Sort strips", displayNameKey: "Prop_SortStrips", items: SORT_ITEMS, value: SORT_ITEMS[0] });
    showTotals = new formattingSettings.ToggleSwitch({ name: "showTotals", displayName: "Show totals", displayNameKey: "Prop_ShowTotals", value: true });
    showLegend = new formattingSettings.ToggleSwitch({ name: "showLegend", displayName: "Show legend", displayNameKey: "Prop_ShowLegend", value: true });
    showSubtitle = new formattingSettings.ToggleSwitch({ name: "showSubtitle", displayName: "Show subtitle", displayNameKey: "Prop_ShowSubtitle", value: true });

    stateOrder = new formattingSettings.ItemDropdown({ name: "stateOrder", displayName: "State order", displayNameKey: "Prop_StateOrder", items: ORDER_ITEMS, value: ORDER_ITEMS[0] });
    customOrder = new formattingSettings.TextInput({ name: "customOrder", displayName: "Custom order", displayNameKey: "Prop_CustomOrder", placeholder: "Idle, Running, Fault", value: "" });
    restingAsTrack = new formattingSettings.ToggleSwitch({ name: "restingAsTrack", displayName: "First state as track", displayNameKey: "Prop_RestingAsTrack", value: true });
    alwaysShow = new formattingSettings.TextInput({ name: "alwaysShow", displayName: "Always show", displayNameKey: "Prop_AlwaysShow", description: "States that are always drawn in Block strips, even when another state has more time in the block (comma separated)", descriptionKey: "Prop_AlwaysShow_Desc", placeholder: "Fault", value: "" });

    timeGrain = new formattingSettings.ItemDropdown({ name: "timeGrain", displayName: "Block size", displayNameKey: "Prop_TimeGrain", items: GRAIN_ITEMS, value: GRAIN_ITEMS[0] });
    durationUnit = new formattingSettings.ItemDropdown({ name: "durationUnit", displayName: "Duration unit", displayNameKey: "Prop_DurationUnit", items: UNIT_ITEMS, value: UNIT_ITEMS[0] });

    groups: FormattingSettingsGroup[] = [
        new FormattingSettingsGroup({ name: "stLayout", displayName: "Layout", displayNameKey: "Group_Layout", slices: [this.style, this.sortStrips, this.showTotals, this.showLegend, this.showSubtitle] }),
        new FormattingSettingsGroup({ name: "stStates", displayName: "States", displayNameKey: "Group_States", slices: [this.stateOrder, this.customOrder, this.restingAsTrack, this.alwaysShow] }),
        new FormattingSettingsGroup({ name: "stTime", displayName: "Time", displayNameKey: "Group_Time", slices: [this.timeGrain, this.durationUnit] }),
    ];

    reveal(): void {
        this.customOrder.visible = this.stateOrder.value?.value === "custom";
        // Block size drives Block strips and the board's history strip (drawn as blocks)
        this.timeGrain.visible = this.style.value?.value !== "runs";
    }
}

export class StateColoursCard extends FormattingSettingsCard {
    name = "stateColours";
    displayName = "State colours";
    displayNameKey = "Card_StateColours";
    // Card-level colours: no selector (a wildcard would persist the constant where populate
    // never reads it back; formatting-model.md section 2). instanceKind alone gives the fx button.
    accent = new formattingSettings.ColorPicker({ name: "accent", displayName: "State colour", displayNameKey: "Prop_Accent", description: "Drawn at rising strengths for states later in the order", value: { value: DEFAULT_ACCENT }, instanceKind: ConstantOrRule });
    track = new formattingSettings.ColorPicker({ name: "track", displayName: "First state colour", displayNameKey: "Prop_Track", value: { value: DEFAULT_TRACK }, instanceKind: ConstantOrRule });
    slices: FormattingSettingsSlice[] = [this.accent, this.track];
}

export class LabelsCard extends FormattingSettingsCard {
    name = "labels";
    displayName = "Labels";
    displayNameKey = "Card_Labels";
    font = makeFontControl("label", { fontSize: 12 });
    textColor = new formattingSettings.ColorPicker({ name: "textColor", displayName: "Text colour", displayNameKey: "Prop_TextColor", value: { value: DEFAULT_TEXT }, instanceKind: ConstantOrRule });
    slices: FormattingSettingsSlice[] = [this.font.control, this.textColor];
}

export class StBackgroundSettings extends BackgroundSettings {
    show = new formattingSettings.ToggleSwitch({ name: "show", displayName: "Show background", displayNameKey: "Prop_ShowBackground", value: true });
    slices: FormattingSettingsSlice[] = [this.show, this.backgroundColor, this.transparency];
}

// Fix round 11 (S6, owner ruling 2026-11-21): "Keep report colours" is not part of the design and is
// removed; a colour the author set is drawn verbatim in every theme mode outside high contrast.
export class StCodexThemeSettings extends CodexThemeSettings {
    slices: FormattingSettingsSlice[] = [this.mode, this.surfaceTransparency, this.neon, this.neonColor, this.neonScope, this.glowStrength];
}

const side = (name: string, displayName: string, key: string, value: number) => new formattingSettings.NumUpDown({
    name, displayName, displayNameKey: key, value,
    options: {
        minValue: { type: powerbi.visuals.ValidatorType.Min, value: PADDING_MIN },
        maxValue: { type: powerbi.visuals.ValidatorType.Max, value: PADDING_MAX },
    },
});

export class ContentPaddingCard extends FormattingSettingsCard {
    name = "contentPadding";
    displayName = "Content padding";
    displayNameKey = "ContentPadding_Card";
    top = side("top", "Top", "ContentPadding_Top", PADDING_DEFAULTS.top);
    right = side("right", "Right", "ContentPadding_Right", PADDING_DEFAULTS.right);
    bottom = side("bottom", "Bottom", "ContentPadding_Bottom", PADDING_DEFAULTS.bottom);
    left = side("left", "Left", "ContentPadding_Left", PADDING_DEFAULTS.left);
    slices: FormattingSettingsSlice[] = [this.top, this.right, this.bottom, this.left];
}

export class VisualFormattingSettingsModel extends FormattingSettingsModel {
    statusTimeline = new StatusTimelineCard();
    stateColours = new StateColoursCard();
    labels = new LabelsCard();
    titleSettings = new TitleSettings();
    background = new StBackgroundSettings();
    codexTheme = new StCodexThemeSettings();
    contentPadding = new ContentPaddingCard();
    licence = new LicenceSettings();
    cards = [this.statusTimeline, this.stateColours, this.labels, this.titleSettings, this.background, this.codexTheme, this.contentPadding, this.licence];

    constructor() {
        super();
        // Localisation keys for the shared cards (their source is vendored and never edited).
        const keys: Array<[{ displayNameKey?: string }, string]> = [
            [this.titleSettings, "Card_Title"], [this.titleSettings.showTitle, "Prop_ShowTitle"], [this.titleSettings.titleText, "Prop_TitleText"],
            [this.titleSettings.titleFont, "Prop_Font"], [this.titleSettings.titleAlign, "Prop_Alignment"], [this.titleSettings.titleColor, "Prop_FontColor"],
            [this.background, "Card_Background"], [this.background.backgroundColor, "Prop_BackgroundColor"], [this.background.transparency, "Prop_Transparency"],
            [this.codexTheme, "Card_CodexTheme"], [this.codexTheme.mode, "Prop_Mode"], [this.codexTheme.surfaceTransparency, "Prop_SurfaceTransparency"],
            [this.codexTheme.neon, "Prop_Neon"], [this.codexTheme.neonColor, "Prop_NeonColor"], [this.codexTheme.neonScope, "Prop_NeonScope"], [this.codexTheme.glowStrength, "Prop_GlowStrength"],
            [this.labels.font.control, "Prop_Font"],
            [this.licence, "Card_Licence"], [this.licence.key, "Prop_SuiteKey"],
        ];
        for (const [o, k] of keys) o.displayNameKey = k;
        // Visual title: the shared card is a flat SimpleCard with fx on its colour already.
        this.titleSettings.titleColor.instanceKind = ConstantOrRule;
    }
}
