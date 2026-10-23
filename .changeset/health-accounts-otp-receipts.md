---
"@apifuse/provider-sdk": minor
---

Declare health-monitor accounts and the OTPs they receive with `healthAccounts` on `defineProvider`.

`ProviderDeclaration` and `ProviderDefinition` gain the optional `healthAccounts?: readonly HealthAccountDeclaration[]`, built with the new identity helper `defineHealthAccount()`. Each account names a `persona`, maps each OTP medium to the seed field that holds its address (`destinations`), records the OTP wait with its measured rationale (`wait`), and lists one or more OTP receipts (`otp`). The only medium today is `"email"` (`EmailOtpReceipt`: sender domains, optional subject keywords, an RE2 `SafeRegex` code rule, and a `maxAge` of at most `PT15M`); `OtpMedium` and the `OtpReceipt` union widen as more media land.

`defineProvider` validates the declaration's structure, rejects unknown fields and media, and rejects an OTP `maxAge` above `PT15M`. The field is passed through to the built provider unchanged and is not part of the provider contract snapshot. New exports from the root and `./provider` entry points: `defineHealthAccount`, `HealthAccountDeclaration`, `OtpMedium`, `OtpCodeRule`, `OtpReceiptBase`, `EmailOtpReceipt`, `OtpReceipt`.
