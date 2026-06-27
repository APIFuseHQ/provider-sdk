import { describe, expect, it } from "bun:test";
import { runStandardTests } from "@apifuse/provider-sdk/testing";

import provider from "../index";

runStandardTests(provider);

describe("{{PROVIDER_ID}}", () => {
  it("exposes provider metadata from defineProvider", () => {
    expect(provider.id).toBe("{{PROVIDER_ID}}");
    expect(provider.reviewed).toBe("community");
  });
});
