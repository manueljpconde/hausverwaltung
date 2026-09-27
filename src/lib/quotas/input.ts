// #52 R2: strikte Eingabe-Schemas — nichts wird still in eine andere Finanzoperation umgedeutet.
import { z } from "zod";
import { QuotaError } from "./errors";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const date = z.date().refine((d) => !Number.isNaN(d.getTime()), "invalid date");
const cents = z.number().int().positive();
const id = z.string().min(1);
const method = z.enum(["PERMILLAGE", "FIXED", "CUSTOM"]);
const custom = z.record(z.string().min(1), z.number().int().nonnegative());

// Nur Felder, die beide Arten haben; description/resolutionId sind der extraordinária vorbehalten.
const common = { propertyId: id, month, method: method.default("PERMILLAGE"), custom: custom.optional() };
const withCustomRule = <T extends { method: string; custom?: unknown }>(v: T, ctx: z.RefinementCtx) => {
  if ((v.method === "CUSTOM") !== (v.custom !== undefined)) ctx.addIssue({ code: "custom", message: "custom map iff method CUSTOM" });
};

export const issueInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ORDINARY"), ...common, dueDay: z.number().int().min(1).max(28).optional() }),
  z.strictObject({ kind: z.literal("EXTRAORDINARY"), ...common, totalCents: cents, asOf: date, dueDate: date,
    description: z.string().trim().min(1).max(500), resolutionId: id.optional() }),
]).superRefine(withCustomRule);
export type ParsedIssueInput = z.infer<typeof issueInputSchema>;

// Stornierungs-/Änderungsgrund: getrimmt, nie leer (DB-CHECK auf cancelReason).
export const reasonSchema = z.string().trim().min(3).max(500);

// refundAndCancel: Konto optional, aber nie leer; leere Referenz wird null.
export const refundInputSchema = z.strictObject({
  accountId: id.nullish(),
  date,
  reference: z.string().trim().max(140).nullish().transform((v) => v || null),
  reason: reasonSchema,
});

// quotaStatement: genau eines von unitId/personId; from/to als Monat (YYYY-MM), from ≤ to.
export const statementQuerySchema = z.strictObject({
  propertyId: id, unitId: id.optional(), personId: id.optional(), from: month.optional(), to: month.optional(),
}).superRefine((v, ctx) => {
  if (!!v.unitId === !!v.personId) ctx.addIssue({ code: "custom", message: "unitId xor personId" });
  if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: "custom", message: "from > to" });
});
export type StatementQuery = z.input<typeof statementQuerySchema>;

export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new QuotaError("INVALID_INPUT", undefined, r.error.issues);
  return r.data;
}
