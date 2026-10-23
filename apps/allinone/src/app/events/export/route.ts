import {
  buildEventExportFileName,
  eventExportLimit,
  listEventDetailsPage,
  parseEventFilters,
  toEventCsv,
} from "@/lib/ledger/events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filters = parseEventFilters(url.searchParams);
  const result = await listEventDetailsPage(filters, 1, eventExportLimit);

  if (result.total === 0) {
    return new Response("没有可导出的数据。", {
      status: 400,
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  if (result.total > eventExportLimit) {
    return new Response(
      `当前筛选结果共 ${result.total} 条，已超过 ${eventExportLimit} 条导出上限，请缩小筛选范围后再导出。`,
      {
        status: 400,
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  return new Response(toEventCsv(result.items), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${buildEventExportFileName()}"`,
    },
  });
}
