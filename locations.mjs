import { readFileSync } from 'node:fs';

export class LocationError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = code => { throw new LocationError(400, code); };
const rounded = number => Number(number.toFixed(2));
const normalize = text => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const catalog = JSON.parse(readFileSync(new URL('./data/cities.json', import.meta.url), 'utf8'));
const cities = catalog.map(city => ({
  ...city,
  terms: `\n${[...new Set([city.name, city.ascii, ...city.aliases.split(',')].map(normalize).filter(Boolean))].join('\n')}\n`,
  nameKey: normalize(city.name), asciiKey: normalize(city.ascii),
}));
const cityById = new Map(cities.map(city => [city.id, city]));
const publicCity = city => ({ id: city.id, label: `${city.name} · ${city.country}`, name: city.name, country: city.country,
  lat: rounded(city.lat), lng: rounded(city.lng), timezone: city.timezone });

/** Reject precise user coordinates before they can reach storage. */
export function validateApproximatePoint(point) {
  if (!point || typeof point !== 'object' || Array.isArray(point) || Object.keys(point).some(key => !['lat', 'lng'].includes(key))) fail('invalid_location_point');
  const { lat, lng } = point;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) fail('invalid_coordinates');
  if (Math.abs(lat * 100 - Math.round(lat * 100)) > 1e-7 || Math.abs(lng * 100 - Math.round(lng * 100)) > 1e-7) fail('coordinates_too_precise');
  return { lat: rounded(lat), lng: rounded(lng) };
}
export function getLocation(id) {
  if (typeof id !== 'string' || !/^\d{1,12}$/.test(id)) fail('invalid_city');
  const city = cityById.get(id);
  if (!city) fail('invalid_city');
  return publicCity(city);
}
export function distanceKm(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat), dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export function pointForLocation(id, point) {
  const location = getLocation(id);
  if (point === undefined) return { location, point: { lat: location.lat, lng: location.lng } };
  const approximate = validateApproximatePoint(point);
  if (distanceKm(location, approximate) > 80) fail('point_too_far_from_city');
  return { location, point: approximate };
}
export function searchLocations(query) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 80) fail('invalid_location_query');
  const key = normalize(query);
  if (key.length < 2) fail('invalid_location_query');
  const results = [];
  for (const city of cities) {
    let rank;
    if (city.nameKey === key || city.asciiKey === key) rank = 0;
    else if (city.nameKey.startsWith(key) || city.asciiKey.startsWith(key)) rank = 1;
    else if (city.terms.includes(`\n${key}\n`)) rank = 2;
    else if (city.nameKey.includes(key) || city.asciiKey.includes(key)) rank = 3;
    else if (city.terms.includes(`\n${key}`)) rank = 4;
    else if (city.terms.includes(key)) rank = 5;
    else continue;
    results.push({ city, rank });
  }
  results.sort((a, b) => a.rank - b.rank || b.city.population - a.city.population);
  return { locations: results.slice(0, 12).map(result => publicCity(result.city)) };
}
export function nearestLocation(point) {
  const approximate = validateApproximatePoint(point);
  let closest = null, best = Infinity;
  for (const city of cities) {
    const distance = distanceKm(approximate, city);
    if (distance < best) { closest = city; best = distance; }
  }
  return { location: publicCity(closest) };
}
