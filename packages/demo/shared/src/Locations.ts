/**
 * Demo offices, shaped like a typical marketing platform's `Location`
 * resources.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

const LocationSlug = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))

/**
 * Schema for office ids: `location:` plus a slug.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LocationId = Schema.TemplateLiteral(["location:", LocationSlug]).pipe(Schema.brand("acme/LocationId"))

/**
 * An office id.
 *
 * @category models
 * @since 0.1.0
 */
export type LocationId = typeof LocationId.Type

/** Matches Platform `LocationAddress`. */
class LocationAddress extends Schema.Class<LocationAddress>("LocationAddress")({
  addressLine1: Schema.NonEmptyString,
  addressLine2: Schema.optional(Schema.String),
  attentionOf: Schema.optional(Schema.String),
  city: Schema.NonEmptyString,
  zone: Schema.optional(Schema.String),
  countryCode: Schema.String.check(Schema.isPattern(/^[A-Z]{2}$/)),
  zipcode: Schema.NonEmptyString
}) {}

/** Matches Platform `LocationContact`. */
class LocationContact extends Schema.Class<LocationContact>("LocationContact")({
  email: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  phone: Schema.optional(Schema.String),
  mobile: Schema.optional(Schema.String),
  firstName: Schema.optional(Schema.String)
}) {}

class LocationCoordinates extends Schema.Class<LocationCoordinates>("LocationCoordinates")({
  latitude: Schema.Finite,
  longitude: Schema.Finite
}) {}

/**
 * An office.
 *
 * @category models
 * @since 0.1.0
 */
export class Location extends Schema.Class<Location>("acme/Location")({
  locationId: LocationId,
  /** The location's stable slug. */
  identifier: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  locale: Schema.NonEmptyString,
  postalCodes: Schema.Array(Schema.String),
  address: LocationAddress,
  contact: LocationContact,
  coordinates: LocationCoordinates,
  /** Default ship-to line shown on product orders (from `attentionOf` + address). */
  defaultShipTo: Schema.NonEmptyString
}) {}

const defaultShipToLine = (name: string, address: LocationAddress): string => {
  const attention = address.attentionOf?.trim()
  const line = [address.addressLine1, address.zipcode, address.city].filter(Boolean).join(", ")

  if (attention !== undefined && attention.length > 0) {
    return `${attention} — ${name}, ${line}`
  }

  return `${name} — ${line}`
}

const location = (input: {
  readonly locationId: LocationId
  readonly identifier: string
  readonly name: string
  readonly locale: string
  readonly postalCodes: ReadonlyArray<string>
  readonly address: LocationAddress
  readonly contact: LocationContact
  readonly coordinates: LocationCoordinates
}): Location =>
  Location.make({
    ...input,
    postalCodes: [...input.postalCodes],
    defaultShipTo: defaultShipToLine(input.name, input.address)
  })

/**
 * Every demo office.
 *
 * @category constants
 * @since 0.1.0
 */
