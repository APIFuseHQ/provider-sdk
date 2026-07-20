import type { XmlElement } from "@rgrove/parse-xml";

const FAILURE_TEXT_PATTERN =
	/\b(?:access denied|denied|error|exception|failed|failure|fault|forbidden|invalid|maintenance|not authorized|temporarily unavailable|unauthorized|unavailable)\b/i;
const KOREAN_FAILURE_TEXT_PATTERN =
	/(?:오류|에러|실패|장애|점검|서비스\s*(?:중단|불가)|(?:일시적(?:으로)?\s*)?(?:이용|사용)\s*(?:이|가)?\s*(?:불가|어렵|할\s*수\s*없))/u;
const SUCCESS_CODE_PATTERN = /^(?:0+|2\d\d|2xx|ok|success|successful|normalservice)$/;
const SUCCESS_VALUE_PATTERN = /^(?:1|true|y|yes|ok|success|successful)$/;
const SUCCESS_TEXT_PATTERN = /^(?:normalserviceresponse|successfulresponse)$/;
const LOCALIZED_SUCCESS_TEXT_PATTERN =
	/^(?:成功|正常|処理完了|正常終了|処理が完了しました|성공|정상|처리완료|처리가완료되었습니다|处理完成|處理完成|操作成功)$/u;
const CODE_SHAPED_VALUE_PATTERN = /^(?:\d+|[1-5]xx)$/;
const CODE_CONTROL_FIELDS: ReadonlySet<string> = new Set([
	"httpstatus",
	"resultcode",
	"returnreasoncode",
	"statuscode",
]);
const TEXT_CONTROL_FIELDS: ReadonlySet<string> = new Set([
	"message",
	"msg",
	"reason",
	"resultmessage",
	"resultmsg",
	"state",
	"status",
	"statustext",
]);
const SUCCESS_CONTROL_FIELDS: ReadonlySet<string> = new Set([
	"issuccess",
	"ok",
	"success",
	"successful",
]);
const ERROR_CODE_FIELD_PATTERN = /^(?:(?:error|exception|fault)(?:code|status)s?|errcode)$/;
const ERROR_TEXT_FIELD_PATTERN =
	/^(?:(?:error|exception|fault)(?:description|detail|details|info|message|reason|string|type)?s?|errmsg|returnauthmsg)$/;
const STRONG_CONTROL_CONTEXT_NAMES: ReadonlySet<string> = new Set([
	"cmmmsgheader",
	"control",
	"error",
	"exception",
	"fault",
	"header",
	"meta",
	"result",
	"status",
]);
const ORDINARY_ENVELOPE_NAMES: ReadonlySet<string> = new Set(["body", "envelope", "response"]);
const ERROR_ROOT_NAMES: ReadonlySet<string> = new Set([
	"error",
	"errorresponse",
	"exception",
	"exceptionresponse",
	"fault",
	"faultresponse",
]);
const DOMAIN_BOUNDARY_NAMES: ReadonlySet<string> = new Set([
	"entry",
	"item",
	"measurement",
	"record",
	"row",
]);

export type XmlSemanticBranch = "control" | "domain" | "envelope" | "error" | "neutral";

// A control failure is only meaningful in a control/error/envelope context.
// Inside a domain boundary (item/record/row/…) the same field names are ordinary
// data — e.g. `faultCode` describing a charger's fault is not a service failure.
export function hasSemanticXmlFailure(element: XmlElement, branch: XmlSemanticBranch): boolean {
	if (branch === "domain") return false;
	const insideError = branch === "error";
	const strongControl = insideError || branch === "control";
	const insideControl = strongControl || branch === "envelope";
	const fieldName = normalizedXmlName(element.name);
	const value = element.text.trim();
	if (
		hasControlValueFailure({
			fieldName,
			value,
			insideControl: insideControl || isSemanticControlField(fieldName),
			strongControl,
		})
	) {
		return true;
	}
	return Object.entries(element.attributes).some(([name, attributeValue]) =>
		hasControlValueFailure({
			fieldName: normalizedXmlName(name),
			value: attributeValue.trim(),
			insideControl: true,
			strongControl: true,
		}),
	);
}

