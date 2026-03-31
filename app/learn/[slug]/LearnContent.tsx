'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Link from 'next/link';

interface LearnContentProps {
  content: string;
}

export function LearnContent({ content }: LearnContentProps) {
  return (
    <article className="prose prose-invert prose-slate max-w-none
      prose-headings:font-bold
      prose-h1:text-2xl prose-h1:border-b prose-h1:border-slate-700 prose-h1:pb-3 prose-h1:mb-6
      prose-h2:text-xl prose-h2:mt-10 prose-h2:mb-4
      prose-h3:text-lg prose-h3:mt-8 prose-h3:mb-3
      prose-p:text-slate-300 prose-p:leading-relaxed
      prose-li:text-slate-300
      prose-strong:text-white
      prose-code:text-emerald-400 prose-code:bg-slate-800 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:before:content-none prose-code:after:content-none
      prose-pre:bg-slate-900 prose-pre:border prose-pre:border-slate-700 prose-pre:rounded-lg
      prose-blockquote:border-l-blue-500 prose-blockquote:bg-blue-500/5 prose-blockquote:py-1 prose-blockquote:px-4 prose-blockquote:rounded-r-lg
      prose-table:text-sm
      prose-th:text-slate-200 prose-th:bg-slate-800/50 prose-th:px-3 prose-th:py-2
      prose-td:px-3 prose-td:py-2 prose-td:border-slate-700
      prose-hr:border-slate-700
      prose-a:text-blue-400 prose-a:no-underline hover:prose-a:text-blue-300
    ">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        children={content}
        components={{
          // Internal links (relative .md files) → Next.js Link
          a: ({ href, children, ...props }) => {
            if (href && href.endsWith('.md') && !href.startsWith('http')) {
              const slug = href.replace('.md', '').replace(/^\.\//, '');
              return (
                <Link href={`/learn/${slug}`} className="text-blue-400 hover:text-blue-300">
                  {children}
                </Link>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            );
          },
        }}
      />
    </article>
  );
}
