import { sendWorkspaceIntent } from "./workspace-ui-bridge";
import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { getCustomThemes, installCustomTheme, updateCustomTheme, parseThemeFile, serializeThemeFile, CUSTOM_THEMES_STORAGE_KEY, THEME_HALVES_STORAGE_KEY, type ThemeColorOverrides } from "../themePalette";
import { sameThemeDefinition } from "./AAAThemeMatch";

export const AAA_THEME_ID = "aaaagent-warm";
function palette(dark: boolean, legacy = false): ThemeColorOverrides {
  const background = dark ? "#242422" : "#f7f6f2";
  const panel = dark ? "#2c2c29" : "#eeede7";
  const raised = dark ? "#32322e" : "#ffffff";
  const text = dark ? "#ece9e1" : "#2a2b26";
  const muted = dark ? "#aaa79c" : "#686b61";
  const border = dark ? "#41413c" : "#ddded5";
  const accent = dark ? "#cf8b70" : "#4b5746";
  return {
    canvas: background, chrome: panel, toolbar: background, toolbarForeground: text,
    toolbarBorder: border, toolbarControl: panel, toolbarControlForeground: text,
    toolbarControlHover: raised, surface: background, surfaceRaised: raised, surfaceOverlay: raised,
    text, textMuted: muted, border, input: raised, focus: accent, accent,
    accentForeground: dark ? "#242422" : "#ffffff", secondary: panel, secondaryForeground: text,
    muted: panel, mutedForeground: muted, placeholder: muted, secondaryLabel: muted, iconMuted: muted,
    error: dark ? "#ec9d94" : "#a63732", errorForeground: legacy ? (dark ? "#242422" : "#ffffff") : (dark ? "#ffc1b7" : "#84231f"),
    errorSurface: dark ? "#492b29" : "#f7e3df", warning: dark ? "#dcb574" : "#86621c",
    warningForeground: legacy ? (dark ? "#242422" : "#ffffff") : (dark ? "#ecd099" : "#68460e"), warningSurface: dark ? "#443a27" : "#f5edd9",
    update: dark ? "#abc294" : "#496a39", updateForeground: legacy ? (dark ? "#242422" : "#ffffff") : (dark ? "#c6dcaf" : "#345025"),
    updateSurface: dark ? "#303b2a" : "#e4eddc", accentSurface: panel, accentSurfaceForeground: text,
    messageSurface: panel, messageForeground: text, messageAction: raised,
    messageActionForeground: text, messageActionHover: panel, codeBackground: dark ? "#20201e" : "#eeede7",
    codeForeground: text, sidebar: panel, sidebarForeground: text, sidebarMutedForeground: muted,
    sidebarControlSurface: raised, sidebarRowHover: raised, sidebarRowActive: raised,
    sidebarRowSelected: dark ? "#4b3b32" : "#dfe4d8", sidebarBorder: border,
    terminalBackground: dark ? "#20201e" : "#f7f6f2", terminalForeground: text,
    terminalCursor: accent, terminalSelection: dark ? "#554438" : "#dfe4d8",
    terminalScrollbar: border, terminalScrollbarHover: muted,
  };
}
function generatedTheme(legacy = false) {
  return parseThemeFile({ version: 1, id: AAA_THEME_ID, name: "AAA 米白 / 暖炭灰",
    appearance: "light", colors: palette(false, legacy), variants: { dark: palette(true, legacy) } });
}
function isUnmodifiedLegacyTheme() {
  const library: unknown = JSON.parse(localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY) ?? "[]");
  if (!Array.isArray(library)) return false;
  const candidates = library.filter(theme => theme?.id === AAA_THEME_ID);
  if (candidates.length !== 1) return false;
  const file = JSON.parse(serializeThemeFile(generatedTheme(true)));
  return sameThemeDefinition(candidates[0], { id: file.id, label: file.name, appearance: file.appearance,
    colors: file.colors, variants: file.variants });
}
export function AAAppearance() {
  const { appearanceMode, setTheme, setAppearanceMode } = useTheme();
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      if (!getCustomThemes().some(t => t.id === AAA_THEME_ID)) {
        installCustomTheme(generatedTheme());
      } else if (isUnmodifiedLegacyTheme()) updateCustomTheme(generatedTheme());
      // A fresh app adopts the paired palette. An existing preference stays selected.
      if (!localStorage.getItem("t3code:theme") && !localStorage.getItem(THEME_HALVES_STORAGE_KEY)) setTheme(AAA_THEME_ID);
    } catch { setError("外观偏好暂时无法保存。"); }
  }, [setTheme]);
  return <div className="aaa-appearance" aria-label="外观">
    {([['light', '米白'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([mode, label]) =>
      <button key={mode} type="button" aria-pressed={appearanceMode === mode}
        onClick={() => { if (!setAppearanceMode(mode)) setError("外观偏好暂时无法保存。"); else setError("");
          sendWorkspaceIntent("appearance.set", { mode }); }}>
        {label}
      </button>)}
    {error && <span role="status">{error}</span>}
  </div>;
}
