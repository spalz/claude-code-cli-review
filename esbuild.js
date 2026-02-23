const esbuild = require("esbuild");
const { execSync } = require("child_process");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const deploy = process.argv.includes("--deploy");

const deployPlugin = {
	name: "deploy",
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length === 0 && deploy) {
				try {
					execSync("node scripts/deploy.js", { stdio: "inherit" });
				} catch {}
			}
		});
	},
};

async function main() {
	const plugins = deploy ? [deployPlugin] : [];

	const ctx = await esbuild.context({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		outfile: "dist/extension.js",
		external: ["vscode"],
		format: "cjs",
		platform: "node",
		target: "node20",
		sourcemap: !production,
		minify: production,
		logLevel: "info",
		plugins,
	});

	if (watch) {
		await ctx.watch();
		console.log("Watching for changes...");
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
