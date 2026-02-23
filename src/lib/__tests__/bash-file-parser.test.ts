import { describe, it, expect } from "vitest";
import { parseBashCommand, splitCommands, tokenize } from "../bash-file-parser";

describe("parseBashCommand", () => {
	// --- rm ---
	describe("rm", () => {
		it("rm file.txt → deleted", () => {
			const r = parseBashCommand("rm file.txt", "/ws");
			expect(r.deleted).toEqual(["/ws/file.txt"]);
			expect(r.modified).toEqual([]);
		});

		it("rm -rf /path/to/dir → deleted (absolute)", () => {
			const r = parseBashCommand("rm -rf /path/to/dir", "/ws");
			expect(r.deleted).toEqual(["/path/to/dir"]);
		});

		it("rm file1 file2 file3 → multiple deleted", () => {
			const r = parseBashCommand("rm file1 file2 file3", "/ws");
			expect(r.deleted).toEqual(["/ws/file1", "/ws/file2", "/ws/file3"]);
		});

		it("rm -f file.txt → deleted", () => {
			const r = parseBashCommand("rm -f file.txt", "/ws");
			expect(r.deleted).toEqual(["/ws/file.txt"]);
		});
	});

	// --- mv ---
	describe("mv", () => {
		it("mv src.ts dest.ts → deleted(src) + modified(dest)", () => {
			const r = parseBashCommand("mv src.ts dest.ts", "/ws");
			expect(r.deleted).toEqual(["/ws/src.ts"]);
			expect(r.modified).toEqual(["/ws/dest.ts"]);
		});

		it("mv -f old.ts new.ts → deleted + modified", () => {
			const r = parseBashCommand("mv -f old.ts new.ts", "/ws");
			expect(r.deleted).toEqual(["/ws/old.ts"]);
			expect(r.modified).toEqual(["/ws/new.ts"]);
		});
	});

	// --- cp ---
	describe("cp", () => {
		it("cp src.ts dest.ts → modified(dest)", () => {
			const r = parseBashCommand("cp src.ts dest.ts", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual(["/ws/dest.ts"]);
		});

		it("cp -r src/ dest/ → modified(dest)", () => {
			const r = parseBashCommand("cp -r src/ dest/", "/ws");
			expect(r.modified).toEqual(["/ws/dest"]);
		});
	});

	// --- sed ---
	describe("sed", () => {
		it("sed -i 's/old/new/g' file.ts → modified", () => {
			const r = parseBashCommand("sed -i 's/old/new/g' file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/file.ts"]);
		});

		it("sed -i.bak 's/x/y/' file.ts → modified", () => {
			const r = parseBashCommand("sed -i.bak 's/x/y/' file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/file.ts"]);
		});

		it("sed without -i → no modifications", () => {
			const r = parseBashCommand("sed 's/old/new/g' file.ts", "/ws");
			// Without -i, sed doesn't modify in place
			expect(r.modified).toEqual([]);
		});
	});

	// --- touch ---
	describe("touch", () => {
		it("touch new-file.ts → modified", () => {
			const r = parseBashCommand("touch new-file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/new-file.ts"]);
		});

		it("touch a.ts b.ts → multiple modified", () => {
			const r = parseBashCommand("touch a.ts b.ts", "/ws");
			expect(r.modified).toEqual(["/ws/a.ts", "/ws/b.ts"]);
		});
	});

	// --- tee ---
	describe("tee", () => {
		it("tee output.log → modified", () => {
			const r = parseBashCommand("tee output.log", "/ws");
			expect(r.modified).toEqual(["/ws/output.log"]);
		});

		it("tee -a output.log → modified", () => {
			const r = parseBashCommand("tee -a output.log", "/ws");
			expect(r.modified).toEqual(["/ws/output.log"]);
		});
	});

	// --- redirections ---
	describe("redirections", () => {
		it("echo data > output.txt → modified", () => {
			const r = parseBashCommand('echo "data" > output.txt', "/ws");
			expect(r.modified).toEqual(["/ws/output.txt"]);
		});

		it("cat >> append.txt → modified", () => {
			const r = parseBashCommand("cat >> append.txt", "/ws");
			expect(r.modified).toEqual(["/ws/append.txt"]);
		});

		it("> /dev/null is skipped", () => {
			const r = parseBashCommand("echo test > /dev/null", "/ws");
			expect(r.modified).toEqual([]);
		});
	});

	// --- git ---
	describe("git commands", () => {
		it("git checkout -- file.ts → modified", () => {
			const r = parseBashCommand("git checkout -- file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/file.ts"]);
		});

		it("git restore file.ts → modified", () => {
			const r = parseBashCommand("git restore file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/file.ts"]);
		});
	});

	// --- chained commands ---
	describe("chained commands", () => {
		it("rm a.ts && rm b.ts → both deleted", () => {
			const r = parseBashCommand("rm a.ts && rm b.ts", "/ws");
			expect(r.deleted).toEqual(["/ws/a.ts", "/ws/b.ts"]);
		});

		it("cp src dest; rm old → modified + deleted", () => {
			const r = parseBashCommand("cp src dest; rm old", "/ws");
			expect(r.modified).toEqual(["/ws/dest"]);
			expect(r.deleted).toEqual(["/ws/old"]);
		});

		it("echo x | tee file.ts → modified", () => {
			const r = parseBashCommand("echo x | tee file.ts", "/ws");
			expect(r.modified).toEqual(["/ws/file.ts"]);
		});
	});

	// --- quotes and spaces ---
	describe("quotes and spaces", () => {
		it('rm "file with spaces.ts" → deleted', () => {
			const r = parseBashCommand('rm "file with spaces.ts"', "/ws");
			expect(r.deleted).toEqual(["/ws/file with spaces.ts"]);
		});

		it("rm 'quoted.ts' → deleted", () => {
			const r = parseBashCommand("rm 'quoted.ts'", "/ws");
			expect(r.deleted).toEqual(["/ws/quoted.ts"]);
		});
	});

	// --- edge cases ---
	describe("edge cases", () => {
		it("empty command → no changes", () => {
			const r = parseBashCommand("", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual([]);
		});

		it("echo hello → no file ops", () => {
			const r = parseBashCommand("echo hello", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual([]);
		});

		it("ls -la → no file ops", () => {
			const r = parseBashCommand("ls -la", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual([]);
		});

		it("mkdir -p dir → no file ops", () => {
			const r = parseBashCommand("mkdir -p dir", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual([]);
		});

		it("chmod +x file → no file ops", () => {
			const r = parseBashCommand("chmod +x file", "/ws");
			expect(r.deleted).toEqual([]);
			expect(r.modified).toEqual([]);
		});
	});

	// --- path resolution ---
	describe("path resolution", () => {
		it("absolute paths preserved as-is", () => {
			const r = parseBashCommand("rm /abs/path.ts", "/ws");
			expect(r.deleted).toEqual(["/abs/path.ts"]);
		});

		it("relative paths resolved via workspacePath", () => {
			const r = parseBashCommand("rm src/file.ts", "/workspace");
			expect(r.deleted).toEqual(["/workspace/src/file.ts"]);
		});

		it("works without workspacePath", () => {
			const r = parseBashCommand("rm file.ts");
			expect(r.deleted).toEqual(["file.ts"]);
		});
	});
});

describe("splitCommands", () => {
	it("splits by &&", () => {
		expect(splitCommands("a && b")).toEqual(["a", "b"]);
	});

	it("splits by ;", () => {
		expect(splitCommands("a; b")).toEqual(["a", "b"]);
	});

	it("splits by ||", () => {
		expect(splitCommands("a || b")).toEqual(["a", "b"]);
	});

	it("splits by |", () => {
		expect(splitCommands("a | b")).toEqual(["a", "b"]);
	});

	it("respects quotes", () => {
		expect(splitCommands('echo "a && b"')).toEqual(['echo "a && b"']);
	});
});

describe("tokenize", () => {
	it("splits simple tokens", () => {
		expect(tokenize("rm -f file.ts")).toEqual(["rm", "-f", "file.ts"]);
	});

	it("handles double quotes", () => {
		expect(tokenize('rm "file with spaces"')).toEqual(["rm", "file with spaces"]);
	});

	it("handles single quotes", () => {
		expect(tokenize("rm 'file.ts'")).toEqual(["rm", "file.ts"]);
	});

	it("handles backslash escape", () => {
		expect(tokenize("rm file\\ name")).toEqual(["rm", "file name"]);
	});

	it("handles empty input", () => {
		expect(tokenize("")).toEqual([]);
	});
});
