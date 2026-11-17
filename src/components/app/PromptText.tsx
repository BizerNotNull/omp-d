import { Fragment, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ComponentProps, type CSSProperties } from "react";
import { Textarea } from "@/components/ui/textarea";
import { magicKeywordGradients, magicKeywordRanges, type MagicKeywordRange } from "@/lib/omp/magic-keywords";

export function PromptText({ text, ranges = magicKeywordRanges(text) }: {
  text: string;
  ranges?: MagicKeywordRange[];
}) {
  let end = 0;
  return <>{ranges.map((range) => {
    const prefix = text.slice(end, range.from);
    end = range.to;
    return <Fragment key={range.from}>{prefix}<span
      className="magic-keyword"
      data-keyword={range.word}
      style={{ "--keyword-gradient": magicKeywordGradients[range.word] } as CSSProperties}
    >{text.slice(range.from, range.to)}</span></Fragment>;
  })}{text.slice(end)}</>;
}

// Keep native textarea editing, IME, selection, undo, and accessibility. Only
// its paint is mirrored; no markup is ever inserted into the submitted value.
export function PromptTextarea({ ref, value, className, onScroll, ...props }:
  Omit<ComponentProps<"textarea">, "value" | "defaultValue" | "children"> & { value: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const ranges = useMemo(() => magicKeywordRanges(value), [value]);
  const highlighted = ranges.length > 0;
  useImperativeHandle(ref, () => inputRef.current!, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const overlay = overlayRef.current;
    const text = textRef.current;
    if (!input || !overlay || !text || !highlighted) return;
    const sync = () => {
      const style = getComputedStyle(input);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "word-spacing", "tab-size", "text-indent", "text-transform", "padding-top", "padding-right", "padding-bottom", "padding-left"]) {
        text.style.setProperty(property, style.getPropertyValue(property));
      }
      overlay.style.left = `${input.offsetLeft + input.clientLeft}px`;
      overlay.style.top = `${input.offsetTop + input.clientTop}px`;
      overlay.style.width = `${input.clientWidth}px`;
      overlay.style.height = `${input.clientHeight}px`;
      overlay.scrollTop = input.scrollTop;
      overlay.scrollLeft = input.scrollLeft;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    return () => observer.disconnect();
  }, [highlighted, value, className]);

  return <div className="prompt-editor relative min-w-0" data-highlighted={highlighted || undefined}>
    {highlighted && <div ref={overlayRef} className="prompt-editor-paint" aria-hidden="true">
      <div ref={textRef} className="prompt-editor-text"><PromptText text={value} ranges={ranges} />{"\n"}</div>
    </div>}
    <Textarea {...props} ref={inputRef} value={value} className={className} onScroll={(event) => {
      if (overlayRef.current) {
        overlayRef.current.scrollTop = event.currentTarget.scrollTop;
        overlayRef.current.scrollLeft = event.currentTarget.scrollLeft;
      }
      onScroll?.(event);
    }} />
  </div>;
}
