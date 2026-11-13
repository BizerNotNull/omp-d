import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useAppStore } from "@/lib/omp/store";
import { Transcript, TranscriptEmpty } from "./Transcript";

export function ChatView() {
  const messages = useAppStore((state) => state.messages);
  const pending = useAppStore((state) => state.pending);
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

  useLayoutEffect(() => {
    stick.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [sessionId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;

    // Tool updates, loaded images, and viewport changes can resize the chat
    // without changing the message arrays.
    const observer = new ResizeObserver(() => {
      if (stick.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (stick.current) scrollToBottom();
  }, [messages, pending]);

  function onScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
    // A growing transcript or an in-progress jump must not disable following.
    if (element.scrollTop < lastScrollTop.current) stick.current = nearBottom;
    else if (nearBottom) stick.current = true;
    lastScrollTop.current = element.scrollTop;
    setAtBottom(stick.current);
  }

  const empty = messages.length === 0 && pending.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-thin h-full overflow-y-auto px-4">
        <div ref={contentRef} className="mx-auto w-full max-w-3xl pt-4 pb-2">
          {empty ? <TranscriptEmpty /> : <Transcript messages={messages} pending={pending} />}
          <div className="h-2" />
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
