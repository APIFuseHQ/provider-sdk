import { mock } from "bun:test";

mock.module("wreq-js", () => {
	throw new Error("Cannot find the wreq-js native binding");
});
