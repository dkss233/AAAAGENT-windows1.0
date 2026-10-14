import { useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { NATIVE_READ } from "./NativeReadBoundary";

function useSharedControlSlot(id: string) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (NATIVE_READ) setTarget(document.getElementById(id));
  }, [id]);
  return target;
}

// Move the original React controls, preserving their context and handlers.
// Chat/composer state remains in the original ChatView route tree.
export function AAAChatHeader(props: ComponentProps<typeof WorkspacePageHeader>) {
  const target = useSharedControlSlot("aaa-native-header-actions");
  if (!NATIVE_READ) return <WorkspacePageHeader {...props} />;
  return target ? createPortal(<div className="aaa-original-header-content">{props.children}</div>, target) : null;
}

export function AAAWorkspacePanelControls({ children }: { children: ReactNode }) {
  const target = useSharedControlSlot("aaa-native-panel-controls");
  if (!NATIVE_READ) return children;
  return target ? createPortal(children, target) : null;
}
