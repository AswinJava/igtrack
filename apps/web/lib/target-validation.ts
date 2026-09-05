import { z } from "zod";

// Shared create-target validation. Instagram usernames cap at 30 characters,
// matching the lookup query schema — a single source of truth so the form,
// the API, and lookup never disagree about what is valid.
export const targetCreateSchema = z.object({
  username: z
    .string()
    .min(1)
    .max(30)
    .transform((v) => v.trim().replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]+$/, "invalid Instagram username")),
  localName: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});

export type TargetCreateInput = z.infer<typeof targetCreateSchema>;
