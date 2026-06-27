import { describeKey, z } from "@apifuse/provider-sdk/provider";

export const pingInputSchema = describeKey(
  z.object({
    value: describeKey(z.string(), "schemaDescriptions.input.value"),
  }),
  "schemaDescriptions.input.root",
);

export const pingOutputSchema = describeKey(
  z.object({
    ok: describeKey(z.boolean(), "schemaDescriptions.output.ok"),
    message: describeKey(z.string(), "schemaDescriptions.output.message"),
    pageTitle: describeKey(
      z.string().optional(),
      "schemaDescriptions.output.pageTitle",
    ),
    frameCount: describeKey(
      z.number().int().nonnegative().optional(),
      "schemaDescriptions.output.frameCount",
    ),
  }),
  "schemaDescriptions.output.root",
);
