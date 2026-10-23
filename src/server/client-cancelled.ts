/**
 * The HTTP status served and logged for a request its caller cancelled: a
 * streaming response whose client went away, and a non-streaming request
 * whose transport was cancelled because the caller closed the connection.
 */
export const CLIENT_CANCELLED_STATUS = 400;
