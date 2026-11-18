import { FundingError, FundingStore, type Collection } from "./store";
import { fundingOpenApi } from "./openapi";
const collections = new Set(["accounts", "batches", "transfers", "goals"]);
export async function fundingRequest(
  request: Request,
  segments: string[],
): Promise<Response> {
  try {
    const [resource, id, action] = segments;
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      const requestUrl = new URL(request.url);
      const host =
        request.headers.get("x-forwarded-host") ||
        request.headers.get("host") ||
        requestUrl.host;
      let originHost: string | null = null;
      if (origin) {
        try {
          originHost = new URL(origin).host;
        } catch {
          throw new FundingError("Invalid Origin", 403);
        }
      }
      if (
        request.headers.get("sec-fetch-site") === "cross-site" ||
        (originHost && originHost !== host)
      )
        throw new FundingError("Cross-origin writes are not allowed", 403);
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        throw new FundingError("Content-Type must be application/json", 415);
      if (Number(request.headers.get("content-length") || "0") > 1048576)
        throw new FundingError("Request body too large", 413);
    }
    if (segments.length > 3) throw new FundingError("not found", 404);
    if (
      request.method === "GET" &&
      (resource === "openapi" || resource === "openapi.json") &&
      !id
    )
      return Response.json(fundingOpenApi);
    const store = new FundingStore();
    if (request.method === "GET" && !id && resource === "summary")
      return Response.json(store.summary());
    if (request.method === "GET" && !id && resource === "changes")
      return Response.json(
        store.changes(
          Number(new URL(request.url).searchParams.get("after") ?? "0"),
        ),
      );
    if (!collections.has(resource)) throw new FundingError("not found", 404);
    const collection = resource as Collection;
    if (request.method === "GET" && !action) {
      if (id)
        return Response.json(
          collection === "batches"
            ? (store.batches().find((b) => b.id === id) ??
                store.get(collection, id))
            : store.get(collection, id),
        );
      const query = new URL(request.url).searchParams;
      const records =
        collection === "batches" ? store.batches() : store.list(collection);
      return Response.json(
        records.filter((record) => {
          const r = record as unknown as Record<string, unknown>;
          for (const key of [
            "currency",
            "status",
            "sourceStatus",
            "pathStatus",
            "kind",
            "accountId",
            "fromAccountId",
            "toAccountId",
          ]) {
            const value = query.get(key);
            if (
              value &&
              r[key] !== value &&
              !(key === "currency" && r.receivedCurrency === value)
            )
              return false;
          }
          const when = String(
            r.confirmedAt || r.occurredAt || r.createdAt,
          ).slice(0, 10);
          if (query.get("startDate") && when < query.get("startDate")!)
            return false;
          if (query.get("endDate") && when > query.get("endDate")!)
            return false;
          return true;
        }),
      );
    }
    let input: unknown;
    const body = await request.text();
    if (body.length > 1048576)
      throw new FundingError("Request body too large", 413);
    try {
      input = body.trim() ? JSON.parse(body) : {};
    } catch {
      throw new FundingError("invalid JSON body");
    }
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new FundingError("request body must be an object");
    return Response.json(
      store.mutate(
        request.method,
        collection,
        id,
        action,
        input as Record<string, unknown>,
        request.headers.get("Idempotency-Key") ?? undefined,
        request.headers.get("X-Funding-Source") ?? "api",
      ),
    );
  } catch (error) {
    if (error instanceof FundingError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Funding API error", error);
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
