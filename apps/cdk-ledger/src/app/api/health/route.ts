import { dbQuery } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await dbQuery("select 1");

    return Response.json({
      ok: true,
      database: "up",
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        database: "down",
        error: error instanceof Error ? error.message : "unknown error",
      },
      {
        status: 503,
      },
    );
  }
}
