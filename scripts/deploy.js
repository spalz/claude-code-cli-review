const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkg = require("../package.json");
const root = path.resolve(__dirname, "..");
const home = require("os").homedir();
const extDir = path.join(home, ".vscode", "extensions");
const name = `local.${pkg.name}-${pkg.version}`;
const target = path.join(extDir, name);

const exclude = ["node_modules", ".git", ".claude", "src", "scripts", ".prettierrc", ".prettierignore"];

// Remove old versions (folders)
if (fs.existsSync(extDir)) {
	for (const entry of fs.readdirSync(extDir)) {
		if (entry.startsWith(`local.${pkg.name}-`) && entry !== name) {
			const old = path.join(extDir, entry);
			fs.rmSync(old, { recursive: true, force: true });
			console.log(`Removed old → ${old}`);
		}
	}
}

// Clean stale entries from extensions.json (VS Code extension registry)
const registryPath = path.join(extDir, "extensions.json");
if (fs.existsSync(registryPath)) {
	try {
		const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
		const before = registry.length;
		const cleaned = registry.filter((e) => {
			const id = e.identifier?.id || "";
			const loc = e.relativeLocation || "";
			// Remove entries for our extension that point to old versions
			if (loc.startsWith(`local.${pkg.name}-`) && loc !== name) return false;
			if (id === `local.${pkg.name}` && e.version !== pkg.version) return false;
			return true;
		});
		if (cleaned.length < before) {
			fs.writeFileSync(registryPath, JSON.stringify(cleaned));
			console.log(`Cleaned ${before - cleaned.length} stale entries from extensions.json`);
		}
	} catch {}
}

// Deploy current version — clean first to avoid stale files
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const items = fs.readdirSync(root).filter((f) => !exclude.includes(f));
for (const item of items) {
	execSync(`cp -r "${path.join(root, item)}" "${path.join(target, item)}"`);
}

console.log(`Deployed → ${target}`);
