/**
 * Decode a 4-, 6-, or 8-character Maidenhead grid locator to the
 * center of the square. Returns null on invalid input.
 * Examples:
 *   EM38  -> { lat: 38.5, lon: -92.0 }  (center of 2-char square)
 *   EM38ww -> more precise
 */
export function decodeGrid(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/.test(g)) return null;

  // Field (A-R) = 20 deg lon / 10 deg lat
  const lonField = g.charCodeAt(0) - 'A'.charCodeAt(0);
  const latField = g.charCodeAt(1) - 'A'.charCodeAt(0);
  // Square (0-9) = 2 deg lon / 1 deg lat
  const lonSquare = Number(g[2]);
  const latSquare = Number(g[3]);

  let lon = -180 + lonField * 20 + lonSquare * 2;
  let lat = -90 + latField * 10 + latSquare * 1;

  if (g.length >= 6) {
    // Subsquare (A-X) = 5' lon / 2.5' lat
    const lonSub = g.charCodeAt(4) - 'A'.charCodeAt(0);
    const latSub = g.charCodeAt(5) - 'A'.charCodeAt(0);
    lon += (lonSub * 5) / 60;
    lat += (latSub * 2.5) / 60;
    // Center of subsquare
    lon += 2.5 / 60;
    lat += 1.25 / 60;
  } else {
    // Center of square
    lon += 1;
    lat += 0.5;
  }

  if (g.length >= 8) {
    const lonExt = Number(g[6]);
    const latExt = Number(g[7]);
    // Extended square (0-9) = 0.5' lon / 0.25' lat
    lon += (lonExt * 0.5) / 60;
    lat += (latExt * 0.25) / 60;
  }

  return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
}
