import {
  resolveDeviceModelId,
  type DeviceAccessorySource,
  type DeviceModelSource,
} from "@t3tools/client-runtime/device/model";
import type { DevicePlatform } from "@t3tools/contracts";

// Device artwork is optional and supplied locally under its own license.
// An empty glob keeps public source builds working without redistributing it.
const modelUrls = import.meta.glob<string>("./models/*.glb", {
  eager: true,
  query: "?url",
  import: "default",
});

export function deviceModel(platform: DevicePlatform, name: string): DeviceModelSource | null {
  const id = resolveDeviceModelId(platform, name);
  const url = id ? modelUrls[`./models/${id}.glb`] : undefined;
  return id && url ? { id, url } : null;
}

export function deviceKeyboard(
  platform: DevicePlatform,
  name: string,
): DeviceAccessorySource | null {
  const url = modelUrls["./models/ipad-pro-13-m5-magic-keyboard.glb"];
  return resolveDeviceModelId(platform, name) === "ipad-pro-13-m5" && url
    ? { id: "ipad-pro-13-m5-magic-keyboard", modelId: "ipad-pro-13-m5", url }
    : null;
}
