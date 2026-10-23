type EventEntryHistoryProps = {
  items: string[];
};

export function EventEntryHistory({ items }: EventEntryHistoryProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border bg-white/70 px-4 py-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">最近录入</h3>
        <span className="text-xs text-muted">数据库最近 3 条</span>
      </div>

      <ul className="mt-3 space-y-2 text-sm text-muted">
        {items.map((item, index) => (
          <li
            key={`${item}-${index}`}
            className="rounded-xl border border-border/70 bg-surface px-3 py-2"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
