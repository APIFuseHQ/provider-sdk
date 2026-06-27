import { serve } from "@apifuse/provider-sdk";

import provider from "./index";

await serve(provider, { port: Number(process.env.APIFUSE__RUNTIME__PORT) || 3000 });
