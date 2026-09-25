/**
 * The branded products offices can order: print, merchandise, and signage.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * Schema for a product's stock keeping unit.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Sku = Schema.String.pipe(Schema.brand("acme/Sku"))

/**
 * A product's stock keeping unit.
 *
 * @category models
 * @since 0.1.0
 */
export type Sku = typeof Sku.Type

/**
 * Schema for product categories.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Category = Schema.Literals(["print", "merchandise", "signage", "apparel"])

/**
 * A product in the catalog.
 *
 * @category models
 * @since 0.1.0
 */
export class Product extends Schema.Class<Product>("acme/Product")({
  sku: Sku,
  name: Schema.NonEmptyString,
  category: Category,
  description: Schema.NonEmptyString,
  /** Per unit, in USD. */
  unitPrice: Schema.Finite,
  /** Units per pack; orders are rounded up to whole packs. */
  packingUnit: Schema.Int,
  minQuantity: Schema.Int,
  /** Working days from order to shipping. */
  leadTimeDays: Schema.Int
}) {}

const product = (fields: Omit<ConstructorParameters<typeof Product>[0], "sku"> & { readonly sku: string }) =>
  Product.make({ ...fields, sku: Sku.make(fields.sku) })

/**
 * Every product.
 *
 * @category constants
 * @since 0.1.0
 */
export const all: ReadonlyArray<Product> = [
  product({
    sku: "PEN-ACM-BLU-50",
    name: "Acme branded pens",
    category: "merchandise",
    description: "Blue ballpoint pens with the Acme logo. The office favourite.",
    unitPrice: 0.9,
    packingUnit: 50,
    minQuantity: 100,
    leadTimeDays: 4
  }),
  product({
    sku: "NTB-A5-DOT",
    name: "A5 dotted notebooks",
    category: "merchandise",
    description: "Recycled-paper A5 notebooks with a debossed logo.",
    unitPrice: 4.2,
    packingUnit: 25,
    minQuantity: 50,
    leadTimeDays: 7
  }),
  product({
    sku: "TOTE-CTN-NAT",
    name: "Cotton tote bags",
    category: "merchandise",
    description: "Natural cotton totes, one-colour print. Popular at events.",
    unitPrice: 3.1,
    packingUnit: 50,
    minQuantity: 100,
    leadTimeDays: 8
  }),
  product({
    sku: "BTL-STEEL-500",
    name: "Steel water bottles",
    category: "merchandise",
    description: "500 ml insulated bottles, laser-engraved.",
    unitPrice: 9.8,
    packingUnit: 20,
    minQuantity: 40,
    leadTimeDays: 10
  }),
  product({
    sku: "STK-ACM-3IN",
    name: "Die-cut logo stickers",
    category: "print",
    description: "3-inch vinyl stickers, weatherproof.",
    unitPrice: 0.35,
    packingUnit: 100,
    minQuantity: 200,
    leadTimeDays: 3
  }),
  product({
    sku: "BRO-A4-TRI",
    name: "Tri-fold brochures",
    category: "print",
    description: "A4 tri-fold brochures on 170 gsm silk. Artwork per campaign.",
    unitPrice: 0.6,
    packingUnit: 250,
    minQuantity: 500,
    leadTimeDays: 5
  }),
  product({
    sku: "BIZ-CARD-400",
    name: "Business cards",
    category: "print",
    description: "400 gsm matte cards, per person, 250 per box.",
    unitPrice: 0.12,
    packingUnit: 250,
    minQuantity: 250,
    leadTimeDays: 3
  }),
  product({
    sku: "ROLL-UP-85",
    name: "Roll-up banners",
    category: "signage",
    description: "85 × 200 cm roll-up banner with carry bag.",
    unitPrice: 119,
    packingUnit: 1,
    minQuantity: 1,
    leadTimeDays: 6
  }),
  product({
    sku: "WIN-CLING-A2",
    name: "Window clings",
    category: "signage",
    description: "A2 static window clings for storefront campaigns.",
    unitPrice: 14.5,
    packingUnit: 10,
    minQuantity: 10,
    leadTimeDays: 5
  }),
  product({
    sku: "HOOD-ORG-NVY",
    name: "Organic hoodies",
    category: "apparel",
    description: "Navy organic-cotton hoodies with an embroidered logo. Sizes S–XXL.",
    unitPrice: 32,
    packingUnit: 10,
    minQuantity: 20,
    leadTimeDays: 12
  })
]

/**
 * Returns the product with a SKU.
 *
 * @category getters
 * @since 0.1.0
 */
export const find = (sku: string): Product | undefined => all.find((product) => product.sku === sku)

/**
 * Returns the product whose name or SKU best matches a query.
 *
 * @category getters
 * @since 0.1.0
 */
export const search = (query: string): Product | undefined => {
  const needle = query.trim().toLowerCase()

  if (needle.length === 0) return undefined

  return all.find((product) => product.sku.toLowerCase() === needle) ??
    all.find((product) => product.name.toLowerCase().includes(needle)) ??
    all.find((product) =>
      needle.split(/\s+/).some((word) => word.length > 3 && product.name.toLowerCase().includes(word))
    )
}

/**
 * Rounds a quantity up to whole packs and the minimum order.
 *
 * @category getters
 * @since 0.1.0
 */
export const orderableQuantity = (product: Product, quantity: number): number =>
  Math.max(product.minQuantity, Math.ceil(quantity / product.packingUnit) * product.packingUnit)
