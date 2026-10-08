import * as Predicate from "effect/Predicate"
import type * as Instructions from "../Instructions.ts"

/** @internal */
export const mapText = (
  instructions: string | Instructions.Resolved,
  f: (text: string) => string
): Instructions.Resolved =>
  Predicate.isString(instructions) ? { text: f(instructions) } : { ...instructions, text: f(instructions.text) }
