import { defineProvider, type ProviderContextOf } from "@apifuse/provider-sdk/provider";

import { providerMeta } from "./meta";
import { operations } from "./operations";

const buildProvider = defineProvider({
  id: "{{PROVIDER_ID}}",
  version: "1.0.0",
  runtime: "{{RUNTIME}}"{{BROWSER_BLOCK}},
  allowedHosts: ["api.example.com"],
  reviewed: "community",
  {{SECRETS_BLOCK}}{{CREDENTIAL_BLOCK}}auth: {{AUTH_BLOCK}},
  meta: providerMeta,
});

export type ProviderContext = ProviderContextOf<typeof buildProvider>;

export default buildProvider({ operations });
