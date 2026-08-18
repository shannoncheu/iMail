import "server-only";

import { z } from "zod";

export const providerSourceSchema = z.enum(["gmail", "outlook", "zoho"]);
export const mailScopeQuerySchema = z
  .object({
    scope: z.union([z.literal("all"), providerSourceSchema]),
    accountId: z.string().uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.scope === "all" && value.accountId) {
      context.addIssue({
        code: "custom",
        message: "An account filter requires a provider scope",
        path: ["accountId"],
      });
    }
  });
export const folderSchema = z.enum([
  "inbox",
  "starred",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
]);
export const mailSearchSchema = z.string().trim().max(256);

const attachmentSchema = z.object({
  id: z.string().min(1).max(8_192),
  name: z.string().min(1).max(255),
  size: z.string().min(1).max(64),
  kind: z.enum(["document", "image", "archive"]),
  mimeType: z.string().min(1).max(255).optional(),
  sizeBytes: z.number().int().nonnegative().max(150 * 1_024 * 1_024).optional(),
  inline: z.boolean().optional(),
  contentId: z.string().max(998).optional(),
  contentBase64: z.string().max(7 * 1_024 * 1_024).optional(),
});

export const draftSchema = z.object({
  id: z.string().min(1).max(8_192).optional(),
  accountId: z.string().uuid(),
  to: z.array(z.string().email().max(320)).max(200),
  cc: z.array(z.string().email().max(320)).max(200),
  bcc: z.array(z.string().email().max(320)).max(200),
  subject: z.string().max(998),
  body: z.string().max(1_000_000),
  attachments: z.array(attachmentSchema).max(10),
  composeIntent: z
    .object({
      mode: z.enum(["reply", "forward"]),
      sourceId: z.string().min(1).max(8_192),
    })
    .optional(),
});

export const mutateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.enum(["archive", "trash", "restoreTrash"]),
    ids: z.array(z.string().min(1).max(8_192)).min(1).max(200),
  }),
  z.object({
    action: z.literal("restore"),
    locations: z
      .array(
        z.object({ id: z.string().min(1).max(8_192), folder: folderSchema }),
      )
      .min(1)
      .max(200),
  }),
  z.object({
    action: z.literal("read"),
    ids: z.array(z.string().min(1).max(8_192)).min(1).max(200),
    read: z.boolean(),
  }),
  z.object({
    action: z.literal("star"),
    id: z.string().min(1).max(8_192),
    starred: z.boolean(),
  }),
]);
