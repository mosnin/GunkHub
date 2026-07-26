import type { Config } from 'tailwindcss'

// Palette, type, and shapes are governed by /design.md ("Neon — Server Room After
// Dark"). The existing `neutral`/`primary`/etc. scales are REMAPPED onto the Neon
// tokens so every component inherits the identity, and the radius scale is
// overridden to enforce the design's shape dichotomy: 4px for all containers,
// 9999px (pill) for buttons via `rounded-full`.
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Direct Neon token names (design.md) — preferred for new work.
        neon: {
          glow: '#34d59a',
          muted: '#285d49',
          scanline: '#39a57d',
        },
        blackout: '#000000',
        depth: '#0a0a0b',
        graphite: {
          deep: '#151617',
          DEFAULT: '#242628',
          light: '#303236',
        },
        ash: '#797d86',
        pewter: '#94979e',
        cloud: '#c9cbcf',
        whiteout: '#ffffff',
        // Ember — the READABLE red. `system-warning`/`destructive-500` (#ff3621) is
        // the SIGNAL red: icons, dots, borders only. Ember is the only red clearing
        // AA on Graphite (5.40) and on the destructive fills (5.30 / 5.98), so all
        // destructive/error *copy* uses `text-ember`. See design.md token table.
        ember: '#ff6a5a',
        'system-warning': '#ff3621',
        // ⚠ ALIAS TRAP — these remapped scales are the SAME COLORS as the named
        // tokens above, but the class names hide which token you picked. Prefer the
        // named spelling in all new work; the numeric stops are kept only so
        // pre-existing classes keep compiling.
        //   text-neutral-500 === text-ash    → FAILS AA on cards (4.39 / 3.68)
        //   text-neutral-400 === text-pewter → the correct secondary on surfaces
        //   text-neutral-200 === text-cloud
        //   text-neutral-300  = #a6a9af      → interpolated, NOT in design.md
        //   border-neutral-600 = #4a4d53     → 2.48 on Blackout, never text
        // Full mapping + ratios: design.md § "Tailwind alias trap".
        neutral: {
          50: '#ffffff',
          100: '#f4f5f6',
          200: '#c9cbcf', // cloud
          300: '#a6a9af',
          400: '#94979e', // pewter
          500: '#797d86', // ash
          600: '#4a4d53',
          700: '#303236', // graphite-light (borders)
          800: '#242628', // graphite
          850: '#151617', // graphite-deep (cards)
          900: '#0a0a0b', // depth
          950: '#000000', // blackout
        },
        // Accent scale → Neon Glow. primary-* usages become electric green.
        primary: {
          DEFAULT: '#34d59a',
          50: '#e7fbf3',
          100: '#c2f4e0',
          200: '#8fe9c6',
          300: '#5fdeae',
          400: '#34d59a', // neon glow
          500: '#34d59a',
          600: '#22b884',
          700: '#1a8f68',
          800: '#285d49', // neon muted
          900: '#123b2f',
        },
        success: {
          DEFAULT: '#34d59a',
          50: '#e7fbf3',
          100: '#c2f4e0',
          400: '#5fdeae',
          500: '#34d59a',
          600: '#22b884',
          700: '#1a8f68',
          900: '#123b2f',
        },
        destructive: {
          DEFAULT: '#ff3621',
          50: '#3a0e0a',
          100: '#4d120c',
          // 400 === `ember`. Use `text-ember` for destructive copy — it is the only
          // stop in this ramp that clears AA on Graphite and on the -900 hover fill.
          400: '#ff6a5a',
          500: '#ff3621',
          600: '#e02a17',
          700: '#b71f10',
          900: '#4d120c',
        },
        warning: {
          DEFAULT: '#ff3621',
          50: '#3a0e0a',
          100: '#4d120c',
          400: '#ff6a5a',
          500: '#ff3621',
          600: '#e02a17',
          700: '#b71f10',
          900: '#4d120c',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'Fira Code', 'Source Code Pro', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Shape dichotomy: every container radius collapses to 4px; only `rounded-full`
      // (buttons) stays a pill. See design.md "Do's": 9999px buttons / 4px else.
      borderRadius: {
        none: '0px',
        sm: '4px',
        DEFAULT: '4px',
        md: '4px',
        lg: '4px',
        xl: '4px',
        '2xl': '4px',
        '3xl': '4px',
        full: '9999px',
      },
      boxShadow: {
        // design.md: depth is layered near-black surfaces, not shadows. The one
        // sanctioned shadow token for genuine overlays (modals) only.
        lg: 'rgba(0, 0, 0, 0.4) 0px 8px 20px 0px',
      },
      keyframes: {
        'neon-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        'data-stream': {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100%)' },
        },
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'neon-pulse': 'neon-pulse 2s ease-in-out infinite',
        'data-stream': 'data-stream 6s linear infinite',
        'fade-up': 'fade-up 0.4s ease-out both',
      },
    },
  },
  plugins: [],
}

export default config
