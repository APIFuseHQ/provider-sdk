import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const configDir = join(root, "config", "api-extractor");
const tempDir = join(root, "temp", "api");
const reportDir = join(root, "api-reports");
const mode = process.argv[2];

type PackageJson = {
	exports?: Record<string, unknown>;
};

type ApiExtractorConfig = {
	projectFolder?: string;
	mainEntryPointFilePath: string;
	apiReport: {
		enabled?: boolean;
		includeForgottenExports?: boolean;
		reportFolder?: string;
		reportFileName: string;
		reportVariants?: unknown;
	};
	docModel?: { includeForgottenExports?: boolean };
};

type NonTypedExportExemption = {
	reason: string;
	targets: string[];
};

type ForgottenExportAllowance = {
	reason: string;
	symbols: Set<string>;
};

const nonTypedExportExemptions: Record<string, NonTypedExportExemption> = {
	"./auth-turn/auth-turn.v1.schema.json": {
		reason: "JSON Schema asset; API Extractor only reports TypeScript declaration entry points.",
		targets: ["./dist/auth-turn/auth-turn.v1.schema.json"],
	},
};

function forgottenExports(reason: string, symbols: string): ForgottenExportAllowance {
	return { reason, symbols: new Set(symbols.trim().split(/\s+/).filter(Boolean)) };
}

