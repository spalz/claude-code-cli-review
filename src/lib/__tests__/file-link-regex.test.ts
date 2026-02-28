import { describe, it, expect } from "vitest";

// Same regex used in media/webview/terminals.js for file path link detection
const FILE_LINK_REGEX =
    /((?:~\/|\.{1,2}\/|\/|[a-zA-Z]:[\\/])[\w.\-\\/]+\.\w{1,10}|(?:[\w.\-]+\/)+[\w.\-]+\.\w{1,10})(?::(\d+))?(?::(\d+))?/g;

function parseLinks(line: string) {
    const results: { path: string; line?: number; col?: number; match: string }[] = [];
    let m;
    const re = new RegExp(FILE_LINK_REGEX.source, FILE_LINK_REGEX.flags);
    while ((m = re.exec(line)) !== null) {
        results.push({
            path: m[1],
            line: m[3] ? +m[2] : m[2] ? +m[2] : undefined,
            col: m[3] ? +m[3] : undefined,
            match: m[0],
        });
    }
    return results;
}

describe("file link regex", () => {
    it("matches absolute unix paths", () => {
        const links = parseLinks("Error at /Users/spals/project/src/index.ts:42:5");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("/Users/spals/project/src/index.ts");
        expect(links[0].line).toBe(42);
        expect(links[0].col).toBe(5);
    });

    it("matches tilde paths (~/...)", () => {
        const links = parseLinks("Read(~/projects/extensions/claude-code-review/docs/test.md)");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("~/projects/extensions/claude-code-review/docs/test.md");
    });

    it("matches relative paths with ./", () => {
        const links = parseLinks("  ./src/utils.ts:10");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("./src/utils.ts");
        expect(links[0].line).toBe(10);
    });

    it("matches parent-relative paths with ../", () => {
        const links = parseLinks("at ../lib/helpers.js:99:1");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("../lib/helpers.js");
        expect(links[0].line).toBe(99);
        expect(links[0].col).toBe(1);
    });

    it("matches bare relative paths with slash (src/foo.ts)", () => {
        const links = parseLinks("Read(src/utils/api/handleAxiosError.ts)");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("src/utils/api/handleAxiosError.ts");
    });

    it("matches bare relative with line number", () => {
        const links = parseLinks("src/foo.ts:42");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("src/foo.ts");
        expect(links[0].line).toBe(42);
    });

    it("does NOT match bare filenames without slash", () => {
        const links = parseLinks("Checking index.ts for errors");
        expect(links).toHaveLength(0);
    });

    it("does NOT match bare filename:line without slash", () => {
        const links = parseLinks("foo.ts:42");
        expect(links).toHaveLength(0);
    });

    it("matches multiple paths on one line", () => {
        const links = parseLinks("diff ./a.ts:1 ./b.ts:2");
        expect(links).toHaveLength(2);
        expect(links[0].path).toBe("./a.ts");
        expect(links[1].path).toBe("./b.ts");
    });

    it("matches Windows-style paths", () => {
        const links = parseLinks("Error in C:\\Users\\foo\\bar.ts:10");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("C:\\Users\\foo\\bar.ts");
        expect(links[0].line).toBe(10);
    });

    it("handles line-only (no column) correctly", () => {
        const links = parseLinks("/file.ts:25");
        expect(links).toHaveLength(1);
        expect(links[0].line).toBe(25);
        expect(links[0].col).toBeUndefined();
    });

    it("ignores lines with no file paths", () => {
        const links = parseLinks("Hello world, no files here!");
        expect(links).toHaveLength(0);
    });

    it("matches common extensions", () => {
        for (const ext of ["ts", "js", "py", "rs", "go", "json", "yaml", "tsx"]) {
            const links = parseLinks(`./file.${ext}`);
            expect(links).toHaveLength(1);
        }
    });

    it("matches paths without line numbers", () => {
        const links = parseLinks("Modified ./package.json");
        expect(links).toHaveLength(1);
        expect(links[0].path).toBe("./package.json");
        expect(links[0].line).toBeUndefined();
    });
});