export function rootXmlContext(name: string): XmlSemanticBranch {
	if (DOMAIN_BOUNDARY_NAMES.has(name)) return "domain";
	if (isXmlErrorWrapperName(name)) return "error";
	if (isStrongControlContextName(name)) return "control";
	return ORDINARY_ENVELOPE_NAMES.has(name) ? "envelope" : "neutral";
}

export function childXmlContext(parent: XmlSemanticBranch, name: string): XmlSemanticBranch {
	if (parent === "control" || parent === "domain" || parent === "error") return parent;
	if (isXmlErrorWrapperName(name)) return "error";
	if (isStrongControlContextName(name)) return "control";
	if (DOMAIN_BOUNDARY_NAMES.has(name)) return "domain";
	return parent === "envelope" || ORDINARY_ENVELOPE_NAMES.has(name) ? "envelope" : "neutral";
}

export function isXmlErrorRootName(name: string): boolean {
	return ERROR_ROOT_NAMES.has(name) || isXmlErrorWrapperName(name);
}

export function normalizedXmlName(name: string): string {
	const compatibleName = name.normalize("NFKC");
	const localName = compatibleName.slice(compatibleName.lastIndexOf(":") + 1);
	return localName.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
}

function hasControlValueFailure(input: {
	readonly fieldName: string;
	readonly value: string;
	readonly insideControl: boolean;
	readonly strongControl: boolean;
}): boolean {
	const { fieldName, value, insideControl, strongControl } = input;
	const normalizedValue = normalizedXmlValue(value);
	if (ERROR_CODE_FIELD_PATTERN.test(fieldName)) {
		return !SUCCESS_CODE_PATTERN.test(normalizedValue);
	}
	if (ERROR_TEXT_FIELD_PATTERN.test(fieldName)) {
		return normalizedValue.length > 0 && !SUCCESS_CODE_PATTERN.test(normalizedValue);
	}
	if (
		strongControl &&
		TEXT_CONTROL_FIELDS.has(fieldName) &&
		normalizedValue.length > 0 &&
		!isExplicitSuccess(normalizedValue)
	) {
		return true;
	}
	const isCodeControl =
		CODE_CONTROL_FIELDS.has(fieldName) ||
		(fieldName === "code" && insideControl) ||
		(fieldName === "status" && insideControl && CODE_SHAPED_VALUE_PATTERN.test(normalizedValue));
	if (isCodeControl && !SUCCESS_CODE_PATTERN.test(normalizedValue)) return true;
	if (
		insideControl &&
		SUCCESS_CONTROL_FIELDS.has(fieldName) &&
		!SUCCESS_VALUE_PATTERN.test(normalizedValue)
	) {
		return true;
	}
	return insideControl && TEXT_CONTROL_FIELDS.has(fieldName) && hasFailureText(value);
}

function isSemanticControlField(fieldName: string): boolean {
	return (
		CODE_CONTROL_FIELDS.has(fieldName) ||
		TEXT_CONTROL_FIELDS.has(fieldName) ||
		SUCCESS_CONTROL_FIELDS.has(fieldName) ||
		ERROR_CODE_FIELD_PATTERN.test(fieldName) ||
		ERROR_TEXT_FIELD_PATTERN.test(fieldName) ||
		fieldName === "code"
	);
}

function isExplicitSuccess(value: string): boolean {
	return (
		SUCCESS_CODE_PATTERN.test(value) ||
		SUCCESS_VALUE_PATTERN.test(value) ||
		SUCCESS_TEXT_PATTERN.test(value) ||
		LOCALIZED_SUCCESS_TEXT_PATTERN.test(value)
	);
}

function isStrongControlContextName(name: string): boolean {
	return STRONG_CONTROL_CONTEXT_NAMES.has(name) || name.endsWith("control");
}

function isXmlErrorWrapperName(name: string): boolean {
	return /(?:error|exception|fault)(?:response)?$/.test(name);
}

function hasFailureText(value: string): boolean {
	const normalized = value.normalize("NFKC");
	return [normalized, normalized.replace(/\p{Cf}/gu, "")].some((candidate) => {
		if (KOREAN_FAILURE_TEXT_PATTERN.test(candidate)) return true;
		const tokenized = candidate
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.replace(/[^A-Za-z0-9]+/g, " ");
		return FAILURE_TEXT_PATTERN.test(tokenized);
	});
}

function normalizedXmlValue(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]/gu, "")
		.toLowerCase();
}
