'use client'

import { motion, type HTMLMotionProps } from 'framer-motion'

import type { ReactNode } from 'react'

// Shared motion primitives for the Neon UI. Reveals are subtle (opacity + small
// translate), honor prefers-reduced-motion via framer's built-in reducedMotion,
// and stagger children for an orchestrated page-load (design.md motion guidance).

const easeOut = [0.16, 1, 0.3, 1] as const

/** Fade + rise a single block into view on mount. */
export function Reveal({
  children,
  delay = 0,
  className,
  ...props
}: { children: ReactNode; delay?: number; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: easeOut, delay }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/** Container that staggers the reveal of its `RevealItem` children as they scroll in. */
export function RevealGroup({
  children,
  className,
  stagger = 0.06,
}: {
  children: ReactNode
  className?: string
  stagger?: number
}) {
  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-60px' }}
      variants={{ show: { transition: { staggerChildren: stagger } } }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

/** A single staggered child inside a RevealGroup. */
export function RevealItem({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 14 },
        show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: easeOut } },
      }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}
