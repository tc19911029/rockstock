'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  /** 目標路徑（default '/'）。提供 onClick 時忽略。 */
  href?: string;
  /** with-label variant 顯示的文字（e.g. "回主頁"） */
  label?: string;
  /** 'icon' 只顯示 ⬅️；'with-label' 顯示 ⬅️ + label */
  variant?: 'icon' | 'with-label';
  className?: string;
  /** 提供時 render <button>（mobile fullscreen 模式關閉用，不導頁） */
  onClick?: () => void;
}

export function BackButton({
  href = '/',
  label,
  variant = 'icon',
  className,
  onClick,
}: BackButtonProps) {
  const baseClass = cn(
    'inline-flex items-center gap-1.5 shrink-0',
    'text-muted-foreground hover:text-foreground transition-colors',
    'min-h-11 min-w-11 justify-center rounded-md text-base leading-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
    variant === 'with-label' && 'text-sm',
    className,
  );

  const content = (
    <>
      <ArrowLeft className="size-5" aria-hidden="true" />
      {variant === 'with-label' && label && (
        <span className="text-sm">{label}</span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label ?? '返回'}
        data-testid="back-button"
        className={baseClass}
      >
        {content}
      </button>
    );
  }

  return (
    <Link
      href={href}
      aria-label={label ?? '返回'}
      data-testid="back-button"
      className={baseClass}
    >
      {content}
    </Link>
  );
}
