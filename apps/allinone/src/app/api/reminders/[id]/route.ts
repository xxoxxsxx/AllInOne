import { detail } from "@/lib/reminders/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return detail(request, (await context.params).id, "get");
}
export async function PATCH(request: Request, context: Context) {
  return detail(request, (await context.params).id, "patch");
}
export async function DELETE(request: Request, context: Context) {
  return detail(request, (await context.params).id, "delete");
}
