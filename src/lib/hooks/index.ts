// Barrel re-exports for hooks module
export { getPostHookScript, getPreHookScript, getNotifyHookScript } from "./scripts";
export { getHookPath, getPreHookPath, getNotifyHookPath } from "./paths";
export { isHookInstalled } from "./validation";
export { installHook } from "./installation";
export { checkAndPrompt, doInstall } from "./commands";
