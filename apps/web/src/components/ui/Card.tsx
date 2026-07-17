import { cn } from '@/lib/utils'

interface CardProps {
  children: React.ReactNode
  variant?: 'default' | 'elevated'
  className?: string
}

// Cards are layered near-black surfaces with a hairline border (design.md:
// depth comes from stacking surfaces, never from box-shadows). 4px radius.
export function Card({ children, variant = 'default', className }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-[4px] border',
        variant === 'default' && 'bg-graphite-deep border-graphite',
        variant === 'elevated' && 'bg-graphite border-graphite-light',
        className
      )}
    >
      {children}
    </div>
  )
}
