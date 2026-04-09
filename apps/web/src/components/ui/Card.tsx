import { cn } from '@/lib/utils'

interface CardProps {
  children: React.ReactNode
  variant?: 'default' | 'elevated'
  className?: string
}

export function Card({ children, variant = 'default', className }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-md border',
        variant === 'default' && 'bg-neutral-900 border-neutral-800',
        variant === 'elevated' && 'bg-neutral-850 border-neutral-700 shadow-lg shadow-black/30',
        className
      )}
    >
      {children}
    </div>
  )
}
