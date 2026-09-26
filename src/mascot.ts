export type MascotState = 'idle' | 'focused' | 'happy' | 'success' | 'deployment' | 'sleep';

export function buildMascotSvg(state: MascotState = 'idle'): string {
  const moodClass = `mascot ${state}`;
  const accent = state === 'success' ? '#22c55e' : state === 'deployment' ? '#f59e0b' : '#4f7cff';
  const expression = state === 'focused' ? 'eyes focused' : state === 'happy' ? 'eyes happy' : state === 'success' ? 'eyes happy' : state === 'deployment' ? 'eyes alert' : 'eyes';

  return `
    <svg class="${moodClass}" viewBox="0 0 180 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Salesforce coding mascot">
      <defs>
        <linearGradient id="bodyGlow" x1="0" x2="1">
          <stop offset="0%" stop-color="#7dd3fc" />
          <stop offset="100%" stop-color="${accent}" />
        </linearGradient>
      </defs>
      <g class="character">
        <circle class="hair" cx="90" cy="58" r="30" fill="#2d3748" />
        <path class="hair" d="M62 60 Q90 18 118 60 L112 82 H68 Z" fill="#1f2937" />
        <ellipse class="face" cx="90" cy="84" rx="30" ry="34" fill="#f6d7b8" />
        <g class="${expression}">
          <circle cx="78" cy="82" r="3.5" fill="#1f2937" />
          <circle cx="102" cy="82" r="3.5" fill="#1f2937" />
        </g>
        <path class="mouth" d="M80 98 Q90 106 100 98" fill="none" stroke="#9a4d4d" stroke-width="2.5" stroke-linecap="round" />
        <rect class="body" x="58" y="112" width="64" height="56" rx="16" fill="url(#bodyGlow)" />
        <rect class="collar" x="72" y="112" width="36" height="12" rx="6" fill="#e2e8f0" opacity="0.9" />
        <path class="arm left" d="M58 120 L34 142" stroke="#f6d7b8" stroke-width="10" stroke-linecap="round" />
        <path class="arm right" d="M122 120 L146 142" stroke="#f6d7b8" stroke-width="10" stroke-linecap="round" />
        <path class="leg left" d="M74 168 L66 196" stroke="#1f2937" stroke-width="8" stroke-linecap="round" />
        <path class="leg right" d="M106 168 L114 196" stroke="#1f2937" stroke-width="8" stroke-linecap="round" />
        <circle class="spark" cx="144" cy="38" r="10" fill="${accent}" opacity="0.8" />
        <path class="spark" d="M144 18 V28 M139 23 H149 M148 30 L156 38 M140 30 L132 38" stroke="#fff7ed" stroke-width="2" stroke-linecap="round" />
      </g>
    </svg>
  `;
}
