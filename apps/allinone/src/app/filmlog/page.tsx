import Link from "next/link";
import { getFilmDb, listOptions, listRolls } from "@/lib/filmlog/store";
import { FilmClient } from "./film-client";
import "./film.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "胶卷日志 · AllInOne" };
export default function FilmLogPage() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const db = getFilmDb();
  return <main className="fl-page"><Link href="/" className="fl-back">← 返回工具箱</Link><FilmClient rolls={listRolls(db)} today={today} options={listOptions(db)} /></main>;
}
