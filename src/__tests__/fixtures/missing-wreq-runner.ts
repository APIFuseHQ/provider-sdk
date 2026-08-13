const sdk = await import("../../index.js");
const client = sdk.createStealthClient("https://example.com");

try {
	await client.fetch("/health");
	throw new Error("Expected the unavailable stealth transport to reject");
} catch (error) {
	if (!(error instanceof sdk.SDKError)) throw error;
	if (error.code !== "stealth_transport_unavailable") throw error;
	const expectedMessage = `Stealth transport is unavailable on ${process.platform}-${process.arch}: the wreq-js native binary could not be loaded.`;
	if (!error.message.includes(expectedMessage)) throw error;
}
