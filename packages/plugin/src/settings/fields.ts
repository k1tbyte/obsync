import { Setting } from "obsidian";

import type ObsyncPlugin from "@/main";
import { EFieldKind } from "@/storage/field-spec";

import type { ObsyncSettings } from "./model";

const SUB_SETTING_CLASS = "obsync-sub-setting";

export interface FieldContext {
	plugin: ObsyncPlugin;
	/** Re-renders the settings tab, for fields that reveal or hide others. */
	rerender: () => void;
}

interface FieldBase {
	name: string;
	desc?: string;
	/** Only render the field when this holds. */
	when?: (settings: ObsyncSettings) => boolean;
	/** Indent under the field above. */
	sub?: boolean;
	/** Re-scan the vault after the change; for scope-affecting settings. */
	refreshScope?: boolean;
	/** Re-render the whole tab after the change. */
	rerender?: boolean;
	/** Runs once the new value is saved, for fields with a side effect. */
	after?: (plugin: ObsyncPlugin) => void;
}

export interface ToggleField extends FieldBase {
	kind: EFieldKind.Toggle;
	get: (settings: ObsyncSettings) => boolean;
	set: (value: boolean, plugin: ObsyncPlugin) => Partial<ObsyncSettings>;
}

export interface TextField extends FieldBase {
	kind: EFieldKind.Text | EFieldKind.Password;
	placeholder?: string;
	get: (settings: ObsyncSettings) => string;
	set: (value: string, plugin: ObsyncPlugin) => Partial<ObsyncSettings>;
}

export interface NumberField extends FieldBase {
	kind: EFieldKind.Number;
	get: (settings: ObsyncSettings) => string;
	/** Clamps/validates the raw input; the result is what gets stored. */
	parse: (raw: string) => number;
	set: (value: number, plugin: ObsyncPlugin) => Partial<ObsyncSettings>;
}

export type SettingsField = ToggleField | TextField | NumberField;

/**
 * Renders a declarative list of settings fields. Every field saves through the
 * same path, so scope refreshes and re-renders behave identically everywhere.
 */
export function renderFields(
	parent: HTMLElement,
	ctx: FieldContext,
	fields: ReadonlyArray<SettingsField>,
): void {
	for (const field of fields) {
		if (field.when && !field.when(ctx.plugin.settings)) continue;
		renderField(parent, ctx, field);
	}
}

function renderField(
	parent: HTMLElement,
	ctx: FieldContext,
	field: SettingsField,
): void {
	const setting = new Setting(parent).setName(field.name);
	if (field.desc) setting.setDesc(field.desc);
	if (field.sub) setting.settingEl.addClass(SUB_SETTING_CLASS);

	const apply = (patch: Partial<ObsyncSettings>): void => {
		applyPatch(ctx, patch, field);
	};

	if (field.kind === EFieldKind.Toggle) {
		setting.addToggle((toggle) =>
			toggle
				.setValue(field.get(ctx.plugin.settings))
				.onChange((value) => apply(field.set(value, ctx.plugin))),
		);
		return;
	}

	if (field.kind === EFieldKind.Number) {
		setting.addText((text) =>
			text
				.setValue(field.get(ctx.plugin.settings))
				.onChange((raw) => apply(field.set(field.parse(raw), ctx.plugin))),
		);
		return;
	}

	setting.addText((text) => {
		if (field.kind === EFieldKind.Password) text.inputEl.type = "password";
		if (field.placeholder) text.setPlaceholder(field.placeholder);
		text
			.setValue(field.get(ctx.plugin.settings))
			.onChange((value) => apply(field.set(value, ctx.plugin)));
	});
}

function applyPatch(
	ctx: FieldContext,
	patch: Partial<ObsyncSettings>,
	field: SettingsField,
): void {
	Object.assign(ctx.plugin.settings, patch);
	void ctx.plugin.saveSettings().then(() => {
		if (field.refreshScope) {
			ctx.plugin.scheduleScopeRefresh("Sync scope settings changed.");
		}
		field.after?.(ctx.plugin);
		if (field.rerender) ctx.rerender();
	});
}
