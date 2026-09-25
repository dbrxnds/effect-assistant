/**
 * Each office's marketing budget for the current quarter, and what's spent.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as Locations from "./Locations.ts"
import * as Orders from "./Orders.ts"

/**
 * The quarter the demo is in.
 *
 * @category constants
 * @since 0.1.0
 */
export const currentQuarter = { name: "2026-Q3", start: "2026-07-01", end: "2026-09-30" } as const

/** Quarterly budgets, in USD. */
const quarterly = new Map<string, number>([
  ["location:amsterdam", 18000],
  ["location:new-york", 16000],
  ["location:london", 15000],
  ["location:paris", 9000],
  ["location:berlin", 7000],
  ["location:singapore", 6000],
  ["location:madrid", 6000],
  ["location:toronto", 5000]
])

/**
 * An office's budget for a quarter.
 *
 * @category models
 * @since 0.1.0
 */
export class OfficeBudget extends Schema.Class<OfficeBudget>("acme/OfficeBudget")({
  office: Schema.NonEmptyString,
  quarter: Schema.String,
  budget: Schema.Finite,
  /** Orders placed this quarter (cancelled ones excluded). */
  spent: Schema.Finite,
  remaining: Schema.Finite
}) {}

const inQuarter = (date: string) => date >= currentQuarter.start && date <= currentQuarter.end

/**
 * Returns an office's budget this quarter, counting the orders in the demo
 * data plus `extra` (orders placed in this session).
 *
 * @category getters
 * @since 0.1.0
 */
export const forOffice = (location: Locations.Location, extra = 0): OfficeBudget => {
  const budget = quarterly.get(location.locationId) ?? 0

  const spent = Orders.all
    .filter((order) => order.locationId === location.locationId && inQuarter(order.placedOn))
    .filter((order) => order.status !== "cancelled")
    .reduce((sum, order) => sum + Orders.cost(order), extra)

  const rounded = Math.round(spent * 100) / 100

  return OfficeBudget.make({
    office: location.name,
    quarter: currentQuarter.name,
    budget,
    spent: rounded,
    remaining: Math.round((budget - rounded) * 100) / 100
  })
}
