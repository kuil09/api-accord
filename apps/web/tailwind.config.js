/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/**/*.ts',
    './public/**/*.html'
  ],
  theme: {
    extend: {
      colors: {
        accord: {
          bg: '#f2efe8',
          fg: '#171915',
          border: '#171915',
          'border-light': '#e0ded8',
          shadow: '#171915',
        },
        badge: {
          human: { bg: '#d1fae5', fg: '#065f46', border: '#059669' },
          ai: { bg: '#ede9fe', fg: '#5b21b6', border: '#7c3aed' },
          blocking: { bg: '#fee2e2', fg: '#991b1b', border: '#dc2626' },
          provider: { bg: '#dbeafe', fg: '#1e40af', border: '#3b82f6' },
          consumer: { bg: '#fef3c7', fg: '#92400e', border: '#f59e0b' },
        }
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        serif: ['Georgia', 'Times New Roman', 'serif'],
      },
      boxShadow: {
        'accord': '4px 4px 0 #171915',
      },
      spacing: {
        '18': '4.5rem', '88': '22rem', '128': '32rem',
      }
    }
  },
  plugins: [],
  safelist: [
    { pattern: /badge-/ },
    { pattern: /confidence-/ },
    { pattern: /toast-/ },
    { pattern: /phase-step/ },
    { pattern: /timeline-step/ },
  ]
};