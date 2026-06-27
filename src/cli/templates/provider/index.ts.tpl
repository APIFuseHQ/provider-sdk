import { defineProvider } from "@apifuse/provider-sdk/provider";

import { providerMeta } from "./meta";
import { operations } from "./operations";

export default defineProvider({
  id: "{{PROVIDER_ID}}",
  version: "1.0.0",
  runtime: "{{RUNTIME}}"{{BROWSER_BLOCK}},
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  {{SECRETS_BLOCK}}{{CREDENTIAL_BLOCK}}auth: {{AUTH_BLOCK}},
  meta: providerMeta,
  operations: operations,
});
