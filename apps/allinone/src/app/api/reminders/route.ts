import { create, list } from "@/lib/reminders/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = list;
export const POST = create;
