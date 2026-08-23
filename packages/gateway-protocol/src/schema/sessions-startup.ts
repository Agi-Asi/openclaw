import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

export const SessionsStartupResolveParamsSchema = closedObject({
  key: NonEmptyString,
  operationId: NonEmptyString,
  action: Type.Union([Type.Literal("cancel"), Type.Literal("work-local")]),
});

export const SessionsStartupResolveResultSchema = closedObject({ ok: Type.Literal(true) });

export type SessionsStartupResolveParams = Static<typeof SessionsStartupResolveParamsSchema>;
export type SessionsStartupResolveResult = Static<typeof SessionsStartupResolveResultSchema>;
