import { Buffer as BufferShim } from "buffer/";

const g = window as unknown as {
	Buffer?: typeof BufferShim;
	process?: { env: Record<string, string>; platform: string };
};
if (typeof g.Buffer === "undefined") {
	g.Buffer = BufferShim;
}
if (typeof g.process === "undefined") {
	g.process = { env: {}, platform: "browser" };
}
