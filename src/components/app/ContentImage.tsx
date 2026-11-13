import { memo, useMemo, useState } from "react";
import type { ImageContent } from "@/lib/omp/types";
import { toBase64DataUrl } from "@/lib/omp/format";
import { SvgFigure } from "./SvgFigure";

export const ContentImage = memo(function ContentImage({ image, alt }: { image: ImageContent; alt: string }) {
  const src = toBase64DataUrl(image);
  const [failed, setFailed] = useState<string>();
  const svg = useMemo(() => {
    if (image.mimeType.toLowerCase().split(";", 1)[0] !== "image/svg+xml") return undefined;
    try {
      const data = image.data.startsWith("data:") ? image.data.slice(image.data.indexOf(",") + 1) : image.data;
      return new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
    } catch {
      return undefined;
    }
  }, [image.data, image.mimeType]);
  if (svg) return <SvgFigure source={svg} />;
  if (failed === src) return <p className="text-xs text-destructive" role="status">Unable to display {alt} ({image.mimeType}).</p>;
  return <img src={src} alt={alt} className="my-2 block h-auto max-w-full rounded-lg border object-contain" onError={() => setFailed(src)} />;
});
