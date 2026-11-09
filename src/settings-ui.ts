import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, type SettingsListTheme } from "@earendil-works/pi-tui";
import {
  applySettingToRawConfig,
  FAST_SETTING_DESCRIPTORS,
  FOOTER_SETTING_DESCRIPTORS,
  readRawConfig,
  USAGE_SETTING_DESCRIPTORS,
  writeConfig,
  type ResolvedConfig,
} from "./config.ts";
import type { FastController } from "./fast-controller.ts";
import type { UsageController } from "./usage-controller.ts";

// The /grok-settings picker: loaded by its command handler on first use, so the
// settings list widgets and pi-core's theme stay out of extension startup.

/** What the settings picker needs from the extension's session state. */
export type SettingsUiHost = {
  config: (ctx: ExtensionContext) => ResolvedConfig;
  refresh: (ctx: ExtensionContext) => ResolvedConfig;
  fastController: FastController;
  usageController: Pick<UsageController, "restart">;
  updateFooter: (ctx: ExtensionContext) => void;
};

type SettingsPickerItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
};

// pi-core's getSettingsListTheme pulls the host module graph into this
// extension's loader, so it is resolved when the picker first opens.
let loadedSettingsListTheme: SettingsListTheme | undefined;
async function loadSettingsListTheme(): Promise<SettingsListTheme> {
  loadedSettingsListTheme ??= (
    await import("@earendil-works/pi-coding-agent")
  ).getSettingsListTheme();
  return loadedSettingsListTheme;
}

class DynamicBorder {
  readonly #color: (text: string) => string;

  constructor(color: (text: string) => string = (str) => str) {
    this.#color = color;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.#color("─".repeat(Math.max(1, width)))];
  }
}

function settingsItems(
  descriptors:
    | typeof FOOTER_SETTING_DESCRIPTORS
    | typeof USAGE_SETTING_DESCRIPTORS
    | typeof FAST_SETTING_DESCRIPTORS,
  cfg: ResolvedConfig,
): SettingsPickerItem[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    currentValue: descriptor.current(cfg),
    values: descriptor.values ? [...descriptor.values] : undefined,
  }));
}

function buildSettingsSections(cfg: ResolvedConfig): SettingsPickerItem[] {
  return [
    { id: "section.footer", label: "Footer", currentValue: "" },
    ...settingsItems(FOOTER_SETTING_DESCRIPTORS, cfg),
    { id: "section.usage", label: "Usage", currentValue: "" },
    ...settingsItems(USAGE_SETTING_DESCRIPTORS, cfg),
    { id: "section.fast", label: "Fast mode", currentValue: "" },
    ...settingsItems(FAST_SETTING_DESCRIPTORS, cfg),
  ];
}

function writeSetting(
  ctx: ExtensionContext,
  host: SettingsUiHost,
  id: string,
  rawValue: string,
): void {
  const cfg = host.refresh(ctx);
  const current = readRawConfig(cfg.configPath);
  if (id === "fast.enabled") {
    host.fastController.setDesired(ctx, cfg, rawValue === "true");
  }
  const nextRawConfig = applySettingToRawConfig(current, id, rawValue, {
    persistState: cfg.persistState,
    active: host.fastController.active,
    desiredActive: host.fastController.desiredActive,
  });
  writeConfig(cfg.configPath, nextRawConfig);
  if (id === "usage.refreshIntervalMs") host.usageController.restart(ctx);
  host.updateFooter(ctx);
}

export async function showSettingsPicker(
  ctx: ExtensionContext,
  host: SettingsUiHost,
): Promise<void> {
  const settingsListTheme = await loadSettingsListTheme();
  try {
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
      container.addChild(
        new (class {
          render(_width: number) {
            const cfg = host.config(ctx);
            return [
              theme.bold(theme.fg("accent", "Better Grok Settings")),
              theme.fg("muted", cfg.configPath),
              "",
            ];
          }
          invalidate() {}
        })(),
      );
      const settingsList = new SettingsList(
        buildSettingsSections(host.refresh(ctx)),
        8,
        settingsListTheme,
        (id, newValue) => {
          if (!id.startsWith("section.")) writeSetting(ctx, host, id, newValue);
          settingsList.updateValue(
            id,
            buildSettingsSections(host.config(ctx)).find((item) => item.id === id)?.currentValue ??
              newValue,
          );
          tui.requestRender();
        },
        () => done(undefined),
        { enableSearch: true },
      );
      container.addChild(settingsList);
      container.addChild(new DynamicBorder((text) => theme.fg("border", text)));
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  } finally {
    host.updateFooter(ctx);
  }
}