export const all: ReadonlyArray<Location> = [
  location({
    locationId: LocationId.make("location:amsterdam"),
    identifier: "AMS-HQ",
    name: "Acme Amsterdam",
    locale: "nl-NL",
    postalCodes: ["1011", "1012", "1017"],
    address: LocationAddress.make({
      addressLine1: "Herengracht 420",
      city: "Amsterdam",
      zone: "NH",
      countryCode: "NL",
      zipcode: "1017 BZ",
      attentionOf: "Receiving — Dock 2"
    }),
    contact: LocationContact.make({
      email: "amsterdam@acme.example",
      phone: "+31 20 555 0101",
      firstName: "Sanne",
      website: "https://www.acme.example"
    }),
    coordinates: LocationCoordinates.make({ latitude: 52.3676, longitude: 4.9041 })
  }),
  location({
    locationId: LocationId.make("location:new-york"),
    identifier: "NYC-001",
    name: "Acme New York",
    locale: "en-US",
    postalCodes: ["10001", "10118"],
    address: LocationAddress.make({
      addressLine1: "350 Fifth Avenue",
      addressLine2: "Floor 34",
      city: "New York",
      zone: "NY",
      countryCode: "US",
      zipcode: "10118",
      attentionOf: "Mailroom"
    }),
    contact: LocationContact.make({
      email: "nyc@acme.example",
      phone: "+1 212 555 0142",
      firstName: "Jordan"
    }),
    coordinates: LocationCoordinates.make({ latitude: 40.7484, longitude: -73.9857 })
  }),
  location({
    locationId: LocationId.make("location:london"),
    identifier: "LON-CW",
    name: "Acme London",
    locale: "en-GB",
    postalCodes: ["E14"],
    address: LocationAddress.make({
      addressLine1: "1 Canada Square",
      city: "London",
      zone: "England",
      countryCode: "GB",
      zipcode: "E14 5AB",
      attentionOf: "Dock 3"
    }),
    contact: LocationContact.make({
      email: "london@acme.example",
      phone: "+44 20 7946 0958",
      firstName: "Priya"
    }),
    coordinates: LocationCoordinates.make({ latitude: 51.5054, longitude: -0.0235 })
  }),
  location({
    locationId: LocationId.make("location:singapore"),
    identifier: "SG-MB",
    name: "Acme Singapore",
    locale: "en-SG",
    postalCodes: ["018960", "018961"],
    address: LocationAddress.make({
      addressLine1: "8 Marina View",
      addressLine2: "Asia Square Tower 1",
      city: "Singapore",
      countryCode: "SG",
      zipcode: "018960",
      attentionOf: "Level 12 Receiving"
    }),
    contact: LocationContact.make({
      email: "singapore@acme.example",
      phone: "+65 6123 4567",
      firstName: "Wei"
    }),
    coordinates: LocationCoordinates.make({ latitude: 1.2789, longitude: 103.8545 })
  }),
  location({
    locationId: LocationId.make("location:berlin"),
    identifier: "BER-PP",
    name: "Acme Berlin",
    locale: "de-DE",
    postalCodes: ["10785"],
    address: LocationAddress.make({
      addressLine1: "Potsdamer Platz 1",
      city: "Berlin",
      zone: "BE",
      countryCode: "DE",
      zipcode: "10785",
      attentionOf: "Eingang B"
    }),
    contact: LocationContact.make({
      email: "berlin@acme.example",
      phone: "+49 30 555 0199",
      firstName: "Lena"
    }),
    coordinates: LocationCoordinates.make({ latitude: 52.5096, longitude: 13.376 })
  }),
  location({
    locationId: LocationId.make("location:paris"),
    identifier: "PAR-01",
    name: "Acme Paris",
    locale: "fr-FR",
    postalCodes: ["75002", "75009"],
    address: LocationAddress.make({
      addressLine1: "18 Rue du Sentier",
      city: "Paris",
      zone: "IDF",
      countryCode: "FR",
      zipcode: "75002",
      attentionOf: "Accueil — 3e étage"
    }),
    contact: LocationContact.make({
      email: "paris@acme.example",
      phone: "+33 1 55 50 01 45",
      firstName: "Camille"
    }),
    coordinates: LocationCoordinates.make({ latitude: 48.8686, longitude: 2.3467 })
  }),
  location({
    locationId: LocationId.make("location:madrid"),
    identifier: "MAD-01",
    name: "Acme Madrid",
    locale: "es-ES",
    postalCodes: ["28004", "28010"],
    address: LocationAddress.make({
      addressLine1: "Calle de Fuencarral 88",
      city: "Madrid",
      zone: "MD",
      countryCode: "ES",
      zipcode: "28004"
    }),
    contact: LocationContact.make({
      email: "madrid@acme.example",
      phone: "+34 91 555 0177",
      firstName: "Lucía"
    }),
    coordinates: LocationCoordinates.make({ latitude: 40.4262, longitude: -3.7012 })
  }),
  location({
    locationId: LocationId.make("location:toronto"),
    identifier: "YYZ-01",
    name: "Acme Toronto",
    locale: "en-CA",
    postalCodes: ["M5V"],
    address: LocationAddress.make({
      addressLine1: "220 King Street West",
      city: "Toronto",
      zone: "ON",
      countryCode: "CA",
      zipcode: "M5V 3M2",
      attentionOf: "Mailroom"
    }),
    contact: LocationContact.make({
      email: "toronto@acme.example",
      phone: "+1 416 555 0133",
      firstName: "Priya"
    }),
    coordinates: LocationCoordinates.make({ latitude: 43.6475, longitude: -79.3897 })
  })
]

/**
 * Returns the office with an id.
 *
 * @category getters
 * @since 0.1.0
 */
export const find = (locationId: LocationId): Location | undefined => all.find((row) => row.locationId === locationId)

/**
 * Returns the office matching a name, identifier, or city.
 *
 * @category getters
 * @since 0.1.0
 */
export const findByName = (query: string): Location | undefined => {
  const normalized = query.trim().toLowerCase()

  if (normalized.length === 0) return undefined

  for (const row of all) {
    if (row.identifier.toLowerCase() === normalized) return row

    if (row.name.toLowerCase().includes(normalized)) return row

    if (row.address.city.toLowerCase().includes(normalized)) return row

    if (normalized.includes(row.address.city.toLowerCase())) return row
  }

  return undefined
}
