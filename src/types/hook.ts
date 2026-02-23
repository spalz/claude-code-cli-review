export type HookStatus = "installed" | "outdated" | "missing";
export type HookStatusCallback = (status: HookStatus) => void;
