import type { Artifact } from "@grove/shared";
import { useState } from "react";
import { buildArtifactDoc } from "../lib/artifactPreview.ts";

export function ArtifactView({
  artifact,
  mode = "preview",
}: {
  artifact: Artifact;
  mode?: "preview" | "code";
}) {
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    void navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-0 flex-1 overflow-hidden h-full w-full">
      {mode === "preview" ? (
        <iframe
          key={`${artifact.id}-${artifact.updatedAt}`}
          title={artifact.title}
          srcDoc={buildArtifactDoc(artifact.content, artifact.type)}
          sandbox="allow-scripts"
          className="h-full w-full border-none bg-canvas"
        />
      ) : (
        <div className="relative h-full w-full overflow-hidden bg-canvas">
          <button
            type="button"
            onClick={copyCode}
            className="absolute top-2 right-2 z-10 rounded border border-line bg-raised px-2 py-1 text-2xs font-medium text-fg-dim hover:text-fg"
          >
            {copied ? "Copied!" : "Copy Code"}
          </button>
          <div className="scroll-fade-y h-full overflow-y-auto p-4 font-mono text-xs text-fg">
            <pre className="whitespace-pre-wrap break-words">{artifact.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
