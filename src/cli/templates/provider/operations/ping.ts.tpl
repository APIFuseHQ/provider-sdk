import { defineOperation } from "@apifuse/provider-sdk/provider";

import { pingInputSchema, pingOutputSchema } from "../schemas/ping";

export const pingOperation = defineOperation({
  descriptionKey: "operations.ping.description",
  input: pingInputSchema,
  output: pingOutputSchema,
  handler: async ({{HANDLER_CTX}}, input) => {
    {{BROWSER_HANDLER_BLOCK}}
    return {
      ok: true,
      message: "{{DISPLAY_NAME}} received: " + input.value{{BROWSER_RESPONSE_FIELDS}},
    };
  },
  fixtures: {
    request: { value: "hello" },
    response: { ok: true, message: "{{DISPLAY_NAME}} received: hello" },
  },
  healthCheckUnsupported: {
    reason:
      "Generated local-only scaffold operation. Replace this with a real healthCheck for upstream-backed bounty operations when safe; keep healthCheckUnsupported only for destructive, paid, credential-sensitive, or otherwise unprobeable operations with a specific rationale.",
  },
});
