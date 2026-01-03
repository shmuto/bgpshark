/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'bgp-open': '#22c55e',
        'bgp-update': '#3b82f6',
        'bgp-notification': '#ef4444',
        'bgp-keepalive': '#a855f7',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Consolas', 'Monaco', 'monospace'],
      },
      keyframes: {
        flash: {
          '0%, 100%': { backgroundColor: 'transparent' },
          '25%': { backgroundColor: 'rgb(254 240 138)' },
          '50%': { backgroundColor: 'rgb(253 224 71)' },
          '75%': { backgroundColor: 'rgb(254 240 138)' },
        },
      },
      animation: {
        flash: 'flash 1s ease-in-out',
      },
    },
  },
  plugins: [],
}
