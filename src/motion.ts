/** Human-like cursor paths: eased cubic Bezier with a slight arc, duration from distance (Fitts-ish). */

export interface Point {
	x: number;
	y: number;
}

export function easeInOutCubic(t: number) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Ease that accelerates quickly and settles slowly, which reads as "aimed" movement. */
export function easeOutQuint(t: number) {
	return 1 - (1 - t) ** 5;
}

export function easeAimed(t: number) {
	// blend: smooth start (cubic in-out) with a long settle (quint out)
	return 0.45 * easeInOutCubic(t) + 0.55 * easeOutQuint(t);
}

/** Movement duration in ms for a given distance and target size. */
export function travelDuration(distance: number, targetSize = 40, speed = 1): number {
	if (distance < 2) return 0;
	const fitts = 260 + 170 * Math.log2(distance / Math.max(targetSize, 8) + 1);
	return Math.round(Math.min(1400, Math.max(320, fitts)) / speed);
}

/** Deterministic pseudo-random so re-renders of a scenario produce the same motion. */
export function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function makePath(from: Point, to: Point, rand: () => number) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy);
	// perpendicular unit vector
	const nx = dist > 0 ? -dy / dist : 0;
	const ny = dist > 0 ? dx / dist : 0;
	const arc = dist * (0.06 + rand() * 0.08) * (rand() < 0.5 ? -1 : 1);
	const c1 = { x: from.x + dx * 0.3 + nx * arc, y: from.y + dy * 0.3 + ny * arc };
	const c2 = { x: from.x + dx * 0.75 + nx * arc * 0.4, y: from.y + dy * 0.75 + ny * arc * 0.4 };
	return (t: number): Point => {
		const u = 1 - t;
		return {
			x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
			y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
		};
	};
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
