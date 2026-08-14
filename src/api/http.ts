import { errorDocument } from "./jsonapi.ts";

export const JSONAPI = "application/vnd.api+json";
export const DEFAULT_BODY_LIMIT = 1_048_576;

const ACCEPTABLE_MEDIA = new Set([
  JSONAPI,
  "application/json",
  "*/*",
  "application/*",
]);

export function jsonResponse(
  body: unknown,
  status = 200,
  contentType = JSONAPI,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": contentType, ...headers },
  });
}

export function methodNotAllowed(allow: string): Response {
  return jsonResponse(
    errorDocument([{
      status: "405",
      title: "method not allowed",
      detail: `Only ${allow} is allowed for this route.`,
    }]),
    405,
    JSONAPI,
    { Allow: allow },
  );
}

export function unsupportedMediaType(): Response {
  return jsonResponse(
    errorDocument([{
      status: "415",
      title: "unsupported media type",
      detail: `Content-Type must be ${JSONAPI}.`,
    }]),
    415,
  );
}

export function notAcceptable(): Response {
  return jsonResponse(
    errorDocument([{
      status: "406",
      title: "not acceptable",
      detail: `Accept must include ${JSONAPI} or application/json.`,
    }]),
    406,
  );
}

export function payloadTooLarge(limit: number): Response {
  return jsonResponse(
    errorDocument([{
      status: "413",
      title: "payload too large",
      detail: `Request body exceeds the ${limit}-byte limit.`,
    }]),
    413,
  );
}

export function notFoundResponse(): Response {
  return jsonResponse(
    errorDocument([{
      status: "404",
      title: "not found",
      detail: "No route matches this request.",
    }]),
    404,
  );
}

export function unsupportedNodeTypeError(): Response {
  return jsonResponse(
    errorDocument([
      {
        status: "422",
        title: "unsupported node type",
        detail: "The declared node type is not supported.",
      },
    ]),
    422,
  );
}

export function hasJsonApiContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  return contentType !== null && contentType.toLowerCase().includes(JSONAPI);
}

export function acceptsJsonApi(request: Request): boolean {
  const accept = request.headers.get("accept");
  if (accept === null || accept.trim() === "") {
    return true;
  }
  return accept.split(",").some((part) => {
    const media = part.trim().split(";")[0]!.trim().toLowerCase();
    return ACCEPTABLE_MEDIA.has(media);
  });
}

export interface ParsedBody {
  ok: boolean;
  tooLarge: boolean;
  body: unknown;
}

export async function parseBody(
  request: Request,
  limit: number,
): Promise<ParsedBody> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    return { ok: false, tooLarge: true, body: null };
  }

  let bytes: Uint8Array | null = null;
  const reader = request.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.length;
        if (total > limit) {
          await reader.cancel();
          return { ok: false, tooLarge: true, body: null };
        }
        chunks.push(value);
      }
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    bytes = all;
  } else {
    bytes = new Uint8Array(await request.arrayBuffer());
  }

  try {
    return {
      ok: true,
      tooLarge: false,
      body: JSON.parse(new TextDecoder().decode(bytes)),
    };
  } catch {
    return { ok: false, tooLarge: false, body: null };
  }
}
