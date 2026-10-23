type DashboardStatCardProps = {
  description: string;
  title: string;
  value: number;
};

export function DashboardStatCard({
  description,
  title,
  value,
}: DashboardStatCardProps) {
  return (
    <article className="rounded-2xl border border-border bg-white/85 p-5">
      <p className="text-xs uppercase tracking-[0.22em] text-accent">{title}</p>
      <p className="mt-4 text-4xl font-semibold tracking-tight">{value}</p>
      <p className="mt-3 text-sm leading-7 text-muted">{description}</p>
    </article>
  );
}
