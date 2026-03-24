interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center border border-white/[0.08] bg-white/[0.02] rounded-lg">
      {icon && <div className="text-neutral-500 mb-3">{icon}</div>}
      <p className="text-sm font-medium text-neutral-200">{title}</p>
      {description && <p className="text-xs text-neutral-400 mt-1 max-w-xs">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
