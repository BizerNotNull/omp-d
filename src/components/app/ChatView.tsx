import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAppStore } from "@/lib/omp/store";
import { Transcript, TranscriptEmpty } from "./Transcript";

export function ChatView() {
  const status = useAppStore((state) => state.status);
  const sessionId = useAppStore((state) => state.session?.sessionId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTop = useRef(0);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  function scrollToBottom(behavior: ScrollBehavior = "auto") {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    lastScrollTop.current = element.scrollTop;
  }

  useEffect(() => {
    if (status === "ready" && stick.current) scrollToBottom();
  }, [status]);

  useEffect(() => {
    stick.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [sessionId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    // React commits, tool output, images, and viewport resizing all share
    // the same follow path. Only a size change can move the scroll end.
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const previous = lastScrollTop.current;
    const top = element.scrollTop;
    lastScrollTop.current = top;
    // Downward motion while following cannot turn following off.
    if (stick.current && top >= previous) return;
    const following = element.scrollHeight - top - element.clientHeight < 96;
    if (stick.current === following) return;
    stick.current = following;
    setAtBottom(following);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-thin h-full overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div ref={contentRef} className="conversation-lane pt-3 pb-2">
          <ChatTranscript />
        </div>
      </div>

      {!atBottom && (
        <button
          type="button"
          onClick={() => {
            stick.current = true;
            setAtBottom(true);
            scrollToBottom("smooth");
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover px-2.5 py-1 text-[10px] text-muted-foreground shadow-md hover:text-foreground"
        >
          <ChevronDown className="size-3" /> Jump to latest
        </button>
      )}
    </div>
  );
}

function ChatTranscript() {
  const messages = useAppStore((state) => state.messages);
  const pending = useAppStore((state) => state.pending);
  const empty = useAppStore((state) => !state.promptEcho && !state.busy) && messages.length === 0 && pending.length === 0;
  return empty ? <TranscriptEmpty /> : <Transcript messages={messages} pending={pending} />;
}
