import { Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { EFieldKind } from "@/storage/field-spec";

import type { ObsyncSettings } from "./model";

const SUB_SETTING_CLASS = "obsync-sub-setting";

export interface FieldContext {
	plugin: PluginHost;
	rerender: () => void;
}

interface FieldBase {
	name: string;
	desc?: string;
	when?: (settings: ObsyncSettings) => boolean;
	sub?: boolean;
	/** For scope-affecting settings. */
	refreshScope?: boolean;
	rerender?: boolean;
	after?: (plugin: PluginHost) => void;
}

export interface ToggleField extends FieldBase {
	kind: typeof EFieldKind.Toggle;
	get: (settings: ObsyncSettings) => boolean;
	set: (value: boolean, plugin: PluginHost) => Partial<ObsyncSettings>;
}

export interface TextField extends FieldBase {
	kind: typeof EFieldKind.Text | typeof EFieldKind.Password;
	placeholder?: string;
	get: (settings: ObsyncSettings) => string;
	set: (value: string, plugin: PluginHost) => Partial<ObsyncSettings>;
}

export interface NumberField extends FieldBase {
	kind: typeof EFieldKind.Number;
	get: (settings: ObsyncSettings) => string;
	/** Validates input before storage. */
	parse: (raw: string) => number;
	set: (value: number, plugin: PluginHost) => Partial<ObsyncSettings>;
}

export type SettingsField = ToggleField | TextField | NumberField;

/** Uniform save path ensures scope refreshes and re-renders behave identically. */
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
