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

// Remove old versions
if (fs.existsSync(extDir)) {
	for (const entry of fs.readdirSync(extDir)) {
		if (entry.startsWith(`local.${pkg.name}-`) && entry !== name) {
			const old = path.join(extDir, entry);
			fs.rmSync(old, { recursive: true, force: true });
			console.log(`Removed old → ${old}`);
		}
	}
}

// Deploy current version — clean first to avoid stale files
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
const items = fs.readdirSync(root).filter((f) => !exclude.includes(f));
for (const item of items) {
	execSync(`cp -r "${path.join(root, item)}" "${path.join(target, item)}"`);
}

console.log(`Deployed → ${target}`);
