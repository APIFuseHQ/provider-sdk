---
"@apifuse/provider-sdk": patch
---

Test harness only: the real-browser fixture helper (`src/__tests__/fixtures/real-browser-availability.ts`)
now honours `APIFUSE_TEST_REQUIRE_REAL_BROWSER=1`. When the flag is set and the resolved
Chromium executable does not exist, the fixture process throws with the resolved path
(and the `bunx playwright install chromium` / `APIFUSE_TEST_BROWSER_EXECUTABLE_PATH` remedy)
instead of skipping every subtest and exiting 0, so the wrapper test fails on the
browser gap rather than on a misleading `(pass) …` assertion. Without the flag the
fixture still skips cleanly. No published API changes.
