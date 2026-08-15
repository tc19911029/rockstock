import type { ReactNode } from 'react';

export default function SignalDisclosure({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children?: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-border/45 bg-secondary/10">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-3 text-xs font-semibold text-foreground/80 outline-none transition-colors duration-200 hover:bg-secondary/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-400/70 [&::-webkit-details-marker]:hidden">
        <svg
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none"
          viewBox="0 0 20 20"
          fill="none"
        >
          <path d="m7.5 4.5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>{title}</span>
        {meta && (
          <span className="ml-auto max-w-36 truncate text-right text-[10px] font-normal text-muted-foreground/75">
            {meta}
          </span>
        )}
      </summary>
      <div className="border-t border-border/35 px-3 py-2.5">
        {children}
      </div>
    </details>
  );
}
