/** Inline SVG icons for each AI coding platform */
export function PlatformIcon({ source, size = 14 }: { source: string; size?: number }) {
  const s = size;
  if (source === "claude-code") {
    // Anthropic "A\" mark
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="currentColor">
        <path d="M9.5 2L14 14h-2.8L8.1 6.1 5.8 14H3L7.5 2h2z" />
      </svg>
    );
  }
  if (source === "codex") {
    // OpenAI hexagon
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M8 1.5L14 4.75v6.5L8 14.5 2 11.25v-6.5L8 1.5z" />
        <circle cx="8" cy="8" r="2" fill="currentColor" />
      </svg>
    );
  }
  if (source === "openclaw") {
    // Terminal/claw icon
    return (
      <svg width={s} height={s} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="10" rx="1" />
        <path d="M5 6l2 2-2 2M8 10h3" />
      </svg>
    );
  }
  return null;
}
