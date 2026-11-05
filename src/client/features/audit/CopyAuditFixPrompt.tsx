import { Download } from "lucide-react";
import { CopyButton } from "@/client/components/CopyButton";
import { Button } from "@/client/components/ui/button";
import { downloadFile } from "@/client/lib/download";

/** Copies a fix prompt, and can save the same markdown. */
export function CopyAuditFixPrompt({
  prompt,
  filename,
}: {
  prompt: string;
  filename: string;
}) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-1"
      onClick={(event) => event.stopPropagation()}
    >
      <CopyButton
        value={prompt}
        label="Copy AI fix prompt"
        successMessage="AI fix prompt copied"
      />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => downloadFile(prompt, filename, "text/markdown")}
      >
        <Download />
        Download .md
      </Button>
    </div>
  );
}
