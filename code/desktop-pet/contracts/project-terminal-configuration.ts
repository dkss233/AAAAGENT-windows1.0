import type { ProjectTerminalModelSelection } from './project-terminal-processing.js';

/** Separate persisted project-memory settings. Preparing this record never enables processing. */
export interface ProjectTerminalConfiguration {
  readonly version: '0.1.0';
  readonly enabled: boolean;
  readonly selection: ProjectTerminalModelSelection;
  readonly maxOutputTokens: 1024;
}
