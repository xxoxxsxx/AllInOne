import { notFound } from "next/navigation";

import { getAmapKey, getTravelDB, getTrip } from "@/lib/travel/db";

import { TravelClient } from "../travel-client";

export const dynamic = "force-dynamic";

export default async function TripPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tripId = Number(id);
  if (!Number.isInteger(tripId) || tripId <= 0) notFound();
  const trip = getTrip(getTravelDB(), tripId);
  if (!trip) notFound();
  return <TravelClient trip={trip} searchConfigured={getAmapKey(getTravelDB()).trim() !== ""} />;
}
