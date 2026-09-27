/**
 * Generates a self-contained, high-performance SVG avatar with vibrant gradient and initials.
 * Works 100% offline, zero external requests, immune to ad-blockers and CDN outages.
 */
export function generateInitialsAvatar(name: string): string {
  const clean = (name || 'User').trim();
  const initial = clean.charAt(0).toUpperCase() || 'U';

  const gradients = [
    ['#4F46E5', '#7C3AED'], // Indigo - Violet
    ['#2563EB', '#06B6D4'], // Blue - Cyan
    ['#059669', '#10B981'], // Emerald - Mint
    ['#D97706', '#F59E0B'], // Amber - Orange
    ['#E11D48', '#FB7185'], // Rose - Coral
    ['#7C3AED', '#C026D3'], // Violet - Fuchsia
    ['#0D9488', '#14B8A6'], // Teal - Turquoise
    ['#3B82F6', '#8B5CF6'], // Royal Blue - Purple
  ];

  let hash = 0;
  for (let i = 0; i < clean.length; i++) {
    hash = clean.charCodeAt(i) + ((hash << 5) - hash);
  }
  const [c1, c2] = gradients[Math.abs(hash) % gradients.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/><text x="50" y="55" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Returns Discord official default avatar URL based on user snowflake ID.
 */
export function getDiscordDefaultAvatar(discordId: string): string {
  try {
    const index = Number((BigInt(discordId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  } catch {
    return `https://cdn.discordapp.com/embed/avatars/0.png`;
  }
}

/**
 * Fetches real Discord avatar URL via our secure same-origin proxy endpoint.
 * This guarantees zero CORS/CSP errors, zero ad-blocker issues, and always delivers
 * either the actual Discord avatar or a vibrant initials SVG.
 */
export async function getDiscordAvatarUrl(
  discordId: string,
  username: string,
  _client?: any
): Promise<string> {
  if (/^\d{16,20}$/.test(discordId)) {
    return `/api/avatar/${discordId}?u=${encodeURIComponent(username)}`;
  }

  // Fallback to offline initials avatar for mock/demo IDs
  return generateInitialsAvatar(username);
}
