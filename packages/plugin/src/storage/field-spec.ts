export enum EFieldKind {
	Text = "text",
	Password = "password",
	Toggle = "toggle",
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

export type SettingsFieldSpec =
	| TextFieldSpec
	| PasswordFieldSpec
	| ToggleFieldSpec;
