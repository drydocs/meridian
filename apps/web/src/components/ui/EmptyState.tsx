interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  className?: string;
}

export function EmptyState({ icon, title, description, className = "" }: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center py-14 px-6 rounded-2xl border border-dashed border-gray-800 bg-gray-900/30 text-center ${className}`}
    >
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gray-800 mb-4 text-gray-400">
        {icon}
      </div>
      <p className="text-sm font-semibold text-white mb-1">{title}</p>
      <p className="text-xs text-gray-500 max-w-[220px] leading-relaxed">{description}</p>
    </div>
  );
}
