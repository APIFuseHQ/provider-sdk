import { defineOperation } from "@apifuse/provider-sdk/provider";
import type { ProviderContext } from "../index";

import { errors } from "../domain/errors";
import { pingInputSchema, pingOutputSchema } from "../schemas/ping";

export const pingOperation = defineOperation<ProviderContext>()({
  connectionMode: "none",
  riskClass: "read",
  descriptionKey: "operations.ping.description",
  errors: [errors.VALUE_EMPTY],
  input: pingInputSchema,
  output: pingOutputSchema,
  handler: async ({{HANDLER_CTX}}, input) => {
    if (input.value.trim().length === 0) {
      throw errors.VALUE_EMPTY({ details: { value: input.value } });
    }
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
