import { startDevServer } from "@apifuse/provider-sdk";

import provider from "./index";

startDevServer(provider, { port: Number(process.env.APIFUSE__RUNTIME__PORT) || 3900 });
