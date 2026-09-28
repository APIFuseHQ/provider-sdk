// A header-constants module in its own file, the fleet layout the owned-header
// lint cannot see across (provider-sdk#316): the stealth call site is elsewhere.
export const DOCUMENT_HEADERS = {
	accept: "text/html",
	"Sec-Fetch-Dest": "document",
};
