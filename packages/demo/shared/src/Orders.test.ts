import assert from "node:assert/strict"
import test from "node:test"
import * as Budgets from "./Budgets.ts"
import * as Locations from "./Locations.ts"
import * as Orders from "./Orders.ts"
import * as Performance from "./Performance.ts"
import * as Products from "./Products.ts"

const amsterdam = Locations.findByName("amsterdam")!

test("the demo has a year of orders across eight offices", () => {
  assert.equal(Locations.all.length, 8)
  assert.ok(Orders.list({ limit: 100 }).length >= 30)
  assert.equal(Orders.list({ limit: 1 })[0]?.placedOn, "2026-09-18")
})

test("Amsterdam's product history includes pens, and one order is still printing", () => {
  const rows = Orders.list({ locationId: amsterdam.locationId, kind: "product" })

  assert.ok(rows.some((row) => row.kind === "product" && row.productName.toLowerCase().includes("pen")))
  assert.ok(rows.some((row) => row.status === "in_production"))
})

test("rankSimilar puts the best match first", () => {
  assert.equal(
    Orders.rankSimilar(Orders.pastCampaigns, "summer campaign for parents", 5)[0]?.orderId,
    Orders.summerCampaignId
  )
})

test("products round up to whole packs and the minimum", () => {
  const pens = Products.search("pens")!

  assert.equal(pens.sku, "PEN-ACM-BLU-50")
  assert.equal(Products.orderableQuantity(pens, 120), 150)
  assert.equal(Products.orderableQuantity(pens, 10), 100)
})

test("budgets count this quarter's orders", () => {
  const budget = Budgets.forOffice(amsterdam)

  assert.equal(budget.quarter, "2026-Q3")
  assert.ok(budget.spent > 0 && budget.remaining < budget.budget)
  assert.equal(Budgets.forOffice(amsterdam, 1000).spent, Math.round((budget.spent + 1000) * 100) / 100)
})

test("campaign results are stable, and only for campaigns", () => {
  const summer = Performance.forCampaign(Orders.summerCampaignId)!

  assert.deepEqual(Performance.forCampaign(Orders.summerCampaignId), summer)
  assert.ok(summer.impressions > summer.clicks && summer.clicks > summer.conversions && summer.conversions > 0)
  assert.equal(Performance.forCampaign("order:ams-pens-aug-2026"), undefined)
})
