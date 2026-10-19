import type { StatusInfo } from "./model.js";

const phrases: Readonly<Record<number, string>> = {
  100: "Continue", 101: "Switching Protocols", 102: "Processing", 103: "Early Hints",
  200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information",
  204: "No Content", 205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
  208: "Already Reported", 226: "IM Used", 300: "Multiple Choices", 301: "Moved Permanently",
  302: "Found", 303: "See Other", 304: "Not Modified", 305: "Use Proxy",
  307: "Temporary Redirect", 308: "Permanent Redirect", 400: "Bad Request", 401: "Unauthorized",
  402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 407: "Proxy Authentication Required", 408: "Request Timeout",
  409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed",
  413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type",
  416: "Range Not Satisfiable", 417: "Expectation Failed", 418: "I'm a Teapot",
  421: "Misdirected Request", 422: "Unprocessable Entity", 423: "Locked", 424: "Failed Dependency",
  425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway",
  503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates", 507: "Insufficient Storage", 508: "Loop Detected",
  509: "Bandwidth Limit Exceeded", 510: "Not Extended", 511: "Network Authentication Required",
};

const descriptions: Readonly<Record<number, string>> = {
  100: "The request may continue.",
  101: "The server is switching protocols.",
  102: "The server is still processing the request.",
  103: "The server is sending early response hints.",
  200: "The request succeeded.",
  201: "The request succeeded and created a resource.",
  202: "The request was accepted for processing.",
  203: "The response came from a transforming proxy.",
  204: "The request succeeded with no response content.",
  205: "The client should reset the document view.",
  206: "The server returned part of the requested resource.",
  207: "The response contains results for multiple resources.",
  208: "The resource was already reported in this response.",
  226: "The server returned an instance manipulation result.",
  300: "The request has multiple possible destinations.",
  301: "The resource has moved permanently.",
  302: "The resource is temporarily available at another location.",
  303: "The response points to another resource to retrieve.",
  304: "The resource has not changed since the last request.",
  305: "The resource must be accessed through a proxy.",
  307: "The resource is temporarily available at another location.",
  308: "The resource has moved permanently.",
  400: "The request is malformed or invalid.",
  401: "Authentication is required or has failed.",
  402: "Payment is required to complete the request.",
  403: "The server refuses to authorize the request.",
  404: "The server cannot find the requested resource.",
  405: "The method is not supported for this resource.",
  406: "The resource cannot meet the request's content negotiation rules.",
  407: "Authentication with the proxy is required.",
  408: "The request took too long to arrive.",
  409: "The request conflicts with the current resource state.",
  410: "The resource is no longer available.",
  411: "The request must include a content length.",
  412: "A request precondition was not met.",
  413: "The request body is larger than the server accepts.",
  414: "The request URI is longer than the server accepts.",
  415: "The request media type is not supported.",
  416: "The requested byte range cannot be served.",
  417: "The request expectation cannot be met.",
  418: "The server refuses the request as a teapot.",
  421: "The request was sent to a server unable to respond for this host.",
  422: "The request is understood but its instructions cannot be processed.",
  423: "The resource is locked.",
  424: "The request failed because a dependent request failed.",
  425: "The server is unwilling to risk processing an early replay.",
  426: "The client must switch to another protocol.",
  428: "The request must include a precondition.",
  429: "The client has sent too many requests.",
  431: "The request headers are too large for the server to process.",
  451: "The resource is unavailable for legal reasons.",
  500: "The server encountered an unexpected condition.",
  501: "The server does not support the requested functionality.",
  502: "A gateway received an invalid upstream response.",
  503: "The server is temporarily unable to handle the request.",
  504: "A gateway did not receive an upstream response in time.",
  505: "The server does not support the request's HTTP version.",
  506: "The server has a content negotiation configuration error.",
  507: "The server cannot store the representation needed to complete the request.",
  508: "The server detected an infinite processing loop.",
  509: "The server's bandwidth limit has been exceeded.",
  510: "The request extension is not supported.",
  511: "Network authentication is required to access the server.",
};

const category = (code: number): string =>
  code < 200 ? "Informational" : code < 300 ? "Success" : code < 400 ? "Redirection" : code < 500 ? "Client error" : "Server error";

const statuses: readonly StatusInfo[] = Object.freeze(
  Object.entries(phrases)
    .map(([code, phrase]) => Object.freeze({ code: Number(code), phrase, category: category(Number(code)), description: descriptions[Number(code)] }))
    .sort((left, right) => left.code - right.code),
);

export function getStatus(code: number): StatusInfo | undefined {
  return statuses.find((status) => status.code === code);
}

export function getAllStatuses(): readonly StatusInfo[] {
  return statuses;
}
