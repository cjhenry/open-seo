import { createFileRoute } from "@tanstack/react-router";
import { WhatsLivePage } from "@/client/features/whats-live/WhatsLivePage";

export const Route = createFileRoute("/_app/whats-live")({
  component: WhatsLivePage,
});
