/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./*.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: '#f6f8f5',
        obsidian: {
          800: '#1a281e',
          900: '#111c14',
          950: '#0b130e',
        },
        brand: {
          50: '#f3fce9',
          100: '#e3f7cd',
          200: '#c8ef9e',
          300: '#a8e468',
          400: '#9be44d',
          500: '#7ec82a',
          600: '#5da016',
          700: '#467a11',
          800: '#386012',
          900: '#2d4d11',
          950: '#142606',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(11, 19, 14, 0.04), 0 4px 12px -2px rgba(11, 19, 14, 0.03)',
        elevated: '0 10px 30px -6px rgba(11, 19, 14, 0.12), 0 4px 10px -3px rgba(11, 19, 14, 0.06)',
        'lime-glow': '0 1px 2px rgba(20, 38, 6, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.45)',
      },
    },
  },
  plugins: [],
};
