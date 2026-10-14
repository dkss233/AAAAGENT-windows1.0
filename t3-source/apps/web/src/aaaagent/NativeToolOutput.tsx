import { useEffect, useRef, useState } from "react";
import { nativeToolOutputKey, type NativeToolOutputTarget } from "./native-tool-output";
import { NativeToolOutputReadState, type NativeToolOutputView } from "./native-tool-output-view.logic";

export function NativeToolOutput({ target, summary, className }: {
  target: NativeToolOutputTarget | null; summary: string; className: string;
}) {
  const [state, setState] = useState<NativeToolOutputView | null>(null);
  const reader = useRef<NativeToolOutputReadState | null>(null);
  if (!reader.current) reader.current = new NativeToolOutputReadState(setState);
  const targetRef = useRef(target);targetRef.current = target;
  const key = target ? nativeToolOutputKey(target) : null;
  useEffect(() => {
    const current = targetRef.current;
    if (current && nativeToolOutputKey(current) === key) reader.current!.open(current);
    return () => reader.current!.cancel();
  }, [key]);
  // A new render cannot display the previous identity while its effect is waiting.
  const current = key !== null && state?.key === key ? state : null;
  const phase = key === null ? "unavailable" : current?.phase ?? "loading";
  const value = current?.phase === "ready" ? current.value : null;
  return <section aria-label="原工具输出" data-native-tool-output-phase={phase}>
    <p role="status" className="mb-1 text-muted-foreground text-xs">
      {phase === "ready" ? "原工具完整输出" : phase === "loading" ? "正在读取原工具全文，摘要保留。" : "原工具全文暂不可读取，已保留摘要。"}
    </p>
    {value ? <pre className={className} aria-label="原工具命令">{value.command}</pre> : null}
    <pre className={className} aria-label={phase === "ready" ? "原工具完整输出" : "原工具摘要"}>
      {value ? value.output : summary}
    </pre>
  </section>;
}
