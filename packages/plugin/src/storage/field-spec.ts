import { DEFAULT_CONCURRENCY } from "../constants";

export enum EFieldKind {
	Text = "text",
	Password = "password",
	Toggle = "toggle",
	Number = "number",
}

export interface BaseFieldSpec {
	key: string;
	name: string;
	desc?: string;
	placeholder?: string;
}

export interface TextFieldSpec extends BaseFieldSpec {
	kind: EFieldKind.Text;
}

export interface PasswordFieldSpec extends BaseFieldSpec {
	kind: EFieldKind.Password;
}

export interface ToggleFieldSpec extends BaseFieldSpec {
	kind: EFieldKind.Toggle;
}

export interface NumberFieldSpec extends BaseFieldSpec {
	kind: EFieldKind.Number;
	min: number;
	fallback: number;
}

export type SettingsFieldSpec =
	| TextFieldSpec
	| PasswordFieldSpec
	| ToggleFieldSpec
	| NumberFieldSpec;

/** Shared per-backend upload/download parallelism field. */
export const CONCURRENCY_FIELD: NumberFieldSpec = {
	kind: EFieldKind.Number,
	key: "concurrency",
	name: "Concurrency",
	desc: "Parallel uploads/downloads for this backend. Higher is faster but heavier on the remote.",
	min: 1,
	fallback: DEFAULT_CONCURRENCY,
};
