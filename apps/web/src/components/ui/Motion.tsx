'use client'

import { MotionConfig, motion, type HTMLMotionProps } from 'framer-motion'

import type { ReactNode } from 'react'

// Shared motion primitives for the Neon UI. Reveals are subtle (opacity + small
// translate) and stagger children for an orchestrated page-load (design.md
// motion guidance).
//
// Accessibility: framer-motion does NOT honor prefers-reduced-motion by default
// (its default is reducedMotion: 'never'). Each primitive therefore wraps its
// content in <MotionConfig reducedMotion="user"> so transform animations are
// disabled for users who request reduced motion — regardless of which tree
// (landing or authed app) the primitive renders in.

const easeOut = [0.16, 1, 0.3, 1] as const

/** Fade + rise a single block into view on mount. */
export function Reveal({
  children,
  delay = 0,
  className,
  ...props
}: { children: ReactNode; delay?: number; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: easeOut, delay }}
        className={className}
        {...props}
      >
        {children}
      </motion.div>
    </MotionConfig>
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
    <MotionConfig reducedMotion="user">
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: '-60px' }}
        variants={{ show: { transition: { staggerChildren: stagger } } }}
        className={className}
      >
        {children}
      </motion.div>
    </MotionConfig>
  )
}

/** A single staggered child inside a RevealGroup. */
export function RevealItem({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <MotionConfig reducedMotion="user">
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
    </MotionConfig>
  )
}
