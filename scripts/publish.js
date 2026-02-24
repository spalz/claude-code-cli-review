const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");

// ── Helpers ──────────────────────────────────────────────────

function run(cmd, opts = {}) {
	console.log(`\n$ ${cmd}`);
	return execSync(cmd, { cwd: root, stdio: "inherit", ...opts });
}

function runCapture(cmd) {
	return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

function loadEnv() {
	if (!fs.existsSync(envPath)) {
		console.error("Error: .env file not found. Create it with:");
		console.error("  dev_azure_access_token=<your-token>");
		console.error("  open_vsx_registry_access_token=<your-token>");
		process.exit(1);
	}
	const env = {};
	for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq > 0) {
			env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
		}
	}
	return env;
}

// ── Pre-flight checks ────────────────────────────────────────

function preflight() {
	// Check git is clean
	const status = runCapture("git status --porcelain");
	if (status) {
		console.error("Error: working directory is not clean. Commit or stash changes first.");
		console.error(status);
		process.exit(1);
	}

	// Check branch
	const branch = runCapture("git rev-parse --abbrev-ref HEAD");
	if (branch !== "master" && branch !== "main") {
		console.error(`Error: expected branch master or main, got "${branch}".`);
		process.exit(1);
	}

	console.log(`Branch: ${branch}, working tree clean.`);
}

// ── Version bump ─────────────────────────────────────────────

function bumpVersion(level) {
	const valid = ["patch", "minor", "major"];
	if (!valid.includes(level)) {
		console.error(`Error: version bump must be one of: ${valid.join(", ")}`);
		process.exit(1);
	}
	run(`npm version ${level} --no-git-tag-version`);
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	console.log(`\nVersion bumped to ${pkg.version}`);
	return pkg.version;
}

// ── Package ──────────────────────────────────────────────────

function packageVsix(version) {
	const vsixName = `claude-code-review-${version}.vsix`;
	run(`npx @vscode/vsce package -o ${vsixName}`);

	// Safety: verify .env is NOT inside the .vsix
	const listing = runCapture(`unzip -l ${path.join(root, vsixName)}`);
	if (listing.includes(".env")) {
		console.error("\nCRITICAL: .env found inside .vsix! Aborting.");
		fs.unlinkSync(path.join(root, vsixName));
		process.exit(1);
	}
	console.log("Safety check passed: .env is not in the package.");
	return vsixName;
}

// ── Publish ──────────────────────────────────────────────────

function publishVSCode(vsixName, token) {
	console.log("\n── Publishing to VS Code Marketplace ──");
	run(`npx @vscode/vsce publish --packagePath ${vsixName} -p ${token}`);
}

function publishOpenVSX(vsixName, token) {
	console.log("\n── Publishing to Open VSX ──");
	run(`npx ovsx publish ${vsixName} -p ${token}`);
}

// ── Git tag & push ───────────────────────────────────────────

function gitTagAndPush(version) {
	const tag = `v${version}`;
	run(`git add package.json`);
	run(`git commit -m "release: ${tag}"`);
	run(`git tag ${tag}`);
	run(`git push && git push --tags`);
	console.log(`\nGit tag ${tag} pushed.`);
}

// ── Main ─────────────────────────────────────────────────────

function main() {
	const level = process.argv[2];
	if (!level) {
		console.log("Usage: node scripts/publish.js <patch|minor|major>");
		console.log("");
		console.log("  patch  — 0.5.0 → 8.0.1 (bug fixes)");
		console.log("  minor  — 0.5.0 → 8.1.0 (new features)");
		console.log("  major  — 0.5.0 → 9.0.0 (breaking changes)");
		process.exit(0);
	}

	const env = loadEnv();
	const vsceToken = env.dev_azure_access_token;
	const ovsxToken = env.open_vsx_registry_access_token;

	if (!vsceToken) {
		console.error("Error: dev_azure_access_token not found in .env");
		process.exit(1);
	}
	if (!ovsxToken) {
		console.error("Error: open_vsx_registry_access_token not found in .env");
		process.exit(1);
	}

	preflight();

	const version = bumpVersion(level);
	const vsixName = packageVsix(version);

	publishVSCode(vsixName, vsceToken);
	publishOpenVSX(vsixName, ovsxToken);
	gitTagAndPush(version);

	// Cleanup .vsix
	const vsixPath = path.join(root, vsixName);
	if (fs.existsSync(vsixPath)) {
		fs.unlinkSync(vsixPath);
	}

	console.log(`\n✓ Published v${version} to both marketplaces.`);
}

main();
