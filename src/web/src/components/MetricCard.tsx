interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  color?: string;
}

export function MetricCard({ label, value, subtitle, color = 'text-white' }: MetricCardProps) {
  return (
    <div className="border border-white/[0.08] rounded-lg p-4">
      <p className="text-[11px] text-neutral-500 uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {subtitle && <p className="text-xs text-neutral-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}