const forgottenExportAllowlist: Record<string, ForgottenExportAllowance> = {
	// Filled with exact per-report symbol names below. Every allowance shares an explicit rationale,
	// while includeForgottenExports ensures the full declarations remain reviewable semver evidence.
	"auth-turn.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			ProviderLocaleKey ProviderLocaleKeyInput
		`,
	),
	"contract.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			AuthAbortRetry AuthConfig AuthContext AuthFlowDefinition AuthFlowInputHandler AuthFlowStartHandler AuthFlowTerminalContext AuthMode
			AuthSafeData AuthSafeJson AuthTurn Bcp47Locale BrowserChallengeRequest BrowserChallengeResult BrowserClient BrowserCookie
			BrowserEngine BrowserFrame BrowserLocator BrowserPage BrowserResourceBody BrowserResourceDecision BrowserResourceMethod BrowserResourcePolicy
			BrowserResourceRequest BrowserResourceRoute ChallengeSolution ContextDeclaration ContextScratchpad CookieJar CredentialContext CredentialDeclaration
			DeclarativeStealthResponse E164PhoneNumber EnvContext FlowContext HealthCheckAssertionContext HealthCheckCase HealthCheckCaseResult HealthCheckInputPreparationContext
			HealthCheckSuite HealthCheckUnsupported HealthJourneyDefinition HealthJourneyEventContext HealthJourneyGatewayContext HealthJourneyJournalContext HealthJourneyManualTriggerPolicy HealthJourneyRunContext
			HealthJourneyRunResult HealthJourneySchedule HealthJourneySmsContext HealthJourneyStep HealthMonitorProbeOverride HealthScheduleRandomization HttpClient HttpMethod
			HttpRedirectPolicy HttpRedirectPolicyMode HttpResponse HttpRetryAfterPolicy HttpRetryDelayStrategy HttpRetryJitter HttpRetryOptions HttpRetryPreset
			HttpRetryUnsafeMethodPolicy HttpStreamResponse InferSchemaOutput Iso3166Alpha2CountryCode Iso8601Duration NativeContext NativeNetworkClient NativeNetworkCloseReason
			NativeNetworkConnectInput NativeNetworkConnectOptions NativeNetworkConnection NativeNetworkDynamicGrantOptions NativeNetworkEgressGrant NativeProviderConfig NativeProviderContext NativeProxyDrainHandler
			NativeProxyEgressInfo NativeProxyExpiringEvent NativeProxyExpiringReason NativeTcpDynamicEgressRule NativeTcpEgressRule NativeTcpPortRange NativeTcpTlsMode NativeTlsConnectOptions
			OcrCaptchaCandidate OcrCaptchaOptions OcrCaptchaResult OcrContext OcrImageInput OcrRecognizeRequest OcrResult OcrWarning
			OperationAnnotations OperationApprovalPolicy OperationContractMetadata OperationDefinition OperationDeprecationMetadata OperationDocMeta OperationErrorCode OperationHandlerResult
			OperationHttpStreamTransport OperationInputExample OperationJsonTransport OperationLifecycle OperationObservabilityConfig OperationObservabilitySensitiveConfig OperationRelationships OperationRiskClass
			OperationSensitivePath OperationSseTransport OperationToolRouterMetadata OperationTransport OperationWebSocketTransport ProbeInterval ProviderAccessConfig ProviderAccessVisibility
			ProviderCache ProviderCacheGetOrSetOptions ProviderCacheKeyOptions ProviderCacheLookupMeta ProviderCacheResponseMeta ProviderCacheResult ProviderChallenge ProviderChallengeKind
			ProviderChoiceBindingOptions ProviderChoiceConsumeMode ProviderChoiceConsumeResult ProviderChoiceContext ProviderChoiceExplicitParseResult ProviderChoiceIssueOptions ProviderChoiceParseOptions ProviderChoiceStorageOptions
			ProviderContext ProviderDefinition ProviderDeploymentOverrides ProviderErrorStatus ProviderFileRef ProviderFilesContext ProviderHealthMonitorConfig ProviderHealthProbeConfig
			ProviderLocaleKey ProviderLocaleKeyInput ProviderLogoProfile ProviderMeta ProviderOcrConfig ProviderProxyConfig ProviderProxyMode ProviderProxyPolicy
			ProviderProxyProvider ProviderProxySessionAffinity ProviderPublicConnectionMode ProviderPublicProfile ProviderRequestContext ProviderResolvedFile ProviderResolverConfig ProviderResolverVendor
			ProviderReviewed ProviderRuntimeState ProviderSecretDeclaration ProviderStateDurationString ProviderStateNamespace ProviderStreamEvent ProviderSttConfig ProviderSttMode
			ProviderSupportLevel ProxiedOAuthConfig RedirectRunReason RequestOptions RequestParamPrimitive RequestParamValue RequestParams RequestWithMethodOptions
			ResolverContext SchemaLike SmsOrigin SmsOtpExtractionPattern SmsOtpMatcherDefinition SmsPhoneIdentity SseMessage StandardSchemaV1
			StateCasResult StateNamespaceOptions StateNamespaceScope StateValue StateWriteOptions StealthClient StealthCookieStore StealthCookieStoreV1
			StealthFetchOptions StealthPlatform StealthRedirectHop StealthRedirectRunOptions StealthRedirectRunResult StealthResponse StealthSession StealthSessionCookies
			SttAudioInput SttContext SttPromptPolicy SttSegment SttTranscribeMode SttTranscribeRequest SttTranscript SttUnsupportedOptionPolicy
			SttUsage SttVerificationCodeOptions SttWarning TraceContext VALID_OPERATION_ERROR_STATUSES VerificationCodeCandidate VerificationCodeCandidateSource VerificationCodeExtractionResult
		`,
	),
	"index.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			AuthAbortRetry AuthFlowTerminalContext AuthModeLike AuthSafeData AuthSafeJson AuthStartNoInputGuard BrowserChallengeRequest BrowserChallengeResult
			BrowserClient BrowserFrame BrowserLocator BrowserPage CloudflareWorkersAiOcrClientOptions DeclarativeStealthResponse EnvLike EnvLike_2
			HealthCheckInputPreparationContext HealthMonitorProbeOverride HttpClientOptions HttpStreamOperationConfig JsonObject OTLPExportOptions OpenAiCompatibleOcrClientOptions OperationConfig
			OperationHttpStreamTransport OperationJsonTransport OperationMapConfig OperationRequest OperationRequestSchema OperationSseTransport OperationWebSocketTransport ProviderAuthLike
			ProviderChoiceStorageOptions ProviderChoiceTelemetryEvent ProviderContractMetaLike ProviderImplementationCredentialStrategy ProviderImplementationProfile ProviderImplementationSourceAccess ProviderLintMode ProviderLintOptions
			ProviderOperation ProviderRequestContext ProviderRequestCost ProviderServerCloseOptions ProviderServerHandle ProviderServerLogEvent ProviderServerLogEventBase ProviderServerLogger
			ProviderServerOperationExecutor ProviderServerOperationExecutorInput ProviderServerOptions ProviderServerStatefulForwardEnvelope ProviderServerStatefulForwardEnvelopeSchema ProviderServerStatefulOwnerFence ProviderServerStatefulOwnerFenceValidator ProxyAttemptTelemetryEvent
			ProxyCacheStatus ProxyResolutionTelemetryEvent ProxyTelemetrySink ProxyUserAgentSource ProxyVendorFailoverTelemetryEvent RequestParamPrimitive RequestParamValue RequestParams
			RequestWithMethodOptions SelfTestCancellationLogEvent SensitivePathSegment SmartproxyAllocatorBodyClass SmsPhoneIdentity SseOperationConfig StreamOperationConfig TraceAttributeValue
			TraceContext_2 VALID_OPERATION_ERROR_STATUSES WebSocketOperationConfig
		`,
	),
	"provider.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			AuthConfig AuthContext AuthFlowDefinition AuthFlowInputHandler AuthFlowStartHandler AuthStartNoInputGuard AuthTurn Bcp47Locale
			BrowserChallengeRequest BrowserChallengeResult BrowserClient BrowserCookie BrowserEngine BrowserFrame BrowserLocator BrowserPage
			BrowserResourceBody BrowserResourceDecision BrowserResourceMethod BrowserResourcePolicy BrowserResourceRequest BrowserResourceRoute ChallengeSolution ContextDeclaration
			ContextScratchpad CookieJar CreateProviderChoiceTokenOptions CredentialContext CredentialDeclaration DeclarativeStealthResponse E164PhoneNumber EnvContext
			FreshProviderChoiceIssuedAtOptions HealthCheckCaseResult HealthCheckInputPreparationContext HealthJourneyGatewayContext HealthJourneyJournalContext HealthJourneySchedule HealthJourneySmsContext HealthJourneyStep
			HealthMonitorProbeOverride HttpClient HttpMethod HttpRedirectErrorOptions HttpResponse HttpStreamResponse Iso3166Alpha2CountryCode Iso8601Duration
			JsonObject OcrCaptchaCandidate OcrCaptchaOptions OcrCaptchaResult OcrContext OcrImageInput OcrRecognizeRequest OcrResult
			OcrWarning OperationAnnotations OperationConfig OperationDeprecationMetadata OperationHandlerResult OperationHttpStreamTransport OperationJsonTransport OperationMapConfig
			OperationSseTransport OperationWebSocketTransport PROVIDER_ERROR_CATEGORIES ParseProviderChoiceTokenOptions ProbeInterval ProviderAccessConfig ProviderCache ProviderCacheGetOrSetOptions
			ProviderCacheKeyOptions ProviderCacheLookupMeta ProviderCacheResponseMeta ProviderCacheResult ProviderChallenge ProviderChallengeKind ProviderChoiceStorageOptions ProviderChoiceTelemetryEvent
			ProviderConfig ProviderErrorCategory ProviderErrorOptions ProviderHealthMonitorConfig ProviderHealthProbeConfig ProviderImplementationCredentialStrategy ProviderImplementationProfile ProviderImplementationSourceAccess
			ProviderLocaleCatalog ProviderLocaleValue ProviderMeta ProviderOcrConfig ProviderOperation ProviderProxyConfig ProviderProxyMode ProviderProxyProvider
			ProviderProxySessionAffinity ProviderRequestContext ProviderResolverConfig ProviderResolverVendor ProviderReviewed ProviderSecretDeclaration ProviderStreamEvent ProviderSttConfig
			ProviderSttMode ProxyProtocol RequestOptions RequestParamPrimitive RequestParamValue RequestParams RequestWithMethodOptions ResolverContext
			SensitivePathSegment SmsOrigin SmsOtpExtractionPattern SmsPhoneIdentity SseMessage StealthClient StealthCookieStore StealthCookieStoreV1
			StealthFetchOptions StealthPlatform StealthRedirectHop StealthRedirectRunOptions StealthRedirectRunResult StealthResponse StealthSession StealthSessionCookies
			SttAudioInput SttContext SttPromptPolicy SttSegment SttTranscribeMode SttTranscribeRequest SttTranscript SttUnsupportedOptionPolicy
			SttUsage SttVerificationCodeOptions SttWarning TraceContext TransportErrorOptions VALID_OPERATION_ERROR_STATUSES ValidationErrorOptions VerificationCodeCandidate
			VerificationCodeCandidateSource VerificationCodeExtractionResult
		`,
	),
	"runtime-browser.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			BrowserChallengeRequest BrowserChallengeResult BrowserClient_2 BrowserCookie BrowserEngine BrowserFrame BrowserLocator BrowserOptions
			BrowserPage BrowserPageContract BrowserResourceBody BrowserResourceDecision BrowserResourceMethod BrowserResourcePolicy BrowserResourceRequest BrowserResourceRoute
		`,
	),
	"runtime-native-network.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			DynamicEgressRuleSnapshot EnvContext Iso3166Alpha2CountryCode NativeConnectTls NativeNetworkClient NativeNetworkCloseReason NativeNetworkConnectInput NativeNetworkConnectOptions
			NativeNetworkConnection NativeNetworkDynamicGrantOptions NativeNetworkEgressGrant NativeProviderConfig NativeProxyDrainHandler NativeProxyEgressInfo NativeProxyExpiringEvent NativeProxyExpiringReason
			NativeTcpDynamicEgressRule NativeTcpEgressRule NativeTcpPortRange NativeTcpTlsMode NativeTlsConnectOptions PROVIDER_ERROR_CATEGORIES ProviderError ProviderErrorCategory
			ProviderErrorOptions ProviderProxyMode ProviderProxyPolicy ProviderProxyProvider ProviderProxySessionAffinity ProxyProtocol TransportError TransportErrorOptions
		`,
	),
	"runtime-prevalidate.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			JsonSchema
		`,
	),
	"runtime-resolver.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			ChallengeSolution EnvLike Iso3166Alpha2CountryCode ProviderCache ProviderCacheGetOrSetOptions ProviderCacheKeyOptions ProviderCacheLookupMeta ProviderCacheResponseMeta
			ProviderCacheResult ProviderChallenge ProviderChallengeKind ProviderProxyMode ProviderProxyPolicy ProviderProxyProvider ProviderProxySessionAffinity ProviderResolverConfig
			ProviderResolverVendor ProxyAttemptTelemetryEvent ProxyCacheStatus ProxyProtocol ProxyResolutionOptions ProxyResolutionTelemetryEvent ProxyTelemetrySink ProxyUserAgentSource
			ProxyVendorFailoverTelemetryEvent ProxyVendorName ResolverChainClient ResolverContext ResolverIdentity ResolverIssuingIdentity ResolverVendorAdapter ResolverVendorTransport
			SmartproxyAllocatorBodyClass SpanHookOptions TraceRecorder
		`,
	),
	"runtime-stealth.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			CookieJar DeclarativeStealthResponse HttpMethod HttpRedirectPolicy HttpRedirectPolicyMode HttpRetryAfterPolicy HttpRetryDelayStrategy HttpRetryJitter
			HttpRetryOptions HttpRetryPreset HttpRetryUnsafeMethodPolicy Iso3166Alpha2CountryCode ProviderProxyMode ProviderProxyPolicy ProviderProxyProvider ProviderProxySessionAffinity
			ProxyAttemptTelemetryEvent ProxyCacheStatus ProxyProtocol ProxyResolutionOptions ProxyResolutionTelemetryEvent ProxyTelemetrySink ProxyUserAgentSource ProxyVendorFailoverTelemetryEvent
			ProxyVendorName RedirectRunReason RequestOptions RequestParamPrimitive RequestParamValue RequestParams SmartproxyAllocatorBodyClass StealthClient
			StealthCookieStore StealthCookieStoreV1 StealthFetchOptions StealthRedirectHop StealthRedirectRunOptions StealthRedirectRunResult StealthResponse StealthSession
			StealthSessionCookies StealthTransportBody StealthTransportHeaders StealthTransportResponse
		`,
	),
	"server.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			AuthAbortRetry AuthConfig AuthContext AuthFlowDefinition AuthFlowErrorResponse AuthFlowErrorResponseSchema AuthFlowInputHandler AuthFlowStartHandler
			AuthFlowTerminalContext AuthMode AuthSafeData AuthSafeJson AuthTurn Bcp47Locale BrowserChallengeRequest BrowserChallengeResult
			BrowserClient BrowserCookie BrowserEngine BrowserFrame BrowserLocator BrowserPage BrowserResourceBody BrowserResourceDecision
			BrowserResourceMethod BrowserResourcePolicy BrowserResourceRequest BrowserResourceRoute ChallengeSolution ContextDeclaration ContextScratchpad CookieJar
			CredentialContext CredentialDeclaration DeclarativeStealthResponse E164PhoneNumber EnvContext FlowContext HealthCheckAssertionContext HealthCheckCase
			HealthCheckCaseResult HealthCheckInputPreparationContext HealthCheckSuite HealthCheckUnsupported HealthJourneyDefinition HealthJourneyEventContext HealthJourneyGatewayContext HealthJourneyJournalContext
			HealthJourneyManualTriggerPolicy HealthJourneyRunContext HealthJourneyRunResult HealthJourneySchedule HealthJourneySmsContext HealthJourneyStep HealthMonitorProbeOverride HealthScheduleRandomization
			HttpClient HttpMethod HttpRedirectPolicy HttpRedirectPolicyMode HttpResponse HttpRetryAfterPolicy HttpRetryDelayStrategy HttpRetryJitter
			HttpRetryOptions HttpRetryPreset HttpRetryUnsafeMethodPolicy HttpStreamResponse InferSchemaOutput Iso3166Alpha2CountryCode Iso8601Duration NativeContext
			NativeNetworkClient NativeNetworkCloseReason NativeNetworkConnectInput NativeNetworkConnectOptions NativeNetworkConnection NativeNetworkDynamicGrantOptions NativeNetworkEgressGrant NativeProviderConfig
			NativeProviderContext NativeProxyDrainHandler NativeProxyEgressInfo NativeProxyExpiringEvent NativeProxyExpiringReason NativeTcpDynamicEgressRule NativeTcpEgressRule NativeTcpPortRange
			NativeTcpTlsMode NativeTlsConnectOptions OcrCaptchaCandidate OcrCaptchaOptions OcrCaptchaResult OcrContext OcrImageInput OcrRecognizeRequest
			OcrResult OcrWarning OperationAnnotations OperationApprovalPolicy OperationContractMetadata OperationDefinition OperationDeprecationMetadata OperationDocMeta
			OperationErrorCode OperationHandlerResult OperationHttpStreamTransport OperationInputExample OperationJsonTransport OperationLifecycle OperationObservabilityConfig OperationObservabilitySensitiveConfig
			OperationRelationships OperationRiskClass OperationSensitivePath OperationSseTransport OperationToolRouterMetadata OperationTransport OperationWebSocketTransport PROVIDER_ERROR_CATEGORIES
			ProbeInterval ProviderAccessConfig ProviderAccessVisibility ProviderCache ProviderCacheGetOrSetOptions ProviderCacheKeyOptions ProviderCacheLookupMeta ProviderCacheResponseMeta
			ProviderCacheResult ProviderChallenge ProviderChallengeKind ProviderChoiceBindingOptions ProviderChoiceConsumeMode ProviderChoiceConsumeResult ProviderChoiceContext ProviderChoiceExplicitParseResult
			ProviderChoiceIssueOptions ProviderChoiceParseOptions ProviderChoiceStorageOptions ProviderContext ProviderDefinition ProviderDeploymentOverrides ProviderErrorCategory ProviderErrorStatus
			ProviderFileRef ProviderFilesContext ProviderHealthMonitorConfig ProviderHealthProbeConfig ProviderLocaleKey ProviderLocaleKeyInput ProviderLogoProfile ProviderMeta
			ProviderOcrConfig ProviderProxyConfig ProviderProxyMode ProviderProxyPolicy ProviderProxyProvider ProviderProxySessionAffinity ProviderPublicConnectionMode ProviderPublicProfile
			ProviderRequestContext ProviderRequestCost ProviderResolvedFile ProviderResolverConfig ProviderResolverVendor ProviderReviewed ProviderRuntimeState ProviderSecretDeclaration
			ProviderServerLogEventBase ProviderServerStatefulForwardEnvelopeSchema ProviderServerStatefulOwnerFence ProviderServerStatefulOwnerFenceValidator ProviderStateDurationString ProviderStateNamespace ProviderStreamEvent ProviderSttConfig
			ProviderSttMode ProviderSupportLevel ProxiedOAuthConfig RedirectRunReason RequestOptions RequestParamPrimitive RequestParamValue RequestParams
			RequestWithMethodOptions ResolverContext SchemaLike SelfTestCancellationLogEvent SmsOrigin SmsOtpExtractionPattern SmsOtpMatcherDefinition SmsPhoneIdentity
			SseMessage StandardSchemaV1 StateCasResult StateNamespaceOptions StateNamespaceScope StateValue StateWriteOptions StealthClient
			StealthCookieStore StealthCookieStoreV1 StealthFetchOptions StealthPlatform StealthRedirectHop StealthRedirectRunOptions StealthRedirectRunResult StealthResponse
			StealthSession StealthSessionCookies SttAudioInput SttContext SttPromptPolicy SttSegment SttTranscribeMode SttTranscribeRequest
			SttTranscript SttUnsupportedOptionPolicy SttUsage SttVerificationCodeOptions SttWarning TraceContext VALID_OPERATION_ERROR_STATUSES VerificationCodeCandidate
			VerificationCodeCandidateSource VerificationCodeExtractionResult
		`,
	),
	"stateful.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			FetchTransport FetchTransport_2 FetchTransport_3 ProviderServerStatefulForwardEnvelope ProviderServerStatefulForwardEnvelopeSchema SessionCloseHook SessionFactory
		`,
	),
	"testing.api.md": forgottenExports(
		"These pre-existing indirect declarations are intentionally not direct entry-point exports; their full definitions are included in this report for semver review.",
		`
			AuthAbortRetry AuthConfig AuthContext AuthFlowDefinition AuthFlowInputHandler AuthFlowStartHandler AuthFlowTerminalContext AuthMode
			AuthSafeData AuthSafeJson AuthTurn Bcp47Locale BrowserChallengeRequest BrowserChallengeResult BrowserClient BrowserCookie
			BrowserEngine BrowserFrame BrowserLocator BrowserPage BrowserResourceBody BrowserResourceDecision BrowserResourceMethod BrowserResourcePolicy
			BrowserResourceRequest BrowserResourceRoute ChallengeSolution ContextDeclaration ContextScratchpad CookieJar CredentialContext CredentialDeclaration
			DeclarativeStealthResponse E164PhoneNumber EnvContext FlowContext HealthCheckAssertionContext HealthCheckCase HealthCheckCaseResult HealthCheckInputPreparationContext
			HealthCheckSuite HealthCheckUnsupported HealthJourneyDefinition HealthJourneyEventContext HealthJourneyGatewayContext HealthJourneyJournalContext HealthJourneyManualTriggerPolicy HealthJourneyRunContext
			HealthJourneyRunResult HealthJourneySchedule HealthJourneySmsContext HealthJourneyStep HealthMonitorProbeOverride HealthScheduleRandomization HttpClient HttpMethod
			HttpRedirectPolicy HttpRedirectPolicyMode HttpResponse HttpRetryAfterPolicy HttpRetryDelayStrategy HttpRetryJitter HttpRetryOptions HttpRetryPreset
			HttpRetryUnsafeMethodPolicy HttpStreamResponse InferSchemaOutput Iso3166Alpha2CountryCode Iso8601Duration NativeContext NativeNetworkClient NativeNetworkCloseReason
			NativeNetworkConnectInput NativeNetworkConnectOptions NativeNetworkConnection NativeNetworkDynamicGrantOptions NativeNetworkEgressGrant NativeProviderConfig NativeProviderContext NativeProxyDrainHandler
			NativeProxyEgressInfo NativeProxyExpiringEvent NativeProxyExpiringReason NativeTcpDynamicEgressRule NativeTcpEgressRule NativeTcpPortRange NativeTcpTlsMode NativeTlsConnectOptions
			OcrCaptchaCandidate OcrCaptchaOptions OcrCaptchaResult OcrContext OcrImageInput OcrRecognizeRequest OcrResult OcrWarning
			OperationAnnotations OperationApprovalPolicy OperationContractMetadata OperationDefinition OperationDeprecationMetadata OperationDocMeta OperationErrorCode OperationHandlerResult
			OperationHttpStreamTransport OperationInputExample OperationJsonTransport OperationLifecycle OperationObservabilityConfig OperationObservabilitySensitiveConfig OperationRelationships OperationRiskClass
			OperationSensitivePath OperationSseTransport OperationToolRouterMetadata OperationTransport OperationWebSocketTransport ProbeInterval ProviderAccessConfig ProviderAccessVisibility
			ProviderCache ProviderCacheGetOrSetOptions ProviderCacheKeyOptions ProviderCacheLookupMeta ProviderCacheResponseMeta ProviderCacheResult ProviderChallenge ProviderChallengeKind
			ProviderChoiceBindingOptions ProviderChoiceConsumeMode ProviderChoiceConsumeResult ProviderChoiceContext ProviderChoiceExplicitParseResult ProviderChoiceIssueOptions ProviderChoiceParseOptions ProviderChoiceStorageOptions
			ProviderContext ProviderDefinition ProviderDeploymentOverrides ProviderErrorStatus ProviderFileRef ProviderFilesContext ProviderHealthMonitorConfig ProviderHealthProbeConfig
			ProviderLocaleKey ProviderLocaleKeyInput ProviderLogoProfile ProviderMeta ProviderOcrConfig ProviderProxyConfig ProviderProxyMode ProviderProxyPolicy
			ProviderProxyProvider ProviderProxySessionAffinity ProviderPublicConnectionMode ProviderPublicProfile ProviderRequestContext ProviderResolvedFile ProviderResolverConfig ProviderResolverVendor
			ProviderReviewed ProviderRuntimeState ProviderSecretDeclaration ProviderStateDurationString ProviderStateNamespace ProviderStreamEvent ProviderSttConfig ProviderSttMode
			ProviderSupportLevel ProxiedOAuthConfig RedirectRunReason RequestOptions RequestParamPrimitive RequestParamValue RequestParams RequestWithMethodOptions
			ResolverContext SchemaLike ShapeArray ShapeMatcher ShapeObject ShapeValue SmsOrigin SmsOtpExtractionPattern
			SmsOtpMatcherDefinition SmsPhoneIdentity SseMessage StandardSchemaV1 StateCasResult StateNamespaceOptions StateNamespaceScope StateValue
			StateWriteOptions StealthClient StealthCookieStore StealthCookieStoreV1 StealthFetchOptions StealthPlatform StealthRedirectHop StealthRedirectRunOptions
			StealthRedirectRunResult StealthResponse StealthSession StealthSessionCookies SttAudioInput SttContext SttPromptPolicy SttSegment
			SttTranscribeMode SttTranscribeRequest SttTranscript SttUnsupportedOptionPolicy SttUsage SttVerificationCodeOptions SttWarning TraceContext
			VALID_OPERATION_ERROR_STATUSES VerificationCodeCandidate VerificationCodeCandidateSource VerificationCodeExtractionResult
		`,
	),
};

if (mode !== "update" && mode !== "check") {
	console.error("Usage: bun scripts/api-reports.ts <update|check>");
	process.exit(2);
}

mkdirSync(tempDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });

const configs = readdirSync(configDir)
	.filter((name) => name.endsWith(".json"))
	.sort();

function collectStringTargets(target: unknown): string[] {
	if (typeof target === "string") return [target];
	if (Array.isArray(target)) return target.flatMap(collectStringTargets);
	if (typeof target !== "object" || target === null) return [];
	return Object.values(target).flatMap(collectStringTargets);
}

function collectTypesTargets(target: unknown): string[] {
	if (Array.isArray(target)) return target.flatMap(collectTypesTargets);
	if (typeof target !== "object" || target === null) return [];
	return Object.entries(target).flatMap(([condition, value]) =>
		condition === "types" ? collectStringTargets(value) : collectTypesTargets(value),
	);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const packageExports = Object.entries(packageJson.exports ?? {});
const typedExports = packageExports.flatMap(([exportName, value]) => {
	const typesTargets = [...new Set(collectTypesTargets(value))];
	return typesTargets.map((types) => ({
		exportName,
		types: types.replace(/^\.\//, ""),
	}));
});
const exemptExports = packageExports.flatMap(([exportName, value]) => {
	if (collectTypesTargets(value).length > 0) return [];
	const exemption = nonTypedExportExemptions[exportName];
	if (!exemption) return [];
	const actualTargets = [...new Set(collectStringTargets(value))].sort();
	const expectedTargets = [...exemption.targets].sort();
	if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) return [];
	return [{ exportName, ...exemption }];
});
const unclassifiedExports = packageExports.filter(([exportName, value]) => {
	if (collectTypesTargets(value).length > 0) return false;
	return !exemptExports.some((entry) => entry.exportName === exportName);
});
const staleExemptions = Object.entries(nonTypedExportExemptions).filter(
	([exportName]) => !exemptExports.some((entry) => entry.exportName === exportName),
);

console.log("Public export classification:");
for (const { exportName, types } of typedExports) {
	console.log(`  typed: ${exportName} (${types})`);
}
for (const { exportName, reason, targets } of exemptExports) {
	console.log(`  exempt asset: ${exportName} (${targets.join(", ")}) — ${reason}`);
}

if (unclassifiedExports.length > 0 || staleExemptions.length > 0) {
	console.error("Public export classification is incomplete or stale.");
	if (unclassifiedExports.length > 0) {
		console.error("Exports without a types condition or an exact non-typed asset exemption:");
		for (const [exportName] of unclassifiedExports) console.error(`  ${exportName}`);
	}
	if (staleExemptions.length > 0) {
		console.error("Non-typed asset exemptions that are absent, typed, or have different targets:");
		for (const [exportName] of staleExemptions) console.error(`  ${exportName}`);
	}
	process.exit(1);
}

const parsedConfigs = configs.map((configName) => {
	const configPath = join(configDir, configName);
	const config = JSON.parse(readFileSync(configPath, "utf8")) as ApiExtractorConfig;
	return {
		config,
		configName,
		configPath,
		// Resolved against projectFolder (like API Extractor itself), re-relativized
		// to the repository root, and normalized to POSIX separators so the value
		// compares against package.json export targets on every platform.
		types: relative(root, resolveConfiguredPath(configPath, config, config.mainEntryPointFilePath))
			.split(sep)
			.join("/"),
	};
});

function resolveConfiguredPath(
	configPath: string,
	config: ApiExtractorConfig,
	configuredPath: string,
): string {
	const configFolder = resolve(configPath, "..");
	const projectFolder = resolve(configFolder, config.projectFolder ?? ".");
	return resolve(configFolder, configuredPath.replaceAll("<projectFolder>", projectFolder));
}

const invalidApiReportConfigs = parsedConfigs.filter(({ config, configPath }) => {
	if (config.apiReport.enabled !== true) return true;
	if (config.apiReport.reportVariants !== undefined) return true;
	if (typeof config.apiReport.reportFolder !== "string") return true;
	return resolveConfiguredPath(configPath, config, config.apiReport.reportFolder) !== reportDir;
});
if (invalidApiReportConfigs.length > 0) {
	console.error(
		`API Extractor configs must enable apiReport and resolve apiReport.reportFolder to ${reportDir}.`,
	);
	for (const { config, configPath } of invalidApiReportConfigs) {
		if (config.apiReport.enabled !== true) {
			console.error(`  ${configPath}: apiReport.enabled must be true.`);
		}
		if (config.apiReport.reportVariants !== undefined) {
			console.error(
				`  ${configPath}: apiReport.reportVariants is not supported; a variant would be written to a suffixed file while this gate verifies ${config.apiReport.reportFileName}.`,
			);
		}
		const reportFolder = config.apiReport.reportFolder;
		if (typeof reportFolder !== "string") {
			console.error(`  ${configPath}: apiReport.reportFolder must be a string.`);
		} else {
			const resolvedReportFolder = resolveConfiguredPath(configPath, config, reportFolder);
			if (resolvedReportFolder !== reportDir) {
				console.error(
					`  ${configPath}: apiReport.reportFolder resolves to ${resolvedReportFolder}.`,
				);
			}
		}
	}
	process.exit(1);
}

const unsafeForgottenExportConfigs = parsedConfigs.filter(
	({ config }) =>
		config.apiReport.includeForgottenExports !== true ||
		config.docModel?.includeForgottenExports !== true,
);
if (unsafeForgottenExportConfigs.length > 0) {
	console.error(
		"API Extractor configs must include forgotten exports in all supported output models.",
	);
	for (const { configName } of unsafeForgottenExportConfigs) console.error(`  ${configName}`);
	process.exit(1);
}

const unsafeReportNameConfigs = parsedConfigs.filter(
	// A plain, non-boundary file name: basename equality alone still admits "", "."
	// and "..", which join() would resolve to a directory rather than a report.
	({ config }) => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.api\.md$/.test(config.apiReport.reportFileName),
);
if (unsafeReportNameConfigs.length > 0) {
	console.error(
		"apiReport.reportFileName must be a plain <name>.api.md file name inside the report folder.",
	);
	for (const { configName, config } of unsafeReportNameConfigs)
		console.error(`  ${configName}: ${config.apiReport.reportFileName}`);
	process.exit(1);
}

const configuredReportNames = new Set(
	parsedConfigs.map(({ config }) => config.apiReport.reportFileName),
);
const duplicateReportNames = [...configuredReportNames].filter(
	(reportName) =>
		parsedConfigs.filter(({ config }) => config.apiReport.reportFileName === reportName).length > 1,
);
if (duplicateReportNames.length > 0) {
	console.error("API report files must be owned by exactly one API Extractor config.");
	for (const reportName of duplicateReportNames) console.error(`  ${reportName}`);
	process.exit(1);
}

const orphanedReports = readdirSync(reportDir)
	.filter((name) => name.endsWith(".api.md") && !configuredReportNames.has(name))
	.sort();
if (orphanedReports.length > 0) {
	if (mode === "check") {
		console.error("Orphaned API reports are not owned by any API Extractor config:");
		for (const reportName of orphanedReports) console.error(`  api-reports/${reportName}`);
		console.error("Run `bun run api:update` to delete orphaned reports.");
		process.exit(1);
	}
	for (const reportName of orphanedReports) {
		unlinkSync(join(reportDir, reportName));
		console.log(`deleted orphaned ${reportName}`);
	}
}

const missingConfigs = typedExports.filter(
	({ types }) => !parsedConfigs.some((config) => config.types === types),
);
const extraConfigs = parsedConfigs.filter(
	({ types }) => !typedExports.some((entry) => entry.types === types),
);
const nonUniqueExports = [...new Set(typedExports.map(({ exportName }) => exportName))]
	.map((exportName) => ({
		exportName,
		types: typedExports
			.filter((entry) => entry.exportName === exportName)
			.map(({ types }) => types),
	}))
	.filter((entry) => entry.types.length > 1);
const nonUniqueTypes = [
	...new Set([
		...typedExports.map(({ types }) => types),
		...parsedConfigs.map(({ types }) => types),
	]),
]
	.map((types) => ({
		configs: parsedConfigs.filter((config) => config.types === types),
		exports: typedExports.filter((entry) => entry.types === types),
		types,
	}))
	.filter((entry) => entry.configs.length > 1 || entry.exports.length > 1);

if (
	missingConfigs.length > 0 ||
	extraConfigs.length > 0 ||
	nonUniqueExports.length > 0 ||
	nonUniqueTypes.length > 0
) {
	console.error("API Extractor config coverage does not match package.json typed exports.");
	if (missingConfigs.length > 0) {
		console.error("Missing configs for typed exports:");
		for (const entry of missingConfigs) console.error(`  ${entry.exportName} (${entry.types})`);
	}
	if (extraConfigs.length > 0) {
		console.error("Extra configs without typed exports:");
		for (const entry of extraConfigs) console.error(`  ${entry.configName} (${entry.types})`);
	}
	if (nonUniqueExports.length > 0) {
		console.error("Typed exports with multiple declaration entry points:");
		for (const entry of nonUniqueExports) {
			console.error(`  ${entry.exportName} (${entry.types.join(", ")})`);
		}
	}
	if (nonUniqueTypes.length > 0) {
		console.error("Typed entry points without one-to-one mappings:");
		for (const entry of nonUniqueTypes) {
			console.error(
				`  ${entry.types}: exports [${entry.exports.map(({ exportName }) => exportName).join(", ")}], configs [${entry.configs.map(({ configName }) => configName).join(", ")}]`,
			);
		}
	}
	process.exit(1);
}

function validateForgottenExports(reportName: string, report: string): boolean {
	const actual = new Set(
		[...report.matchAll(/\(ae-forgotten-export\).*?symbol "([^"]+)"/g)].map(([, symbol]) => symbol),
	);
	const allowance = forgottenExportAllowlist[reportName];
	const expected = allowance?.symbols ?? new Set<string>();
	const unlisted = [...actual].filter((symbol) => !expected.has(symbol)).sort();
	const stale = [...expected].filter((symbol) => !actual.has(symbol)).sort();

	if (unlisted.length === 0 && stale.length === 0) return true;

	console.error(`Forgotten-export allowlist differs: ${reportName}`);
	if (unlisted.length > 0) {
		console.error("Unlisted ae-forgotten-export symbols:");
		for (const symbol of unlisted) console.error(`  ${symbol}`);
	}
	if (stale.length > 0) {
		console.error("Stale ae-forgotten-export allowances:");
		for (const symbol of stale) console.error(`  ${symbol}`);
	}
	if (allowance) console.error(`Current allowance rationale: ${allowance.reason}`);
	console.error("Add or remove exact symbol allowances with an explicit rationale.");
	return false;
}

for (const { config, configPath } of parsedConfigs) {
	const reportName = config.apiReport.reportFileName;
	const committed = join(reportDir, reportName);
	if (mode === "check" && !existsSync(committed)) {
		console.error(`Missing committed API report: api-reports/${reportName}`);
		process.exit(1);
	}
	// Reject anything that is not a real file living directly in reportDir. readFileSync
	// and API Extractor's --local write both follow symlinks, so a tracked report symlink
	// (say, to /dev/null) would make an empty read compare equal to an empty write and
	// let a stale or missing report pass the gate.
	if (existsSync(committed)) {
		const stats = lstatSync(committed);
		if (!stats.isFile()) {
			console.error(
				`Committed API report must be a regular file: api-reports/${reportName} (${
					stats.isSymbolicLink() ? "symbolic link" : "not a regular file"
				}).`,
			);
			process.exit(1);
		}
		if (realpathSync(committed) !== join(realpathSync(reportDir), reportName)) {
			console.error(
				`Committed API report must resolve inside the report folder: api-reports/${reportName}.`,
			);
			process.exit(1);
		}
	}
	const committedBefore = mode === "check" ? readFileSync(committed, "utf8") : undefined;
	const result = Bun.spawnSync(
		["bunx", "api-extractor", "run", "--local", "--config", configPath],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);

	if (result.exitCode !== 0) {
		process.stderr.write(new TextDecoder().decode(result.stdout));
		process.stderr.write(new TextDecoder().decode(result.stderr));
		process.exit(result.exitCode ?? 1);
	}

	const generated = readFileSync(committed, "utf8");
	const forgottenExportsValid = validateForgottenExports(reportName, generated);
	if (mode === "update") {
		console.log(`updated ${reportName}`);
	} else {
		writeFileSync(committed, committedBefore);
		if (committedBefore !== generated) {
			console.error(`API surface differs: ${reportName}`);
			console.error("Run `bun run api:update` and commit the resulting api-reports diff.");
			process.exitCode = 1;
		} else {
			console.log(`verified ${reportName}`);
		}
	}
	if (!forgottenExportsValid) process.exitCode = 1;
}

if (mode === "check" && process.exitCode) {
	process.exit(process.exitCode);
}
