export function LoadingSpinner({ size = 'md', text }: { size?: 'sm' | 'md' | 'lg'; text?: string }) {
  const sizeMap = { sm: 'w-4 h-4', md: 'w-8 h-8', lg: 'w-12 h-12' };
  return (
    <div className="flex flex-col items-center gap-3">
      <div className={`${sizeMap[size]} border-2 border-slate-700 border-t-sky-500 rounded-full animate-spin`} />
      {text && <p className="text-xs text-slate-400">{text}</p>}
    </div>
  );
}

export function FullPageLoading({ text = '載入中...' }: { text?: string }) {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <LoadingSpinner size="lg" text={text} />
    </div>
  );
}
