import { z } from "zod";

export const usernameQuerySchema = z.object({
  username: z
    .string()
    .min(1)
    .max(30)
    .transform((v) => v.trim().replace(/^@/, "").toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]+$/, "invalid Instagram username")),
});

export type UsernameQuery = z.infer<typeof usernameQuerySchema>;
