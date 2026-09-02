---
"@apifuse/provider-sdk": patch
---

Separate CapSolver AWS WAF token minting from the caller's proxy policy by always using `AntiAwsWafTaskProxyLess`. AWS WAF token portability is established, while source-IP-allowlisted proxies such as Smartproxy's raw allocator reject connections from solver workers.
