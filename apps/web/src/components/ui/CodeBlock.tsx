import { CopyToClipboardButton } from '@/components/ui/CopyToClipboardButton'
import { cn } from '@/lib/utils'

interface CodeBlockProps {
  content: string
  language?: string
  maxHeight?: string
  className?: string
}

export function CodeBlock({ content, language, maxHeight = '400px', className }: CodeBlockProps) {
  return (
    <div
      className={cn(
        'relative rounded-md border border-neutral-800 bg-neutral-950',
        className
      )}
    >
      <div className="px-3 py-1.5 border-b border-neutral-800 flex items-center justify-between">
        <span className="text-xs font-mono text-neutral-500">{language ?? 'text'}</span>
        <CopyToClipboardButton value={content} label="Copy code to clipboard" />
      </div>
      <div
        className="overflow-auto p-4"
        style={{ maxHeight }}
      >
        <pre className="text-xs font-mono text-neutral-300 whitespace-pre-wrap break-words leading-relaxed">
          {content}
        </pre>
      </div>
    </div>
  )
}
