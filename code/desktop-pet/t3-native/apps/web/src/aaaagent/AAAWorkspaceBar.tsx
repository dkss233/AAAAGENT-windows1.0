import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironment } from "../state/environments";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { SidebarTrigger } from "../components/ui/sidebar";
import { NATIVE_READ } from "./NativeReadBoundary";
import { AAAppearance } from "./AAAppearance";
import { managementPages, sendWorkspaceIntent, useWorkspaceBridge } from "./workspace-ui-bridge";

export function AAAWorkspaceBar() {
  const navigate = useNavigate();
  const header = useRef<HTMLElement>(null), menu = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const phase = useWorkspaceBridge();
  const environment = usePrimaryEnvironment();
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    let frame = 0;
    const update = () => {
      const parent = element.parentElement, height = `${element.getBoundingClientRect().height}px`;
      if (parent && parent.style.getPropertyValue("--aaa-toolbar-height") !== height) parent.style.setProperty("--aaa-toolbar-height", height);
    };
    update();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame);frame = requestAnimationFrame(update); });
    observer.observe(element);
    return () => { observer.disconnect();cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault();setOpen(false);trigger.current?.focus(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []);
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        event.preventDefault();items[next]?.focus();
      } else if (event.key === "Tab") setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);document.addEventListener("keydown", keyboard);
    return () => { document.removeEventListener("pointerdown", outside, true);document.removeEventListener("keydown", keyboard); };
  }, [open]);
  const params = useParams({ strict: false });
  const search = useLocation({ select: location => location.search as { aaaProject?: string; aaaEnvironment?: string } });
  const shell = useThreadShell(params.environmentId && params.threadId
    ? scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId) : null);
  const projects = useProjects();
  const project = projects.find(p => p.id === (shell?.projectId ?? search.aaaProject) && p.environmentId === (shell?.environmentId ?? search.aaaEnvironment));
  const connected = environment?.connection.phase === "connected";
  const embedded = window.parent !== window && location.pathname.startsWith("/native/");
  return <header ref={header} className="aaa-workspace-bar">
    <div className="aaa-navigation-controls">
      <button ref={trigger} type="button" className="aaa-menu-trigger" aria-label="AAAAGENT 菜单" aria-haspopup="menu" aria-expanded={open} aria-controls="aaa-management-menu" onClick={() => setOpen(!open)}>AAAAGENT <span aria-hidden="true">⌄</span></button>
      {open && <div ref={menu} id="aaa-management-menu" className="aaa-management-menu" role="menu" aria-label="管理页面">
        <button type="button" role="menuitem" disabled={!connected} onClick={() => { setOpen(false);void navigate({ to: "/welcome" }); }}>选择历史项目</button>
        <span className="aaa-menu-heading">本机管理</span>
        {embedded ? managementPages.map(([page, label]) => <button key={page} type="button" role="menuitem" onClick={() => { setOpen(false);sendWorkspaceIntent("management.navigate", { page }); }}>{label}</button>) : <span className="aaa-menu-heading">请从 AAAAGENT 控制台进入管理页面</span>}
        {embedded && <button type="button" role="menuitem" className="aaa-menu-return" onClick={() => { setOpen(false);sendWorkspaceIntent("management.navigate", { page: "overview" }); }}>返回管理</button>}
      </div>}
      <SidebarTrigger aria-label="项目导航" />
    </div>
    <div className="aaa-workspace-path" title={shell ? `${project?.title ?? "项目"} / ${shell.title}` : project?.title ?? "项目总览"}>
      <Link to="/" search={shell ? { aaaEnvironment: shell.environmentId, aaaProject: shell.projectId } : {}} className="aaa-home-link">{project?.title ?? "项目总览"}</Link>
      {shell && <span className="aaa-thread-path"> / {shell.title}</span>}
    </div>
    <div className="aaa-workspace-tools">
      <div id="aaa-native-header-actions" className="aaa-shared-header-actions" />
      <div id="aaa-native-panel-controls" className="aaa-shared-panel-controls" />
      {NATIVE_READ && <span className="aaa-connection" role="status" title="原生服务连接">{phase && phase !== "ready" ? "会话不可用" : connected ? "已连接" : "连接中"}</span>}
      {import.meta.env.VITE_AAA_PREVIEW === "1" && <span className="aaa-example-badge">界面示例 · 只读预览</span>}
      <AAAppearance />
    </div>
  </header>;
}
