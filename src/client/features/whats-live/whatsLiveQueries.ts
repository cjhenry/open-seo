import { queryOptions } from "@tanstack/react-query";
import { getWhatsLivePosts } from "@/serverFunctions/whatsLive";

export function whatsLiveQueryOptions(month: string, timeZone: string) {
  return queryOptions({
    queryKey: ["whatsLive", month, timeZone],
    queryFn: () => getWhatsLivePosts({ data: { month, timeZone } }),
  });
}
