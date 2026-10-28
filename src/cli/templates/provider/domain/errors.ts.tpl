import { defineErrors, sdkErrors } from "@apifuse/provider-sdk/provider";

// Every error this provider can throw, declared once. The status served, the
// category reported and the retryability published come from this map; a
// throw site only adds details, a cause, or a message override.
export const errors = defineErrors({
  UPSTREAM_ERROR: sdkErrors.UPSTREAM_ERROR,
  UPSTREAM_SCHEMA_ERROR: sdkErrors.UPSTREAM_SCHEMA_ERROR,
  VALUE_EMPTY: {
    status: 400,
    category: "input_validation",
    description: "The ping value is empty.",
    messageKey: "errors.valueEmpty.message",
  },
});
