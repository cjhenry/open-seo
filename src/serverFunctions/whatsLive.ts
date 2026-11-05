import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { WhatsLiveService } from "@/server/features/whats-live/WhatsLiveService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";

const whatsLiveInputSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  timeZone: z.string().min(1).max(100),
});

export const getWhatsLivePosts = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(whatsLiveInputSchema)
  .handler(({ data }) => WhatsLiveService.list(data));
