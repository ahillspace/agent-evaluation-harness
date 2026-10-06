declare const __AEH_BUILD_ID__: string;
export const buildId =
  typeof __AEH_BUILD_ID__ === "undefined" ? "development" : __AEH_BUILD_ID__;
