export function UsageRing({ percent }: { percent: number | null }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 20 20" className="flex-none -rotate-90">
      <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-cg-line-strong" />
      {value === null ? null : <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${(value * 0.4398).toFixed(4)} 43.98`} className={value >= 90 ? "text-cg-del-fg" : value >= 75 ? "text-cg-amber-text" : "text-cg-muted-strong"} />}
    </svg>
  );
}
