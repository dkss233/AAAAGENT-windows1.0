import { createFileRoute } from "@tanstack/react-router";
import { FlowOverview } from "../aaaagent/FlowOverview";

function ChatIndexRouteView() {
  const { aaaProject, aaaEnvironment } = Route.useSearch();
  return <FlowOverview {...(aaaEnvironment ? { preferredEnvironment: aaaEnvironment } : {})}
    {...(aaaProject ? { preferredProject: aaaProject } : {})} />;
}

export const Route = createFileRoute("/_chat/")({
  validateSearch: (search: Record<string, unknown>): { aaaProject?: string; aaaEnvironment?: string } =>
    typeof search.aaaProject === "string" && search.aaaProject.length > 0 && search.aaaProject.length <= 250 &&
    typeof search.aaaEnvironment === "string" && search.aaaEnvironment.length > 0 && search.aaaEnvironment.length <= 250
      ? { aaaProject: search.aaaProject, aaaEnvironment: search.aaaEnvironment } : {},
  component: ChatIndexRouteView,
});
