import * as Response from "effect/ai/Response"
import * as Predicate from "effect/Predicate"

type Metadata = Response.ProviderMetadata

// Per provider, the later part's keys win.
const mergeMetadata = (left: Metadata, right: Metadata): Metadata => ({
  ...left,
  ...Object.fromEntries(
    Object.entries(right).map(([provider, metadata]) => {
      const previous = left[provider]

      return [
        provider,
        Predicate.isObject(previous) && Predicate.isObject(metadata) ? Object.assign({}, previous, metadata) : metadata
      ]
    })
  )
})

interface Open {
  readonly index: number
  text: string
  metadata: Metadata
}

// A streamed call's parts as the call would have returned them whole: each text and reasoning block joined into one
// part, with its provider metadata (a reasoning block's signature arrives on one of its deltas). Partial text is kept;
// reasoning that never ended is dropped, as a provider would refuse it back without its signature.
/** @internal */
export const collect = (parts: ReadonlyArray<Response.AnyPart>): ReadonlyArray<Response.AnyPart> => {
  const collected: Array<Response.AnyPart | undefined> = []
  const texts = new Map<string, Open>()
  const reasonings = new Map<string, Open>()

  const start = (open: Map<string, Open>, id: string, metadata: Metadata) => {
    open.set(id, { index: collected.length, text: "", metadata })
    collected.push(undefined)
  }

  const delta = (open: Map<string, Open>, id: string, text: string, metadata: Metadata) => {
    const active = open.get(id)

    if (active === undefined) return

    active.text += text
    active.metadata = mergeMetadata(active.metadata, metadata)
  }

  const end = (open: Map<string, Open>, id: string, metadata: Metadata, type: "text" | "reasoning") => {
    const active = open.get(id)

    if (active === undefined) return

    open.delete(id)
    collected[active.index] = Response.makePart(type, {
      text: active.text,
      metadata: mergeMetadata(active.metadata, metadata)
    })
  }

  for (const part of parts) {
    switch (part.type) {
      case "text-start":
        start(texts, part.id, part.metadata)
        break
      case "text-delta":
        delta(texts, part.id, part.delta, part.metadata)
        break
      case "text-end":
        end(texts, part.id, part.metadata, "text")
        break
      case "reasoning-start":
        start(reasonings, part.id, part.metadata)
        break
      case "reasoning-delta":
        delta(reasonings, part.id, part.delta, part.metadata)
        break
      case "reasoning-end":
        end(reasonings, part.id, part.metadata, "reasoning")
        break
      case "tool-params-start":
      case "tool-params-delta":
      case "tool-params-end":
        break
      default:
        collected.push(part)
    }
  }

  for (const active of texts.values()) {
    if (active.text.length > 0) {
      collected[active.index] = Response.makePart("text", { text: active.text, metadata: active.metadata })
    }
  }

  return collected.filter(Predicate.isNotUndefined)
}
