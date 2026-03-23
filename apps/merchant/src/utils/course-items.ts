/**
 * course-items.ts
 *
 * Shared helpers for sorting and filtering order items by course/kitchen routing.
 * Extracted from printer.ts to allow star-raster.ts to import without creating
 * a circular dependency (printer ↔ star-raster).
 *
 * Used by:
 *  - v2/src/services/printer.ts    (re-exports these as public API)
 *  - v2/src/services/star-raster.ts (imports directly)
 */

/** Minimal interface for the course-routing fields on any print item. */
export interface CourseRoutable {
  courseOrder?: number | null
  isLastCourse?: boolean
  printDestination?: 'both' | 'kitchen' | 'counter'
}

/** Sort items into print order: numbered courses → mains → last */
export function sortItemsByCourse<T extends CourseRoutable>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const grp = (i: T) =>
      i.isLastCourse ? 2 : (i.courseOrder != null ? 0 : 1)
    const ga = grp(a), gb = grp(b)
    if (ga !== gb) return ga - gb
    if (ga === 0) return (a.courseOrder ?? 0) - (b.courseOrder ?? 0)
    return 0
  })
}

/** Items that should appear on the kitchen ticket (excludes counter-only) */
export function kitchenItems<T extends CourseRoutable>(items: T[]): T[] {
  return items.filter(i => (i.printDestination ?? 'both') !== 'counter')
}

/**
 * "First batch" items for kitchen printing: all kitchen items whose category has an explicit
 * `courseOrder` (e.g. Appetizers = 1, Salads = 2, Soups = 3), excluding the last-course flag.
 *
 * The name "course1" means "first print batch", NOT "menu course number 1".
 * These are fired immediately when an order is placed.  Compare {@link course2Items},
 * which returns the deferred (main-course) batch fired after a delay.
 *
 * Concretely: items where `courseOrder != null && !isLastCourse`.
 */
export function course1Items<T extends CourseRoutable>(items: T[]): T[] {
  return kitchenItems(items).filter(i => i.courseOrder != null && !i.isLastCourse)
}

/**
 * "Second batch" items for kitchen printing: all kitchen items whose category has no
 * explicit `courseOrder` (i.e. mains — the bulk of the menu), excluding last-course items.
 *
 * The name "course2" means "second print batch", NOT "menu course number 2".
 * These are fired after a configurable delay (`courseDelayMinutes`) so kitchen staff
 * can pace the meal.  Compare {@link course1Items}, which returns the immediate batch.
 *
 * Concretely: items where `courseOrder == null && !isLastCourse`.
 */
export function course2Items<T extends CourseRoutable>(items: T[]): T[] {
  return kitchenItems(items).filter(i => i.courseOrder == null && !i.isLastCourse)
}
