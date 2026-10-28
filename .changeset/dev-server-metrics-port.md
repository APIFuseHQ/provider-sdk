---
"@apifuse/provider-sdk": minor
---

`DevServerOptions` gains `metricsPort`, passed to `serve` as `ServeOptions.metricsPort`, and `apifuse dev` accepts `--metrics-port <n>` (also `--metrics-port=<n>`, an integer from 1 to 65535) to set it. `serve` always starts the metrics listener, so two dev servers on one host collided on the same metrics port (`APIFUSE__PROVIDER_RUNTIME__METRICS_PORT`, else `9090`) and the second one exited with `EADDRINUSE`; each can now be given its own port. Without the option nothing changes: the port is still the env value, else `9090`.
