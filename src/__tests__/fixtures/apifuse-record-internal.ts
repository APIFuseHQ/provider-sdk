import { main } from "../../../bin/apifuse-record.js";
import { createInternalTestProviderEngine } from "../../internal/in-process-engine.js";

await main({ engine: createInternalTestProviderEngine() });
