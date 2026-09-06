/**
 * Move one item within a list, returning a new array.
 *
 * Pulled out of the component because the run-net log's reorder controls are
 * the one place in the app where an operator edits the RECORD's order rather
 * than its content, and an off-by-one there silently rewrites who checked in
 * when. Easier to prove correct in isolation than through a rendered list.
 *
 * Out-of-range indices return the list unchanged rather than throwing: the
 * caller is a pair of buttons on the first and last rows, and a no-op is the
 * correct answer for "move the top row up".
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to) return items.slice();
  if (from < 0 || from >= items.length) return items.slice();
  if (to < 0 || to >= items.length) return items.slice();
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}
