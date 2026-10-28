import Link from "next/link";

import { getTravelDB, listTripSummaries } from "@/lib/travel/db";

import { DeleteTripButton } from "./delete-trip-button";
import { NewTripForm } from "./new-trip-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "旅行攻略",
};

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function first(params: Record<string, string | string[] | undefined>, key: string): string {
  const v = params[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export default async function TravelHomePage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {};
  const trips = listTripSummaries(getTravelDB());
  const error = first(params, "error");
  const flash = first(params, "flash");

  return (
    <main className="travel-page">
      <div className="travel-container">
        <Link href="/" className="travel-back">← 工具箱</Link>
        <header className="travel-hero">
          <p className="travel-kicker">Travel Planner</p>
          <h1 className="travel-title">旅行攻略</h1>
          <p className="travel-sub">按天安排地点顺序，在地图上标注，收集照片与各平台攻略链接。</p>
        </header>

        {error ? <p className="travel-note travel-note-error">{error}</p> : null}
        {flash ? <p className="travel-note travel-note-ok">{flash}</p> : null}

        <NewTripForm />

        {trips.length === 0 ? (
          <p className="travel-empty">还没有行程。用上面的表单创建第一个行程吧。</p>
        ) : (
          <div className="trip-grid">
            {trips.map((t) => (
              <div key={t.id} className="trip-card">
                <Link href={`/travel/${t.id}`} className="trip-card-link">
                  <div className="trip-card-cover">
                    {t.coverFile ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={`/api/travel/photos/${t.coverFile}`} alt="" loading="lazy" />
                    ) : (
                      <span className="trip-card-cover-empty" aria-hidden>🗺️</span>
                    )}
                  </div>
                  <div className="trip-card-body">
                    <h2 className="trip-card-title">{t.title}</h2>
                    {t.description ? <p className="trip-card-desc">{t.description}</p> : null}
                    <p className="trip-card-meta">
                      {t.dayCount} 天 · {t.placeCount} 个地点
                      {t.startDate ? ` · ${t.startDate} 出发` : ""}
                    </p>
                  </div>
                </Link>
                <DeleteTripButton tripId={t.id} title={t.title} />
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
