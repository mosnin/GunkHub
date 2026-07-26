import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  children: ReactNode
}

// Buttons are pills (design.md: 9999px radius). Primary = Whiteout bg / Graphite
// Deep text; Ghost = transparent with a Graphite-light hairline border.
const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-whiteout hover:bg-cloud text-graphite-deep border-transparent focus-visible:ring-neon-glow',
  secondary:
    'bg-graphite hover:bg-graphite-light text-whiteout border-graphite-light focus-visible:ring-neon-glow',
  ghost:
    'bg-transparent hover:bg-graphite text-whiteout border-graphite-light hover:border-neutral-600 focus-visible:ring-neon-glow',
  destructive:
    // Label is destructive-400 (#ff6a5a), not System Warning #ff3621: the red
    // must survive its own hover ground. #ff3621 on the destructive-900 hover
    // fill is 4.12:1 — sub-AA — while #ff6a5a clears 5.30:1 there and ≥4.56:1
    // on every sanctioned surface. The red is kept, not dropped (design.md:
    // "System Warning ... Never Text On: Graphite, Graphite Light").
    'bg-transparent hover:bg-destructive-900 text-destructive-400 border-destructive-700 focus-visible:ring-destructive-500',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'px-4 py-1.5 text-xs',
  md: 'px-[18px] py-2 text-sm',
  lg: 'px-7 py-3 text-sm',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center font-medium rounded-full border',
        'transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-blackout',
        'disabled:opacity-40 disabled:pointer-events-none',
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
