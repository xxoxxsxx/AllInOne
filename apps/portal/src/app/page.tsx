import { HomeView } from "@/components/home-view";
import { loadCatalog } from "@/lib/tools";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const { tools, categories, error } = loadCatalog();
  return <HomeView tools={tools} categories={categories} loadError={error} />;
}
