/** @type {import('tailwindcss').Config} */

/**
 * Every colour resolves to a CSS variable defined in src/index.css, so the two
 * themes swap by changing those variables rather than by sprinkling dark:
 * variants through the components. Use these names instead of Tailwind's raw
 * gray/blue scales — a literal gray-500 will not follow the theme.
 */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: token('canvas'),
        surface: {
          DEFAULT: token('surface'),
          sunken: token('surface-sunken'),
          raised: token('surface-raised'),
        },
        hair: {
          DEFAULT: token('hair'),
          strong: token('hair-strong'),
        },
        'on-solid': token('on-solid'),
        strong: token('text-strong'),
        body: token('text-body'),
        muted: token('text-muted'),
        dim: token('text-dim'),
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          fg: token('accent-fg'),
          subtle: token('accent-subtle'),
        },

        // BGP message types
        'bgp-open': token('msg-open'),
        'bgp-update': token('msg-update'),
        'bgp-notification': token('msg-notification'),
        'bgp-keepalive': token('msg-keepalive'),
        'bgp-route-refresh': token('msg-route-refresh'),

        // Severity
        critical: {
          DEFAULT: token('critical'),
          subtle: token('critical-subtle'),
        },
        warning: {
          DEFAULT: token('warning'),
          subtle: token('warning-subtle'),
        },
        ok: {
          DEFAULT: token('ok'),
          subtle: token('ok-subtle'),
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      keyframes: {
        flash: {
          '0%, 100%': { backgroundColor: 'transparent' },
          '40%': { backgroundColor: 'rgb(var(--accent) / 0.28)' },
        },
      },
      animation: {
        flash: 'flash 1s ease-in-out',
      },
    },
  },
  plugins: [],
}
